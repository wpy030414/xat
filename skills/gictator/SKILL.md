---
name: gictator
description: "独裁式重写 git 提交历史：移除所有 co-author，author/committer 统一改为本人（取自 git 全局配置），提交时间对齐作者时间，并强制 GPG 签名。"
argument-hint: "[commit_hash]"
user-invocable: true
---

## 概览

对指定范围内的 git commit 执行「独裁」重写，每个 commit 施加四条铁律：

1. **移除 co-author**：删除 message 中所有 `Co-authored-by:` trailer（大小写不敏感）。
2. **author 归一**：author 与 committer 一律改为 git **全局配置**的 `user.name` / `user.email`。
3. **时间对齐**：committer date 强制等于原 author date（提交时间 = 作者时间）。
4. **强制签名**：用 `git commit-tree -S` 重建每个 commit，强制 GPG 签名。

> **实现原理**：不使用 `rebase` / `filter-branch` / `filter-repo`。逐 commit 读取其 tree 与父指针，通过 `commit-tree -S` 以新身份、新时间、新 message 重建为**全新 hash**，再沿拓扑序（parent 在前）串起父指针，最后用带 CAS 的 `update-ref` 一次性切换分支指针。tree 内容**逐字节不变**，仅元数据被改写。

## 调用形态

| 形态 | 语义 |
|---|---|
| `/gictator` | 独裁当前分支**所有未 push** 的 commit（以 upstream 跟踪分支为界）。 |
| `/gictator <commit_hash>` | 从 `<commit_hash>`（**含**）到 HEAD 的所有 commit 独裁。 |

## 参数

| 参数 | 必填 | 说明 |
|---|---|---|
| `[commit_hash]` | 否 | 范围起点（含）。省略则进入「未 push」模式。支持任何 `git rev-parse` 可解析的引用（hash / 短 hash / 分支名 / `HEAD~2` 等）。 |

## 工具约束

- 所有 git 操作通过技能目录下的 `gictator.cjs`（Node.js）完成；脚本内部一律使用 `execFileSync('git', [args])` **数组传参**，规避 shell 引号与转义问题。
- 唯一的 shell 命令应只有 `node`；不要手写 `git rebase`、`git filter-branch` 等替代实现。
- commit message 通过 `stdin` 传入 `commit-tree`（`input` 选项），**禁止**内联到命令行字符串。

## 前置条件（脚本会自动校验并报错退出）

- 当前目录是 git 仓库。
- 不在 detached HEAD 状态（须先 `git checkout <branch>`）。
- git 已配置 `user.name` / `user.email`（优先读全局 `--global`，缺失时回退 effective 配置）。
- GPG 签名可用：`user.signingkey` 已配置或能按 committer email 自动匹配到私钥；`gpg`/`gpg-agent` 可非交互签名。可用 `--key <keyid>` 覆盖签名密钥。

## 范围界定逻辑

脚本按以下优先级确定待重写的 commit 集合（`resolveRange()`）：

```
① 传了 commit_hash → range 模式：git rev-list --reverse --topo-order <hash>..HEAD，再前插 <hash> 本身。
② 未传 + 有 upstream → unpushed 模式：git rev-list --reverse --topo-order @{u}..HEAD。
③ 未传 + 无 upstream → all 模式（回退）：重写当前分支全部 commit，并在输出中给出 warning。
```

- **祖先校验**：range 模式下若 `<hash>` 不是当前 HEAD 的祖先，直接报错退出，避免误改无关分支。
- **merge commit**：范围内的父指针会被重映射到重写后的新 hash；范围外的父保持原样。多父合并因此得以正确保留。
- **只动当前分支**：脚本仅切换当前分支指针，其他分支（如被合并的 feature 分支）不会被移动。

## 操作步骤

> 本技能为**历史重写**，属高风险但可回滚的操作。按下述流程执行，先预览后落地。

### 1. 预览（dry-run，必做）

在**目标 git 仓库根目录**下执行（`<skill_dir>` 为本 SKILL.md 所在目录，用绝对路径引用脚本）：

```bash
node <skill_dir>/gictator.cjs [commit_hash] --dry-run
```

解析 stdout 的 JSON，向用户展示预览表（见「结果展示 / dry-run 预览」），并明确告知：

- 模式（`range` / `unpushed` / `all`）、待重写 commit 数量、目标身份、签名密钥。
- 若 `mode === "all"`（无 upstream 回退）：**必须停下来向用户确认**——这会重写当前分支的全部历史，通常不是「只改未 push」的本意。确认后再进入步骤 2。
- 若 `workingTreeDirty === true`：提示用户工作树有未提交改动。重写**不影响**工作树与索引（tree 逐字节不变，`update-ref` 不做 checkout），可安全继续，但需让用户知情。

### 2. 执行

用户知悉（all 模式下确认）后，去掉 `--dry-run` 执行：

```bash
node <skill_dir>/gictator.cjs [commit_hash]
```

脚本成功后：以 CAS 方式更新当前分支指针（`git update-ref refs/heads/<branch> <newHead> <oldHead>`），返回每个 commit 的旧→新 hash 映射与签名状态。

失败（多为 GPG 签名不可用）时：分支指针**不被改动**，脚本返回 `error` 与 `partial:true`；据 stderr 向用户报告原因（提示检查 `user.signingkey`、私钥是否已解锁、gpg-agent 是否可用），并给出解锁建议后重试。

### 3. 展示结果 + 善后提示

向用户展示执行结果表，并给出两条善后命令（取自输出 JSON）：

- `rollback`：`git reset --hard <oldHead>` —— 旧 commit 仍在对象库与 reflog 中，可一键回退。
- `pushHint`：历史已重写，推送需 `git push --force-with-lease`（**不要**用 `--force`，`--force-with-lease` 在远端有他人新提交时会拒绝，更安全）。

## 执行命令（脚本 CLI 参考）

```bash
# 未 push 模式，预览
node <skill_dir>/gictator.cjs --dry-run
# 未 push 模式，执行
node <skill_dir>/gictator.cjs
# range 模式：从 abc1234（含）到 HEAD
node <skill_dir>/gictator.cjs abc1234
# 覆盖签名密钥
node <skill_dir>/gictator.cjs --key 0123ABCD...
```

## 输出 JSON 结构

**dry-run 预览**：

```json
{
  "success": true, "dryRun": true, "branch": "main",
  "mode": "unpushed", "upstream": "origin/main",
  "baseParent": "8637561", "count": 2,
  "identity": "杏仁鹿 <krkr@xrl.im>", "idFromGlobal": true,
  "signingKey": "5DA29157B3C5F863", "workingTreeDirty": false,
  "warning": null,
  "preview": [
    {"old":"b4fc1ce","subject":"feat: 未push提交1","author":"另一人 <another@x.com>",
     "authorDate":"2026-10-15T09:22:11+08:00","committerDate":"2026-10-15T09:22:11+08:00",
     "sigBefore":"N","coAuthors":1}
  ]
}
```

**执行成功**：

```json
{
  "success": true, "branch": "main", "mode": "unpushed", "upstream": "origin/main",
  "identity": "杏仁鹿 <krkr@xrl.im>", "idFromGlobal": true, "signingKey": "5DA29157B3C5F863",
  "oldHead": "3cc65fb...", "newHead": "9ab12cd...", "count": 2,
  "allSigned": true, "totalCoAuthorsRemoved": 1, "workingTreeDirty": false, "warning": null,
  "results": [
    {"old":"b4fc1ce","new":"e71aa02","newFull":"e71aa02...","subject":"feat: 未push提交1",
     "coAuthorsRemoved":1,"sigBefore":"N","sigAfter":"G"}
  ],
  "rollback": "git reset --hard 3cc65fb...",
  "pushHint": "git push --force-with-lease"
}
```

**空范围**（没有可独裁的 commit）：

```json
{"success":true,"empty":true,"branch":"main","mode":"unpushed","upstream":"origin/main",
 "message":"没有未 push 的 commit，无需独裁"}
```

**失败**：

```json
{"success":false,"error":"当前处于 detached HEAD 状态，请先切换到具体分支（如 git checkout main）"}
```

## 结果展示

### dry-run 预览表

```
将独裁 <count> 个 commit（模式：<mode>｜身份：<identity>｜签名：<signingKey>）：

| # | commit | 原 author | co-author | 签名 | subject |
|---|---|---|---|---|---|
| 1 | b4fc1ce | 另一人 <another@x.com> | 1 | N→G | feat: 未push提交1 |
| 2 | 3cc65fb | 第三人 <third@x.com> | 0 | N→G | fix: 未push提交2 |
```

> `all` 模式回退时，在表格外**醒目提示**：「当前分支无 upstream，将重写全部 <count> 个历史 commit，是否确认？」并等待用户回复。

### 执行结果表

```
独裁完成 ✅（<count> 个 commit｜移除 <totalCoAuthorsRemoved> 个 co-author｜签名 <allSigned>）：

| commit | 新 hash | co-author 移除 | 签名 | subject |
|---|---|---|---|---|
| b4fc1ce | e71aa02 | 1 | N→G | feat: 未push提交1 |
| 3cc65fb | 9ab12cd | 0 | N→G | fix: 未push提交2 |

- 分支指针：<oldHead7> → <newHead7>
- 回退：git reset --hard <oldHead>
- 推送：git push --force-with-lease
```

## 签名状态码（`%G?`）对照

| 码 | 含义 | 视为已签名 |
|---|---|---|
| `G` | 有效签名 | ✅ |
| `U` | 有效但密钥不受信任 | ✅ |
| `N` | 无签名 | ❌ |
| `B` / `E` / `X` / `Y` | 坏签名 / 密钥或签名过期 | ❌ |

> `allSigned` 仅当所有 commit 的 `sigAfter` ∈ {`G`,`U`} 时为 `true`。若出现非 `G/U`，向用户说明对应含义并检查 gpg 环境。

## 注意事项

- **不可逆的是「远端」**：本地旧 commit 通过 reflog 与 `rollback` 可恢复；但若已 `--force-with-lease` 推送，远端历史即被覆盖，协作者需重新对齐。
- **只重写当前分支**：merge 引入的其他分支引用不会被移动，重写后这些分支可能与当前分支指向不同历史——这是预期行为。
- **时间对齐会丢弃原 committer date**：所有被重写 commit 的提交时间改为其作者时间，rebase/cherry-pick 产生的「提交晚于作者」痕迹被抹平。
- **工作树安全**：重写只改元数据与分支指针，不触碰工作树与索引；脏工作树不会丢失改动。
