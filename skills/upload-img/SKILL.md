---
name: upload-img
description: "将图片上传至 img.scdn.io 免费图床。"
argument-hint: <local_uri>
user-invocable: true
---

## 概览

将本地图片上传至 img.scdn.io，返回公共 CDN 链接。

## 工具约束

- **目录探查**：使用 `Glob` 工具列出文件，禁止使用 `ls`、`find` 等 shell 命令。
- **上传操作**：所有上传逻辑通过 Bash 执行 Node.js 完成，禁止使用 `curl`、`wget` 等非 Node.js 的 shell 工具。
- 简言之：整个上传流程中，唯一的 shell 命令应只有 `node`，其余一律禁止。

## 路径传参规范

- **禁止将路径内联到 `-e` 的 JS 代码字符串中**，Windows 反斜杠路径（如 `C:\Users\...`）会被 Node.js 误解析为转义序列导致 SyntaxError。
- **正确做法**：所有路径必须通过 `process.argv[1]`（单文件）或 `process.argv[1]`（目录）作为 shell 参数传入，并且 shell 参数中**将 `\` 替换为 `/`**（如 `"C:/Users/xrl/Pictures/test"`），避免 bash 转义问题。

## 操作步骤

1. **解析路径**：若为相对路径，基于当前工作目录解析为绝对路径。按「路径传参规范」将 `\` 替换为 `/`。
2. **判断类型**：文件 → 单文件上传；目录 → 批量上传（不递归，跳过非图片文件）。
3. **通过 Bash 执行 Node.js 上传命令**：使用下述内联 Node.js 命令，直接读取原文件构建 multipart 请求并上传。
4. **解析 JSON 响应**：提取 `data.url` 字段。若 `success` 为 false，显示错误信息。
5. **展示结果**：单文件 → 直接显示链接；目录 → 以 Markdown 表格展示所有结果。
6. **错误处理**：收到 429（频率限制）时，等待后重试。收到 413（文件过大）时，告知用户。网络错误时，显示错误信息。

## API 接口

- **请求地址**：`POST https://img.scdn.io/api/v1.php`
- **鉴权**：无需鉴权（公开 API）
- **请求格式**：`multipart/form-data`
- **文件字段**：`image`（File 类型，本地文件上传）
- **频率限制**：5 次 / 5 秒，120 次 / 60 秒
- **自动清理**：60 天无人访问的图片将被自动删除
- **最大体积**：20 MB（自动模式）

## 上传命令

通过 Bash 执行以下 Node.js 内联命令，将 `<路径>` 替换为目标路径（`\` 替换为 `/`）。脚本自动判断路径是文件还是目录，走对应的上传逻辑。

```bash
node -e "
const fs=require('fs'),path=require('path'),crypto=require('crypto'),https=require('https');
const exts=new Set(['.png','.jpg','.jpeg','.gif','.webp','.bmp','.svg','.ico','.tiff']);
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));

const upload=(src)=>new Promise((resolve)=>{
  const boundary=crypto.randomUUID();
  const body=Buffer.concat([
    Buffer.from('--'+boundary+'\r\nContent-Disposition: form-data; name=\"image\"; filename=\"upload\"\r\nContent-Type: application/octet-stream\r\n\r\n'),
    fs.readFileSync(src),
    Buffer.from('\r\n--'+boundary+'--\r\n')
  ]);
  const req=https.request('https://img.scdn.io/api/v1.php',{method:'POST',timeout:30000,headers:{'Content-Type':'multipart/form-data; boundary='+boundary,'Content-Length':body.length}},res=>{
    let d='';res.on('data',c=>d+=c);res.on('end',()=>{
      if(res.statusCode!==200){resolve({file:path.basename(src),success:false,error:'HTTP '+res.statusCode});return;}
      try{const j=JSON.parse(d);resolve({file:path.basename(src),success:j.success,url:j.data&&j.data.url,error:j.error});}catch(e){resolve({file:path.basename(src),success:false,error:'JSON parse failed'});}
    });
  });
  req.on('error',e=>resolve({file:path.basename(src),success:false,error:e.message}));
  req.on('timeout',()=>{req.destroy();resolve({file:path.basename(src),success:false,error:'timeout'});});
  req.write(body);req.end();
});

(async()=>{
  const target=process.argv[1];
  const stat=fs.statSync(target);

  if(stat.isFile()){
    let r=await upload(target);
    if(!r.success&&r.error==='timeout'){await sleep(2000);r=await upload(target);}
    console.log(JSON.stringify({mode:'file',...r}));
    return;
  }

  const files=fs.readdirSync(target).filter(f=>exts.has(path.extname(f).toLowerCase())).map(f=>path.join(target,f));
  const results=[];
  for(let i=0;i<files.length;i++){
    let r=await upload(files[i]);
    if(!r.success&&r.error==='timeout'){await sleep(2000);r=await upload(files[i]);}
    results.push(r);
    if(i<files.length-1) await sleep(1000);
  }
  console.log(JSON.stringify({mode:'directory',results}));
})();
" "<路径>"
```

**单文件响应示例**（`mode: "file"`）：
```json
{"mode":"file","file":"photo.png","success":true,"url":"https://img.cdn1.vip/i/xxx.webp"}
```

**目录响应示例**（`mode: "directory"`）：
```json
{"mode":"directory","results":[{"file":"a.png","success":true,"url":"https://img.cdn1.vip/i/xxx.webp"},{"file":"b.jpg","success":false,"error":"timeout"}]}
```

**注意事项**：
- 目录模式每次上传间隔 1000ms，遵守频率限制（5 次 / 5 秒）。
- 超时自动重试一次（间隔 2 秒后）。

## 结果展示

- **单文件**（`mode: "file"`）：直接显示链接给用户。
- **目录**（`mode: "directory"`）：以 Markdown 表格呈现结果（用原文件名展示）：

```
| 文件 | 链接 |
|---|---|
| a.png | https://img.cdn1.vip/i/xxx.webp |
| b.jpg | https://img.cdn1.vip/i/yyy.webp |
```
