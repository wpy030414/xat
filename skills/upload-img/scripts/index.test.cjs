#!/usr/bin/env node
'use strict';
/**
 * upload-img 的请求构造测试（不依赖外网）。
 *
 * 为什么需要它：真实接口在部分网络不可达、且服务端会因上游抖动返回 5xx，
 * 于是「上传失败」既可能是代码问题也可能是服务端问题，肉眼分不清。这里用本地
 * mock 图床把链路跑通，只验证我们能负责的部分：multipart 结构、链接归一与域名
 * 改写、重试策略、错误信息透传、退出码。
 *
 * 用法：
 *   node scripts/index.test.cjs
 *
 * 原理：脚本支持 IMG_UPLOAD_API 覆盖接口地址（测试用开关），测试把它指向本地
 * http server，然后以子进程方式调用真实的 CLI，断言服务端收到的请求。
 * mock 的返回值刻意模仿真实服务端：HTTP 链接 + img.cdn1.vip 域名。
 */

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const CLI = path.join(__dirname, 'index.cjs');
const CDN_HOST = 'cloudflareimg.cdn.sn';

// 1x1 透明 PNG，够用且不用引入二进制夹具。
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
);

/* ───────────────────────── mock 图床 ───────────────────────── */

function startMock() {
  return new Promise((resolve) => {
    const requests = [];
    const hits = {};
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const raw = Buffer.concat(chunks);
        const text = raw.toString('latin1');
        const img = text.match(
          /name="image"; filename="upload"\r\nContent-Type: application\/octet-stream\r\n\r\n([\s\S]*?)\r\n--/,
        );
        requests.push({
          url: req.url,
          contentLength: Number(req.headers['content-length']),
          bodyLength: raw.length,
          imageBytes: img ? Buffer.from(img[1], 'latin1').length : -1,
          boundaryOk: /^--[0-9a-f-]{36}\r\n/.test(text) && /--[0-9a-f-]{36}--\r\n$/.test(text),
          cdnField: (text.match(/name="cdn_name"\r\n\r\n([^\r]*)/) || [])[1] || null,
          cdnFieldCount: (text.match(/name="cdn_name"/g) || []).length,
        });

        const key = req.url;
        hits[key] = (hits[key] || 0) + 1;

        // 模拟上游抖动：首次 500，重试即成功。
        if (/fail=flaky/.test(req.url) && hits[key] === 1) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: '调用压缩API失败：模拟抖动' }));
          return;
        }
        // 模拟持续 500（压缩服务长期不可用）。
        if (/fail=always/.test(req.url)) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: '调用压缩API失败：cURL 错误 - 模拟' }));
          return;
        }
        // 模拟 4xx 确定性拒绝（真实场景：图片无法被解码）。
        if (/fail=400/.test(req.url)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: '图片无法被解码，请上传未损坏的有效图片文件。' }));
          return;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        // 与真实服务端一致：http 链接、img.cdn1.vip 域名。
        res.end(
          JSON.stringify({
            success: true,
            url: 'http://img.cdn1.vip/i/mock.webp',
            data: { url: 'http://img.cdn1.vip/i/mock.webp', storage_backend: 'local' },
          }),
        );
      });
    });
    // 端口 0 = 由系统分配，避免与用户本机端口冲突。
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, requests }));
  });
}

function runCli(apiBase, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI].concat(args), {
      env: Object.assign({}, process.env, { IMG_UPLOAD_API: apiBase }),
    });
    let out = '';
    child.stdout.on('data', (c) => (out += c));
    child.on('close', (code) => {
      let json = null;
      try {
        json = JSON.parse(out.trim());
      } catch (e) {
        /* 交给断言去报 */
      }
      resolve({ code, json, raw: out.trim() });
    });
  });
}

/* ───────────────────────── 断言 ───────────────────────── */

let failed = 0;

function check(name, cond, detail) {
  if (cond) {
    console.log('  ok   ' + name);
  } else {
    failed++;
    console.log('  FAIL ' + name + (detail === undefined ? '' : '  → ' + detail));
  }
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upload-img-test-'));
  const one = path.join(dir, 'one.png');
  const multi = path.join(dir, 'multi');
  fs.writeFileSync(one, PNG);
  fs.mkdirSync(multi);
  fs.writeFileSync(path.join(multi, 'a.png'), PNG);
  fs.writeFileSync(path.join(multi, 'b.jpg'), PNG);
  fs.writeFileSync(path.join(multi, 'notes.txt'), 'not an image');

  const { server, port, requests } = await startMock();
  const api = 'http://127.0.0.1:' + port + '/api/v1.php';

  /* ── 1. 单文件成功 ── */
  console.log('\n[单文件 · 成功]');
  let r = await runCli(api, [one]);
  let req = requests[requests.length - 1];
  check('退出码 0', r.code === 0, 'exit=' + r.code);
  check('只发 1 次请求', r.json && r.json.attempts === 1, r.json && r.json.attempts);
  check('multipart 边界首尾正确', req.boundaryOk);
  check('Content-Length = 实际 body 长度', req.contentLength === req.bodyLength);
  check('image 字段字节数 = 源文件大小', req.imageBytes === PNG.length, req.imageBytes);
  check('表单显式带 cdn_name=' + CDN_HOST, req.cdnField === CDN_HOST, req.cdnField);
  check('cdn_name 只出现一次', req.cdnFieldCount === 1, req.cdnFieldCount);
  check('cdn_name 不塞进 query', req.url.indexOf('cdn_name') < 0, req.url);
  check('http 链接被升到 https', r.json && r.json.url === 'https://' + CDN_HOST + '/i/mock.webp', r.json && r.json.url);
  check('api 字段为接口域名', r.json && r.json.api === '127.0.0.1:' + port, r.json && r.json.api);

  /* ── 2. 多余的参数（free / --cdn）被忽略，不影响结果 ── */
  console.log('\n[多余参数被忽略]');
  r = await runCli(api, [one, 'free']);
  check('多传 free 仍然成功', r.code === 0 && r.json.success === true, 'exit=' + r.code);
  check('链接照旧在 ' + CDN_HOST, r.json && r.json.url.indexOf(CDN_HOST) >= 0);
  r = await runCli(api, [one, '--cdn', 'img.cdn1.vip']);
  check('多传 --cdn 仍然成功', r.code === 0 && r.json.success === true, 'exit=' + r.code);

  /* ── 4. 目录批量 ── */
  console.log('\n[目录批量]');
  const before = requests.length;
  r = await runCli(api, [multi]);
  const batch = requests.slice(before);
  check('退出码 0', r.code === 0, 'exit=' + r.code);
  check('只上传图片（2 个，跳过 .txt）', batch.length === 2, '实际 ' + batch.length);
  check('total/failed 字段', r.json && r.json.total === 2 && r.json.failed === 0);
  check('每条结果都改写到目标域名', r.json && r.json.results.every((x) => x.url.indexOf(CDN_HOST) >= 0));

  /* ── 5. 5xx 重试后成功 ── */
  console.log('\n[5xx · 重试后成功]');
  r = await runCli(api + '?fail=flaky', [one]);
  check('退出码 0', r.code === 0, 'exit=' + r.code);
  check('共尝试 2 次（首次 500 + 重试成功）', r.json && r.json.attempts === 2, r.json && r.json.attempts);
  check('重试成功后仍返回链接', r.json && /mock\.webp/.test(r.json.url || ''));

  /* ── 6. 5xx 持续失败：带出服务端原文 ── */
  console.log('\n[5xx · 持续失败]');
  r = await runCli(api + '?fail=always', [one]);
  check('退出码 1', r.code === 1, 'exit=' + r.code);
  check('尝试满 2 次', r.json && r.json.attempts === 2, r.json && r.json.attempts);
  check('错误信息带服务端原文', r.json && /压缩API失败/.test(r.json.error || ''), r.json && r.json.error);

  /* ── 7. 4xx 不重试，且透传中文原因 ── */
  console.log('\n[4xx · 不重试]');
  r = await runCli(api + '?fail=400', [one]);
  check('退出码 1', r.code === 1, 'exit=' + r.code);
  check('只尝试 1 次', r.json && r.json.attempts === 1, r.json && r.json.attempts);
  check('错误含服务端中文原因', r.json && /图片无法被解码/.test(r.json.error || ''), r.json && r.json.error);
  check('错误含状态码', r.json && /400/.test(r.json.error || ''), r.json && r.json.error);

  /* ── 8. 参数与路径错误 ── */
  console.log('\n[错误分支]');
  r = await runCli(api, []);
  check('缺路径 → 退出码 2', r.code === 2, 'exit=' + r.code);
  check('缺路径 → 有 usage', r.json && !!r.json.usage);

  r = await runCli(api, [path.join(dir, 'no-such.png')]);
  check('路径不存在 → 退出码 2', r.code === 2, 'exit=' + r.code);

  const emptyDir = path.join(dir, 'empty');
  fs.mkdirSync(emptyDir);
  r = await runCli(api, [emptyDir]);
  check('空目录 → 退出码 1 且说明原因', r.code === 1 && /没有可上传/.test(r.json.error || ''), r.json && r.json.error);

  /* ── 9. 网络不可达 ── */
  console.log('\n[网络不可达]');
  r = await runCli('http://127.0.0.1:1/api/v1.php', [one]);
  check('连接被拒 → 退出码 1 且 success=false', r.code === 1 && r.json && r.json.success === false);
  check('标记 net=true', r.json && r.json.net === true);
  check('错误信息可读', r.json && /ECONNREFUSED|connect/i.test(r.json.error || ''), r.json && r.json.error);

  server.close();
  fs.rmSync(dir, { recursive: true, force: true });

  console.log('\n' + (failed ? failed + ' 项失败' : '全部通过'));
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
