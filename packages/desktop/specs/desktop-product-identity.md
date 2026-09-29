# 桌面产品身份（opencode rebrand）

> 状态：已实现
> 关联文档：仓库根目录《田迎CODETY_REBRAND.md》第 1.1、3 节

## 权威值

应用名、Bundle ID 一律取自 opencode 官方源码（`packages/desktop/electron-builder.config.ts`
与 `packages/desktop/src/main/index.ts`），不从记忆或猜测取值：

| flavor | appId（Bundle ID） | productName | Linux 包名 / 可执行名 |
| --- | --- | --- | --- |
| production | `ai.opencode.desktop` | `OpenCode` | `opencode` |
| preview（对应官方 beta） | `ai.opencode.desktop.beta` | `OpenCode Beta` | `opencode-beta` |
| dev（未打包 / 开发副本） | `ai.opencode.desktop.dev` | `OpenCode Dev` | — |

实现位置：

- 构建期身份：`packages/desktop/scripts/desktop-product-identity.mjs`
- 运行时显示名：`packages/desktop/src/main/desktopRuntimeEnv.ts` 的 `runtimeApplicationName`
  （`ZCODE_DESKTOP_APPLICATION_NAME` 覆盖仍同时决定显示名与数据目录名，保住 e2e 隔离语义）
- 桌面包：`packages/desktop/package.json` 的 `productName`
- Dev Electron 副本：`packages/desktop/scripts/devElectronAppBundle.mjs`
- Windows 未打包 AUMID：`ai.opencode.desktop.dev`（原 `cn.aminer.zcode`）
- About 对话框应用名：`OpenCode Desktop App`（`packages/desktop/src/main/about.ts`）

## 显示名与数据目录解耦（硬性边界）

`runtimeApplicationName`（对外显示名，opencode 系）与 Electron userData 目录名（zcode 原名
`ZCode` / `ZCode Dev` / `ZCode Preview`）是两个独立变量。本地配置、登录态、项目记录必须继续
走 zcode 原有路径；改显示名不得连带迁移数据目录。

## 内部兼容边界（刻意保留）

- CLI 命令名 `zcode`（`CLI_COMMAND_NAME`）
- `zcode://` URL scheme、`zcode-media`、`zcode.cjs`、`ZCODE_*` 环境变量
- i18n / 菜单的消息键名（如 `titleBar.menu.help.toggleZCodeStdioTap`）
- `packages/ui/src/lib/oauthProviderIcon.tsx` 中的 `logo-zai.svg`：那是 Z.ai **供应商**图标，
  不是应用 logo，不改。

## 回归测试

`packages/desktop/test/desktop-product-identity.test.mjs` 通过源码扫描锁定上表全部值；
改动身份前先更新本 spec 与该测试。
