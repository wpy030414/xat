'use strict';
// node --test actions/actions.test.cjs
//
// 覆盖注册表、参数解析与失败语义。**不覆盖 pm2 的真实启停**——本机没有 pm2，
// 测它只会得到「命令不存在」这个与工件逻辑无关的结论。

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const BIN = path.join(__dirname, 'index.cjs');
const { loadActions } = require('./index.cjs');
const { detectManager, readScripts } = require('./update-app-node.cjs');

function proj(pkg, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xat-action-'));
  if (pkg) fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg));
  for (const f of files || []) fs.writeFileSync(path.join(dir, f), '');
  return dir;
}

function run(args) {
  const r = spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8' });
  let body = null;
  try {
    body = JSON.parse(r.stdout);
  } catch {
    /* 断言会打印原始 stdout */
  }
  return { code: r.status, body, stdout: r.stdout };
}

test('注册表：加载 actions/ 下的工件，无非法项', () => {
  const { actions, invalid } = loadActions(__dirname);
  assert.deepEqual([...actions.keys()], ['update-app-node']);
  assert.deepEqual(invalid, []);
});

test('注册表：形状不对的工件被显式报出，而不是静默消失', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xat-registry-'));
  fs.writeFileSync(path.join(dir, 'broken.cjs'), 'module.exports = { name: 1 };');
  fs.writeFileSync(path.join(dir, 'noisy.cjs'), 'module.exports = { name: "x", run: () => ({ ok: true }) };');
  const { actions, invalid } = loadActions(dir);
  assert.deepEqual([...actions.keys()], ['x']);
  assert.equal(invalid.length, 1);
  assert.match(invalid[0].reason, /必须导出/);
});

test('包管理器按锁文件判定，无锁文件退回 npm', () => {
  assert.equal(detectManager(proj({}, ['pnpm-lock.yaml'])).name, 'pnpm');
  assert.equal(detectManager(proj({}, ['yarn.lock'])).name, 'yarn');
  assert.equal(detectManager(proj({}, ['bun.lockb'])).name, 'bun');
  assert.equal(detectManager(proj({}, ['package-lock.json'])).name, 'npm');
  assert.equal(detectManager(proj({}, [])).name, 'npm');
});

test('readScripts 对缺失或非法 package.json 返回 null', () => {
  assert.equal(readScripts(proj(null, [])), null);
  const dir = proj(null, []);
  fs.writeFileSync(path.join(dir, 'package.json'), '{ 坏 json');
  assert.equal(readScripts(dir), null);
});

test('不是 Node 项目 → NOT_NODE_PROJECT', () => {
  const r = run(['update-app-node', '--dir', proj(null, [])]);
  assert.equal(r.code, 1);
  assert.equal(r.body.error.code, 'NOT_NODE_PROJECT');
});

test('缺 scripts.start → NO_START_SCRIPT（不猜入口）', () => {
  const r = run(['update-app-node', '--dir', proj({ scripts: { build: 'x' } }, [])]);
  assert.equal(r.code, 1);
  assert.equal(r.body.error.code, 'NO_START_SCRIPT');
});

test('--dry-run 只给计划，不装依赖', () => {
  const dir = proj({ scripts: { start: 'node s.js', build: 'node build.js' } }, ['pnpm-lock.yaml']);
  const r = run(['update-app-node', '--dir', dir, '--name', 'my-app', '--dry-run']);
  assert.equal(r.code, 0);
  assert.equal(r.body.dryRun, true);
  assert.equal(r.body.packageManager, 'pnpm');
  assert.equal(r.body.name, 'my-app');
  const plan = r.body.plan.join('\n');
  assert.match(plan, /pnpm build/);
  assert.match(plan, /pm2 delete my-app/);
  assert.match(plan, /pm2 start pnpm start --name my-app/);
  assert.equal(fs.existsSync(path.join(dir, 'node_modules')), false);
});

test('构建失败 → BUILD_FAILED，线上未被触碰，且不出现 start 步骤', () => {
  const dir = proj(
    { scripts: { start: 'node s.js', build: `node -e "process.exit(3)"` } },
    ['package-lock.json'],
  );
  const r = run(['update-app-node', '--dir', dir, '--name', 'x', '--skip-install']);
  assert.equal(r.code, 1);
  assert.equal(r.body.error.code, 'BUILD_FAILED');
  assert.match(r.body.note, /未被触碰/);
  const build = r.body.steps.find((s) => s.step === 'build');
  assert.equal(build.exitCode, 3);
  assert.equal(r.body.steps.some((s) => s.step === 'start'), false);
});

test('list 与未知工件', () => {
  const list = run(['list']);
  assert.equal(list.code, 0);
  assert.deepEqual(list.body.actions.map((a) => a.uses), ['update-app-node']);

  // 工件要能自述参数：文档里的清单会过期，注册表不会
  const params = list.body.actions[0].params;
  assert.ok(params && Object.keys(params).length > 0);
  assert.match(params.skip_install, /跳过/);

  const bad = run(['nope']);
  assert.equal(bad.code, 2);
  assert.equal(bad.body.error.code, 'UNKNOWN_ACTION');
  assert.match(bad.body.error.hint, /update-app-node/);
});

test('没声明 params 的工件在注册表里是 null，不是空对象', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xat-params-'));
  fs.writeFileSync(
    path.join(dir, 'bare.cjs'),
    'module.exports = { name: "bare", description: "x", run: () => ({ ok: true }) };',
  );
  const { actions } = loadActions(dir);
  assert.equal(actions.get('bare').params, null);
});

test('参数必须以 -- 开头，避免手误被当成别的东西', () => {
  const r = run(['update-app-node', 'dir=/tmp']);
  assert.equal(r.code, 2);
  assert.equal(r.body.error.code, 'USAGE');
});
