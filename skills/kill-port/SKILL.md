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

- 所有操作通过 Bash 执行技能目录下的 `scripts/index.cjs`（Node.js）完成，禁止使用 `curl`、`wget` 等非 Node.js 的 shell 工具。
- 简言之：唯一的 shell 命令应只有 `node`，其余一律禁止。

## 参数规范

- 端口号作为 `node` 的位置参数传入（脚本内读取 `process.argv[2]`），禁止内联到 `-e` 的 JS 代码字符串中。

## 操作步骤

1. 校验端口号为 1-65535 的正整数（脚本内部已校验，非法时返回用法错误）。
2. 通过 Bash 执行 `scripts/index.cjs`（跨平台自适应，无需手动选择分支）。
3. 解析 JSON 输出，展示结果给用户。

## 执行命令

```bash
node <skill_dir>/scripts/index.cjs <端口号>
```

退出码：`0` 成功（含「端口未被占用」）/ `1` 有进程未能终止 / `2` 端口参数非法。

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
