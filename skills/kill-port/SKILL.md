---
name: kill-port
description: "按端口号查找并终止占用进程。"
argument-hint: <port>
user-invocable: true
---

## 概览

通过 `lsof` 查找指定端口的占用进程，先发 `SIGTERM` 优雅终止，2 秒后仍存活则 `SIGKILL` 强制结束。

## 工具约束

- 所有操作通过 Bash 执行 Node.js 完成，禁止使用 `curl`、`wget` 等非 Node.js 的 shell 工具。
- 简言之：唯一的 shell 命令应只有 `node`，其余一律禁止。

## 参数规范

- 端口号通过 `process.argv[1]` 传入，禁止内联到 `-e` 的 JS 代码字符串中。

## 操作步骤

1. 校验端口号为 1-65535 的正整数。
2. 通过 Bash 执行以下 Node.js 内联命令。
3. 解析 JSON 输出，展示结果给用户。

## 执行命令

```bash
node -e "
const {execSync}=require('child_process');
const port=process.argv[1];

if(!/^\d+$/.test(port)||port<1||port>65535){
  console.log(JSON.stringify({success:false,error:'无效端口号：'+port+', 请输入 1-65535 的值'}));
  process.exit(0);
}

let pids=[];
try{
  const out=execSync('lsof -i tcp:'+port+' -t',{encoding:'utf8',timeout:10000});
  pids=out.trim().split('\n').filter(Boolean).map(p=>parseInt(p.trim(),10));
}catch(e){
  if(e.status===1&&!e.stdout){pids=[];}
  else{console.log(JSON.stringify({success:false,error:'lsof 执行失败: '+e.message}));process.exit(0);}
}

if(pids.length===0){
  console.log(JSON.stringify({success:true,port:parseInt(port),message:'端口 '+port+' 未被占用',results:[]}));
  process.exit(0);
}

const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const results=[];

(async()=>{
  for(const pid of pids){
    let command='unknown';
    try{command=execSync('ps -p '+pid+' -o comm=',{encoding:'utf8',timeout:5000}).trim();}catch(e){}

    let signal='SIGTERM',killed=true;
    try{
      process.kill(pid,'SIGTERM');
      await sleep(2000);
      try{process.kill(pid,0);signal='SIGKILL';process.kill(pid,'SIGKILL');}
      catch(e2){if(e2.code==='ESRCH')killed=true;}
    }catch(e){
      if(e.code==='EPERM'){killed=false;signal='EPERM';}
      else if(e.code==='ESRCH'){killed=true;}
      else{killed=false;signal=e.code;}
    }

    results.push({pid,command,signal,killed});
  }

  const allKilled=results.every(r=>r.killed);
  console.log(JSON.stringify({
    success:allKilled,
    port:parseInt(port),
    message:allKilled?'端口 '+port+' 已释放 ('+results.length+' 个进程)':'部分进程未能终止',
    results
  }));
})();
" <端口号>
```

**响应 JSON 结构**：

```json
{
  "success": true,
  "port": 3000,
  "message": "端口 3000 已释放 (1 个进程)",
  "results": [
    {"pid": 12345, "command": "node", "signal": "SIGTERM", "killed": true}
  ]
}
```

端口未被占用时：
```json
{"success":true,"port":3000,"message":"端口 3000 未被占用","results":[]}
```

## 结果展示

- 以 Markdown 表格展示终止结果：

```
| PID | 进程名 | 信号 | 结果 |
|---|---|---|---|
| 12345 | node | SIGTERM | 已终止 |
| 12346 | node | SIGKILL | 已终止 |
```

- 特权端口（<1024）失败时提示可能需要 `sudo`。
- 端口未被占用时直接告知用户。