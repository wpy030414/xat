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
 *   node gictator.cjs                    # 独裁当前分支所有「未 push」的 commit
 *   node gictator.cjs <commit_hash>      # 从 <commit_hash>（含）到 HEAD 全部独裁
 *   node gictator.cjs [commit_hash] --dry-run   # 仅预览，不改动
 *   node gictator.cjs [commit_hash] --key <keyid>  # 覆盖签名密钥
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

/* ─────────────────────── commit 元数据读取 ─────────────────────── */
function readMeta(hash) {
  // %x1f = 单元分隔符，字段顺序固定；完整 message 用 %B 单独取（含换行）。
  const line = git(['show', '-s', '--format=%H%x1f%h%x1f%an%x1f%ae%x1f%aI%x1f%cn%x1f%ce%x1f%cI%x1f%G?%x1f%s', hash]);
  const f = line.replace(/\n$/, '').split('\x1f');
  const body = git(['show', '-s', '--format=%B', hash]);
  return {
    hash: f[0], short: f[1],
    authorName: f[2], authorEmail: f[3], authorDate: f[4],
    committerName: f[5], committerEmail: f[6], committerDate: f[7],
    sigStatus: f[8], subject: f[9],
    body: body.replace(/\n$/, ''),
  };
}

/* ─────────────────────────── 范围解析 ─────────────────────────── */
// 返回 { commits:[old→new 拓扑序], baseParent, mode, ... } 或 { error }
function resolveRange() {
  if (hashArg) {
    const full = gitTrim(['rev-parse', '--verify', hashArg + '^{commit}']);
    if (!full) return { error: '无效或不可解析的 commit：' + hashArg };
    if (!isAncestor(full, 'HEAD')) {
      return { error: 'commit ' + hashArg + ' 不是当前分支 HEAD 的祖先，无法重写「它到 HEAD」的范围' };
    }
    const rest = gitTrim(['rev-list', '--reverse', '--topo-order', full + '..HEAD']) || '';
    const commits = [full].concat(rest ? rest.split('\n') : []);
    const baseParent = gitTrim(['rev-parse', '--verify', full + '^']); // root commit 时为 null
    return { commits, baseParent, mode: 'range', startHash: full };
  }

  // 未 push 模式：优先用 upstream 跟踪分支界定。
  const up = gitTrim(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  if (up) {
    const list = gitTrim(['rev-list', '--reverse', '--topo-order', '@{u}..HEAD']) || '';
    const commits = list ? list.split('\n') : [];
    const baseParent = gitTrim(['rev-parse', '@{u}']);
    return { commits, baseParent, mode: 'unpushed', upstream: up };
  }

  // 无 upstream：无法界定「未 push」，回退为重写当前分支全部 commit。
  const list = gitTrim(['rev-list', '--reverse', '--topo-order', 'HEAD']) || '';
  const commits = list ? list.split('\n') : [];
  return {
    commits, baseParent: null, mode: 'all',
    warning: '当前分支无 upstream（未设置远程跟踪分支），已回退为重写当前分支的全部 ' + commits.length + ' 个 commit',
  };
}

/* ───────────── 核心：遍历多个 commit 逐一重建（含签名） ───────────── */
// commits 为拓扑序（parent 在前）；baseParent 为范围外首个父（null=无父）。
// 返回 { newHead, results:[{old,new,subject,coAuthorsRemoved,sigBefore,sigAfter}] }
function dictate(commits, baseParent, id, key) {
  let parent = baseParent;
  const oldToNew = {};
  const results = [];

  for (const oldHash of commits) {
    const meta = readMeta(oldHash);
    const tree = gitTrim(['rev-parse', oldHash + '^{tree}']);
    if (!tree) throw new Error('无法取得 commit ' + meta.short + ' 的 tree');

    const newMsg = stripCoAuthors(meta.body);
    const coRemoved = countCoAuthors(meta.body);

    // parent 映射：范围内的父指向重写后的新 hash；范围外的父保持原样（支持 merge commit）。
    const rawParents = (gitTrim(['rev-list', '--parents', '-n', '1', oldHash]) || '').split(/\s+/).slice(1);
    const newParents = rawParents.map((p) => oldToNew[p] || p);
    // 首个 commit 若原本无父（root），沿用 baseParent 逻辑；否则用映射后的父。
    const useParents = newParents.length ? newParents : (parent ? [parent] : []);

    const env = Object.assign({}, process.env, {
      GIT_AUTHOR_NAME: id.name, GIT_AUTHOR_EMAIL: id.email, GIT_AUTHOR_DATE: meta.authorDate,
      GIT_COMMITTER_NAME: id.name, GIT_COMMITTER_EMAIL: id.email, GIT_COMMITTER_DATE: meta.authorDate,
    });

    const args = ['commit-tree', tree];
    for (const p of useParents) args.push('-p', p);
    args.push(key ? '-S' + key : '-S');

    let newHash;
    try {
      newHash = execFileSync('git', args, {
        encoding: 'utf8', env, input: newMsg, maxBuffer: 16 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
    } catch (e) {
      const detail = (e.stderr || e.message || '').toString().trim();
      throw new Error('重写 commit ' + meta.short + ' 失败（多为 GPG 签名不可用）：' + detail);
    }
    if (!newHash) throw new Error('commit-tree 未返回新 hash：' + meta.short);

    const sigAfter = gitTrim(['log', '-1', '--format=%G?', newHash]) || 'N';
    oldToNew[oldHash] = newHash;
    results.push({
      old: meta.short, new: newHash.slice(0, 7), newFull: newHash,
      subject: meta.subject, coAuthorsRemoved: coRemoved,
      sigBefore: meta.sigStatus, sigAfter,
    });
    parent = newHash;
  }

  return { newHead: parent, results };
}

/* ───────────────────────────── 主流程 ───────────────────────────── */
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
  if (!range.commits.length) {
    return emit({
      success: true, empty: true, branch, mode: range.mode,
      upstream: range.upstream || null,
      message: range.mode === 'unpushed'
        ? '没有未 push 的 commit，无需独裁'
        : '当前分支没有可重写的 commit',
    });
  }

  // 预览信息（dry-run 与执行前都计算，供展示）。
  const preview = range.commits.map((h) => {
    const m = readMeta(h);
    return {
      old: m.short, subject: m.subject,
      author: m.authorName + ' <' + m.authorEmail + '>',
      authorDate: m.authorDate, committerDate: m.committerDate,
      sigBefore: m.sigStatus, coAuthors: countCoAuthors(m.body),
    };
  });

  if (dryRun) {
    return emit({
      success: true, dryRun: true, branch, mode: range.mode,
      upstream: range.upstream || null, baseParent: range.baseParent ? range.baseParent.slice(0, 7) : null,
      count: range.commits.length, identity: name + ' <' + email + '>',
      idFromGlobal, signingKey: key || '(git 默认，按 committer email 匹配)',
      workingTreeDirty, warning: range.warning || null, preview,
    });
  }

  // 实际执行。
  const oldHead = gitTrim(['rev-parse', 'HEAD']);
  let outcome;
  try {
    outcome = dictate(range.commits, range.baseParent, id, key);
  } catch (e) {
    return fail(e.message, { branch, mode: range.mode, oldHead, partial: true });
  }

  // 带 oldvalue 的 CAS 更新，避免并发下误覆盖。
  try {
    git(['update-ref', 'refs/heads/' + branch, outcome.newHead, oldHead]);
  } catch (e) {
    return fail('更新分支指针失败：' + (e.stderr || e.message), { branch, oldHead, newHead: outcome.newHead });
  }

  const allSigned = outcome.results.every((r) => r.sigAfter === 'G' || r.sigAfter === 'U');
  const totalCoAuthors = outcome.results.reduce((s, r) => s + r.coAuthorsRemoved, 0);

  emit({
    success: true, branch, mode: range.mode, upstream: range.upstream || null,
    identity: name + ' <' + email + '>', idFromGlobal,
    signingKey: key || '(git 默认)',
    oldHead, newHead: outcome.newHead, count: outcome.results.length,
    allSigned, totalCoAuthorsRemoved: totalCoAuthors,
    workingTreeDirty, warning: range.warning || null,
    results: outcome.results,
    rollback: 'git reset --hard ' + oldHead,
    pushHint: range.mode === 'unpushed'
      ? 'git push --force-with-lease'
      : 'git push --force-with-lease（历史已重写，需强制推送）',
  });
}

try { main(); }
catch (e) { fail((e && e.message) || e); }
