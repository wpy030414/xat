#!/usr/bin/env node
'use strict';
/**
 * upload-img —— 把本地图片上传到免费图床，返回公共 CDN 链接。
 *
 * 接口与链接都只走 cloudflareimg.cdn.sn（Cloudflare 承载）。这是实测唯一在本机
 * 网络里整条链路都通的域名：
 *   - img.scdn.io     整站不可达（TCP 443 直接超时，等约 20s 才失败）；
 *   - img.cdn1.vip    /api 前有验证码 WAF（返回 _guard/html.js），传不上去；
 *   - cloudflareimg.cdn.sn  接口与 /i/ 静态资源都 200。
 * 三个域名共享同一份 /i/<file> 路径，所以服务端即使返回 img.cdn1.vip 的链接，
 * 本地把 host 换掉即可（实测同一路径在 cloudflareimg 下 200）。
 *
 * 用法：
 *   node index.cjs <路径>        # 路径可以是单个文件，也可以是目录（不递归）
 *
 * 输出：单个 JSON 对象到 stdout，供 AI 解析展示。
 * 退出码：0 全部成功 / 1 有文件失败 / 2 用法错误。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const http = require('http');

const CDN_HOST = 'cloudflareimg.cdn.sn';
const DEFAULT_API = 'https://' + CDN_HOST + '/api/v1.php';

const EXIT = { ok: 0, fail: 1, usage: 2 };

// 目录批量上传时只挑这些扩展名，其余静默跳过。
const EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.ico', '.tiff']);

// 网络层失败：多为域名不可达，重试无意义但成本低（同一域名仍会试一次兜抖动）。
const NET_ERRORS = new Set([
  'ETIMEDOUT', 'ECONNREFUSED', 'ECONNRESET', 'EAI_AGAIN',
  'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE', 'timeout',
]);

// 服务端限流：5 次 / 5 秒，120 次 / 60 秒。逐张间隔 1 秒是最省事的安全值。
const GAP_MS = 1000;
const RETRY_MS = 1500;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function emit(obj, code) {
  process.stdout.write(JSON.stringify(obj) + '\n');
  process.exitCode = code === undefined ? EXIT.ok : code;
  return obj;
}

/* ───────────────────────── 参数解析 ───────────────────────── */

function parseArgs(argv) {
  const out = { target: null, help: false };
  for (const a of argv) {
    if (a === '--help' || a === '-h') out.help = true;
    // 只认第一个非选项参数作路径；其余（free、--cdn 之类的历史残留）直接忽略。
    else if (!out.target && a[0] !== '-') out.target = a;
  }
  return out;
}

/* ───────────────────────── 链接归一 ───────────────────────── */

// 服务端返回 http://img.cdn1.vip/...：http 会先吃一次 301，统一升到 https；
// host 换成 cloudflareimg.cdn.sn —— 三个域名共享同一份 /i/ 路径，换 host 安全。
function normalizeUrl(url) {
  if (!url) return url;
  return url.replace(/^http:\/\//i, 'https://').replace(/^https:\/\/[^/]+/i, 'https://' + CDN_HOST);
}

/* ───────────────────────── 请求构造 ───────────────────────── */

// multipart 手拼：不引第三方依赖，也便于逐字节对齐服务端预期。
function buildBody(src) {
  const boundary = crypto.randomUUID();
  const body = Buffer.concat([
    Buffer.from(
      '--' + boundary + '\r\n' +
        // 固定文件名：图床按内容嗅探格式，不依赖扩展名。
        'Content-Disposition: form-data; name="image"; filename="upload"\r\n' +
        'Content-Type: application/octet-stream\r\n\r\n',
    ),
    fs.readFileSync(src),
    Buffer.from('\r\n'),
    // 显式声明想要的 CDN 域名。服务端目前并不据此改返回链接（本地会改写 host），
    // 但带上它有两个实际意义：把「要哪个域名」表达在协议层而不是只写在代码里；
    // 服务端哪天支持了就自动生效，不必再改客户端。
    Buffer.from(
      '--' + boundary + '\r\n' +
        'Content-Disposition: form-data; name="cdn_name"\r\n\r\n' +
        CDN_HOST + '\r\n',
    ),
    Buffer.from('--' + boundary + '--\r\n'),
  ]);
  return { boundary, body };
}

function apiUrl() {
  // IMG_UPLOAD_API 是测试开关：指向本地 mock 时走它。
  return process.env.IMG_UPLOAD_API || DEFAULT_API;
}

/* ───────────────────────── 单次请求 ───────────────────────── */

function postOnce(src) {
  return new Promise((resolve) => {
    let built;
    try {
      built = buildBody(src);
    } catch (e) {
      resolve({ kind: 'fatal', error: '读取文件失败: ' + e.message });
      return;
    }

    const url = apiUrl();
    const transport = new URL(url).protocol === 'http:' ? http : https;
    const req = transport.request(
      url,
      {
        method: 'POST',
        timeout: 45000,
        headers: {
          'Content-Type': 'multipart/form-data; boundary=' + built.boundary,
          'Content-Length': built.body.length,
        },
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          let json = null;
          try {
            json = JSON.parse(data);
          } catch (e) {
            /* 非 JSON 响应（如 WAF 验证码页）留空 */
          }

          if (res.statusCode === 200 && json && json.success) {
            resolve({ kind: 'ok', url: (json.data && json.data.url) || json.url, raw: json });
            return;
          }
          // 4xx 是确定性拒绝（体积过大 / 图片损坏 / 参数错），重试没用。
          // 服务端的 error/message 是中文人话（如「图片无法被解码」），务必带出来。
          if (res.statusCode >= 400 && res.statusCode < 500) {
            const msg = json && (json.error || json.message);
            resolve({
              kind: 'fatal',
              error: msg ? msg + '（HTTP ' + res.statusCode + '）' : 'HTTP ' + res.statusCode,
              raw: json,
            });
            return;
          }
          // 5xx 多为服务端上游抖动（实测有「调用压缩API失败」），再试一次常有救。
          resolve({
            kind: 'retryable',
            error: (json && (json.error || json.message)) || 'HTTP ' + res.statusCode,
            status: res.statusCode,
          });
        });
      },
    );

    req.on('error', (e) => {
      const code = e.code || 'ERROR';
      resolve({ kind: NET_ERRORS.has(code) ? 'retryable' : 'fatal', error: code + ' ' + e.message, net: true });
    });
    req.on('timeout', () => {
      req.destroy();
      resolve({ kind: 'retryable', error: 'timeout', net: true });
    });
    req.write(built.body);
    req.end();
  });
}

/* ───────────────────────── 单文件上传 ───────────────────────── */

async function uploadOne(src) {
  const file = path.basename(src);
  let last = null;

  for (let attempt = 1; attempt <= 2; attempt++) {
    const r = await postOnce(src);
    if (r.kind === 'ok') {
      return { file, success: true, url: normalizeUrl(r.url), api: new URL(apiUrl()).host, attempts: attempt };
    }
    last = r;
    if (r.kind === 'fatal') break;
    if (attempt === 1) await sleep(RETRY_MS);
  }

  return {
    file,
    success: false,
    error: (last && last.error) || '上传失败',
    net: !!(last && last.net),
    api: new URL(apiUrl()).host,
    attempts: last && last.kind === 'fatal' ? 1 : 2,
  };
}

/* ───────────────────────── 主流程 ───────────────────────── */

async function main() {
  const opt = parseArgs(process.argv.slice(2));

  if (opt.help) {
    return emit({ success: false, mode: 'none', usage: 'node index.cjs <路径>' }, EXIT.ok);
  }
  if (!opt.target) {
    return emit(
      { success: false, mode: 'none', error: '缺少路径参数', usage: 'node index.cjs <路径>' },
      EXIT.usage,
    );
  }
  if (!opt.target) {
    return emit(
      { success: false, mode: 'none', error: '缺少路径参数', usage: 'node index.cjs <路径>' },
      EXIT.usage,
    );
  }

  const target = path.resolve(opt.target);
  let stat;
  try {
    stat = fs.statSync(target);
  } catch (e) {
    return emit({ success: false, mode: 'none', error: '路径不存在或不可访问: ' + target }, EXIT.usage);
  }

  if (stat.isFile()) {
    const r = await uploadOne(target);
    return emit(Object.assign({ mode: 'file' }, r), r.success ? EXIT.ok : EXIT.fail);
  }

  if (!stat.isDirectory()) {
    return emit({ success: false, mode: 'none', error: '不是普通文件或目录: ' + target }, EXIT.usage);
  }

  let names;
  try {
    names = fs.readdirSync(target);
  } catch (e) {
    return emit({ success: false, mode: 'directory', error: '读取目录失败: ' + e.message }, EXIT.fail);
  }

  const files = names
    .filter((f) => {
      if (!EXTS.has(path.extname(f).toLowerCase())) return false;
      // 目录名带图片扩展名的情况不多，但 statSync 一次比事后报错便宜。
      try {
        return fs.statSync(path.join(target, f)).isFile();
      } catch (e) {
        return false;
      }
    })
    .sort()
    .map((f) => path.join(target, f));

  if (!files.length) {
    return emit(
      { mode: 'directory', results: [], success: false, error: '目录下没有可上传的图片: ' + target },
      EXIT.fail,
    );
  }

  const results = [];
  for (let i = 0; i < files.length; i++) {
    results.push(await uploadOne(files[i]));
    if (i < files.length - 1) await sleep(GAP_MS);
  }

  const allOk = results.every((r) => r.success);
  return emit(
    {
      mode: 'directory',
      success: allOk,
      total: results.length,
      failed: results.filter((r) => !r.success).length,
      results,
    },
    allOk ? EXIT.ok : EXIT.fail,
  );
}

main().catch((e) => emit({ success: false, mode: 'none', error: (e && e.message) || String(e) }, EXIT.fail));
