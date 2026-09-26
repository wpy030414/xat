---
name: upload-repo
description: "通过 git bundle + SCP 将当前项目部署到远程服务器，自动检测技术栈并建议构建命令。"
argument-hint: "<user@host | username server> [password|-]"
user-invocable: true
---

## 概览

将当前目录的 git 仓库打包为 bundle，通过 SCP 上传至远程服务器，多策略自动扫描服务器上已有的同名/同源仓库并优先更新，仅在全未命中时创建全新部署。上传完成后自动配置 SSH 免密登录，并检测技术栈给出构建建议。

> **核心原则**：本技能作为操作指引，每步由 AI 判断实际输出后决定下一步。不依赖预设脚本覆盖所有分支——AI 的上下文理解能力比穷举代码更可靠。

## 参数

| 参数 | 必填 | 说明 |
|---|---|---|
| `<user@host>` | 是 | 紧凑格式：`root@example.xrl.im`；或分两参数 `root example.xrl.im` |
| `[password]` | 否 | 服务器密码，传 `-` 或留空则仅尝试 SSH key 认证 |
| `[-p <remote_dir>]` | 否 | 服务器上的部署目录，默认为 `~/.xat-deploy/<repo_name>` |

> **参数解析优先级**：若第一个参数包含 `@`（如 `root@1.2.3.4`），从中拆分 `username` 和 `server`，忽略第二个参数中的地址部分（若有）。若不含 `@`，则第一、二个参数分别为 `username` 和 `server`。

## 操作约束

- **密码安全**：密码通过环境变量 `SSHPASS` 传递，禁止将密码内联到任何 shell 命令字符串中。
- **等待标志**：所有远程命令（`scp`、`ssh`、`sshpass`）必须等待其进程自然退出后才能进入下一步。
- **非交互**：`scp`/`ssh` 使用 `-o StrictHostKeyChecking=no` 跳过首次连接指纹确认；`-o ConnectTimeout=10` 防止长时间挂起。
- **错误即停**：任何步骤失败后立即向用户报告，不继续执行后续步骤。若某步骤的失败不影响核心目标（如 SSH 免密配置失败），可标注为非致命继续。

## 操作步骤

### 0. 解析参数

从用户输入中解析：

- **用户名与服务器地址**：
  - 若第一个参数包含 `@`（如 `root@example.xrl.im`），按 `@` 拆分为 `username`（`@` 左侧）和 `server`（`@` 右侧）。
  - 若不含 `@`，第一参数为 `username`，第二参数为 `server`。
  - 均不包含时告知用户参数不完整，退出。
- `password`（可选，紧跟 host 之后的参数，`-` 视为无密码）
- `-p <remote_dir>`（可选，默认 `~/.xat-deploy/<cwd_basename>`）
- 获取当前目录名作为 `repo_name`（`basename $(pwd)`）

**解析示例：**

| 用户输入 | username | server | password |
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

获取当前分支名存入上下文变量。

检测安装依赖：
```bash
which sshpass
```
- 若不存在且用户提供了密码：告知用户「sshpass 未安装，请执行 `brew install sshpass`」，退出。

### 2. 技术栈分析

浏览当前目录下的文件结构，利用对常见技术生态的已有知识，自行判断项目使用的技术栈和构建方式。

**原则**：

- 先观察目录中有什么（配置文件、锁文件、构建脚本入口等），再决定属于什么栈，不要反查表格。
- 常见的识别线索：`package.json`（Node.js/前端）、`go.mod`（Go）、`Cargo.toml`（Rust）、`requirements.txt` / `pyproject.toml`（Python）、`Makefile` / `CMakeLists.txt`（C/C++）、`Gemfile`（Ruby）、`pom.xml` / `build.gradle`（JVM）、`Dockerfile`（容器化）等——但不限于此，留意 monorepo、workspace、task runner（turbo/nx/lerna）等特殊结构。
- 同一个项目可能同时命中多个栈（比如 `package.json` + `Dockerfile`），全部记录。
- 读入关键配置文件（如 `package.json` 的 `scripts` 字段）获取精确的构建/启动命令，不要猜测。
- 若识别不到任何已知构建系统，如实告知，但**仍继续部署流程**——部署 repo 本身是有价值的，构建可以后续手动处理。

将结果整理为 `stacks`（技术栈名列表）和 `build_commands`（对应的服务器端构建命令列表，路径代入远程路径）。

### 3. 建立 SSH 连接

**重要：分步判断，每步读取实际输出。**

**Step 3a — 先尝试 SSH key 认证：**

```bash
ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 -o BatchMode=yes <username>@<server> 'echo SSH_OK'
```

- 输出包含 `SSH_OK` → key 认证成功。`ssh_method = "key"`，跳到 Step 3d。
- 失败 + 用户未提供密码 → 告知「SSH 密钥认证失败，且未提供密码」，退出。
- 失败 + 用户提供了密码 → 进入 Step 3b。

**Step 3b — 密码认证兜底：**

```bash
SSHPASS=<password> sshpass -e ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 <username>@<server> 'echo SSH_OK'
```

- 输出包含 `SSH_OK` → 密码认证成功。`ssh_method = "password"`，进入 Step 3c。
- 失败 → 告知「密钥和密码认证均失败」，退出。

**Step 3c — 配置 SSH 免密登录（仅密码认证成功后执行）：**

检测本机公钥（优先级从高到低）：
```bash
cat ~/.ssh/id_ed25519.pub 2>/dev/null || cat ~/.ssh/id_rsa.pub 2>/dev/null || echo NO_KEY
```
- 输出 `NO_KEY` → 跳过免密配置（标注非致命），进入 Step 3d。

读取到公钥后，检查服务器是否已有：

```bash
SSHPASS=<password> sshpass -e ssh -o StrictHostKeyChecking=no <username>@<server> "mkdir -p ~/.ssh && chmod 700 ~/.ssh && grep -qF '<pubkey>' ~/.ssh/authorized_keys 2>/dev/null && echo EXISTS || echo NOT_FOUND"
```

- 输出 `EXISTS` → 跳过，标注「服务器已存在本机公钥」。
- 输出 `NOT_FOUND` → 追加公钥：

```bash
SSHPASS=<password> sshpass -e ssh -o StrictHostKeyChecking=no <username>@<server> "echo '<pubkey>' >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys && echo KEY_ADDED"
```
- 此步骤失败标注非致命，不阻塞后续流程。

**Step 3d — 封装远程执行辅助变量：**

根据 `ssh_method` 构造后续远程命令前缀：
```bash
# ssh_method == "key" → 直接使用 ssh
SSH_CMD="ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 <username>@<server>"
SCP_CMD="scp -o StrictHostKeyChecking=no -o ConnectTimeout=10"

# ssh_method == "password" → 使用 sshpass -e
SSH_CMD="SSHPASS=<password> sshpass -e ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 <username>@<server>"
SCP_CMD="SSHPASS=<password> sshpass -e scp -o StrictHostKeyChecking=no -o ConnectTimeout=10"
```

后续所有远程操作通过 `$SSH_CMD` 和 `$SCP_CMD` 执行。

### 4. 创建 git bundle

```bash
git bundle create /tmp/<repo_name>.bundle --all
```

执行后：
- 失败 → 告知原因，退出。
- 成功 → 获取 bundle 文件大小：

```bash
ls -lh /tmp/<repo_name>.bundle | awk '{print $5}'
```

向用户报告：「创建 bundle 完成，大小 <size>」。

### 5. 上传 bundle 到服务器

先确保远程部署目录存在：

```bash
$SSH_CMD "mkdir -p <remote_base_dir>"
```

上传 bundle：

```bash
$SCP_CMD /tmp/<repo_name>.bundle <username>@<server>:<remote_base_dir>/<repo_name>.bundle
```

- 失败 → 清理本地 `/tmp/<repo_name>.bundle`，告知原因，退出。

### 6. 远程部署（多策略降级扫描）

**核心逻辑：四层降级扫描，逐层下探。**

```
策略1: 精确路径匹配（快速命中）
  ↓ 未命中 + 用户未指定 -p
策略2: 文件名扫描（同名仓库搜索）
  ↓ 未命中
策略3: Git 起源匹配（同源仓库搜索）
  ↓ 未命中
策略4: 全新部署（兜底）
```

> **关键规则**：
> - 若用户显式通过 `-p` 指定了路径，**仅执行策略1**——尊重用户意图，不做扫描。
> - 若用户未指定 `-p`（使用默认路径），策略1 未命中后自动下探策略2、策略3。
> - 策略2 发现**唯一候选**时可直接使用，无需用户确认。
> - 策略2/3 发现**多个候选**时列出来，由 AI 选择最近修改的那个；若时间相近（<1 天）则询问用户。
> - 策略3 发现的候选必须经用户确认（因为目录名已变更，用户可能忘了）。

---

**Step 6a — 策略1：精确路径匹配：**

先探查 `<remote_path>`（用户 `-p` 指定的路径或默认 `~/.xat-deploy/<repo_name>`）：

```bash
$SSH_CMD "ls -la <remote_path> 2>/dev/null && echo '---DIR_OK---' || echo 'DIR_NOT_FOUND'"
```

```bash
$SSH_CMD "ls -la <remote_path>/.git 2>/dev/null && echo '---GIT_OK---' || echo 'GIT_NOT_FOUND'"
```

```bash
$SSH_CMD "cd <remote_path> 2>/dev/null && git status 2>&1 || echo 'NOT_A_GIT_REPO'"
```

**分支处理**（按优先级匹配第一个满足的状态）：

| 远程实际状态 | 判定依据 | 处理策略 |
|---|---|---|
| 目录不存在（`DIR_NOT_FOUND`） | 第一行即为 `DIR_NOT_FOUND` | 若用户未指定 `-p` → 不立即新建，进入策略2。若用户指定了 `-p` → `mkdir -p` 后全新部署（跳到策略4的全新部署命令）。 |
| 目录存在但不是 git 仓库 | `DIR_OK` + `NOT_A_GIT_REPO` | 检查目录是否为空：为空 → 直接初始化并部署；非空 → 告知用户目录非空且非 git 仓库，**不覆盖**，要求手动处理或指定 `-p` 其他路径。 |
| 目录存在且是 git 仓库 | `GIT_OK` + `git status` 正常输出 | 命中！记录 `scan_strategy = "策略1:精确路径"`。检查 `git status` 是否有未提交改动、detached HEAD、或正在进行的合并/变基。**干净** → 继续更新流程；**不干净** → 告知用户远程有未提交的改动，询问是否强制覆盖（`git reset --hard FETCH_HEAD`）。 |
| 裸仓库（bare repo） | `git status` 报错提及 `bare repository` | 告知用户「远程是一个裸仓库，不适合直接部署代码」，建议改为 `-p` 指定其他路径。 |
| 同名文件/目录但不是仓库 | `DIR_OK` + `GIT_NOT_FOUND` + 非空 | 告知路径被占用且非 git 仓库，**不覆盖**。 |

---

**Step 6b — 策略2：文件名扫描（仅用户未指定 `-p` 时触发）：**

在服务器上的常见部署目录中搜索名为 `<repo_name>` 且包含 `.git` 的目录：

```bash
$SSH_CMD "find ~/.xat-deploy /home /srv /var/www /opt \
  -maxdepth 2 -path '~/.xat-deploy/*' -name '<repo_name>' -type d \
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
| 0 | 进入策略3。 |
| 1 | 直接使用该路径作为 `remote_path`，记录 `scan_strategy = "策略2:文件名扫描"`，输出提示「在 <path> 发现同名仓库，自动使用此路径」。 |
| ≥2 | 列出候选。若有某个候选的修改时间明显更近（差距 > 1 天），自动选择最新的并告知用户；否则列出所有候选，标注路径和最后修改时间，询问用户选择。 |

---

**Step 6c — 策略3：Git 远程起源匹配（仅用户未指定 `-p` 时触发）：**

当策略1和2均未命中时，可能是用户在服务器上重命名了目录。通过比对 remote origin URL 来找同源仓库。

先获取本地的 origin URL（用于后续对比）：

```bash
git remote get-url origin 2>/dev/null
```

> 若无 origin（纯本地仓库），跳过策略3，直接进入策略4。

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
   - 去除协议前缀差异（`https://` ↔ `git@` + `:`）
   - 去除尾部 `.git`
   - 归一化后完全一致即为同源
3. 收集所有同源记录。

**候选数量处理**：

| 结果数 | 行为 |
|---|---|
| 0 | 进入策略4。 |
| 1 | 给出路径，告知用户「在 <path> 发现同源仓库（目录名已变更），是否使用此路径更新？」——用户确认后使用，拒绝则进入策略4。记录 `scan_strategy = "策略3:起源匹配"`。 |
| ≥2 | 列出所有同源路径，标注路径和 origin URL，询问用户选择。用户确认后使用所选路径，拒绝则进入策略4。 |

> **策略3 的候选必须经用户确认**——目录名已变更意味着用户可能做过有意的结构调整，不应自动覆盖。

---

**Step 6d — 策略4：全新部署：**

前三策略均未命中时的兜底方案。

```bash
$SSH_CMD "mkdir -p <remote_path> && cd <remote_path> && git init && git fetch <remote_base_dir>/<repo_name>.bundle && git checkout -b main FETCH_HEAD"
```

记录 `scan_strategy = "策略4:全新部署"`。

---

**更新已有仓库命令参考（策略1/2/3 命中后使用）：**

```bash
# 获取当前分支
$SSH_CMD "cd <remote_path> && git rev-parse --abbrev-ref HEAD"

# 拉取 bundle 中的提交
$SSH_CMD "cd <remote_path> && git remote add _bundle <remote_base_dir>/<repo_name>.bundle 2>/dev/null; git remote set-url _bundle <remote_base_dir>/<repo_name>.bundle 2>/dev/null; git fetch _bundle"

# 合并
$SSH_CMD "cd <remote_path> && git merge FETCH_HEAD --no-edit --allow-unrelated-histories"

# 清理临时 remote
$SSH_CMD "cd <remote_path> && git remote remove _bundle 2>/dev/null"
```

**处理 fetch 结果时注意**：

- 输出包含 `Already up to date` → 仓库已是最新，无需合并，标注 `action = "up_to_date"`。
- 合并冲突 → 告知用户远程存在分歧的提交，需手动在服务器上解决，列出远程路径。
- 其余错误 → 逐字读取 stderr，AI 判断原因后告知用户。

> **重要**：不要机械枚举场景然后死板匹配。远程可能的状态组合远不止这些——用命令探查，然后像工程师排查问题一样，看什么、判什么、做什么。

### 7. 清理

```bash
rm -f /tmp/<repo_name>.bundle
$SSH_CMD "rm -f <remote_base_dir>/<repo_name>.bundle"
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
| 扫描策略 | 策略1:精确路径 / 策略2:文件名扫描 / 策略3:起源匹配 / 策略4:全新部署 |
| 部署动作 | 新建仓库 / 已更新 / 已是最新 |
| 远程路径 | <remote_path> |
| 技术栈 | Node.js, Docker ... |
```

若技术栈可识别，追加构建建议：

```
**在服务器上构建：**

\`\`\`bash
ssh <username>@<server>
cd <remote_path>
npm install && npm run build
docker build -t <repo_name> .
\`\`\`
```

无技术栈命中时告知：「未识别到已知构建系统，请手动检查并在服务器上构建。」