#!/usr/bin/env node
'use strict';
/**
 * gictator —— 「独裁」重写 git commit。
 *
 * 对指定范围内的每个 commit：
 *   1. 移除 message 中所有 Co-authored-by trailer；
 *   2. author / committer 一律改为 git 全局配置的 user.name / user.email；
 *   3. committer date 强制等于原 author date（提交时间 = 作者时间）；
 *   4. 用 commit-tree -S 强制 GPG 签名重建。
 *
 * 用法：
 *   node gictator.cjs                    # 独裁所有「未 push」的 commit（含被 amend 的，含已 push 但被 amend 的）
 *   node gictator.cjs <commit_hash>      # 从 <commit_hash>（含）到 HEAD 全部独裁
 *   node gictator.cjs [commit_hash] --dry-run   # 仅预览，不改动
 *   node gictator.cjs [commit_hash] --key <keyid>  # 覆盖签名密钥
 *
 * 范围界定（未携带参数时）：
 *   ① 有 upstream        → @{u}..HEAD（upstream 可达的全部排除）；
 *   ② 无 upstream 有远端 → HEAD --not --remotes（凡在任何 remote-tracking ref 可达的排除）；
 *   ③ 无任何远端 ref     → 当前分支全部 commit（warning 提示）；
 *   ④ amend 扩展（①②③之后统一应用）：扫描 HEAD reflog 中 `commit (amend)` 条目，
 *      产物 hash 若在当前 HEAD 祖先链上却不在上述范围（即「已 push 但被 amend」），
 *      以其中拓扑最深者为锚点，范围向下扩展至锚点（含），级联重写到 HEAD。
 *
 * 输出：单个 JSON 对象到 stdout，供 AI 解析展示。
 */

const { execFileSync } = require('child_process');

/* ───────────────────────── 参数解析 ───────────────────────── */
const argv = process.argv.slice(2);
let dryRun = false;
let keyArg = null;
let hashArg = null;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--dry-run' || a === '-n') dryRun = true;
  else if (a === '--key') keyArg = argv[++i] || null;
  else if (a === '--help' || a === '-h') {
    process.stdout.write(JSON.stringify({ success: false, usage: true }));
    process.exit(0);
  } else if (!hashArg && !a.startsWith('-')) hashArg = a;
}

/* ───────────────────────── 工具函数 ───────────────────────── */
function emit(obj) {
  process.stdout.write(JSON.stringify(obj));
  process.exit(0);
}
function fail(error, extra) {
  emit(Object.assign({ success: false, error: String(error) }, extra || {}));
}

// git 调用统一走 execFileSync + 数组参数，彻底规避 shell 引号 / 转义问题。
function git(args, opts) {
  return execFileSync('git', args, Object.assign(
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] },
    opts || {}
  ));
}
// 返回 trim 后的 stdout；命令失败（非零退出）返回 null。
function gitTrim(args, opts) {
  try { const r = git(args, opts); return r == null ? null : r.trim(); }
  catch (e) { return null; }
}
function isAncestor(a, b) {
  try { execFileSync('git', ['merge-base', '--is-ancestor', a, b], { encoding: 'utf8', stdio: 'pipe' }); return true; }
  catch (e) { return false; }
}

/* ─────────────────── message / co-author 处理 ─────────────────── */
const COAUTHOR_RE = /^[ \t]*co-authored-by[ \t]*:/i;

function countCoAuthors(body) {
  return body.split('\n').filter((l) => COAUTHOR_RE.test(l)).length;
}
// 删除所有 Co-authored-by 行，并整理因此产生的多余空白。
function stripCoAuthors(body) {
  const kept = body.split('\n').filter((l) => !COAUTHOR_RE.test(l));
  let s = kept.join('\n');
  s = s
    .replace(/[ \t]+\n/g, '\n')   // 行尾空白
    .replace(/\n{3,}/g, '\n\n')   // 折叠 3+ 连续空行为 1 个
    .replace(/^\n+/, '')          // 去掉开头空行
    .replace(/\s+$/, '');         // 去掉结尾空白
  return s.length ? s + '\n' : '';
}

/* ─────────────── 批量 commit 元数据读取（1 次调用读全部） ─────────────── */
// 每条记录以 \x01 起始，字段间 NUL 分隔：%H %T %P %an %ae %aI %cI %G? %B。
// 不用 \x00\x00 作记录分隔：root commit 的 %P 为空会产生连续 NUL，导致记录被劈开。
const META_FMT = '%x01%H%x00%T%x00%P%x00%an%x00%ae%x00%aI%x00%cI%x00%G?%x00%B';

function parseMetas(raw) {
  const out = [];
  for (const rec of raw.split('\x01')) {
    if (!rec.trim()) continue;
    const f = rec.split('\x00');
    out.push({
      hash: f[0], tree: f[1], parents: f[2] ? f[2].split(' ') : [],
      authorName: f[3], authorEmail: f[4], authorDate: f[5],
      committerDate: f[6], sigStatus: f[7],
      subject: (f[8] || '').split('\n')[0] || '',
      body: (f[8] || '').replace(/\n+$/, ''),
    });
  }
  return out;
}
// rangeArgs 形如 ['@{u}..HEAD'] / ['HEAD','--not','--remotes'] / ['HEAD'] / ['<hash>..HEAD']
function readMetas(rangeArgs) {
  const raw = git(['rev-list', '--reverse', '--topo-order', '--no-commit-header',
    '--format=' + META_FMT].concat(rangeArgs));
  return parseMetas(raw);
}

/* ──────────────────────── amend 产物检测 ──────────────── */
// 从 HEAD reflog 收集 `commit (amend): ...` 条目对应的产物 commit（完整 hash）。
// reflog 不可用 / 被禁用时返回空数组，graceful 降级。
function amendedHashes() {
  const raw = gitTrim(['reflog', 'show', 'HEAD', '--format=%H%x00%gs', '-n', '2000']);
  if (!raw) return [];
  const set = [];
  for (const line of raw.split('\n')) {
    const i = line.indexOf('\x00');
    if (i < 0) continue;
    if (line.slice(i + 1).startsWith('commit (amend)')) {
      const h = line.slice(0, i);
      if (/^[0-9a-f]{40}$/.test(h) && set.indexOf(h) < 0) set.push(h);
    }
  }
  return set;
}

/* ─────────────────────────── 范围解析 ───────────────────────── */
// 返回 { metas:[拓扑序], metas已有parents, baseParent, mode, basis, upstream, warning, amendExtended }
function resolveRange() {
  if (hashArg) {
    const full = gitTrim(['rev-parse', '--verify', hashArg + '^{commit}']);
    if (!full) return { error: '无效或不可解析的 commit：' + hashArg };
    if (!isAncestor(full, 'HEAD')) {
      return { error: 'commit ' + hashArg + ' 不是当前分支 HEAD 的祖先，无法重写「它到 HEAD」的范围' };
    }
    const metas = readMetas([full + '..HEAD']);
    metas.unshift(Object.assign(readMetaOne(full), { parents: parentsOf(full) }));
    const baseParent = metas.length && metas[0].parents.length ? metas[0].parents[0] : null;
    return { metas, baseParent, mode: 'range', basis: 'explicit', startHash: full };
  }

  // ── 未携带参数：界定「未 push」──
  const up = gitTrim(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  let metas, basis, upstream = null, warning = null;
  if (up) {
    upstream = up;
    metas = readMetas(['@{u}..HEAD']);
    basis = 'upstream';
  } else {
    // 无 upstream：凡在任何 remote-tracking ref 可达的都视为已 push。
    const hasRemoteRef = (gitTrim(['for-each-ref', '--format=%(refname)', 'refs/remotes/']) || '').length > 0;
    if (hasRemoteRef) {
      metas = readMetas(['HEAD', '--not', '--remotes']);
      basis = 'remotes';
      warning = '当前分支无 upstream，已按「不在任何远端跟踪分支」界定未 push 范围';
    } else {
      metas = readMetas(['HEAD']);
      basis = 'all';
      warning = '仓库没有任何远端跟踪 ref，视为纯本地仓库，将重写当前分支全部 ' + metas.length + ' 个 commit';
    }
  }

  // ── amend 扩展：已 push 但被 amend 的 commit 也要算在内 ──
  const inRange = new Set(metas.map((m) => m.hash));
  const extraAnchors = [];
  for (const h of amendedHashes()) {
    if (!inRange.has(h) && isAncestor(h, 'HEAD')) extraAnchors.push(h);
  }
  let amendExtended = 0;
  if (extraAnchors.length) {
    // 取拓扑最深的锚点（其余锚点必是其祖先或已在原范围内）
    let deepest = extraAnchors[0];
    for (const h of extraAnchors) {
      if (h !== deepest && isAncestor(deepest, h)) deepest = h;
    }
    const anchorParent = parentsOf(deepest)[0] || null;
    const extended = readMetas([anchorParent ? anchorParent + '..HEAD' : 'HEAD']);
    amendExtended = extended.filter((m) => !inRange.has(m.hash)).length;
    metas = extended;
  }

  const baseParent = metas.length && metas[0].parents.length ? metas[0].parents[0] : null;
  return { metas, baseParent, mode: 'unpushed', basis, upstream, warning,
    amendExtended, amendedSet: new Set(amendedHashes()) };
}

// 单个 commit 元数据（仅 range 模式起点用）
function readMetaOne(h) {
  const raw = git(['rev-list', '--no-commit-header', '-n', '1', '--format=' + META_FMT, h]);
  return parseMetas(raw)[0];
}
function parentsOf(h) {
  return (gitTrim(['rev-list', '--parents', '-n', '1', h]) || '').split(/\s+/).slice(1).filter(Boolean);
}

/* ───────────── 核心：逐 commit 重建（含签名，tree 逐字节不变） ───────────── */
// metas 为拓扑序（parent 在前），元数据已批量读取。
// 返回 { newHead, results:[{old,new,subject,coAuthorsRemoved,sigBefore,sigAfter,amended}] }
function dictate(metas, id, key) {
  const oldToNew = {};
  const newHashes = [];
  const results = [];

  for (const meta of metas) {
    const newMsg = stripCoAuthors(meta.body);
    const coRemoved = countCoAuthors(meta.body);

    // parent 映射：范围内的父指向重写后的新 hash；范围外的父保持原样（支持 merge commit）。
    const useParents = meta.parents.map((p) => oldToNew[p] || p);

    const env = Object.assign({}, process.env, {
      GIT_AUTHOR_NAME: id.name, GIT_AUTHOR_EMAIL: id.email, GIT_AUTHOR_DATE: meta.authorDate,
      GIT_COMMITTER_NAME: id.name, GIT_COMMITTER_EMAIL: id.email, GIT_COMMITTER_DATE: meta.authorDate,
    });

    const args = ['commit-tree', meta.tree];
    for (const p of useParents) args.push('-p', p);
    args.push(key ? '-S' + key : '-S');

    let newHash;
    try {
      newHash = execFileSync('git', args, {
        encoding: 'utf8', env, input: newMsg, maxBuffer: 16 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
    } catch (e) {
      const detail = (e.stderr || e.message || '').toString().trim();
      throw new Error('重写 commit ' + meta.hash.slice(0, 7) + ' 失败（多为 GPG 签名不可用）：' + detail);
    }
    if (!newHash) throw new Error('commit-tree 未返回新 hash：' + meta.hash.slice(0, 7));

    oldToNew[meta.hash] = newHash;
    newHashes.push(newHash);
    results.push({
      old: meta.hash.slice(0, 7), subject: meta.subject,
      coAuthorsRemoved: coRemoved, sigBefore: meta.sigStatus,
      amended: meta.amended === true,
    });
  }

  // 签名状态批量验证（1 次调用替代 N 次）。
  const sigRaw = gitTrim(['rev-list', '--no-commit-header', '-n', String(newHashes.length),
    '--format=%H%x00%G?', newHashes[newHashes.length - 1]]) || '';
  const sigMap = {};
  for (const line of sigRaw.split('\n')) {
    const i = line.indexOf('\x00');
    if (i > 0) sigMap[line.slice(0, i)] = line.slice(i + 1);
  }
  results.forEach((r, idx) => {
    const full = newHashes[idx];
    r.new = full.slice(0, 7);
    r.newFull = full;
    r.sigAfter = sigMap[full] || 'N';
  });

  return { newHead: newHashes[newHashes.length - 1], results };
}

/* ───────────────────────────── 主流程 ───────────────────────── */
function main() {
  if (gitTrim(['rev-parse', '--is-inside-work-tree']) !== 'true') {
    return fail('当前目录不是 git 仓库，请在项目根目录下运行');
  }
  const branch = gitTrim(['rev-parse', '--abbrev-ref', 'HEAD']);
  if (!branch || branch === 'HEAD') {
    return fail('当前处于 detached HEAD 状态，请先切换到具体分支（如 git checkout main）');
  }

  // 身份：优先全局配置，缺失时回退 effective 配置。
  const gName = gitTrim(['config', '--global', 'user.name']);
  const gEmail = gitTrim(['config', '--global', 'user.email']);
  const name = gName || gitTrim(['config', 'user.name']);
  const email = gEmail || gitTrim(['config', 'user.email']);
  if (!name || !email) return fail('无法从 git 配置获取 user.name / user.email');
  const id = { name, email };
  const idFromGlobal = !!(gName && gEmail);

  const key = keyArg || gitTrim(['config', 'user.signingkey']) || gitTrim(['config', '--global', 'user.signingkey']);

  const range = resolveRange();
  if (range.error) return fail(range.error);

  const workingTreeDirty = (gitTrim(['status', '--porcelain']) || '').length > 0;

  // 空范围：没有可独裁的 commit。
  if (!range.metas.length) {
    return emit({
      success: true, empty: true, branch, mode: range.mode,
      basis: range.basis, upstream: range.upstream || null,
      message: range.mode === 'unpushed' ? '没有未 push 的 commit，无需独裁' : '当前分支没有可重写的 commit',
    });
  }

  // 预览数据（标记 amended）。
  const amendedSet = range.amendedSet || new Set();
  const preview = range.metas.map((m) => ({
    old: m.hash.slice(0, 7), subject: m.subject,
    author: m.authorName + ' <' + m.authorEmail + '>',
    authorDate: m.authorDate, committerDate: m.committerDate,
    sigBefore: m.sigStatus, coAuthors: countCoAuthors(m.body),
    amended: amendedSet.has(m.hash),
  }));
  const amendedCount = preview.filter((p) => p.amended).length;

  if (dryRun) {
    return emit({
      success: true, dryRun: true, branch, mode: range.mode,
      basis: range.basis, upstream: range.upstream || null,
      baseParent: range.baseParent ? range.baseParent.slice(0, 7) : null,
      count: range.metas.length, amendedCount,
      amendExtended: range.amendExtended || 0,
      identity: name + ' <' + email + '>',
      idFromGlobal, signingKey: key || '(git 默认，按 committer email 匹配)',
      workingTreeDirty, warning: range.warning || null, preview,
    });
  }

  // 实际执行。
  const oldHead = gitTrim(['rev-parse', 'HEAD']);
  for (const m of range.metas) m.amended = amendedSet.has(m.hash);
  let outcome;
  try {
    outcome = dictate(range.metas, id, key);
  } catch (e) {
    return fail(e.message, { branch, mode: range.mode, oldHead, partial: true });
  }

  // 自动备份旧分支头（refs/gictator/<branch>，幂等覆盖），配合 CAS 更新防误伤。
  let backupRef = 'refs/gictator/' + branch;
  try { git(['update-ref', backupRef, oldHead]); }
  catch (e) { backupRef = null; }
  try {
    git(['update-ref', 'refs/heads/' + branch, outcome.newHead, oldHead]);
  } catch (e) {
    return fail('更新分支指针失败：' + (e.stderr || e.message), { branch, oldHead, newHead: outcome.newHead });
  }

  const allSigned = outcome.results.every((r) => r.sigAfter === 'G' || r.sigAfter === 'U');
  const totalCoAuthors = outcome.results.reduce((s, r) => s + r.coAuthorsRemoved, 0);
  const forceNeeded = range.mode === 'range' || range.basis !== 'upstream' || range.amendExtended > 0;

  emit({
    success: true, branch, mode: range.mode,
    basis: range.basis, upstream: range.upstream || null,
    identity: name + ' <' + email + '>', idFromGlobal,
    signingKey: key || '(git 默认)',
    oldHead, newHead: outcome.newHead, count: outcome.results.length,
    amendedCount, amendExtended: range.amendExtended || 0,
    allSigned, totalCoAuthorsRemoved: totalCoAuthors,
    workingTreeDirty, warning: range.warning || null,
    results: outcome.results,
    backupRef,
    rollback: 'git reset --hard ' + oldHead,
    pushHint: forceNeeded
      ? 'git push --force-with-lease' + (range.amendExtended > 0 ? '（含已 push 但被 amend 的 commit，需强推）' : '（历史已重写，需强制推送）')
      : 'git push（fast-forward 即可）',
  });
}

try { main(); }
catch (e) { fail((e && e.message) || e); }
