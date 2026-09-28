---
name: upload-repo
description: "通过 git bundle + SCP 将当前项目部署到远程服务器，多策略扫描更新或新建，并执行项目定义的 CI/CD 工作流。"
argument-hint: "<user@host | username host> [password|-]"
user-invocable: true
---

## 概览

将当前目录的 git 仓库打包为 bundle，通过 SCP 上传至远程服务器，多策略自动扫描服务器上已有的同名/同源仓库并优先更新，仅在全未命中时创建全新部署，并在部署完成后执行项目定义的 CI/CD 工作流。

> **核心原则**：本技能作为操作指引，每步由 AI 判断实际输出后决定下一步。不依赖预设脚本覆盖所有分支——AI 的上下文理解能力比穷举代码更可靠。

## 参数

| 参数 | 必填 | 说明 |
|---|---|---|
| `<user@host | username host>` | 是 | 紧凑格式：`root@example.xrl.im`；或分两参数 `root example.xrl.im` |
| `[password]` | 否 | 服务器密码，传 `-` 或留空则仅尝试 SSH key 认证 |
| `[-p <remote_dir>]` | 否 | 服务器上的部署目录 |

> **参数解析优先级**：若第一个参数包含 `@`（如 `root@1.2.3.4`），从中拆分 `username` 和 `host`，忽略第二个参数中的地址部分（若有）。若不含 `@`，则第一、二个参数分别为 `username` 和 `host`。

## 操作约束

- **密码安全**：密码通过环境变量 `SSHPASS` 传递，禁止将密码内联到任何 shell 命令字符串中。
- **等待标志**：所有远程命令（`scp`、`ssh`、`sshpass`）必须等待其进程自然退出后才能进入下一步。
- **非交互**：`scp`/`ssh` 使用 `-o StrictHostKeyChecking=no` 跳过首次连接指纹确认；`-o ConnectTimeout=10` 防止长时间挂起。
- **错误即停**：任何步骤失败后立即向用户报告，不继续执行后续步骤。若某步骤的失败不影响核心目标（如 SSH 免密配置失败），可标注为非致命继续。

## 操作步骤

### 0. 解析参数

从用户输入中解析：

- **用户名与服务器地址**：
  - 若第一个参数包含 `@`（如 `root@example.xrl.im`），按 `@` 拆分为 `username`（`@` 左侧）和 `host`（`@` 右侧）。
  - 若不含 `@`，第一参数为 `username`，第二参数为 `host`。
  - 均不包含时告知用户参数不完整，退出。
- `password`（可选，紧跟 host 之后的参数，`-` 视为无密码）
- `-p <remote_dir>`（可选）
- 获取当前目录名作为 `repo_name`（`basename $(pwd)`）

**解析示例：**

| 用户输入 | username | host | password |
|---|---|---|---|
| `root@example.xrl.im mypass` | root | example.xrl.im | mypass |
| `root example.xrl.im mypass` | root | example.xrl.im | mypass |
| `root@example.xrl.im -` | root | example.xrl.im | 无（key 认证） |
| `root example.xrl.im` | root | example.xrl.im | 无（key 认证） |

### 1. 前置检查

执行以下检查，任何一项失败则告知用户并退出：

```bash
git rev-parse --abbrev-ref HEAD
```
- 若失败：告知用户「当前目录不是 git 仓库，请在项目根目录下运行」。
- 输出为 `HEAD`：告知用户「当前处于 detached HEAD 状态，请先切换到具体分支（如 `git checkout main`）」，退出。
- 正常输出：将分支名存入上下文变量 `<branch>`。

检测安装依赖：
```bash
which sshpass
```
- 若不存在且用户提供了密码：告知用户「sshpass 未安装，请执行 `brew install sshpass`（macOS）或 `apt install sshpass`（Linux）」退出。

### 2. 建立 SSH 连接

**重要：分步判断，每步读取实际输出。**

#### 2a. 尝试 SSH key 认证

```bash
ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 -o BatchMode=yes <username>@<host> 'echo SSH_OK'
```

- 输出包含 `SSH_OK` → key 认证成功。`ssh_method = "key"`，跳到 2d。
- 失败 + 用户未提供密码 → 告知「SSH 密钥认证失败，且未提供密码」，退出。
- 失败 + 用户提供了密码 → 进入 2b。

#### 2b. 密码认证兜底

```bash
SSHPASS=<password> sshpass -e ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 <username>@<host> 'echo SSH_OK'
```

- 输出包含 `SSH_OK` → 密码认证成功。`ssh_method = "password"`，进入 2c。
- 失败 → 告知「密钥和密码认证均失败」，退出。

#### 2c. 配置 SSH 免密登录（仅密码认证成功后执行）

检测本机公钥（优先级从高到低）：
```bash
cat ~/.ssh/id_ed25519.pub 2>/dev/null || cat ~/.ssh/id_rsa.pub 2>/dev/null || echo NO_KEY
```
- 输出 `NO_KEY` → 跳过免密配置（标注非致命），进入 2d。

读取到公钥后，检查服务器是否已有：

```bash
SSHPASS=<password> sshpass -e ssh -o StrictHostKeyChecking=no <username>@<host> "mkdir -p ~/.ssh && chmod 700 ~/.ssh && grep -qF '<pubkey>' ~/.ssh/authorized_keys 2>/dev/null && echo EXISTS || echo NOT_FOUND"
```

- 输出 `EXISTS` → 跳过，标注「服务器已存在本机公钥」。
- 输出 `NOT_FOUND` → 追加公钥：

```bash
SSHPASS=<password> sshpass -e ssh -o StrictHostKeyChecking=no <username>@<host> "echo '<pubkey>' >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys && echo KEY_ADDED"
```
- 此步骤失败标注非致命，不阻塞后续流程。

#### 2d. 封装远程执行辅助变量

根据 `ssh_method` 构造后续远程命令前缀：
```bash
# ssh_method == "key" → 直接使用 ssh
SSH_CMD="ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 <username>@<host>"
SCP_CMD="scp -o StrictHostKeyChecking=no -o ConnectTimeout=10"

# ssh_method == "password" → 使用 sshpass -e
SSH_CMD="SSHPASS=<password> sshpass -e ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 <username>@<host>"
SCP_CMD="SSHPASS=<password> sshpass -e scp -o StrictHostKeyChecking=no -o ConnectTimeout=10"
```

后续所有远程操作通过 `$SSH_CMD` 和 `$SCP_CMD` 执行。

### 3. 创建 git bundle

```bash
git bundle create /tmp/<repo_name>.bundle <branch>
```

> 仅打包当前分支，bundle 内只有一个 ref，远端 fetch + reset 时无歧义。

执行后：
- 失败 → 告知原因，退出。
- 成功 → 获取 bundle 文件大小：

```bash
ls -lh /tmp/<repo_name>.bundle | awk '{print $5}'
```

向用户报告：「创建 bundle 完成，大小 <size>」。

### 4. 上传 bundle 到服务器

先确保远程部署目录存在：

```bash
$SSH_CMD "mkdir -p ~/.xat-deploy"
```

上传 bundle：

```bash
$SCP_CMD /tmp/<repo_name>.bundle <username>@<host>:~/.xat-deploy/<repo_name>.bundle
```

- 失败 → 清理本地 `/tmp/<repo_name>.bundle`，告知原因，退出。

### 5. 远程部署（多策略降级扫描）

**核心逻辑：四层降级扫描，逐层下探。**

```
5a: 精确路径匹配（快速命中）
  ↓ 未命中 + 用户未指定 -p
5b: 文件名扫描（同名仓库搜索）
  ↓ 未命中
5c: Git 起源匹配（同源仓库搜索）
  ↓ 未命中
5d: 全新部署（兜底）
```

> **关键规则**：
> - 若用户显式通过 `-p` 指定了路径，**仅执行 5a**——尊重用户意图，不做扫描。
> - 若用户未指定 `-p`（使用默认路径），5a 未命中后自动下探 5b、5c。
> - 5b 发现**唯一候选**时可直接使用，无需用户确认。
> - 5b / 5c 发现**多个候选**时列出来，由 AI 选择最近修改的那个；若时间相近（<1 天）则询问用户。
> - 5c 发现的候选必须经用户确认（因为目录名已变更，用户可能忘了）。

---

#### 5a. 精确路径匹配

先探查 `<remote_path>`（用户 `-p` 指定的路径，**若未显式传入则跳到 5b**）：

```bash
$SSH_CMD "ls -la <remote_path> 2>/dev/null && echo '---DIR_OK---' || echo 'DIR_NOT_FOUND'; \
  ls -la <remote_path>/.git 2>/dev/null && echo '---GIT_OK---' || echo 'GIT_NOT_FOUND'; \
  cd <remote_path> 2>/dev/null && git status 2>&1 || echo 'GIT_NOT_FOUND'"
```

> 三条探查合并为一次 SSH 连接，输出顺序固定：先 DIR 状态行，再 GIT 状态行，最后 `git status` 输出或 `GIT_NOT_FOUND`。

**分支处理**（按优先级匹配第一个满足的状态）：

| 远程实际状态 | 判定依据 | 处理策略 |
|---|---|---|
| 目录不存在（`DIR_NOT_FOUND`） | 第一行即为 `DIR_NOT_FOUND` | 若用户未指定 `-p` → 不立即新建，进入 5b。若用户指定了 `-p` → `mkdir -p` 后全新部署（跳到 5d 的全新部署命令）。 |
| 目录存在但不是 git 仓库 | `DIR_OK` + `GIT_NOT_FOUND` | 检查目录是否为空：为空 → 直接初始化并部署；非空 → 告知用户目录非空且非 git 仓库，**不覆盖**，要求手动处理或指定 `-p` 其他路径。 |
| 目录存在且是 git 仓库 | `DIR_OK` + `GIT_OK` + `git status` 正常输出 | 命中！记录 `scan_strategy = "5a:精确路径"`。检查 `git status` 是否有未提交改动、detached HEAD、或正在进行的合并/变基。**干净** → 直接 `git reset --hard FETCH_HEAD` 强制对齐；**不干净** → 告知用户远程有未提交的改动，询问是否强制覆盖（确认后同上）。 |
| 裸仓库（bare repo） | `git status` 报错提及 `bare repository` | 告知用户「远程是一个裸仓库，不适合直接部署代码」，建议改为 `-p` 指定其他路径。 |
| 同名文件/目录但不是仓库 | `DIR_OK` + `GIT_NOT_FOUND` + 非空 | 告知路径被占用且非 git 仓库，**不覆盖**。 |

---

#### 5b. 文件名扫描

在服务器上的常见部署目录中搜索名为 `<repo_name>` 且包含 `.git` 的目录：

```bash
$SSH_CMD "find ~/.xat-deploy -maxdepth 2 -name '<repo_name>' -type d \
  -exec test -d {}/.git \; -print 2>/dev/null; \
  find /home -maxdepth 4 -name '<repo_name>' -type d \
  -exec test -d {}/.git \; -print 2>/dev/null; \
  find /srv /var/www /opt -maxdepth 3 -name '<repo_name>' -type d \
  -exec test -d {}/.git \; -print 2>/dev/null"
```

| 搜索路径 | 深度 | 说明 |
|---|---|---|
| `~/.xat-deploy` | 2 | 本 skill 的默认部署位置 |
| `/home` | 4 | 用户家目录下的项目 |
| `/srv` | 3 | 服务部署目录 |
| `/var/www` | 3 | Web 服务目录 |
| `/opt` | 3 | 手工安装的软件 |

**候选数量处理**：

| 结果数 | 行为 |
|---|---|
| 0 | 进入 5c。 |
| 1 | 直接使用该路径作为 `remote_path`，记录 `scan_strategy = "5b:文件名扫描"`，输出提示「在 <path> 发现同名仓库，自动使用此路径」。 |
| ≥2 | 列出候选。若有某个候选的修改时间明显更近（差距 > 1 天），自动选择最新的并告知用户；否则列出所有候选，标注路径和最后修改时间，询问用户选择。 |

---

#### 5c. Git 远程起源匹配

当 5a 和 5b 均未命中时，可能是用户在服务器上重命名了目录。通过比对 remote origin URL 来找同源仓库。

先获取本地的 origin URL（用于后续对比）：

```bash
git remote get-url origin 2>/dev/null
```

> 若无 origin（纯本地仓库），跳过 5c，直接进入 5d。

在服务器上扫描所有 git 仓库的 origin URL：

```bash
$SSH_CMD "timeout 15 find /home /srv /var/www /opt ~/.xat-deploy \
  -maxdepth 4 -type d -name '.git' \
  -exec sh -c 'dir=\$(dirname {}); url=\$(cd \"\$dir\" && git remote get-url origin 2>/dev/null); [ -n \"\$url\" ] && echo \"\$dir|\$url\"' \; \
  2>/dev/null || true"
```

> - `timeout 15` 防止扫描卡死；超时视为0结果，直接进入策略4。
> - `|| true` 确保 `timeout` 的非零退出码不会阻塞流程。
> - 输出格式：`<目录路径>|<origin_url>`，AI 解析后对比。

**对比逻辑**（AI 侧执行）：

1. 解析每条 `路径|URL` 记录。
2. 将每条记录的 URL 与本地 origin URL 做**等价归一化判断**：
   - 去除协议前缀差异（`https://` ↔ `git@` + `:` ↔ `ssh://git@` ↔ `git://`）：统一提取 `host + path` 部分
   - 去除端口号差异（`git@host:2222:repo` ↔ `ssh://git@host:22/repo` ↔ `git@host:repo`）
   - 去除尾部 `.git`
   - 归一化后完全一致即为同源
3. 收集所有同源记录。

**候选数量处理**：

| 结果数 | 行为 |
|---|---|
| 0 | 进入 5d。 |
| 1 | 给出路径，告知用户「在 <path> 发现同源仓库（目录名已变更），是否使用此路径更新？」——用户确认后使用，拒绝则进入 5d。记录 `scan_strategy = "5c:起源匹配"`。 |
| ≥2 | 列出所有同源路径，标注路径和 origin URL，询问用户选择。用户确认后使用所选路径，拒绝则进入 5d。 |

> **5c 的候选必须经用户确认**——目录名已变更意味着用户可能做过有意的结构调整，不应自动覆盖。

---

#### 5d. 全新部署

前三策略均未命中时的兜底方案。

```bash
$SSH_CMD "git clone ~/.xat-deploy/<repo_name>.bundle <remote_path>"
```

记录 `scan_strategy = "5d:全新部署"`。

---

**更新已有仓库命令参考（5a / 5b / 5c 命中后使用）：**

```bash
# 拉取 bundle 中当前分支的提交，并强制对齐
$SSH_CMD "cd <remote_path> && git fetch ~/.xat-deploy/<repo_name>.bundle <branch> && git reset --hard FETCH_HEAD"
```

> `<branch>` 为步骤 1 中获取的本地当前分支名——bundle 创建时该分支已打包在内。

**处理 fetch 结果时注意**：

- 输出包含 `Already up to date` → 仓库已是最新，标注 `action = "up_to_date"`。
- `git reset --hard` 会丢弃远程工作区所有未提交改动，与「远程仓库不干净时询问用户」的规则一致——仅在用户确认后执行。
- 其余错误 → 逐字读取 stderr，AI 判断原因后告知用户。

> **重要**：不要机械枚举场景然后死板匹配。远程可能的状态组合远不止这些——用命令探查，然后像工程师排查问题一样，看什么、判什么、做什么。

### 6. CI / CD

部署完成后，扫描项目根目录下的 `.xat/workflows/` 目录中所有 `.yml` / `.yaml` 文件，将其解析为远程构建/重启指令并在服务器上执行。

#### 6a. 扫描工作流文件

```bash
find .xat/workflows -maxdepth 1 \( -name '*.yml' -o -name '*.yaml' \) -type f 2>/dev/null
```

- 无任何 `.yml` 或 `.yaml` 文件 → 跳过本章节（标注「无工作流配置」），直接进入步骤 7。
- 有一条或多条 → 进入 6b。

#### 6b. 解析工作流定义

逐个读取命中的文件，解析其内容。工作流文件为 YAML 格式，结构如下：

```yaml
steps:
  - name: <步骤名称>
    run: <shell 命令>
  - name: <步骤名称>
    run: <shell 命令>
  - name: <步骤名称>
    run: |
      <多行命令 1>
      <多行命令 2>
```

> **解析要点**：
> - 仅识别顶层的 `steps` 数组，忽略未知字段。
> - 每个 step 包含 `name`（可读标签）和 `run`（实际执行的 shell 命令）。
> - `run` 字段内容原样作为远程命令执行，不做转义或修改。
> - **多行命令**：`run` 使用 YAML 字面量块标量 `|` 时，解析出的内容为多行字符串（保留换行），通过 heredoc 写入远程临时脚本后执行（见 6c）。

**示例解析结果**：

| 文件名 | 步骤 |
|---|---|
| `build.yml` | `[Build: pnpm build]` → `[Run: pm2 restart momoi]` |
| `cron.yml` | `[Deploy Cron: bash deploy-cron.sh]` |

#### 6c. 远程执行

对每个工作流文件，按 `steps` 顺序在远程服务器上串行执行；**多个 `.yml` / `.yaml` 文件之间并行执行**。

**单步命令的远程执行**（`run` 为单行命令）：

```bash
$SSH_CMD "cd <remote_path> \
  && echo '=== WORKFLOW: <workflow_filename> ===' \
  && <step_run> && echo '[OK] <step_name>' \
  ..."
```

> 步骤间用 `&&` 串联，前一步失败则立即中止该工作流的后续步骤。

**多行命令的远程执行**（`run` 为 YAML `|` 多行字符串）：

将多行内容写为远程临时脚本后执行，避免 `&&` 串联破坏 `if`/`for`/`while`/管道/重定向等控制结构：

```bash
$SSH_CMD "cd <remote_path> \
  && echo '=== WORKFLOW: <workflow_filename> ===' \
  && cat > /tmp/_xat_step.sh << 'XAT_EOF'
<原始多行命令，逐行保留，不做任何转义或拼接>
XAT_EOF
  && bash /tmp/_xat_step.sh && echo '[OK] <step_name>' \
  && rm -f /tmp/_xat_step.sh"
```

> - heredoc 使用引号包裹的 `'XAT_EOF'` 防止远程 shell 对脚本内容做变量展开，确保命令原样执行。
> - 脚本执行后立即清理临时文件。
> - 前一步失败（heredoc 写盘或脚本执行）则 `&&` 自动中止后续步骤。

**多工作流并行**：AI 侧对每个 `.yml` / `.yaml` 文件并发发起独立的 `$SSH_CMD` 调用（非 shell 后台进程）。

#### 6d. 汇总执行结果

收集所有工作流的执行输出，按文件分组展示：

```
**CI/CD 执行结果：**

| 工作流文件 | 状态 |
|---|---|
| build.yml | ✅ 全部通过 |
| cron.yml | ❌ Deploy Cron 失败: permission denied |
```

单个步骤失败不影响其他并行工作流的执行。整体 CI/CD 为**非致命步骤**——即使所有工作流均失败，部署本身仍然有效，仅在此处汇总告知用户。

### 7. 清理

```bash
rm -f /tmp/<repo_name>.bundle
$SSH_CMD "rm -f ~/.xat-deploy/<repo_name>.bundle"
```

清理失败标注非致命，不影响结果。

### 8. 汇总展示

整合所有上下文信息，以 Markdown 表格向用户展示：

```
| 项目 | <repo_name> |
|---|---|
| 分支 | <branch> |
| Bundle | <size> |
| SSH 方式 | 密钥 / 密码 |
| SSH 免密 | 已配置 / 已存在 / 跳过（无本机公钥） |
| 扫描策略 | 5a:精确路径 / 5b:文件名扫描 / 5c:起源匹配 / 5d:全新部署 |
| 部署动作 | 新建仓库 / 已更新 / 已是最新 |
| 远程路径 | <remote_path> |
| CI/CD | build.yml ✅ cron.yml ❌ / 无工作流配置 |
```