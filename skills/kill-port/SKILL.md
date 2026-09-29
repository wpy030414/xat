---
name: kill-port
description: "按端口号查找并终止占用进程。"
argument-hint: <port>
user-invocable: true
---

## 概览

通过平台原生工具查找指定端口的占用进程，先尝试优雅终止（Windows: `taskkill /PID`，Unix: `SIGTERM`），2 秒后仍存活则强制结束（Windows: `taskkill /F /PID`，Unix: `SIGKILL`）。

- **Windows**: `netstat -ano -p tcp` 查 PID → `tasklist` 查进程名 → `taskkill` 终止。
- **macOS / Linux**: `lsof -i tcp:<port> -t` 查 PID → `ps` 查进程名 → POSIX signal 终止。

## 工具约束

- 所有操作通过 Bash 执行 Node.js 完成，禁止使用 `curl`、`wget` 等非 Node.js 的 shell 工具。
- 简言之：唯一的 shell 命令应只有 `node`，其余一律禁止。

## 参数规范

- 端口号通过 `process.argv[1]` 传入，禁止内联到 `-e` 的 JS 代码字符串中。

## 操作步骤

1. 校验端口号为 1-65535 的正整数。
2. 通过 Bash 执行以下 Node.js 内联命令（跨平台自适应，无需手动选择分支）。
3. 解析 JSON 输出，展示结果给用户。

## 执行命令

```bash
node -e "
const {execSync}=require('child_process');
const os=require('os');
const port=process.argv[1];

if(!/^\d+$/.test(port)||port<1||port>65535){
  console.log(JSON.stringify({success:false,error:'无效端口号：'+port+', 请输入 1-65535 的值'}));
  process.exit(0);
}

const isWin=process.platform==='win32';

/* ── 1. 查找占用端口的 PID ── */
let pids=[];
try{
  if(isWin){
    const out=execSync('netstat -ano -p tcp',{encoding:'utf8',timeout:10000});
    const seen=new Set();
    for(const line of out.split('\n')){
      const m=line.match(/:(\d+)\s+\S+\s+\S+\s+(\d+)/);
      if(m && m[1]===port){
        const pid=parseInt(m[2],10);
        if(pid && pid!==0 && !seen.has(pid)){seen.add(pid);pids.push(pid);}
      }
    }
  }else{
    const out=execSync('lsof -i tcp:'+port+' -t',{encoding:'utf8',timeout:10000});
    pids=out.trim().split('\n').filter(Boolean).map(p=>parseInt(p.trim(),10));
  }
}catch(e){
  if(!isWin && e.status===1 && !e.stdout){pids=[];}
  else{console.log(JSON.stringify({success:false,error:'查找端口占用失败: '+e.message}));process.exit(0);}
}

if(pids.length===0){
  console.log(JSON.stringify({success:true,port:parseInt(port),message:'端口 '+port+' 未被占用',results:[]}));
  process.exit(0);
}

/* ── 2. 查询进程名 ── */
function getCommand(pid){
  try{
    if(isWin){
      const out=execSync('tasklist /FI \"PID eq '+pid+'\" /FO CSV /NH',{encoding:'utf8',timeout:5000});
      return out.split(',')[0].replace(/\"/g,'').trim()||'unknown';
    }else{
      return execSync('ps -p '+pid+' -o comm=',{encoding:'utf8',timeout:5000}).trim()||'unknown';
    }
  }catch(e){return 'unknown';}
}

/* ── 3. 终止进程 ── */
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const isPrivileged=port<1024;

(async()=>{
  const results=[];
  for(const pid of pids){
    const command=getCommand(pid);
    let signal='SIGTERM',killed=false;

    if(isWin){
      /*
       * Windows 策略：
       * 1. taskkill /PID → 发送 WM_CLOSE（等价 SIGTERM）
       *    注意：后台进程（无窗口）会直接拒绝此操作，这是预期行为，不是错误。
       * 2. 等待 2 秒后仍存活 → taskkill /F /PID（等价 SIGKILL）
       */
      let gentleOk=false;
      try{
        execSync('taskkill /PID '+pid,{encoding:'utf8',timeout:5000});
        gentleOk=true;
      }catch(e){
        /* 后台进程无窗口接收 WM_CLOSE 时 taskkill 返回非 0——正常，继续用 /F */
      }
      if(gentleOk){
        await sleep(2000);
        try{process.kill(pid,0);}catch(e2){if(e2.code==='ESRCH'){killed=true;signal='SIGTERM';}}
      }
      if(!killed){
        try{
          execSync('taskkill /F /PID '+pid,{encoding:'utf8',timeout:5000});
          killed=true;
          signal=gentleOk?'SIGKILL':'SIGKILL';
        }catch(e2){
          /* /F 也失败了——权限不足或进程已消失 */
          try{process.kill(pid,0);killed=false;}catch(e3){if(e3.code==='ESRCH')killed=true;}
          if(!killed) signal='EPERM';
        }
      }
    }else{
      /* Unix: POSIX signal */
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
      /* 二次确认 */
      if(signal==='SIGKILL'||signal==='SIGTERM'){
        try{process.kill(pid,0);}catch(e){if(e.code==='ESRCH')killed=true;}
      }
    }

    results.push({pid,command,signal,killed});
  }

  const allKilled=results.every(r=>r.killed);
  const msg=allKilled
    ?'端口 '+port+' 已释放 ('+results.length+' 个进程)'
    :'部分进程未能终止';
  const resp={success:allKilled,port:parseInt(port),message:msg,results};
  if(!allKilled && isPrivileged){
    resp.hint='特权端口（<1024）可能需要管理员/sudo 权限';
  }
  console.log(JSON.stringify(resp));
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

权限不足时（含 hint）：
```json
{"success":false,"port":80,"message":"部分进程未能终止","results":[{"pid":12345,"command":"nginx","signal":"EPERM","killed":false}],"hint":"特权端口（<1024）可能需要管理员/sudo 权限"}
```

## 结果展示

- 以 Markdown 表格展示终止结果：

```
| PID | 进程名 | 信号 | 结果 |
|---|---|---|---|
| 12345 | node | SIGTERM | 已终止 |
| 12346 | node | SIGKILL | 已终止 |
```

- 特权端口（<1024）失败时提示可能需要管理员/sudo 权限。
- 端口未被占用时直接告知用户。