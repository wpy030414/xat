#!/usr/bin/env node
'use strict';
/**
 * 工件注册表与执行器。
 *
 * 一个工件 = `actions/` 下的一个 `.cjs`，导出 { name, description, run(opts) }。
 * 工作流里 `steps[i].uses: <name>` 就是调它；新增工件只需新增一个文件，
 * 不需要动这个执行器，也不需要改工作流解析逻辑。本文就是工件契约的唯一出处。
 *
 * 返回 `{ ok: true, ... }` 或 `{ ok: false, error: { code, message, hint } }`。
 * 失败必须给 code 和 hint，不能只返回 false：调用方靠它区分「旧版本还在服务」
 * 和「线上已经不可用」，这两种后果的处置方式完全不同。
 *
 * 可选导出 `params: { 参数名: 说明 }`，`list` 会把它带出来。建议都写——
 * 参数说明和 run() 在同一个文件里，改代码时很难忘记它；写进别处的清单一定会过期。
 * 形状不对的工件不会静默消失，会在 `list` 的 `invalid[]` 里报出来。
 *
 * 用法（在服务器上、工程目录内）：
 *   node actions/index.cjs list
 *   node actions/index.cjs <name> [--dir <目录>] [--name <进程名>] [--dry-run] [其他工件自定义参数]
 *
 * 输出：单个 JSON 对象到 stdout。退出码：0 成功 / 1 动作失败 / 2 用法或注册表错误。
 */

const fs = require('fs');
const path = require('path');
const { UsageError } = require('./lib.cjs');

const RESERVED = new Set(['index.cjs', 'lib.cjs']);

/* ───────────────────────── 注册表 ───────────────────────── */

function loadActions(dir) {
  const actions = new Map();
  const invalid = [];

  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch (err) {
    return { actions, invalid: [{ file: dir, reason: `读不到目录：${err.message}` }] };
  }

  for (const file of entries.sort()) {
    if (!file.endsWith('.cjs')) continue;
    if (RESERVED.has(file) || file.endsWith('.test.cjs')) continue;

    const full = path.join(dir, file);
    let mod;
    try {
      mod = require(full);
    } catch (err) {
      invalid.push({ file, reason: `加载失败：${err.message}` });
      continue;
    }
    // 形状不对必须显式报出来而不是静默跳过：静默跳过的后果是
    // 工作流里写了一个「看起来存在」的 uses，跑起来却报未知工件。
    if (!mod || typeof mod.name !== 'string' || typeof mod.run !== 'function') {
      invalid.push({ file, reason: '必须导出 { name: string, description: string, run: function }' });
      continue;
    }
    if (actions.has(mod.name)) {
      invalid.push({ file, reason: `与 ${actions.get(mod.name).file} 重名（${mod.name}）` });
      continue;
    }
    actions.set(mod.name, {
      file,
      description: mod.description || '',
      // params 可选：没有就是 null，而不是空对象——「没声明参数」和「声明了零个」不是一回事
      params: mod.params && typeof mod.params === 'object' ? mod.params : null,
      run: mod.run,
    });
  }

  return { actions, invalid };
}

/* ───────────────────────── 参数解析 ───────────────────────── */

const BOOL_FLAGS = new Set(['dry-run', 'skip-install']);

function parseArgs(argv) {
  const [name, ...rest] = argv;
  const opts = { _name: name };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith('--')) throw new UsageError(`无法识别的参数：${a}（所有参数需以 -- 开头）`);
    const key = a.slice(2);
    if (BOOL_FLAGS.has(key)) {
      opts[camel(key)] = true;
      continue;
    }
    const val = rest[i + 1];
    if (val === undefined || val.startsWith('--')) throw new UsageError(`${a} 缺少值`);
    opts[camel(key)] = val;
    i++;
  }
  return opts;
}

function camel(s) {
  return s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

/* ───────────────────────── 入口 ───────────────────────── */

async function main() {
  const dir = __dirname;
  const { actions, invalid } = loadActions(dir);

  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    return finish({ ok: false, error: { code: 'USAGE', message: err.message } }, 2);
  }

  if (!opts._name || opts._name === 'list' || opts._name === '--help') {
    return finish(
      {
        ok: invalid.length === 0,
        actions: [...actions.entries()].map(([name, a]) => ({
          uses: name,
          description: a.description,
          params: a.params,
          file: a.file,
        })),
        invalid,
      },
      invalid.length === 0 ? 0 : 2,
    );
  }

  const action = actions.get(opts._name);
  if (!action) {
    return finish(
      {
        ok: false,
        error: {
          code: 'UNKNOWN_ACTION',
          message: `未知工件 ${opts._name}`,
          hint: `可用：${[...actions.keys()].join(' / ') || '（无）'}`,
        },
      },
      2,
    );
  }

  try {
    const result = await action.run(opts);
    return finish(result, result.ok ? 0 : 1);
  } catch (err) {
    const code = err instanceof UsageError ? 'USAGE' : 'INTERNAL';
    return finish({ ok: false, error: { code, message: err.message } }, code === 'USAGE' ? 2 : 1);
  }
}

function finish(obj, code) {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
  process.exitCode = code;
}

if (require.main === module) main();

module.exports = { loadActions };
