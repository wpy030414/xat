'use strict';
// node --test scripts/index.test.cjs
//
// 只测纯逻辑：参数解析、工作流解析、URL 归一化、候选选择。
// **不测 SSH 相关路径**——本机没有可连的服务器，测它只会得到「连不上」这个
// 与逻辑无关的结论，反而拖慢每次回归。

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const BIN = path.join(__dirname, 'index.cjs');
const {
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
} = require('./index.cjs');

function cli(args, env, cwd) {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...(env || {}) },
  });
  let body = null;
  try {
    body = JSON.parse(r.stdout);
  } catch {
    /* 断言里会打印原始 stdout */
  }
  return { code: r.status, body, stdout: r.stdout, stderr: r.stderr };
}

function usageError(fn) {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error('预期抛错，但没有');
}

/* ───────────────── 参数 ───────────────── */

test('地址只认 user@host', () => {
  assert.deepEqual(parseTarget('root@1.2.3.4'), { user: 'root', host: '1.2.3.4', text: 'root@1.2.3.4' });

  // 这条是本次改动的核心：拆成两个参数不再被「智能补全」
  assert.match(usageError(() => parseTarget('root')).message, /user@host/);
  assert.match(usageError(() => parseTarget('root')).message, /root@example\.xrl\.im/);

  assert.match(usageError(() => parseTarget('@host')).message, /@ 前/);
  assert.match(usageError(() => parseTarget('root@')).message, /@ 后/);
  assert.match(usageError(() => parseTarget('a@b@c')).message, /多余的 @/);
});

test('多余的位置参数被拒绝，而不是被猜成密码', () => {
  const e = usageError(() => parseArgs(['deploy', 'root@host', 'mypass']));
  assert.match(e.message, /SSHPASS/);
});

test('选项解析：-p / --use / --dirty / --skip-ci 均可用', () => {
  const o = parseArgs(['deploy', 'root@h', '-p', '/srv/app', '--dirty', 'overwrite', '--skip-ci']);
  assert.equal(o.target.text, 'root@h');
  assert.equal(o.dir, '/srv/app');
  assert.equal(o.dirty, 'overwrite');
  assert.equal(o.skipCi, true);

  const u = parseArgs(['deploy', 'root@h', '--use', '/opt/x']);
  assert.equal(u.use, '/opt/x');
});

test('未知选项与非法枚举值都当用法错误', () => {
  assert.match(usageError(() => parseArgs(['deploy', 'root@h', '--nope'])).message, /无法识别/);
  assert.match(usageError(() => parseArgs(['deploy', 'root@h', '--dirty', 'yolo'])).message, /overwrite/);
  assert.match(usageError(() => parseArgs(['deploy', 'root@h', '--multi', 'yolo'])).message, /newest/);
  assert.match(usageError(() => parseArgs(['deploy', 'root@h', '--dir'])).message, /缺少值/);
});

test('CLI：缺地址 / 带密码参数 / help 的退出码', () => {
  const noAddr = cli(['deploy']);
  assert.equal(noAddr.code, 2);
  assert.equal(noAddr.body.error.code, 'USAGE');

  const withPass = cli(['deploy', 'root@host', 'secret']);
  assert.equal(withPass.code, 2);
  assert.equal(withPass.body.error.code, 'USAGE');

  const help = cli(['--help']);
  assert.equal(help.code, 0);
  assert.equal(help.body.status, 'help');
  assert.match(help.body.usage, /SSHPASS/);
});

/* ───────────────── 远程 URL 归一化 ───────────────── */

test('同一个仓库的不同写法归一后相等', () => {
  const want = normalizeRemoteUrl('git@github.com:foo/bar.git');
  assert.equal(want, 'github.com/foo/bar');
  for (const u of [
    'https://github.com/foo/bar.git',
    'https://github.com/foo/bar',
    'ssh://git@github.com/foo/bar.git',
    'ssh://git@github.com:22/foo/bar.git',
    'git://github.com/foo/bar',
    'git@github.com:foo/bar',
    'git@github.com:2222:foo/bar',
  ]) {
    assert.equal(normalizeRemoteUrl(u), want, u);
  }
});

test('不同仓库不会误判同源', () => {
  assert.notEqual(normalizeRemoteUrl('git@github.com:foo/bar'), normalizeRemoteUrl('git@github.com:foo/baz'));
  assert.notEqual(normalizeRemoteUrl('git@a.com:x/y'), normalizeRemoteUrl('git@b.com:x/y'));
  assert.equal(normalizeRemoteUrl(''), '');
});

/* ───────────────── 工作流解析 ───────────────── */

test('解析文档里的两种形态', () => {
  const yml = `
name: deploy
steps:
  - uses: update-app-node
  - name: Build
    run: pnpm build
`;
  const { steps, warnings } = parseWorkflow(yml);
  assert.deepEqual(warnings, []);
  assert.equal(steps.length, 2);
  assert.equal(steps[0].uses, 'update-app-node');
  assert.equal(steps[1].name, 'Build');
  assert.equal(steps[1].run, 'pnpm build');
});

test('with 支持嵌套映射与内联映射', () => {
  const nested = parseWorkflow(`
steps:
  - uses: update-app-node
    with:
      name: momoi
      skip_install: "true"
  - uses: update-app-node
    with: { name: inline, skip_install: "true" }
`).steps;
  assert.deepEqual(nested[0].with, { name: 'momoi', skip_install: 'true' });
  assert.deepEqual(nested[1].with, { name: 'inline', skip_install: 'true' });
});

test('run 的多行块标量保留相对缩进', () => {
  const yml = `
steps:
  - name: Deploy
    run: |
      if [ -f a ]; then
        echo "has a"
      fi
      for i in 1 2; do echo $i; done
`;
  const step = parseWorkflow(yml).steps[0];
  assert.equal(
    step.run,
    'if [ -f a ]; then\n  echo "has a"\nfi\nfor i in 1 2; do echo $i; done\n',
  );
});

test('steps 顶格写也能解析（合法的 YAML 风格）', () => {
  const { steps } = parseWorkflow('steps:\n- name: A\n  run: echo a\n- uses: x\n');
  assert.equal(steps.length, 2);
  assert.equal(steps[0].run, 'echo a');
  assert.equal(steps[1].uses, 'x');
});

test('工件与命令可以任意混排，顺序即执行顺序', () => {
  const { steps, warnings } = parseWorkflow(`
steps:
  - name: Test
    run: pnpm test
  - uses: update-app-node
  - name: Notify
    run: echo done
`);
  assert.deepEqual(warnings, []);
  assert.deepEqual(
    steps.map((s) => s.uses || s.run),
    ['pnpm test', 'update-app-node', 'echo done'],
  );
  assert.deepEqual(
    steps.map((s) => s.index),
    [0, 1, 2],
  );
});

test('字段与「-」同列：容错接受并告警，绝不静默丢步骤', () => {
  // 不是合法 YAML，但手写时极常见。丢了步骤比报错危险，所以选择接受 + 告警。
  const { steps, warnings } = parseWorkflow('steps:\n- name: Test\nrun: pnpm test\n- uses: update-app-node\n');
  assert.equal(steps.length, 2);
  assert.equal(steps[0].run, 'pnpm test');
  assert.equal(steps[1].uses, 'update-app-node');
  assert.match(warnings.join(), /同列/);
});

test('同列的多行块标量不被容错吞掉，而是显式告警跳过', () => {
  const { steps, warnings } = parseWorkflow('steps:\n- name: Test\nrun: |\n  echo hi\n');
  assert.equal(steps.length, 0);
  assert.match(warnings.join(), /既没有 uses 也没有 run/);
});

test('steps 之外的内容不会被当成步骤', () => {
  const { steps } = parseWorkflow(`
steps:
  - run: echo hi
after:
  - run: echo nope
`);
  assert.equal(steps.length, 1);
  assert.equal(steps[0].run, 'echo hi');
});

test('同一项既写 uses 又写 run：取 uses 并告警', () => {
  const { steps, warnings } = parseWorkflow('steps:\n  - uses: a\n    run: echo b\n');
  assert.equal(steps[0].uses, 'a');
  assert.equal(steps[0].run, undefined);
  assert.match(warnings.join(), /uses/);
});

test('既无 uses 也无 run 的项被跳过并告警，不会静默消失', () => {
  const { steps, warnings } = parseWorkflow('steps:\n  - name: empty\n  - uses: ok\n');
  assert.equal(steps.length, 1);
  assert.equal(steps[0].uses, 'ok');
  assert.match(warnings.join(), /既没有 uses 也没有 run/);
});

test('没有 steps 时给告警而不是抛错', () => {
  const r = parseWorkflow('name: x\n');
  assert.deepEqual(r.steps, []);
  assert.match(r.warnings.join(), /steps/);
});

test('块标量：折叠写法的多行合并为空格', () => {
  assert.equal(blockScalar([], false), '');
  const folded = parseWorkflow('steps:\n  - name: x\n    run: >\n      echo a\n      echo b\n').steps[0].run;
  assert.equal(folded, 'echo a echo b');
});

/* ───────────────── 探测结果分类 ───────────────── */

test('探测结果到结论的映射', () => {
  assert.equal(classifyRemote({ exists: false }).kind, 'absent');
  assert.equal(classifyRemote({ exists: true, isGit: false, empty: true }).kind, 'empty-dir');
  assert.equal(classifyRemote({ exists: true, isGit: false, empty: false }).kind, 'occupied');
  assert.equal(classifyRemote({ exists: true, isGit: true, bare: 'true' }).kind, 'bare');
  assert.equal(classifyRemote({ exists: true, isGit: true, dirty: [' M a.js'] }).kind, 'dirty');
  assert.equal(classifyRemote({ exists: true, isGit: true, bare: 'false', dirty: [] }).kind, 'repo');
});

/* ───────────────── 候选选择 ───────────────── */

const HOUR = 3600;

test('唯一候选直接用', () => {
  const r = chooseCandidate([{ path: '/a', mtime: 1000 }], 'auto');
  assert.equal(r.kind, 'pick');
  assert.equal(r.candidate.path, '/a');
});

test('多个候选：明显更新的自动选，接近的抛回问人', () => {
  const far = chooseCandidate(
    [
      { path: '/new', mtime: 100 * 24 * HOUR },
      { path: '/old', mtime: 90 * 24 * HOUR },
    ],
    'auto',
    200 * 24 * HOUR,
  );
  assert.equal(far.kind, 'pick');
  assert.equal(far.candidate.path, '/new');

  const near = chooseCandidate(
    [
      { path: '/a', mtime: 100 * 24 * HOUR },
      { path: '/b', mtime: 100 * 24 * HOUR - HOUR },
    ],
    'auto',
    200 * 24 * HOUR,
  );
  assert.equal(near.kind, 'ask');
  assert.equal(near.candidates.length, 2);
});

test('--multi newest 无条件取最新', () => {
  const r = chooseCandidate(
    [
      { path: '/a', mtime: 100 },
      { path: '/b', mtime: 99 },
    ],
    'newest',
    Date.now() / 1000,
  );
  assert.equal(r.kind, 'pick');
  assert.equal(r.candidate.path, '/a');
});

test('空候选集不会误选出东西', () => {
  assert.equal(chooseCandidate([], 'auto').kind, 'none');
});

test('find 输出解析：去重且保留 mtime', () => {
  const out = ['1700000000.5\t/srv/app', '1700000000.5\t/srv/app', '1700000001\t/opt/app'].join('\n');
  const list = parseFindOutput(out);
  assert.equal(list.length, 2);
  assert.equal(list[0].mtime, 1700000000.5);
  assert.deepEqual(parseFindOutput('garbage\n\n'), []);
});

/* ───────────────── 路径与小工具 ───────────────── */

test('路径解析：~ 与相对路径都基于远端 HOME', () => {
  assert.equal(resolvePath('/srv/app', '/home/u', '/home/u/.xat-deploy/x'), '/srv/app');
  assert.equal(resolvePath('~/x', '/home/u', 'z'), '/home/u/x');
  assert.equal(resolvePath('apps/x', '/home/u', 'z'), '/home/u/apps/x');
  assert.equal(resolvePath(undefined, '/home/u', '/home/u/.xat-deploy/x'), '/home/u/.xat-deploy/x');
});

test('大小格式化', () => {
  assert.equal(human(512), '512 B');
  assert.equal(human(2048), '2.0 KB');
});

/* ───────────────── 远程脚本构造 ───────────────── */

test('引号转义：空格与单引号都能原样穿过 shell', () => {
  assert.equal(shq('a b'), `'a b'`);
  assert.equal(shq("it's"), `'it'\\''s'`);
  assert.equal(shq(''), `''`);
  // 拼进 shell 后必须只有一个参数
  const argv = spawnSync('bash', ['-c', `printf '%s\\n' ${shq("it's a b")}`], { encoding: 'utf8' });
  assert.equal(argv.stdout, "it's a b\n");
});

test('更新与全新部署的脚本：都带 set -e，都对分支做引号处理', () => {
  const upd = deployScript('update', '/srv/my app', 'feat/x', '/home/u/.xat-deploy/my app.bundle');
  assert.match(upd, /^set -e\n/);
  assert.match(upd, /cd '\/srv\/my app'/);
  assert.match(upd, /git fetch '\/home\/u\/\.xat-deploy\/my app\.bundle' 'feat\/x'/);
  assert.match(upd, /git reset --hard FETCH_HEAD/);

  const crt = deployScript('create', '/srv/app', 'main', '/tmp/a.bundle');
  assert.match(crt, /^set -e\n/);
  assert.match(crt, /git clone '\/tmp\/a\.bundle' '\/srv\/app'/);
  assert.match(crt, /git checkout -B 'main'/);
});

test('工件参数：布尔开关不给值，普通键给值，缺 name 时用仓库名兜底', () => {
  assert.deepEqual(artifactArgs({ uses: 'x' }, 'myrepo'), [`--name 'myrepo'`]);
  assert.deepEqual(artifactArgs({ uses: 'x', with: { name: 'momoi', skip_install: 'true' } }, 'r'), [
    `--name 'momoi'`,
    '--skip-install',
  ]);
  // YAML 里 "true" 带引号，unquote 之后仍是字符串 true，必须走布尔而不是把值传下去
  const quoted = parseWorkflow('steps:\n  - uses: x\n    with:\n      skip_install: "true"\n').steps[0];
  assert.deepEqual(artifactArgs(quoted, 'r'), ['--skip-install', `--name 'r'`]);
});

test('生成的远程脚本能通过 bash 语法检查', () => {
  const scripts = [
    deployScript('create', '/srv/my app', 'main', '/tmp/a.bundle'),
    deployScript('update', '/srv/app', 'feat/x', '/home/u/.xat-deploy/app.bundle'),
    artifactScript(
      { uses: 'update-app-node', with: { name: "'quoted'", skip_install: 'true' } },
      '/srv/app',
      'app',
    ),
  ];
  for (const s of scripts) {
    const f = path.join(os.tmpdir(), `xat-syntax-${Date.now()}-${Math.random().toString(36).slice(2)}.sh`);
    fs.writeFileSync(f, s);
    const r = spawnSync('bash', ['-n', f], { encoding: 'utf8' });
    assert.equal(r.status, 0, `脚本语法错误：${r.stderr}\n---\n${s}`);
    fs.unlinkSync(f);
  }
});

/* ───────────────── lint（工作流写法自检） ───────────────── */

function wfDir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xat-wf-'));
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
  return dir;
}

test('lint：规范写法无告警，退出码 0', () => {
  const dir = wfDir({
    'build.yml': 'steps:\n  - name: Test\n    run: pnpm test\n  - uses: update-app-node\n',
  });
  const r = cli(['lint', dir]);
  assert.equal(r.code, 0, r.stdout);
  assert.equal(r.body.status, 'ok');
  assert.equal(r.body.totals.steps, 2);
  assert.deepEqual(r.body.files[0].steps.map((s) => s.kind), ['run', 'uses']);
});

test('lint：同列写法告警并退出 1（告警 = 可能漏跑步骤）', () => {
  const dir = wfDir({ 'bad.yml': 'steps:\n- name: Oops\nrun: echo hi\n' });
  const r = cli(['lint', dir]);
  assert.equal(r.code, 1);
  assert.equal(r.body.status, 'warn');
  assert.equal(r.body.files[0].ok, false);
  assert.match(r.body.files[0].warnings.join(), /同列/);
  // 容错后这一步仍然被认出来了，不是丢弃
  assert.equal(r.body.files[0].steps.length, 1);
});

test('lint：空目录 / 缺目录都不算错', () => {
  for (const dir of [wfDir({}), path.join(os.tmpdir(), 'xat-does-not-exist-' + Date.now())]) {
    const r = cli(['lint', dir]);
    assert.equal(r.code, 0, r.stdout);
    assert.match(r.body.note, /没有/);
  }
});

test('lint：非法命令名与多余参数都报用法错误', () => {
  assert.equal(cli(['nope']).code, 2);
  assert.equal(cli(['lint', 'a', 'b']).code, 2);
});

/* ───────────────── dry-run 端到端（不连服务器） ───────────────── */

test('--dry-run 在真实仓库里只输出计划，不产生任何副作用', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xat-upload-'));
  const run = (args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  run(['init', '-q']);
  run(['config', 'user.email', 't@t']);
  run(['config', 'user.name', 't']);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'x');
  run(['add', '.']);
  run(['commit', '-qm', 'init']);

  const bundleBefore = fs.readdirSync(os.tmpdir()).filter((f) => f.endsWith('.bundle'));

  const r = cli(['deploy', 'root@example.invalid', '--dry-run'], {}, dir);
  // dry-run 不做网络、不写 bundle，可以直接在临时仓库里断言计划内容
  assert.equal(r.code, 0, r.stdout);
  assert.equal(r.body.status, 'planned');
  assert.match(r.body.plan.join('\n'), /git bundle create/);
  assert.match(r.body.plan.join('\n'), /git fetch/);

  const bundleAfter = fs.readdirSync(os.tmpdir()).filter((f) => f.endsWith('.bundle'));
  assert.deepEqual(bundleAfter, bundleBefore);
});

test('在非 git 目录里直接报 NOT_A_REPO，而不是打到远端去', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xat-nogit-'));
  const r = spawnSync(process.execPath, [BIN, 'deploy', 'root@example.invalid', '--dry-run'], {
    cwd: dir,
    encoding: 'utf8',
  });
  const body = JSON.parse(r.stdout);
  assert.equal(r.status, 1);
  assert.equal(body.error.code, 'NOT_A_REPO');
});
