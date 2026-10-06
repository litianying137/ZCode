# 进程展示名（codety 系）

> 状态：已实现
> 关联文档：仓库根目录《田迎CODETY_REBRAND.md》第 1.1、4 节

## 规则

进程 / 线程展示名前缀统一为小写 `codety`（官方桌面子进程服务名即 `codety server`，
小写 + 连字符风格一致）。常量名保留 `ZCODE_*` 内部命名，不改：

- 前缀：`packages/shared/src/process-names.ts` 的 `ZCODE_PROCESS_PREFIX = "codety"`
- 产物示例：`codety-main`、`codety-gpu`、`codety-host-local-1`、
  `codety-renderer-main`、`codety-renderer-remote-<workspace>`、`codety-agent-<provider>`
- 窗口标题识别值（`formatZCodeRendererProcessName`）：`"Codety"` 视为主窗口；
  远控窗口前缀 `"Codety - "`（与 `packages/web/src/main.tsx` 的 `document.title` 保持一致）
- CLI 子进程：`CLI_PROCESS_NAME = "codety-cli"`；命令名 `CLI_COMMAND_NAME = "zcode"` 保留
- Node REPL MCP 子进程：`NODE_REPL_MCP_PROCESS_TITLE = "codety-node-repl-mcp"`
- CUA Helper：`Codety Computer Use.app`（dev `.dev.app`），Bundle ID
  `ai.opencode.cua-helper` / `ai.opencode.cua-helper.dev`
- 主进程 `process.title` 与 `app.setName`：`runtimeApplicationName`（`Codety` 系，见
  desktop-product-identity spec）

## 回归测试

- `packages/shared/test/process-names.test.ts`：前缀、窗口标题识别、远控前缀
- `apps/zcode-cli/packages/cli/test/process-name.test.ts`：CLI 进程名 / 命令名
- `apps/zcode-cli/packages/node-repl-host/test/process-title.test.ts`：MCP 子进程标题

运行：

```bash
pnpm exec tsx --test packages/shared/test/process-names.test.ts \
  apps/zcode-cli/packages/cli/test/process-name.test.ts \
  apps/zcode-cli/packages/node-repl-host/test/process-title.test.ts
```
