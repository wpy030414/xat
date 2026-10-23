'use strict';
/**
 * 工件：update-app-node —— Node 项目的「构建 + 冷更新」。
 *
 * 替代工作流里的这一大段：
 *
 *   - name: Build
 *     run: |
 *       avail_kb=$(awk '/MemAvailable/ {print $2}' /proc/meminfo)
 *       ...
 *       pnpm build
 *   - name: Run
 *     run: |
 *       if pm2 jlist | grep -q '"name":"momoi"'; then pm2 delete momoi; fi
 *       pm2 start 'pnpm start' --name momoi
 *
 * 契约：每个工件导出 { name, description, run(opts) }，返回一个可 JSON 化的结果，
 * 带 ok 字段。失败时给出 error.code / error.hint，让调用方能决定下一步，
 * 而不是只拿到一句「失败了」。
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { sh, sleep, quote, memGuardEnv } = require('./lib.cjs');

// 按锁文件判定包管理器。都没有时退回 npm——猜 pnpm 会在没装 pnpm 的机器上直接失败，
// 而 npm 几乎总是存在的。
const MANAGERS = [
  { name: 'pnpm', lock: 'pnpm-lock.yaml', install: 'pnpm install --frozen-lockfile', build: 'pnpm build', start: 'pnpm start' },
  { name: 'yarn', lock: 'yarn.lock', install: 'yarn install --frozen-lockfile', build: 'yarn build', start: 'yarn start' },
  { name: 'bun', lock: 'bun.lockb', install: 'bun install --frozen-lockfile', build: 'bun run build', start: 'bun run start' },
  { name: 'npm', lock: 'package-lock.json', install: 'npm ci', build: 'npm run build', start: 'npm start' },
];

function detectManager(dir) {
  for (const m of MANAGERS) {
    if (fs.existsSync(path.join(dir, m.lock))) return m;
  }
  return MANAGERS[MANAGERS.length - 1];
}

function readScripts(dir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    return { name: pkg.name, scripts: pkg.scripts || {} };
  } catch {
    return null;
  }
}

function pm2Status(name) {
  const r = spawnSync('pm2', ['jlist'], { encoding: 'utf8', shell: true });
  if (r.status !== 0) return null;
  try {
    const list = JSON.parse(r.stdout);
    const found = list.find((p) => p.name === name);
    return found ? found.pm2_env?.status : null;
  } catch {
    return null;
  }
}

async function run(opts) {
  const dir = path.resolve(opts.dir || process.cwd());
  const steps = [];

  const meta = readScripts(dir);
  if (!meta) {
    return {
      ok: false,
      action: 'update-app-node',
      error: {
        code: 'NOT_NODE_PROJECT',
        message: `${dir} 下没有可解析的 package.json`,
        hint: '换用显式 run 步骤，或确认 --dir 指向工程根',
      },
    };
  }

  const name = opts.name || path.basename(dir);
  const pm = detectManager(dir);
  const hasBuild = Boolean(meta.scripts.build);

  if (!meta.scripts.start) {
    return {
      ok: false,
      action: 'update-app-node',
      error: {
        code: 'NO_START_SCRIPT',
        message: `package.json 没有 scripts.start（${path.join(dir, 'package.json')}）`,
        hint: '补一个 start 脚本；本工件用 pm2 start <包管理器> start 启动',
      },
    };
  }

  const needInstall = !opts.skipInstall && !fs.existsSync(path.join(dir, 'node_modules'));

  if (opts.dryRun) {
    return {
      ok: true,
      action: 'update-app-node',
      dryRun: true,
      dir,
      name,
      packageManager: pm.name,
      plan: [
        needInstall ? `install: ${pm.install}` : `install: 跳过（${opts.skipInstall ? '--skip-install' : 'node_modules 已存在'}）`,
        hasBuild ? `build: ${pm.build}（含低内存保护）` : 'build: 跳过（无 scripts.build）',
        `restart: pm2 delete ${name}（仅当已存在）→ pm2 start ${pm.start} --name ${name}`,
      ],
    };
  }

  /* 1. 依赖 */
  if (needInstall) {
    const r = sh(pm.install, dir);
    steps.push({ step: 'install', cmd: r.cmd, ok: r.ok, exitCode: r.status });
    if (!r.ok) {
      return {
        ok: false,
        action: 'update-app-node',
        steps,
        error: { code: 'INSTALL_FAILED', message: `依赖安装失败（退出码 ${r.status}）`, hint: '见 logs' },
        logs: r.tail,
        note: '线上进程未被触碰',
      };
    }
  } else {
    steps.push({ step: 'install', skipped: true, reason: opts.skipInstall ? '--skip-install' : 'node_modules 已存在' });
  }

  /* 2. 构建 */
  if (hasBuild) {
    const guard = memGuardEnv();
    const r = sh(pm.build, dir, guard.env);
    steps.push({ step: 'build', cmd: r.cmd, ok: r.ok, exitCode: r.status, note: guard.note });
    if (!r.ok) {
      return {
        ok: false,
        action: 'update-app-node',
        steps,
        error: { code: 'BUILD_FAILED', message: `构建失败（退出码 ${r.status}）`, hint: '见 logs' },
        logs: r.tail,
        note: '线上进程未被触碰',
      };
    }
  } else {
    steps.push({ step: 'build', skipped: true, reason: 'package.json 无 build 脚本' });
  }

  /* 3. 冷更新：先停后起。窗口很短但不为零——这是刻意的取舍：
        避免新版本起不来时两个进程抢同一个端口，那种故障更难查。 */
  const before = pm2Status(name);
  if (before !== null) {
    const del = sh(`pm2 delete ${quote(name)}`, dir);
    steps.push({ step: 'stop-old', cmd: del.cmd, ok: del.ok, wasStatus: before });
  } else {
    steps.push({ step: 'stop-old', skipped: true, reason: 'pm2 中无同名进程（首次启动）' });
  }

  const start = sh(`pm2 start ${quote(pm.start)} --name ${quote(name)}`, dir);
  steps.push({ step: 'start', cmd: start.cmd, ok: start.ok, exitCode: start.status });
  if (!start.ok) {
    return {
      ok: false,
      action: 'update-app-node',
      steps,
      error: {
        code: 'START_FAILED',
        message: `pm2 start 失败（退出码 ${start.status}）`,
        hint: '线上可能已不可用（旧进程已停）',
      },
      logs: start.tail,
    };
  }

  /* 4. 回读状态：pm2 start 返回 0 只表示守护进程收下了请求，
        应用可能在几百毫秒后就崩掉。不复核就会把「已上线」报给用户。 */
  await sleep(1500);
  const after = pm2Status(name);
  steps.push({ step: 'verify', status: after });

  if (after !== 'online') {
    return {
      ok: false,
      action: 'update-app-node',
      steps,
      error: {
        code: 'APP_NOT_ONLINE',
        message: `启动后 1.5s 内状态为 ${after || 'unknown'}（预期 online）`,
        hint: '见 logs：常见原因是端口被占（EADDRINUSE）、缺环境变量、入口路径错',
      },
      logs: sh(`pm2 logs ${quote(name)} --nostream --lines 40`, dir).tail,
    };
  }

  return {
    ok: true,
    action: 'update-app-node',
    name,
    dir,
    packageManager: pm.name,
    coldUpdate: before !== null,
    steps,
    note: before !== null ? `已冷更新：${before} → online` : '已首次启动',
  };
}

module.exports = {
  name: 'update-app-node',
  description: 'Node 项目：装依赖（必要时）→ 构建（有 build 脚本时，含低内存保护）→ pm2 冷更新 → 回读状态确认在线',
  // 让 `list` 能自述参数，避免调用方靠文档或读源码猜
  params: {
    name: 'pm2 进程名，缺省取工程目录名',
    skip_install: 'true 时跳过依赖安装（node_modules 已确认可用时用）',
  },
  run,
  // 导出给测试用
  detectManager,
  readScripts,
};
