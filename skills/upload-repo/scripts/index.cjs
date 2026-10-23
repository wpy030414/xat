#!/usr/bin/env node
'use strict';
/**
 * upload-repo 的确定性内核（本地编排器）。
 *
 * 为什么要有这个文件：SKILL.md 原先把 8 个步骤全写成「给 AI 的指令」，但其中真正
 * 需要判断的只有三处 —— 远程工作区脏了怎么办 / 多个同名候选选哪个 / 同源仓库要不要
 * 覆盖。其余都是机械动作：拆 user@host、探连通性、打 bundle、scp、探测目录状态、
 * 拼 CI 命令。机械动作让模型每次现推，代价是每次都可能把引号拼错、把退出码读错，
 * 而且错了要从头重来。
 *
 * 所以分工是：机械部分写死在这里，判断点用 exit 3 + status:"needs_input" 显式抛回，
 * SKILL.md 只负责「问用户」和「把结果讲清楚」——那两件才是模型真正擅长的。
 *
 * 两条硬约定：
 *   1. stdout 只有一个 JSON 对象（日志也塞进 JSON 字段），方便上游解析。
 *   2. 密码只从环境变量 SSHPASS 读，不接受命令行参数 —— argv 会进 ps 和 shell history。
 *
 * 退出码：0 成功 / 1 失败 / 2 用法错误 / 3 需要用户决策。
 *
 * 扩展名是 `.cjs` 而非 `.js`：`.js` 的模块系统由上层最近的 package.json 的 `"type"`
 * 决定，而这个仓库随时可能加进 package.json；同目录的 `actions/` 也全是 `.cjs`，
 * 统一起来就不必向后来的人解释「这两种其实有差」。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

/* ───────────────────────── 常量与类型 ───────────────────────── */

// 非交互连接：跳过指纹确认、限时建连。`-T` 是必须的——脚本走 stdin，
// 不申请 pty 才能让 `bash -s` 干净地读到它，否则 ssh 会先抱怨一句
// 「Pseudo-terminal will not be allocated」，把这条警告混进 stderr 干扰判错。
const SSH_OPTS = ['-o', 'StrictHostKeyChecking=no', '-o', 'ConnectTimeout=10', '-T'];

// scp 不加 -T：老版本 scp 对它有自己的解释（关闭文件名严格检查），不是同一个意思。
const SCP_OPTS = ['-o', 'StrictHostKeyChecking=no', '-o', 'ConnectTimeout=10'];

// 远程探针/扫描的超时。给得比 ConnectTimeout 宽松，是为了让慢一点但没死的
// `find /home -maxdepth 4` 跑完——那个扫描在存储慢的机器上确实可能十几秒。
const T = { probe: 60_000, scan: 120_000, deploy: 300_000 };

const EXIT = { ok: 0, fail: 1, usage: 2, needsInput: 3 };

class UsageError extends Error {}

/* ───────────────────────── 进程执行 ───────────────────────── */

/**
 * 同步执行一条命令。统一收口的好处是：失败时「带退code + stderr 尾部」这件事
 * 只实现一次，各处不必再各写一遍 r.status !== 0 的判断。
 */
function exec(cmd, args, opts) {
  const o = opts || {};
  const r = spawnSync(cmd, args, {
    cwd: o.cwd,
    input: o.input,
    timeout: o.timeout,
    encoding: 'utf8',
    env: { ...process.env, ...(o.env || {}) },
  });
  // spawnSync 自身失败（ENOENT、超时被杀）时 status 为 null，必须显式说明，
  // 否则会被误读成「命令成功退出但没输出」。
  const timedOut = r.error && r.error.code === 'ETIMEDOUT';
  return {
    cmd: [cmd, ...(args || [])].join(' '),
    ok: !r.error && r.status === 0,
    code: r.error ? (timedOut ? 'TIMEOUT' : r.error.code || 'EXEC_ERROR') : r.status,
    stdout: r.stdout || '',
    stderr: r.stderr || (r.error ? String(r.error.message) : ''),
  };
}

function execAsync(cmd, args, opts) {
  const o = opts || {};
  return new Promise((resolve) => {
    const p = spawn(cmd, args, {
      cwd: o.cwd,
      timeout: o.timeout,
      env: { ...process.env, ...(o.env || {}) },
    });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => (stdout += d));
    p.stderr.on('data', (d) => (stderr += d));
    p.on('error', (err) => resolve({ ok: false, code: err.code || 'EXEC_ERROR', stdout, stderr }));
    p.on('close', (code) => resolve({ ok: code === 0, code, stdout, stderr }));
    if (o.input) p.stdin.write(o.input);
    p.stdin.end();
  });
}

/** POSIX 单引号转义。空串、空格、单引号都必须能原样穿过。 */
function shq(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function tail(text, n) {
  return String(text || '')
    .trimEnd()
    .split('\n')
    .slice(-n)
    .join('\n');
}

/* ───────────────────────── 参数解析 ───────────────────────── */

const USAGE = `用法：
  node index.cjs deploy <user@host> [选项]
  node index.cjs lint [工作流目录]     只解析 .xat/workflows，不连服务器、不改任何东西

选项：
  -p, --dir <path>        服务器上的部署目录（默认 ~/.xat-deploy/<仓库名>）
      --use <path>        跳过扫描，直接使用该远程路径
      --create            跳过扫描，在目标路径全新部署
      --dirty <overwrite|abort|ask>   远程有未提交改动时怎么办（默认 ask）
      --multi <newest|ask>            多个同名候选时怎么办（默认自动：明显更新则取最新）
      --skip-ci           部署后不执行 .xat/workflows
      --keep              保留 bundle（本地与远程），便于排查
      --dry-run           只输出将执行的步骤，不连服务器、不改任何东西
  -h, --help

密码从环境变量 SSHPASS 读取，不接受命令行参数：
  SSHPASS='xxx' node index.cjs deploy root@example.xrl.im

退出码：0 成功 / 1 失败（lint 时表示有告警）/ 2 用法错误 / 3 需要用户决策`;

const VALUE_FLAGS = new Set(['dir', 'p', 'use', 'dirty', 'multi']);
const BOOL_FLAGS = new Set(['create', 'skip-ci', 'keep', 'dry-run', 'help', 'h']);
const COMMANDS = new Set(['deploy', 'lint']);

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!command || command === '-h' || command === '--help') return { command: 'help' };
  if (!COMMANDS.has(command)) throw new UsageError(`未知命令：${command}（可用：deploy / lint）`);

  const opts = { command, _argv: argv };
  const positional = [];

  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--') {
      positional.push(...rest.slice(i + 1));
      break;
    }
    if (!a.startsWith('-')) {
      positional.push(a);
      continue;
    }
    const key = a.replace(/^--?/, '');
    if (BOOL_FLAGS.has(key)) {
      opts[camel(key)] = true;
      continue;
    }
    if (!VALUE_FLAGS.has(key)) throw new UsageError(`无法识别的参数：${a}`);
    const val = rest[i + 1];
    if (val === undefined || val.startsWith('-')) throw new UsageError(`${a} 缺少值`);
    opts[camel(key)] = val;
    i++;
  }

  if (opts.h || opts.help) return { command: 'help' };

  // lint 的位置参数是「工作流目录」，可省略
  if (command === 'lint') {
    if (positional.length > 1) throw new UsageError(`lint 只接受一个目录参数（收到 ${positional.length} 个）`);
    opts.workflowDir = positional[0];
    return opts;
  }

  // 严格 user@host：不再接受 `username host` 两个位置参数。
  // 多出来的位置参数直接拒绝，而不是猜哪个是密码——猜错的后果是把密码当主机名去连。
  if (positional.length === 0) throw new UsageError('缺少目标地址：需写成 user@host，例如 root@example.xrl.im');
  if (positional.length > 1) {
    throw new UsageError(
      `多余的参数：${positional.slice(1).join(' ')}。地址只接受 user@host 一种形式；` +
        '密码请放进环境变量 SSHPASS',
    );
  }

  opts.target = parseTarget(positional[0]);
  opts.dir = opts.dir || opts.p;
  delete opts.p;

  if (opts.dirty && !['overwrite', 'abort', 'ask'].includes(opts.dirty)) {
    throw new UsageError(`--dirty 只能是 overwrite / abort / ask（收到 ${opts.dirty}）`);
  }
  if (opts.multi && !['newest', 'ask'].includes(opts.multi)) {
    throw new UsageError(`--multi 只能是 newest / ask（收到 ${opts.multi}）`);
  }
  return opts;
}

function camel(s) {
  return s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

/**
 * 只认 `user@host`。第一个参数不含 @ 一律判格式错误，绝不回退去把下一个参数当 host——
 * 那种「智能补全」在用户手滑少打一个 @ 时会静默连到一台不同的机器上。
 */
function parseTarget(s) {
  if (!s) throw new UsageError('缺少目标地址：需写成 user@host，例如 root@example.xrl.im');
  const at = s.indexOf('@');
  if (at < 0) {
    throw new UsageError(`地址参数需写成 user@host，例如 root@example.xrl.im（收到 ${s}）`);
  }
  const user = s.slice(0, at);
  const host = s.slice(at + 1);
  if (!user) throw new UsageError('请在 @ 前补上用户名');
  if (!host) throw new UsageError('请在 @ 后补上服务器地址');
  if (host.includes('@')) throw new UsageError(`地址里出现了多余的 @：${s}`);
  return { user, host, text: `${user}@${host}` };
}

/* ───────────────────────── 仓库上下文 ───────────────────────── */

function git(args, cwd) {
  return exec('git', args, { cwd });
}

/**
 * 读一次仓库上下文。分支名既是 bundle 的 ref，也是远端 reset 的目标，
 * 所以 detached HEAD 必须在这里挡住——让人先切分支，比在远端 reset 到
 * 一个游离提交上要安全得多。
 */
function repoContext() {
  const top = git(['rev-parse', '--show-toplevel']);
  if (!top.ok) {
    return {
      error: {
        code: 'NOT_A_REPO',
        message: '当前目录不是 git 仓库',
        hint: '请在项目根目录下运行，或先 git init',
      },
    };
  }
  const root = top.stdout.trim();

  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], root);
  if (!branch.ok) {
    return { error: { code: 'NO_HEAD', message: branch.stderr.trim() || '无法读取当前分支', hint: '确认仓库至少有一次提交' } };
  }
  const name0 = branch.stdout.trim();
  if (name0 === 'HEAD') {
    return {
      error: {
        code: 'DETACHED_HEAD',
        message: '当前处于 detached HEAD 状态',
        hint: '先切换到具体分支（如 git checkout main）再部署，避免把游离提交推上线',
      },
    };
  }

  const gitDir = git(['rev-parse', '--absolute-git-dir'], root);
  return {
    root,
    branch: name0,
    repoName: path.basename(root),
    gitDir: gitDir.ok ? gitDir.stdout.trim() : path.join(root, '.git'),
  };
}

/* ───────────────────────── SSH 层 ───────────────────────── */

function hasSshpass() {
  const r = exec('sshpass', ['-V']);
  return !r.code || r.code === 1; // sshpass -V 在老版本上退出码不稳定，能跑起来就算有
}

function sshArgv(t, usePass, extra) {
  const base = usePass ? ['sshpass', '-e', 'ssh'] : ['ssh'];
  return [...base, ...SSH_OPTS, ...(extra || []), t.text];
}

function scpArgv(t, usePass) {
  const base = usePass ? ['sshpass', '-e', 'scp'] : ['scp'];
  return [...base, ...SCP_OPTS];
}

/** 远端执行：脚本走 stdin（bash -s），彻底绕开「双引号里再套单引号」这个老坑。 */
function remote(t, ctx, script, opts) {
  const o = opts || {};
  const argv = sshArgv(t, ctx.usePass, ['bash -s']);
  return exec(argv[0], argv.slice(1), {
    input: script,
    timeout: o.timeout || T.probe,
    env: ctx.usePass ? { SSHPASS: ctx.password } : {},
  });
}

function remoteAsync(t, ctx, script, opts) {
  const o = opts || {};
  const argv = sshArgv(t, ctx.usePass, ['bash -s']);
  return execAsync(argv[0], argv.slice(1), {
    input: script,
    timeout: o.timeout || T.deploy,
    env: ctx.usePass ? { SSHPASS: ctx.password } : {},
  });
}

/**
 * ssh 的失败原因要分类，不能一律报「认证失败」。实际用下来最常见的失败根本不是
 * 认证问题，而是地址拼错、端口没开——把这两类混成「密码不对」会让用户去改密码，
 * 白费半天。
 */
function classifySshFailure(stderr) {
  const s = String(stderr || '');
  if (/Could not resolve hostname|Name or service not known/i.test(s)) {
    return { code: 'HOST_UNREACHABLE', message: '主机名解析失败', hint: '检查地址是否拼错，或本机 DNS' };
  }
  if (/Connection refused/i.test(s)) {
    return { code: 'HOST_UNREACHABLE', message: '连接被拒绝', hint: '确认 sshd 在跑、22 端口对当前网络开放' };
  }
  if (/Connection timed out|Operation timed out/i.test(s)) {
    return { code: 'HOST_UNREACHABLE', message: '连接超时', hint: '防火墙 / 安全组 / 地址不可达' };
  }
  if (/Permission denied/i.test(s)) {
    return { code: 'AUTH_FAILED', message: '认证被拒绝', hint: '用户名、密码或公钥至少有一项不对' };
  }
  return null;
}

/**
 * 建连并选定认证方式。顺序是 key → 密码 → 配免密，和原文档一致：
 * 先试 key 是因为它无副作用；只有 key 不通才用密码，且用完顺手把公钥装上，
 * 下次就不用再传密码。
 */
function connect(t, password, log) {
  const ctx = { password, usePass: false };

  const keyArgv = sshArgv(t, false, ['-o', 'BatchMode=yes']);
  const keyTry = exec(keyArgv[0], keyArgv.slice(1), {
    input: 'echo SSH_OK\necho "##HOME=$HOME"\n',
    timeout: T.probe,
  });
  if (keyTry.stdout.includes('SSH_OK')) {
    ctx.method = 'key';
    ctx.home = marker(keyTry.stdout, 'HOME');
    log.push('SSH 密钥认证成功');
    return { ctx };
  }

  if (!password) {
    return {
      error: classifySshFailure(keyTry.stderr) || {
        code: 'AUTH_FAILED',
        message: 'SSH 密钥认证失败，且未提供密码',
        hint: '设置 SSHPASS 环境变量重试，或先把本机公钥装到服务器',
      },
      detail: tail(keyTry.stderr, 6),
    };
  }

  if (!hasSshpass()) {
    return {
      error: {
        code: 'NO_SSHPASS',
        message: '本机未安装 sshpass，无法用密码认证',
        hint: 'macOS: brew install sshpass（或 hudochenkov/sshpass tap）；Debian/Ubuntu: apt install sshpass',
      },
    };
  }

  ctx.usePass = true;
  const passTry = remote(t, ctx, 'echo SSH_OK\necho "##HOME=$HOME"\n');
  if (!passTry.stdout.includes('SSH_OK')) {
    return {
      error: classifySshFailure(passTry.stderr) || {
        code: 'AUTH_FAILED',
        message: '密钥和密码认证均失败',
        hint: '确认用户名、地址与密码',
      },
      detail: tail(passTry.stderr, 6),
    };
  }
  ctx.method = 'password';
  ctx.home = marker(passTry.stdout, 'HOME');
  log.push('SSH 密码认证成功');
  return { ctx };
}

/** 密码认证成功后装公钥。失败不阻塞部署——只是下次还得输密码。 */
function installKey(t, ctx, log) {
  if (ctx.method !== 'password') return { status: '跳过（本次用密钥）' };

  const pub = ['id_ed25519.pub', 'id_rsa.pub']
    .map((f) => path.join(os.homedir(), '.ssh', f))
    .find((p) => fs.existsSync(p));
  if (!pub) {
    log.push('本机无 SSH 公钥，跳过免密配置');
    return { status: '跳过（无本机公钥）' };
  }

  const key = fs.readFileSync(pub, 'utf8').trim();
  const check = remote(
    t,
    ctx,
    `mkdir -p "$HOME/.ssh" && chmod 700 "$HOME/.ssh"\n` +
      `grep -qF ${shq(key)} "$HOME/.ssh/authorized_keys" 2>/dev/null && echo EXISTS || echo NOT_FOUND\n`,
  );
  if (check.stdout.includes('EXISTS')) {
    log.push('服务器已存在本机公钥');
    return { status: '已存在' };
  }

  const add = remote(
    t,
    ctx,
    `mkdir -p "$HOME/.ssh" && chmod 700 "$HOME/.ssh" && ` +
      `echo ${shq(key)} >> "$HOME/.ssh/authorized_keys" && chmod 600 "$HOME/.ssh/authorized_keys" && echo KEY_ADDED\n`,
  );
  if (add.stdout.includes('KEY_ADDED')) {
    log.push('已配置 SSH 免密登录');
    return { status: '已配置' };
  }
  log.push('免密配置失败（非致命）');
  return { status: '失败（非致命）' };
}

function marker(out, name) {
  const m = new RegExp(`^##${name}=(.*)$`, 'm').exec(String(out || ''));
  return m ? m[1].trim() : '';
}

/* ───────────────────────── bundle 与上传 ───────────────────────── */

function createBundle(ctx, log) {
  const file = path.join(os.tmpdir(), `${ctx.repoName}.bundle`);
  const r = git(['bundle', 'create', file, ctx.branch], ctx.root);
  if (!r.ok) {
    return {
      error: {
        code: 'BUNDLE_FAILED',
        message: `git bundle 创建失败：${tail(r.stderr, 3) || '未知原因'}`,
        hint: '确认当前分支至少有一次提交，且工作区没有把 .git 锁住',
      },
    };
  }
  const size = fs.statSync(file).size;
  log.push(`bundle 已生成（${human(size)}）`);
  return { file, size };
}

function upload(t, ctx, bundle, log) {
  const remoteDir = '.xat-deploy';
  const mk = remote(t, ctx, `mkdir -p "$HOME/${remoteDir}" && echo READY\n`);
  if (!mk.stdout.includes('READY')) {
    return { error: { code: 'REMOTE_MKDIR_FAILED', message: '无法创建远程 ~/.xat-deploy', detail: tail(mk.stderr, 6) } };
  }

  const dest = `${ctx.home}/.xat-deploy/${ctx.repoName}.bundle`;
  const argv = scpArgv(t, ctx.usePass);
  const r = exec(argv[0], [...argv.slice(1), bundle.file, `${t.text}:${dest}`], {
    timeout: T.deploy,
    env: ctx.usePass ? { SSHPASS: ctx.password } : {},
  });
  if (!r.ok) {
    return { error: { code: 'UPLOAD_FAILED', message: 'scp 上传 bundle 失败', detail: tail(r.stderr, 6) } };
  }
  log.push(`bundle 已上传到 ${dest}`);
  return { dest };
}

/* ───────────────────────── 远程状态探测 ───────────────────────── */

/**
 * 一次 SSH 拿全目标目录的所有状态。合并成一次连接不只是省时间：
 * 分多次探测时，两次之间目录可能被别的东西改了，读到的是不一致的快照。
 */
function probePath(t, ctx, remotePath) {
  const script = `
p=${shq(remotePath)}
if [ -d "$p" ]; then echo "##DIR=1"; else echo "##DIR=0"; exit 0; fi
if [ -e "$p/.git" ]; then echo "##GIT=1"; else echo "##GIT=0"; fi
e=$(ls -A "$p" 2>/dev/null | head -1)
if [ -z "$e" ]; then echo "##EMPTY=1"; else echo "##EMPTY=0"; fi
cd "$p" 2>/dev/null || exit 0
bare=$(git rev-parse --is-bare-repository 2>/dev/null || echo unknown)
echo "##BARE=$bare"
br=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo none)
echo "##BRANCH=$br"
echo "##DIRTY_BEGIN"
git status --porcelain 2>/dev/null | head -50
echo "##DIRTY_END"
`;
  const r = remote(t, ctx, script, { timeout: T.probe });
  if (r.code === 'TIMEOUT') {
    return { error: { code: 'PROBE_TIMEOUT', message: `探测 ${remotePath} 超时`, hint: '服务器无响应或该路径在挂载卡住的设备上' } };
  }

  const head = marker(r.stdout, 'DIR');
  const dirtyBlock = /##DIRTY_BEGIN\n([\s\S]*?)##DIRTY_END/.exec(r.stdout);
  const dirtyLines = dirtyBlock ? dirtyBlock[1].split('\n').filter(Boolean) : [];

  return {
    path: remotePath,
    exists: head === '1',
    isGit: marker(r.stdout, 'GIT') === '1',
    empty: marker(r.stdout, 'EMPTY') === '1',
    bare: marker(r.stdout, 'BARE'),
    branch: marker(r.stdout, 'BRANCH'),
    dirty: dirtyLines,
  };
}

/**
 * 把探测结果翻译成「结论」。这段是纯函数，因为它是整个流程里最容易写错、
 * 也最值得被测试覆盖的部分——四种状态组合各自的处理策略差别很大。
 */
function classifyRemote(p) {
  if (!p.exists) return { kind: 'absent' };
  if (!p.isGit) return p.empty ? { kind: 'empty-dir' } : { kind: 'occupied' };
  if (p.bare === 'true') return { kind: 'bare' };
  if ((p.dirty || []).length) return { kind: 'dirty', dirty: p.dirty };
  return { kind: 'repo', branch: p.branch };
}

/* ───────────────────────── 多候选选择 ───────────────────────── */

/**
 * 候选选择。规则取自原文档但收紧了默认值：只有「最新那个比其余的领先一天以上」
 * 才敢自动选；差距小时人的意图不明，宁可多问一句，也不要覆盖错目录。
 */
function chooseCandidate(candidates, mode, now) {
  const list = [...candidates].sort((a, b) => b.mtime - a.mtime);
  if (list.length === 0) return { kind: 'none' };
  if (list.length === 1) return { kind: 'pick', candidate: list[0], reason: '唯一候选' };
  if (mode === 'newest') return { kind: 'pick', candidate: list[0], reason: '--multi newest' };

  const t0 = now || Date.now() / 1000;
  const gap = list[0].mtime - list[1].mtime;
  if (gap > 86400 && list[0].mtime <= t0 + 86400) {
    return { kind: 'pick', candidate: list[0], reason: `最新一个领先 ${Math.round(gap / 86400)} 天` };
  }
  return { kind: 'ask', candidates: list };
}

function parseFindOutput(stdout) {
  const seen = new Map();
  for (const line of String(stdout || '').split('\n')) {
    const m = /^(\d+(?:\.\d+)?)\t(.+)$/.exec(line.trim());
    if (!m) continue;
    const p = m[2];
    if (!seen.has(p)) seen.set(p, { path: p, mtime: Number(m[1]) });
  }
  return [...seen.values()];
}

/* ───────────────────────── 远程 URL 归一化 ───────────────────────── */

/**
 * 同一个仓库可以有五种写法：https://host/a/b.git、git@host:a/b、ssh://git@host:22/a/b…。
 * 判同源时逐字比较毫无意义，必须归一到 host + path。
 */
function normalizeRemoteUrl(url) {
  let s = String(url || '').trim();
  if (!s) return '';
  s = s.replace(/\.git$/, '').replace(/\/+$/, '');

  let host = '';
  let p = '';
  let m;

  if ((m = /^[a-z+]+:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/i.exec(s))) {
    host = m[1];
    p = m[2];
  } else if ((m = /^(?:[^@/]+@)([^:/]+):(?:(\d+):)?(.+)$/.exec(s))) {
    // scp 风格 git@host:path，也容忍 git@host:2222:path 这种端口写法
    host = m[1];
    p = m[3];
  } else {
    return s.toLowerCase();
  }

  return `${host.toLowerCase()}/${p.replace(/^\/+/, '').toLowerCase()}`;
}

/* ───────────────────────── 工作流解析 ───────────────────────── */

/**
 * 只解析 .xat/workflows 用到的那一小撮 YAML：顶层 steps 数组，每项是
 * `uses`（工件）或 `name` + `run`（命令），run 支持 `|` / `>` 块标量，
 * with 支持嵌套映射和 `{ a: b }` 内联映射。
 *
 * 为什么不引 yaml 库：这个脚本要能直接在裸机上 `node` 跑起来，装依赖就失去意义了。
 * 代价是只认这个子集——遇到不认识的写法必须显式告警，不能静默丢掉一个步骤
 * 然后报告「全部通过」。
 */
function parseWorkflow(text) {
  const lines = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/);
  const warnings = [];
  const start = lines.findIndex((l) => /^\s*steps\s*:/.test(l));
  if (start < 0) return { steps: [], warnings: ['未找到顶层 steps 数组'] };

  const baseIndent = indentOf(lines[start]);
  const steps = [];
  let i = start + 1;

  while (i < lines.length) {
    const raw = lines[i];
    if (!raw.trim() || /^\s*#/.test(raw)) {
      i++;
      continue;
    }
    const ind = indentOf(raw);
    // steps 数组结束：回到顶层键。注意列表也允许顶格写（`steps:` 下一行直接 `- `），
    // 所以「缩进等于 baseIndent」只有在不是列表项时才代表数组结束。
    if (ind < baseIndent) break;
    if (ind === baseIndent && !/^\s*-(\s|$)/.test(raw)) break;
    if (!/^\s*-(\s|$)/.test(raw)) {
      warnings.push(`忽略无法解析的行（第 ${i + 1} 行）：${raw.trim()}`);
      i++;
      continue;
    }

    const itemIndent = ind;
    const block = [];
    const first = /^\s*-\s*(.*)$/.exec(raw);
    if (first && first[1].trim()) {
      block.push({ indent: itemIndent + 2, raw: first[1], text: first[1].trim() });
    }

    let j = i + 1;
    for (; j < lines.length; j++) {
      const l = lines[j];
      if (!l.trim()) {
        block.push({ indent: Infinity, raw: '', text: '' });
        continue;
      }
      const li = indentOf(l);
      if (li <= itemIndent) {
        // 容错：手写 YAML 常把字段写在和 `-` 同一列。这不是合法 YAML，但很常见，
        // 而「少跑一个步骤」比「报错」危险得多——所以接受并告警，不静默丢弃。
        // 只接受单行的 uses/run/name：`with:` 和 `run: |` 缩进一错就是无法消解的歧义。
        if (li === itemIndent) {
          const body = l.trimStart();
          const m = /^(uses|run|name)\s*:(.*)$/.exec(body);
          if (m && m[2].trim() && !/^[|>]/.test(m[2].trim())) {
            warnings.push(`第 ${j + 1} 行与「-」同列，已按上一步骤的字段处理（建议缩进两个空格）`);
            block.push({ indent: itemIndent + 2, raw: ' '.repeat(itemIndent + 2) + body, text: body });
            continue;
          }
        }
        break;
      }
      block.push({ indent: li, raw: l, text: l.trim() });
    }

    const map = parseBlockMap(block, warnings, i + 1);
    if (map.uses && map.run !== undefined) {
      warnings.push(`第 ${i + 1} 行同时写了 uses 和 run，按规则取 uses`);
    }
    if (!map.uses && typeof map.run !== 'string') {
      warnings.push(`第 ${i + 1} 行的步骤既没有 uses 也没有 run，已跳过`);
      i = j;
      continue;
    }
    steps.push({
      index: steps.length,
      uses: map.uses,
      // uses 优先：两者同时存在时把 run 丢掉，而不是留着让下游再去选一次
      run: map.uses ? undefined : typeof map.run === 'string' ? map.run : undefined,
      name: map.name,
      with: map.with && typeof map.with === 'object' ? map.with : undefined,
    });
    i = j;
  }

  return { steps, warnings };
}

function indentOf(line) {
  return line.length - line.trimStart().length;
}

function parseBlockMap(block, warnings, lineNo) {
  const map = {};
  const real = block.filter((e) => e.indent !== Infinity);
  const base = real.length ? Math.min(...real.map((e) => e.indent)) : 0;

  let k = 0;
  while (k < block.length) {
    const entry = block[k];
    if (!entry.text) {
      k++;
      continue;
    }
    if (entry.indent !== base) {
      warnings.push(`第 ${lineNo} 行附近缩进不一致，已忽略：${entry.text}`);
      k++;
      continue;
    }
    const m = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(entry.text);
    if (!m) {
      warnings.push(`第 ${lineNo} 行附近无法解析：${entry.text}`);
      k++;
      continue;
    }
    const key = m[1];
    const value = m[2].trim();

    // 块标量：| 保留换行，> 折叠为空格；+/- 只影响末尾空行，这里不需要
    if (/^[|>][+-]?\s*(#.*)?$/.test(value)) {
      const chunk = [];
      let k2 = k + 1;
      for (; k2 < block.length; k2++) {
        const e2 = block[k2];
        if (e2.text && e2.indent <= base) break;
        chunk.push(e2);
      }
      map[key] = blockScalar(chunk, value[0] === '>');
      k = k2;
      continue;
    }

    // 空值 = 下一层是映射（with:）或空
    if (value === '' || value.startsWith('#')) {
      const nested = {};
      let k2 = k + 1;
      for (; k2 < block.length; k2++) {
        const e2 = block[k2];
        if (!e2.text) continue;
        if (e2.indent <= base) break;
        const nm = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(e2.text);
        if (nm) nested[nm[1]] = unquote(nm[2]);
        else warnings.push(`第 ${lineNo} 行附近无法解析 with 项：${e2.text}`);
      }
      map[key] = Object.keys(nested).length ? nested : '';
      k = k2;
      continue;
    }

    if (value.startsWith('{')) {
      map[key] = parseInlineMap(value, warnings, lineNo);
      k++;
      continue;
    }

    map[key] = unquote(value);
    k++;
  }
  return map;
}

/**
 * `with: { name: momoi }`。只处理扁平的 `k: v` 与逗号分隔，
 * 嵌套的内联映射不支持——遇到就告警，让人改成缩进写法。
 */
function parseInlineMap(value, warnings, lineNo) {
  const inner = value.replace(/^\{/, '').replace(/\}$/, '');
  const out = {};
  for (const part of inner.split(',')) {
    const m = /^\s*([A-Za-z0-9_-]+)\s*:\s*(.*?)\s*$/.exec(part);
    if (!m) {
      if (part.trim()) warnings.push(`第 ${lineNo} 行附近无法解析内联映射项：${part.trim()}`);
      continue;
    }
    out[m[1]] = unquote(m[2]);
  }
  return out;
}

/**
 * 块标量取值。必须按「最小缩进」统一裁掉前缀而不是 trim()：
 * run 里常写 if/then/for，trim 会把相对缩进压平，脚本语义就变了。
 */
function blockScalar(chunk, folded) {
  const body = chunk.filter((e) => e.text);
  if (!body.length) return '';
  const cut = Math.min(...body.map((e) => indentOf(e.raw)));
  const lines = chunk.map((e) => (e.text ? e.raw.slice(cut) : ''));
  const text = folded
    ? lines
        .join('\n')
        .replace(/\n(?![ \t])/g, ' ')
        .trim()
    : lines.join('\n');
  return folded ? text : text.replace(/\n+$/, '\n');
}

function unquote(s) {
  const t = String(s || '').trim();
  if (t.length >= 2 && ((t[0] === '"' && t.at(-1) === '"') || (t[0] === "'" && t.at(-1) === "'"))) {
    return t.slice(1, -1).replace(/\\"/g, '"');
  }
  return t;
}

/* ───────────────────────── 主流程 ───────────────────────── */

async function deploy(opts) {
  const t = opts.target;
  const log = [];
  const password = process.env.SSHPASS || '';

  /* 1. 仓库上下文 */
  const repo = repoContext();
  if (repo.error) return fail(repo.error);

  if (opts.dryRun) return dryRun(opts, repo, password);

  /* 2. 建连 */
  const conn = connect(t, password, log);
  if (conn.error) return fail(conn.error, { detail: conn.detail, log });
  const ctx = { ...conn.ctx, ...repo };
  // 远端 HOME 没读到时的兜底：宁可退回约定路径，也不要拼出 `/ .xat-deploy/...`
  ctx.home = ctx.home || `/home/${t.user}`;
  const home = ctx.home;

  const keys = installKey(t, ctx, log);

  /* 3. bundle */
  const bundle = createBundle(ctx, log);
  if (bundle.error) return fail(bundle.error, { log });

  /* 4. 上传 */
  const up = upload(t, ctx, bundle, log);
  if (up.error) {
    if (!opts.keep) safeUnlink(bundle.file);
    return fail(up.error, { log });
  }

  const defaultPath = `${home}/.xat-deploy/${ctx.repoName}`;
  const resolved = resolvePath(opts.dir, home, defaultPath);

  /* 5. 定位目标目录（扫描 / 决策） */
  const decision = locateTarget(t, ctx, opts, resolved, log);
  if (decision.error) return failCleanup(decision.error, opts, bundle, log);
  if (decision.needsInput) return needsInput(decision, opts, log);

  /* 6. 部署 */
  const deployed = applyDeploy(t, ctx, decision, bundle.dest, log);
  if (deployed.error) return failCleanup(deployed.error, opts, bundle, log);

  /* 7. CI/CD */
  let ci = { files: [], note: '无工作流配置' };
  if (!opts.skipCi) {
    ci = await runWorkflows(t, ctx, decision.path, ctx.repoName, log);
  }

  /* 8. 清理 */
  if (!opts.keep) {
    safeUnlink(bundle.file);
    const rm = remote(t, ctx, `rm -f ${shq(bundle.dest)} && echo CLEANED\n`);
    if (rm.stdout.includes('CLEANED')) log.push('已清理本地与远程 bundle');
    else log.push('清理远程 bundle 失败（非致命）');
  }

  /* 9. 汇总 */
  const summary = {
    repo: ctx.repoName,
    branch: ctx.branch,
    bundle: human(bundle.size),
    ssh: ctx.method === 'key' ? '密钥' : '密码',
    keyInstall: keys.status,
    strategy: decision.strategy,
    action: deployed.action,
    remotePath: decision.path,
    ci: ciSummary(ci),
  };

  return {
    status: 'ok',
    summary,
    table: summaryTable(summary),
    log,
    ci: {
      files: ci.files,
      note: ci.note,
      // 只要有一个工作流失败，就单独抬到顶层：这是需要人马上看一眼的信号，
      // 混在 files 里容易被一句「部署成功」盖过去。
      failed: ci.files.filter((f) => !f.ok).map((f) => f.file),
    },
  };
}

/**
 * 定位目标。四层降级：显式路径 → 同名扫描 → 同源扫描 → 全新部署。
 * 这里只负责「找」，不负责「改」——所以任何不确定都返回 needsInput，
 * 让上层去问，而不是在这里猜。
 */
function locateTarget(t, ctx, opts, resolved, log) {
  // --use / --create 直接跳过扫描：用户已经说了答案，再扫一遍只会制造困惑
  if (opts.use) return decideForPath(t, ctx, opts, resolvePath(opts.use, ctx.home, opts.use), log, '指定路径');
  if (opts.create) {
    const p = probePath(t, ctx, resolved);
    if (p.error) return { error: p.error };
    if (p.exists && !p.isGit && !p.empty) {
      return {
        error: {
          code: 'PATH_OCCUPIED',
          message: `${resolved} 已存在且非空，不是 git 仓库`,
          hint: '换一个 -p 路径，或先自行处理该目录',
        },
      };
    }
    if (p.exists && p.isGit) {
      return {
        error: {
          code: 'PATH_IS_REPO',
          message: `${resolved} 已经是一个 git 仓库`,
          hint: '你要的可能是更新（去掉 --create 重新运行）',
        },
      };
    }
    return { path: resolved, mode: 'create', strategy: '5d:全新部署' };
  }

  // 5a（仅在显式给了 -p 时）：尊重用户指定的路径，不做扫描
  if (opts.dir) {
    log.push(`使用指定路径 ${resolved}，跳过自动扫描`);
    return decideForPath(t, ctx, opts, resolved, log, '5a:精确路径');
  }

  // 5b：同名目录扫描
  const found = scanByName(t, ctx, ctx.repoName);
  if (found.error) return { error: found.error };
  const pick = chooseCandidate(found.candidates, opts.multi || 'auto');
  if (pick.kind === 'pick') {
    log.push(`5b 命中：${pick.candidate.path}（${pick.reason}）`);
    return decideForPath(t, ctx, opts, pick.candidate.path, log, '5b:文件名扫描');
  }
  if (pick.kind === 'ask') {
    return {
      needsInput: {
        code: 'AMBIGUOUS_NAME_MATCH',
        question: `服务器上发现 ${pick.candidates.length} 个同名仓库，修改时间接近，选哪个？`,
        candidates: pick.candidates.map((c) => ({ path: c.path, mtime: iso(c.mtime) })),
        options: [
          ...pick.candidates.map((c) => ({ label: c.path, flag: ['--use', c.path] })),
          { label: '都不是，全新部署', flag: ['--create'] },
        ],
      },
    };
  }

  // 5c：同源扫描（目录被改过名）
  const origin = git(['remote', 'get-url', 'origin'], ctx.root);
  if (origin.ok && origin.stdout.trim()) {
    const same = scanByOrigin(t, ctx, origin.stdout.trim());
    if (same.error) return { error: same.error };
    const chosen = chooseCandidate(same.candidates, opts.multi || 'auto');
    if (chosen.kind === 'pick') {
      return {
        needsInput: {
          code: 'ORIGIN_MATCH_NEEDS_CONFIRM',
          question:
            `5b 未命中，但发现同源仓库：${chosen.candidate.path}` +
            `（目录名已变更，origin 一致）。要在这里更新吗？`,
          candidates: [{ path: chosen.candidate.path, origin: origin.stdout.trim() }],
          options: [
            { label: `确认更新 ${chosen.candidate.path}`, flag: ['--use', chosen.candidate.path] },
            { label: `全新部署到 ${resolved}`, flag: ['--create'] },
          ],
        },
      };
    }
    if (chosen.kind === 'ask') {
      return {
        needsInput: {
          code: 'ORIGIN_MATCH_NEEDS_CONFIRM',
          question: `发现多个同源仓库，选哪个？`,
          candidates: chosen.candidates.map((c) => ({
            path: c.path,
            mtime: iso(c.mtime),
            origin: origin.stdout.trim(),
          })),
          options: [
            ...chosen.candidates.map((c) => ({ label: c.path, flag: ['--use', c.path] })),
            { label: '全新部署', flag: ['--create'] },
          ],
        },
      };
    }
  }

  // 5d
  log.push('三种扫描均未命中，准备全新部署');
  return { path: resolved, mode: 'create', strategy: '5d:全新部署' };
}

/** 对一个确定路径做状态判定：能自动做的直接给结果，不确定的抛回。 */
function decideForPath(t, ctx, opts, target, log, strategy) {
  const p = probePath(t, ctx, target);
  if (p.error) return { error: p.error };
  const v = classifyRemote(p);

  if (v.kind === 'absent') return { path: target, mode: 'create', strategy };

  if (v.kind === 'empty-dir') return { path: target, mode: 'create', strategy };

  if (v.kind === 'occupied') {
    return {
      error: {
        code: 'PATH_OCCUPIED',
        message: `${target} 已存在且非空，但不是 git 仓库`,
        hint: '不覆盖别人的目录。换一个 -p 路径，或先清理该目录',
      },
    };
  }

  if (v.kind === 'bare') {
    return {
      error: {
        code: 'BARE_REPO',
        message: `${target} 是一个裸仓库，不能直接部署代码`,
        hint: '用 -p 指定一个普通目录',
      },
    };
  }

  if (v.kind === 'dirty') {
    const policy = opts.dirty || 'ask';
    if (policy === 'abort') {
      return {
        error: {
          code: 'REMOTE_DIRTY',
          message: `${target} 有 ${v.dirty.length} 个未提交改动`,
          hint: '按 --dirty abort 中止；确认可覆盖则加 --dirty overwrite',
          detail: v.dirty.slice(0, 10),
        },
      };
    }
    if (policy === 'ask') {
      return {
        needsInput: {
          code: 'REMOTE_DIRTY',
          question:
            `${target} 有 ${v.dirty.length} 个未提交改动，git reset --hard 会全部丢弃。继续吗？`,
          candidates: [{ path: target, dirty: v.dirty.slice(0, 20) }],
          options: [
            { label: '覆盖（丢弃远程改动）', flag: ['--dirty', 'overwrite'] },
            { label: '中止', flag: ['--dirty', 'abort'] },
          ],
        },
      };
    }
    log.push(`按 --dirty overwrite 覆盖 ${target} 的 ${v.dirty.length} 处改动`);
  }

  log.push(`命中已有仓库 ${target}（分支 ${v.branch || '未知'}）`);
  return { path: target, mode: 'update', strategy };
}

function scanByName(t, ctx, repoName) {
  const q = shq(repoName);
  const script =
    `{ find "$HOME/.xat-deploy" -maxdepth 2 -name ${q} -type d -exec sh -c 'test -e "$1/.git"' _ {} \\; -printf '%T@\\t%p\\n' 2>/dev/null\n` +
    `  find /home -maxdepth 4 -name ${q} -type d -exec sh -c 'test -e "$1/.git"' _ {} \\; -printf '%T@\\t%p\\n' 2>/dev/null\n` +
    `  find /srv /var/www /opt -maxdepth 3 -name ${q} -type d -exec sh -c 'test -e "$1/.git"' _ {} \\; -printf '%T@\\t%p\\n' 2>/dev/null\n` +
    `} | sort -u\n`;
  const r = remote(t, ctx, script, { timeout: T.scan });
  if (r.code === 'TIMEOUT') {
    return { error: { code: 'SCAN_TIMEOUT', message: '文件名扫描超时', hint: '用 -p 指定路径可跳过扫描' } };
  }
  return { candidates: parseFindOutput(r.stdout) };
}

function scanByOrigin(t, ctx, originUrl) {
  const want = normalizeRemoteUrl(originUrl);
  const script =
    `timeout 15 find /home /srv /var/www /opt "$HOME/.xat-deploy" -maxdepth 4 -type d -name .git ` +
    `-exec sh -c 'd=$(dirname "$1"); u=$(cd "$d" && git remote get-url origin 2>/dev/null); ` +
    `[ -n "$u" ] && printf "%s|%s|%s\\n" "$(stat -c %Y "$d" 2>/dev/null || echo 0)" "$d" "$u"' _ {} \\; ` +
    `2>/dev/null || true\n`;
  const r = remote(t, ctx, script, { timeout: T.scan });

  const candidates = [];
  for (const line of r.stdout.split('\n')) {
    const parts = line.trim().split('|');
    if (parts.length < 3) continue;
    if (normalizeRemoteUrl(parts.slice(2).join('|')) !== want) continue;
    candidates.push({ path: parts[1], mtime: Number(parts[0]) || 0 });
  }
  return { candidates };
}

/* ───────────────────────── 落盘 ───────────────────────── */

/**
 * 落盘脚本。抽成纯函数是为了能被断言：这是整个工具里唯一一段「远程 bash」，
 * 缩进/引号/`set -e` 少一个都可能变成「看起来跑过了其实没换代码」。
 */
function deployScript(mode, remotePath, branch, bundleDest) {
  const p = shq(remotePath);
  const b = shq(bundleDest);

  if (mode === 'create') {
    // bundle 只有一个 ref，clone 出来的 HEAD 未必就是那个分支，所以显式 checkout -B。
    return (
      `set -e\n` +
      `if [ -d ${p} ]; then rmdir ${p} 2>/dev/null || true; fi\n` +
      `git clone ${b} ${p}\n` +
      `cd ${p}\n` +
      `git checkout -B ${shq(branch)}\n` +
      `echo "##DEPLOYED=clone"\n`
    );
  }

  return (
    `set -e\n` +
    `cd ${p}\n` +
    `git fetch ${b} ${shq(branch)}\n` +
    `git reset --hard FETCH_HEAD\n` +
    `echo "##DEPLOYED=update"\n`
  );
}

function applyDeploy(t, ctx, decision, bundleDest, log) {
  const script = deployScript(decision.mode, decision.path, ctx.branch, bundleDest);
  const r = remote(t, ctx, script, { timeout: T.deploy });
  if (!r.stdout.includes('##DEPLOYED=')) {
    return {
      error: {
        code: decision.mode === 'create' ? 'CLONE_FAILED' : 'UPDATE_FAILED',
        message: `${decision.mode === 'create' ? '全新部署' : '更新'}失败（${decision.path}）`,
        detail: tail(r.stderr || r.stdout, 8),
        hint: '常见原因：目录权限、磁盘满、分支名在 bundle 里不存在',
      },
    };
  }

  const action = marker(r.stdout, 'DEPLOYED') === 'clone' ? '新建仓库' : '已更新';
  const uptodate = /Already up to date/i.test(r.stdout + r.stderr);
  log.push(uptodate ? '远端已是最新提交' : `已${action === '新建仓库' ? '克隆' : '更新'}到 ${decision.path}`);

  return { action: uptodate ? '已是最新' : action, detail: tail(r.stdout, 6) };
}

/* ───────────────────────── CI/CD ───────────────────────── */

/**
 * 工作流目录：显式给的目录优先；如果给它的是仓库根，自动认出里面的 .xat/workflows。
 * 兜底用 cwd，这样在非 git 目录也能对着一个裸文件夹跑 lint。
 */
function workflowDirOf(explicit) {
  if (explicit) {
    const p = path.resolve(explicit);
    const nested = path.join(p, '.xat', 'workflows');
    return fs.existsSync(nested) ? nested : p;
  }
  const repo = repoContext();
  return path.join(repo.error ? process.cwd() : repo.root, '.xat', 'workflows');
}

function listWorkflowFiles(dir) {
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => /\.ya?ml$/i.test(f))
      .sort();
  } catch {
    return [];
  }
}

/**
 * lint：只解析、不执行、不连服务器。
 *
 * 存在理由：工作流格式的规则原本写在 SKILL.md 里，是一份「散文版说明书」。
 * 散文会过期，而且没法验证——读者只能赌自己理解对了。把它变成一条命令之后，
 * 文档只需说「跑它，告警清零」，真值仍留在代码里。
 *
 * 有告警就退出 1，因为告警意味着**某个步骤可能没被执行**，这比语法错误更危险。
 */
function lintWorkflows(opts) {
  const dir = workflowDirOf(opts.workflowDir);
  const entries = listWorkflowFiles(dir);

  if (!entries.length) {
    return finish(
      {
        status: 'ok',
        dir,
        totals: { files: 0, steps: 0, warnings: 0 },
        files: [],
        note: '没有 .yml / .yaml 工作流文件',
      },
      EXIT.ok,
    );
  }

  let stepCount = 0;
  let warnCount = 0;
  const files = entries.map((file) => {
    let text = '';
    try {
      text = fs.readFileSync(path.join(dir, file), 'utf8');
    } catch (err) {
      return { file, ok: false, steps: [], warnings: [`读不到文件：${err.message}`] };
    }
    const { steps, warnings } = parseWorkflow(text);
    stepCount += steps.length;
    warnCount += warnings.length;
    return {
      file,
      ok: warnings.length === 0,
      steps: steps.map((s) =>
        s.uses
          ? { index: s.index, kind: 'uses', uses: s.uses }
          : { index: s.index, kind: 'run', name: s.name || String(s.run).split('\n')[0].slice(0, 60) },
      ),
      warnings,
    };
  });

  const bad = files.filter((f) => !f.ok);

  return finish(
    {
      status: warnCount ? 'warn' : 'ok',
      dir,
      totals: { files: files.length, steps: stepCount, warnings: warnCount },
      files,
      note: warnCount
        ? `${bad.length} 个文件有告警：告警项可能根本没被执行，改完再部署`
        : '未发现写法问题',
    },
    warnCount ? EXIT.fail : EXIT.ok,
  );
}

/**
 * 工件目录（actions/*.cjs）必须在远端存在，`steps[].uses` 才跑得起来。
 *
 * 原来这件事靠文档里一句「一次性准备，工件升级后重传」——人工步骤，而且没人会记得。
 * 这里用内容哈希代替版本号：算一遍本地 actions 的 sha1 写进远端 .hash，下次比对不一致
 * 就重传。代价是一次 ssh 调用，换掉一个必然会被忘掉的仪式。
 */
function actionsHash() {
  const dir = path.join(__dirname, 'actions');
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.cjs') && !f.endsWith('.test.cjs'))
    .sort();
  const h = crypto.createHash('sha1');
  for (const f of files) h.update(`${f}\0${fs.readFileSync(path.join(dir, f))}\0`);
  return h.digest('hex').slice(0, 12);
}

function ensureActions(t, ctx, log) {
  const want = actionsHash();
  const probe = remote(t, ctx, `cat "$HOME/.xat-deploy/scripts/.hash" 2>/dev/null || echo NONE\n`);
  if (probe.stdout.trim() === want) return { ok: true, note: '远端工件已是同版本' };

  const mk = remote(t, ctx, `mkdir -p "$HOME/.xat-deploy/scripts" && echo READY\n`);
  if (!mk.stdout.includes('READY')) {
    return { ok: false, reason: '无法创建远端 scripts 目录' };
  }

  const argv = scpArgv(t, ctx.usePass);
  const r = exec(
    argv[0],
    [...argv.slice(1), '-r', path.join(__dirname, 'actions'), `${t.text}:${ctx.home}/.xat-deploy/scripts/`],
    { timeout: T.deploy, env: ctx.usePass ? { SSHPASS: ctx.password } : {} },
  );
  if (!r.ok) return { ok: false, reason: `上传工件失败：${tail(r.stderr, 4)}` };

  const stamp = remote(t, ctx, `printf '%s\\n' ${shq(want)} > "$HOME/.xat-deploy/scripts/.hash" && echo STAMPED\n`);
  if (!stamp.stdout.includes('STAMPED')) return { ok: false, reason: '写入工件版本标记失败' };

  log.push(`已上传 CI 工件（${want}）`);
  return { ok: true, note: '已上传最新工件' };
}

async function runWorkflows(t, ctx, remotePath, repoName, log) {
  const dir = path.join(ctx.root, '.xat', 'workflows');
  const entries = listWorkflowFiles(dir);
  if (!entries.length) return { files: [], note: '无工作流配置' };

  log.push(`发现 ${entries.length} 个工作流：${entries.join(', ')}`);

  const art = ensureActions(t, ctx, log);
  if (!art.ok) log.push(`CI 工件准备失败：${art.reason}（uses 步骤可能会失败）`);

  // 文件之间并行、文件内部串行——和原文档语义一致：一个工作流失败不该拖住另一个，
  // 但同一个工作流里的步骤顺序有意义。
  const results = await Promise.all(
    entries.map((file) => runOneWorkflow(t, ctx, remotePath, repoName, dir, file)),
  );
  return { files: results, note: '' };
}

async function runOneWorkflow(t, ctx, remotePath, repoName, dir, file) {
  const text = fs.readFileSync(path.join(dir, file), 'utf8');
  const { steps, warnings } = parseWorkflow(text);
  const out = { file, ok: true, steps: [], warnings };

  if (!steps.length) {
    out.ok = true;
    out.note = '没有可执行步骤';
    return out;
  }

  for (const step of steps) {
    const label = step.name || step.uses || `step ${step.index}`;

    if (step.uses) {
      const r = await remoteAsync(t, ctx, artifactScript(step, remotePath, repoName));
      const body = tryJson(r.stdout);
      const ok = Boolean(body && body.ok);
      out.steps.push({
        index: step.index,
        name: label,
        kind: 'uses',
        uses: step.uses,
        ok,
        code: body && body.error ? body.error.code : r.code,
        tail: ok ? '' : tail(r.stdout + r.stderr, 15),
        result: body || null,
      });
      if (!ok) {
        out.ok = false;
        break;
      }
      continue;
    }

    // run 步骤：整段脚本走 stdin，多行结构（if/for/管道）原样保留
    const r = await remoteAsync(t, ctx, `cd ${shq(remotePath)} || exit 1\n${step.run}\n`);
    const ok = r.ok;
    out.steps.push({
      index: step.index,
      name: label,
      kind: 'run',
      ok,
      code: r.code,
      tail: ok ? tail(r.stdout, 10) : tail(r.stdout + r.stderr, 20),
    });
    if (!ok) {
      out.ok = false;
      break;
    }
  }

  return out;
}

/**
 * 把 `with` 映射翻译成工件参数。抽成纯函数是因为这条映射有个非对称的地方：
 * `skip_install: "true"` 是布尔开关（只给 flag 不给值），而 `name: momoi` 需要值。
 * YAML 里两者长得一样，写错就会把 "true" 当成进程名传下去。
 */
function artifactArgs(step, repoName) {
  const w = step.with || {};
  const out = [];
  for (const [k, v] of Object.entries(w)) {
    const flag = `--${k.replace(/_/g, '-')}`;
    out.push(v === 'true' ? flag : `${flag} ${shq(v)}`);
  }
  // 没显式给 name 时用仓库名兜底，避免工件按远端目录名乱起进程名
  if (!('name' in w)) out.push(`--name ${shq(repoName)}`);
  return out;
}

function artifactScript(step, remotePath, repoName) {
  const args = artifactArgs(step, repoName)
    .map((a) => ` ${a}`)
    .join('');
  return (
    `cd ${shq(remotePath)} || exit 1\n` +
    `node "$HOME/.xat-deploy/scripts/actions/index.cjs" ${shq(step.uses)}${args}\n`
  );
}

function tryJson(s) {
  const text = String(s || '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

function ciSummary(ci) {
  if (!ci.files.length) return ci.note || '无工作流配置';
  return ci.files.map((f) => `${f.file} ${f.ok ? '✅' : '❌'}`).join(' ');
}

/* ───────────────────────── 输出 ───────────────────────── */

function summaryTable(s) {
  return [
    `| 项目 | ${s.repo} |`,
    `|---|---|`,
    `| 分支 | ${s.branch} |`,
    `| Bundle | ${s.bundle} |`,
    `| SSH 方式 | ${s.ssh} |`,
    `| SSH 免密 | ${s.keyInstall} |`,
    `| 扫描策略 | ${s.strategy} |`,
    `| 部署动作 | ${s.action} |`,
    `| 远程路径 | ${s.remotePath} |`,
    `| CI/CD | ${s.ci} |`,
  ].join('\n');
}

/**
 * 需要决策时返回完整重跑命令而不是落盘状态：省掉一份可能过期、还可能藏着密码的
 * 状态文件。代价是决策后要重扫一次（十几秒），这个代价值得。
 *
 * 命令用 argv[1] 的绝对路径 + SSHPASS 占位符拼出来，是为了让调用方真的能复制粘贴，
 * 而不是自己照着文档重拼一遍参数——手拼正是这类工具最容易出错的地方。
 */
function needsInput(decision, opts, log) {
  const n = decision.needsInput;
  const bin = process.argv[1] || 'index.cjs';
  const prefix = process.env.SSHPASS ? 'SSHPASS=<密码> ' : '';
  const base = [prefix + 'node', shq(bin), 'deploy', opts.target.text];

  const variants = (n.options || []).map((o) => ({
    label: o.label,
    command: [...base, ...(o.flag || [])].join(' '),
  }));

  return finish(
    {
      status: 'needs_input',
      code: n.code,
      question: n.question,
      candidates: n.candidates || [],
      options: variants,
      passwordHint: process.env.SSHPASS ? '重跑时同样需要带上 SSHPASS' : '当前未使用密码认证',
      log,
    },
    EXIT.needsInput,
  );
}

function fail(error, extra) {
  return finish({ status: 'error', error, ...(extra || {}) }, EXIT.fail);
}

function failCleanup(error, opts, bundle, log) {
  if (!opts.keep) safeUnlink(bundle.file);
  return fail(error, { log });
}

function safeUnlink(p) {
  try {
    fs.unlinkSync(p);
  } catch {
    /* 删不掉不影响结论 */
  }
}

function human(n) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = Number(n) || 0;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function iso(seconds) {
  return new Date((Number(seconds) || 0) * 1000).toISOString().replace('T', ' ').slice(0, 19);
}

function resolvePath(p, home, fallback) {
  const raw = p || fallback;
  if (!raw) return fallback;
  if (raw.startsWith('~')) return raw.replace(/^~/, home);
  if (raw.startsWith('/')) return raw;
  return `${home}/${raw.replace(/^\.\//, '')}`;
}

function dryRun(opts, repo, password) {
  const home = opts.target.user === 'root' ? '/root' : `/home/${opts.target.user}`;
  const fallback = `${home}/.xat-deploy/${repo.repoName}`;
  const target = resolvePath(opts.dir, home, fallback);
  const bundle = `${os.tmpdir()}/${repo.repoName}.bundle`;

  return finish(
    {
      status: 'planned',
      note: 'dry-run：以下步骤未执行，路径中的 home 为估计值（正式运行时会从远端读取）',
      target: opts.target.text,
      repo: repo.repoName,
      branch: repo.branch,
      auth: password ? 'key 优先，失败回退密码' : '仅 key',
      plan: [
        `git bundle create ${bundle} ${repo.branch}`,
        `scp ${bundle} ${opts.target.text}:${fallback}.bundle`,
        opts.use
          ? `使用指定路径 ${target}`
          : opts.create
            ? `全新部署到 ${target}`
            : opts.dir
              ? `探测 ${target}（不做扫描）`
              : `探测 ${target} → 未命中则扫描同名/同源`,
        `cd <path> && git fetch <bundle> ${repo.branch} && git reset --hard FETCH_HEAD`,
        opts.skipCi
          ? 'CI/CD：跳过（--skip-ci）'
          : '执行 .xat/workflows/*.yml（每文件并行、步骤串行；工件按哈希自动同步到远端）',
        opts.keep ? '保留 bundle' : '清理本地与远程 bundle',
      ],
    },
    EXIT.ok,
  );
}

function finish(obj, code) {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
  process.exitCode = code;
  return obj;
}

/* ───────────────────────── 入口 ───────────────────────── */

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    return finish({ status: 'error', error: { code: 'USAGE', message: err.message }, usage: USAGE }, EXIT.usage);
  }

  if (opts.command === 'help') {
    return finish({ status: 'help', usage: USAGE }, EXIT.ok);
  }

  if (opts.command === 'lint') {
    return lintWorkflows(opts);
  }

  try {
    await deploy(opts);
  } catch (err) {
    const usage = err instanceof UsageError;
    finish(
      {
        status: 'error',
        error: { code: usage ? 'USAGE' : 'INTERNAL', message: err.message, stack: usage ? undefined : err.stack },
      },
      usage ? EXIT.usage : EXIT.fail,
    );
  }
}

if (require.main === module) main();

module.exports = {
  parseArgs,
  parseTarget,
  parseWorkflow,
  normalizeRemoteUrl,
  classifyRemote,
  chooseCandidate,
  parseFindOutput,
  blockScalar,
  resolvePath,
  human,
  shq,
  deployScript,
  artifactArgs,
  artifactScript,
};
