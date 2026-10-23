#!/usr/bin/env node
'use strict';
/**
 * kill-port —— 按端口号查找并终止占用进程。
 *
 * 跨平台自适应：
 *   Windows        : netstat -ano -p tcp 查 PID → tasklist 查进程名 → taskkill 终止
 *   macOS / Linux  : lsof -i tcp:<port> -t 查 PID → ps 查进程名 → POSIX signal 终止
 *
 * 终止策略：先优雅（Windows: taskkill /PID 发 WM_CLOSE；Unix: SIGTERM），
 * 等 2 秒仍存活则强制（Windows: taskkill /F /PID；Unix: SIGKILL）。
 *
 * 用法：
 *   node index.cjs <port>
 *
 * 输出：单个 JSON 对象到 stdout，供 AI 解析展示。
 * 退出码：0 成功（含「端口未被占用」）/ 1 有进程未能终止 / 2 用法错误。
 */

const { execSync } = require('child_process');

const EXIT = { ok: 0, fail: 1, usage: 2 };

/* ───────────────────────── 输出 ───────────────────────── */

function emit(obj, code) {
  process.stdout.write(JSON.stringify(obj) + '\n');
  process.exitCode = code === undefined ? EXIT.ok : code;
  return obj;
}

/* ───────────────────────── 参数解析 ───────────────────────── */

function parsePort(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!/^\d+$/.test(s)) return null;
  const n = parseInt(s, 10);
  if (!(n >= 1 && n <= 65535)) return null;
  return n;
}

/* ───────────────────────── 平台命令 ───────────────────────── */

const isWin = process.platform === 'win32';

// 统一收口：任何 execSync 失败都只影响调用方那一步，不中断整体流程。
function run(cmd, timeout) {
  return execSync(cmd, { encoding: 'utf8', timeout: timeout || 10000, windowsHide: true });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/* ───────────────────── 1. 查找占用端口的 PID ───────────────────── */

function findPids(port) {
  const pids = [];
  const seen = new Set();

  if (isWin) {
    // netstat 的端口列形如 `0.0.0.0:3000` / `[::]:3000`，最后一列是 PID。
    const out = run('netstat -ano -p tcp', 10000);
    for (const line of out.split('\n')) {
      const m = line.match(/:(\d+)\s+\S+\s+\S+\s+(\d+)/);
      if (!m || m[1] !== String(port)) continue;
      const pid = parseInt(m[2], 10);
      if (pid && pid !== 0 && !seen.has(pid)) {
        seen.add(pid);
        pids.push(pid);
      }
    }
    return pids;
  }

  // lsof 无匹配时退出码为 1 且 stdout 为空——这是「端口空闲」，不是错误。
  try {
    const out = run('lsof -i tcp:' + port + ' -t', 10000);
    return out
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((p) => parseInt(p.trim(), 10))
      .filter((n) => n > 0);
  } catch (e) {
    if (e.status === 1 && !e.stdout) return [];
    throw e;
  }
}

/* ───────────────────── 2. 查询进程名 ───────────────────── */

function getCommand(pid) {
  try {
    if (isWin) {
      // CSV 首列即映像名；后台系统进程可能查不到，返回 unknown 即可。
      const out = run('tasklist /FI "PID eq ' + pid + '" /FO CSV /NH', 5000);
      const first = out.split(',')[0].replace(/"/g, '').trim();
      return first || 'unknown';
    }
    return run('ps -p ' + pid + ' -o comm=', 5000).trim() || 'unknown';
  } catch (e) {
    return 'unknown';
  }
}

/* ───────────────────── 3. 终止进程 ───────────────────── */

// 用 signal 0 探活：进程还在则不抛错，已消失则抛 ESRCH。
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code !== 'ESRCH';
  }
}

async function killOne(pid) {
  const command = getCommand(pid);

  if (isWin) {
    // Windows 策略：
    //   1. taskkill /PID → 发送 WM_CLOSE（等价 SIGTERM）。
    //      注意：后台/无窗口进程会直接拒绝此操作，属预期行为，不是错误。
    //   2. 等 2 秒后仍存活 → taskkill /F /PID（等价 SIGKILL）。
    let gentleOk = false;
    try {
      run('taskkill /PID ' + pid, 5000);
      gentleOk = true;
    } catch (e) {
      /* 无窗口接收 WM_CLOSE 时返回非 0，继续走 /F */
    }

    if (gentleOk) {
      await sleep(2000);
      if (!isAlive(pid)) return { pid, command, signal: 'SIGTERM', killed: true };
    }

    try {
      run('taskkill /F /PID ' + pid, 5000);
      return { pid, command, signal: 'SIGKILL', killed: true };
    } catch (e) {
      // /F 也失败：权限不足，或进程刚好自己退了。
      return { pid, command, signal: isAlive(pid) ? 'EPERM' : 'SIGKILL', killed: !isAlive(pid) };
    }
  }

  // Unix: POSIX signal
  try {
    process.kill(pid, 'SIGTERM');
    await sleep(2000);
    if (!isAlive(pid)) return { pid, command, signal: 'SIGTERM', killed: true };
    process.kill(pid, 'SIGKILL');
    return { pid, command, signal: 'SIGKILL', killed: !isAlive(pid) };
  } catch (e) {
    if (e.code === 'EPERM') return { pid, command, signal: 'EPERM', killed: false };
    if (e.code === 'ESRCH') return { pid, command, signal: 'SIGTERM', killed: true };
    return { pid, command, signal: e.code || 'ERROR', killed: !isAlive(pid) };
  }
}

/* ───────────────────────── 主流程 ───────────────────────── */

async function main() {
  const raw = process.argv[2];
  const port = parsePort(raw);

  if (!port) {
    return emit(
      {
        success: false,
        error: '无效端口号：' + (raw == null ? '(空)' : raw) + '，请输入 1-65535 的整数',
        usage: 'node index.cjs <port>',
      },
      EXIT.usage,
    );
  }

  let pids;
  try {
    pids = findPids(port);
  } catch (e) {
    return emit({ success: false, port, error: '查找端口占用失败: ' + e.message }, EXIT.fail);
  }

  if (pids.length === 0) {
    return emit({ success: true, port, message: '端口 ' + port + ' 未被占用', results: [] });
  }

  const results = [];
  for (const pid of pids) results.push(await killOne(pid));

  const allKilled = results.every((r) => r.killed);
  const resp = {
    success: allKilled,
    port,
    message: allKilled ? '端口 ' + port + ' 已释放 (' + results.length + ' 个进程)' : '部分进程未能终止',
    results,
  };
  // 特权端口失败八成是权限问题，直接给出可执行的下一步，省得用户自己猜。
  if (!allKilled && port < 1024) {
    resp.hint = '特权端口（<1024）可能需要管理员/sudo 权限';
  }
  return emit(resp, allKilled ? EXIT.ok : EXIT.fail);
}

main().catch((e) => emit({ success: false, error: (e && e.message) || String(e) }, EXIT.fail));
