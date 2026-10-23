---
name: upload-repo
description: "通过 git bundle + SCP 将当前项目部署到远程服务器，多策略扫描更新或新建，并执行项目定义的 CI/CD 工作流。"
argument-hint: "<user@host> [-p <dir>] [--use <path> | --create]"
user-invocable: true
---

## 概览

整个流程由 `scripts/index.cjs` 执行，你只做两件事：**遇到决策问用户，把结果讲清楚**。不要代替脚本重算路径或手拼 ssh 命令。

## 调用方式

```bash
SSHPASS='<密码>' node skills/upload-repo/scripts/index.cjs deploy <user@host> [选项]
```

参数见 `node skills/upload-repo/scripts/index.cjs --help`。

密码只从环境变量 `SSHPASS` 读，不接受命令行参数——argv 会进 `ps` 和 shell history。用户没给密码就不要设置该变量（只走 SSH key）。

## 输出契约

stdout 是**单个 JSON 对象**，`status` 有四种。

| status | 退出码 | 含义 | 做什么 |
|---|---|---|---|
| `planned` | 0 | `--dry-run` 的计划 | 转述，等用户确认 |
| `ok` | 0 | 完成 | 见「报告」 |
| `error` | 1 | 失败 | 读 `error.hint` 汇报，**不要重试** |
| `needs_input` | 3 | 需要用户决策 | 见下节 |

`error.code` 是机器分类码，`error.hint` 才是给人看的那句话。只有两处需要你知道：

- `HOST_UNREACHABLE` 和 `AUTH_FAILED` 别混：前者连不上（地址、端口、防火墙），后者才轮到密码和公钥。报错类型搞错，用户会跑去改密码。
- `INTERNAL` 是脚本自身的 bug：`error.message` 和 `stack` 原样交给用户。

## needs_input

脚本不会替你猜。收到这个 status 时：

1. **原文转述 `question`**，不要改写。
2. `candidates` 非空就列出来（带 `mtime`）。
3. 用户选定后，**直接用 `options[i].command` 重跑**——参数已经拼好了，只需把 `SSHPASS` 占位符换成真实密码。
4. 用户说「都不是」→ 选带 `--create` 的那个，或按用户给的新路径加 `-p`。
5. **同一个问题不问第二次**：`--use`、`--dirty overwrite` 已经内含答案。

## 报告

`status: ok` 时，`summary.table` 已经是可直贴的 Markdown 表格——**原样贴，不要重画**。

贴完补四件事：

1. **`ci.failed` 非空就放最前面说**。部署成功但构建/重启失败，是最需要立刻知道的状态。
2. **分清「进程未被触碰」和「线上可能已不可用」**：凡没走到重启那步，旧版本仍在服务；旧进程已停而新进程没起来，是立刻要处置的状态。判据读 `error.hint`。
3. **`ci.files[].steps[]` 逐条列**，不要只说「失败了」——用户要知道卡在哪一步才能决定回滚还是重跑。
4. **`ci.files[].warnings` 非空必须转述**。它意味着某一步被跳过或写法不规范；容错是为了「少跑一步也不静默」，你不转述，用户就永远不知道那步没跑。

## 什么时候不要用脚本

脚本只覆盖「常规服务器、常规目录」这一条主干。遇到这些，退回手工排查并把结论告诉用户，不要让脚本硬撞：

- 目标目录是**工作树**（`.git` 是文件而非目录），或路径挂在网络存储上（探测会超时）。
- SSH 走跳板机 / 非 22 端口 / 特殊 ssh config —— 脚本用固定选项，连不上就如实说。
- 扫描很慢：`find /home -maxdepth 4` 在存储慢的机器上就是慢，加 `-p` 可跳过。

> 用户要写或改 `.xat/workflows/` 时，读 `references/WORKFLOWS.md`。
