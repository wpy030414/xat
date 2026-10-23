'use strict';
/**
 * 工件共用工具。
 *
 * 放在这里的东西有一个共同点：**每个工件都会用到，且每个工件自己写一遍就会漂移**。
 * 例如 `quote` —— 少一个引号，`pm2 delete momoi` 在项目名带空格时就会删错进程。
 */

const fs = require('fs');
const { spawnSync } = require('child_process');

class UsageError extends Error {}

// sh 执行一条 shell 命令，返回结构化结果。所有工件都必须走它，
// 这样「失败时带 logs 尾部」这件事只需要实现一次。
function sh(cmd, cwd, env) {
  const r = spawnSync(cmd, {
    cwd,
    shell: true,
    encoding: 'utf8',
    env: { ...process.env, ...(env || {}) },
  });
  return {
    cmd,
    status: r.status,
    ok: r.status === 0,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
    tail: lines(r.stdout, r.stderr, 40),
  };
}

function lines(stdout, stderr, n) {
  return ((stdout || '') + (stderr || ''))
    .trimEnd()
    .split('\n')
    .slice(-n)
    .join('\n');
}

// quote 给 shell 参数加单引号。空串、空格、单引号都必须能正确穿过。
function quote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// memGuardEnv 在内存不足 4 GiB 的机器上限制 Node 堆。
// VPS 默认堆按物理内存推算，构建时极易 OOM 且报错信息难懂（只是一个 137 退出码）。
// 非 Linux 无 /proc/meminfo，直接跳过而不是猜一个值。
function memGuardEnv() {
  try {
    const m = /MemAvailable:\s+(\d+) kB/.exec(fs.readFileSync('/proc/meminfo', 'utf8'));
    if (!m) return { env: {}, note: '未读到 MemAvailable，跳过内存保护' };
    if (Number(m[1]) < 4 * 1024 * 1024) {
      return {
        env: { NODE_OPTIONS: '--max-old-space-size=1024' },
        note: `MemAvailable ${m[1]} kB (< 4 GiB)，已设 NODE_OPTIONS=--max-old-space-size=1024`,
      };
    }
    return { env: {}, note: `MemAvailable ${m[1]} kB (>= 4 GiB)，使用默认 NODE_OPTIONS` };
  } catch {
    return { env: {}, note: '未检测到 /proc/meminfo，跳过内存保护' };
  }
}

module.exports = { UsageError, sh, lines, quote, sleep, memGuardEnv };
