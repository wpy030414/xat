# `.xat/workflows/` 参考

用户要写或改 CI/CD 工作流时才读这份。部署流程本身不在这里。

## 位置与执行顺序

项目根目录 `.xat/workflows/`，每个 `.yml` / `.yaml` 一个文件。

**文件之间并行，文件内部按 `steps` 顺序串行**；任一步失败即中止该文件后续步骤，但其他文件继续。

## steps 是混合列表

每一步要么 `uses` 一个工件（可复用动作），要么 `run` 一段命令，顺序即执行顺序，两者可任意交替。

```yaml
steps:
  - name: Test
    run: pnpm test
  - uses: <工件名>
    with: { name: momoi }
  - name: Notify
    run: |
      curl -fsS "$HOOK" || true
```

`run` 支持 `|`（保留换行）和 `>`（折叠成空格）；`with` 是扁平键值，值 `"true"` 视为布尔开关。

## 写完必须验证

```bash
node skills/upload-repo/scripts/index.cjs lint
```

解析 `.xat/workflows/*.yml`，列出每个文件识别到的步骤和 `warnings`；有告警退出 1。**告警清零再部署**——告警意味着某一步可能根本没被执行。

解析的权威实现是 `scripts/index.cjs` 的 `parseWorkflow`，本文只是用法说明，冲突以代码为准。

## 可用工件

```bash
node skills/upload-repo/scripts/actions/index.cjs list
```

返回 `{ uses, description, params }`：`uses` 就是 `steps` 里该写的名字，`params` 是可选参数说明。**不要凭记忆列举工件**，跑这条命令。

新增工件：在 `scripts/actions/` 下加一个 `.cjs`，契约见 `scripts/actions/index.cjs` 头部注释。
