---
name: upload-img
description: "将图片上传至免费图床（cloudflareimg.cdn.sn），返回公共 CDN 链接。"
argument-hint: "<local_uri>"
user-invocable: true
---

## 概览

将本地图片上传至 `cloudflareimg.cdn.sn`，返回公共 CDN 链接。

只走这一个域名，是实测结论，不是偏好：同一套接口在三个域名下都存在，但

- `img.scdn.io` —— 整站不可达（TCP 443 直接超时，要等约 20s 才失败）；
- `img.cdn1.vip` —— `/api` 前有验证码 WAF（返回 `_guard/html.js`），传不上去；
- `cloudflareimg.cdn.sn` —— 接口与 `/i/` 静态资源都 200，唯一全链路可用的。

三者共享同一份 `/i/<file>` 路径，所以服务端即使返回 `img.cdn1.vip` 的链接，本地把 host 换成 `cloudflareimg.cdn.sn` 即可（实测同一路径下 200）。

## 工具约束

- **目录探查**：使用 `Glob` 工具列出文件，禁止使用 `ls`、`find` 等 shell 命令。
- **上传操作**：所有上传逻辑通过 Bash 执行技能目录下的 `scripts/index.cjs`（Node.js）完成，禁止使用 `curl`、`wget` 等非 Node.js 的 shell 工具。
- 简言之：整个上传流程中，唯一的 shell 命令应只有 `node`，其余一律禁止。

## 参数

| 参数 | 必填 | 说明 |
|---|---|---|
| `<local_uri>` | 是 | 本地路径。文件 → 单文件上传；目录 → 批量上传（不递归，只挑图片扩展名）。 |

## 路径传参规范

- 路径作为 `node` 的位置参数传入，**禁止**内联到 `-e` 的 JS 代码字符串中——Windows 反斜杠路径（如 `C:\Users\...`）会被 Node.js 误解析为转义序列导致 SyntaxError。
- 建议在 shell 参数里把 `\` 写成 `/`（如 `"C:/Users/xrl/Pictures/test"`），避免 bash 自身的转义；脚本内部会自行 `path.resolve` 归一化。

## 操作步骤

1. **解析路径**：相对路径按当前工作目录解析为绝对路径。
2. **判断类型**：文件 → 单文件上传；目录 → 批量上传（跳过非图片）。
3. **执行上传命令**，解析 JSON。
4. **展示结果**：单文件 → 直接给链接；目录 → Markdown 表格。
5. **错误处理**：
   - 4xx（`图片无法被解码` / 体积过大等）→ 服务端中文原因会原样带在 `error` 里，直接转述，不要重试；
   - 5xx（多为上游 `调用压缩API失败`）→ 脚本已自动重试 1 次，仍失败则转述 `error`；
   - `net: true` → 域名不可达（网络层问题，不是参数问题）。

## API 接口

- **请求地址**：`POST https://cloudflareimg.cdn.sn/api/v1.php`
- **鉴权**：无需鉴权（公开 API）
- **请求格式**：`multipart/form-data`
- **文件字段**：`image`（File 类型，文件名固定为 `upload`，服务端按内容嗅探格式）
- **CDN 字段**：`cdn_name`（表单字段，值固定 `cloudflareimg.cdn.sn`）。服务端目前不据此改返回链接（实测仍返回 `img.cdn1.vip`），本地会把链接 host 改写兜住；显式带上是为了把「要哪个域名」表达在协议层，服务端哪天支持了即自动生效。
- **频率限制**：5 次 / 5 秒，120 次 / 60 秒
- **自动清理**：60 天无人访问的图片将被自动删除
- **最大体积**：20 MB（自动模式）

## 执行命令

```bash
# 单文件
node <skill_dir>/scripts/index.cjs "<图片路径>"
# 目录批量
node <skill_dir>/scripts/index.cjs "<目录路径>"
```

退出码：`0` 全部成功 / `1` 有文件上传失败 / `2` 参数非法或路径不存在。

**单文件响应**：
```json
{"mode":"file","file":"photo.webp","success":true,
 "url":"https://cloudflareimg.cdn.sn/i/xxx.webp",
 "api":"cloudflareimg.cdn.sn","attempts":1}
```

- `api`：实际使用的接口域名（当前恒为 `cloudflareimg.cdn.sn`）；
- `attempts`：总请求次数（含 5xx 重试）。

**目录响应**：
```json
{"mode":"directory","success":true,"total":2,"failed":0,
 "results":[{"file":"a.png","success":true,"url":"https://cloudflareimg.cdn.sn/i/xxx.webp","api":"cloudflareimg.cdn.sn","attempts":1}]}
```

**失败示例**：
```json
{"mode":"file","file":"x.png","success":false,"error":"图片无法被解码，请上传未损坏的有效图片文件。（HTTP 400）","net":false,"api":"cloudflareimg.cdn.sn","attempts":1}
```

## 测试

```bash
node <skill_dir>/scripts/index.test.cjs
```

本地 mock 图床 + 子进程调用真实 CLI，34 项断言：multipart 边界与长度、`cdn_name` 表单字段（值/唯一性/不进 query）、http→https 归一与域名改写、多余参数被忽略、目录批量、5xx 重试、4xx 不重试并透传中文原因、空目录、网络不可达。不依赖外网。

## 结果展示

- **单文件**：直接显示链接。
- **目录**：Markdown 表格（用原文件名展示）。

```
| 文件 | 链接 |
|---|---|
| a.png | https://cloudflareimg.cdn.sn/i/xxx.webp |
| b.jpg | https://cloudflareimg.cdn.sn/i/yyy.webp |
```

- 速度参考（实测 208 KB webp）：该域名总耗时约 0.9–1.6 s，TTFB 0.24–0.71 s；同内容在 `img.cdn1.vip` 下约 0.36–0.64 s（但它传不上去）。
