# opencode 桌面端重命名与图标改造说明

> 更新时间：2026-09-29
> 目标读者：后续继续修改 ZCode / opencode 桌面端身份、进程名、图标或打包链路的 AI / 工程师。

## 1. 背景与目标

总体目标：用 zcode 源码工程改造为一个可对外调用的 API 产品，对外视觉与命名全部呈现为 opencode。本文件记录的名称、进程与图标改造，是该总体目标下的对外身份统一工作。

本机存在针对原 `ZCode` / `dev.zcode.app` 的监控或干扰，原应用启动后可能立即退出。为了让桌面端能够独立运行，本次改造将用户可见应用身份改为 `opencode`，并同步修改活动监视器中的进程名。

两条硬性要求（对外视觉与命名全部是 opencode）：

1. 图标：zcode 中的所有图标，全部替换为 opencode 对应的图标——应用图标、Dock / DMG / 安装器图标、启动页、About logo、空态水印等，见第 5 节。
2. 名称：zcode 中的 app 名称、线程名、进程名，全部改为 opencode 对应的名称——Bundle 显示名、窗口标题、活动监视器中的主进程 / Helper / host / CLI / MCP 子进程名，见第 3、4 节。

自动更新结论（2026-09-29）：rebrand 后自动更新不仅没有意义，而且有害——官方更新 feed 只分发 `dev.zcode.app` 身份的安装包，命中更新会把改造全部覆盖回原样，正好装回本机拦截的身份。因此自动更新与远端强制升级 gate 已整体关闭，详见第 6.3 节与 `packages/desktop/specs/auto-update-policy.md`。

### 1.1 权威参考源：opencode 官方源码

本机存有 opencode 官方源码，应用名、线程 / 进程名、图标一律以它为准，不从记忆或猜测取值：

```text
/Users/litianying/Documents/AICodeAgent/opencode
```

关键权威值（摘自其 `packages/desktop` 与 `packages/opencode`）：

| 项目 | 权威值 | 出处 |
| --- | --- | --- |
| 应用显示名（productName / `app.setName`） | `OpenCode`（prod）、`OpenCode Beta`、`OpenCode Dev` | `packages/desktop/electron-builder.config.ts`、`packages/desktop/src/main/index.ts` |
| Bundle ID / appId | `ai.opencode.desktop`（prod）、`ai.opencode.desktop.beta`、`ai.opencode.desktop.dev` | 同上 |
| 安装包命名 | `opencode-desktop-${os}-${arch}.${ext}` | `electron-builder.config.ts` |
| 桌面子进程 / 服务名 | `opencode server`（Electron `utilityProcess` 的 `serviceName`，活动监视器可见） | `packages/desktop/src/main/server.ts` |
| Electron Helper 名 | `OpenCode Helper`、`OpenCode Helper (Renderer)` 等（由 productName 派生） | Electron 打包约定 |
| CLI 命令名 | `opencode` | `packages/opencode/package.json` 的 `bin` |
| 图标资产 | `packages/desktop/icons/<channel>/`：`icon.icns`、`icon.ico`、`icon.png`、16–1024 各尺寸 PNG、`dock.png`、Windows `Square*Logo.png` / `StoreLogo.png`、android / iOS 全套 | `packages/desktop/icons/` |
| 图标装配 | 构建时 `scripts/copy-icons.ts` 把 `icons/<channel>` 拷为 `resources/icons`，electron-builder 从该目录取 `icon.icns` / `icon.ico` | `scripts/prebuild.ts`、`scripts/copy-icons.ts` |

注意：

- 官方桌面端显示名是驼峰 `OpenCode`，不是全小写 `opencode`。本文第 3、5 节记录的已完成改造若与官方值不一致（如小写 `opencode`、`dev.opencode.app`），后续以本表为准对齐。
- 图标制作流程见 `packages/desktop/icons/README.md`：`tauri icon` 生成各尺寸，再用 Image2Icon 的 Big Sur preset 生成带 macOS 阴影边距的 `icon.icns`；`dock.png` 需与对应 `icon.icns` 中的 `icon_128x128@2x.png` 保持同步。

具体改造目标：

- macOS 应用显示名：`opencode`
- Bundle ID：`dev.opencode.app`
- 应用主进程：`opencode`
- Electron Helper：`opencode Helper...`
- Host 进程：`opencode-host...`
- CLI 子进程：`opencode-cli`
- Node REPL MCP 子进程：`opencode-node-repl-mcp`
- 应用图标：简洁蓝色圆角方形 + 白色 `T`，并保留与其他 macOS Dock 图标一致的视觉安全边距

## 2. 明确不改的内部兼容边界

不要把仓库里的所有 `ZCode` / `zcode` 机械替换掉。以下内容刻意保留：

- 内部协议名：`ZCode Protocol`
- 环境变量：`ZCODE_*`
- 自定义 scheme：`zcode-media`
- CLI 命令名：`zcode`
- Agent bundle 文件名：`zcode.cjs`
- 数据目录、远端运行时、协议版本和历史兼容字段

原因：这些名称属于内部协议、历史数据和部署兼容边界。全量替换会破坏 Agent、远程工作区、配置迁移和更新链路。

**本地配置与本地项目路径（2026-09-29 明确）**：读取本地配置文件、本地项目（工作区）必须继续走 zcode 原有路径与逻辑——包括 `~/.zcode` 数据目录、既有 settings / 登录态存储、工作区记录的解析方式。rebrand 只改对外可见的身份（显示名、图标、进程名），不动这些路径的解析和读写逻辑。

注意一个连带影响：改 `productName` / `app.setName()` 会连带改变 Electron 默认用户数据目录（macOS 上是 `~/Library/Application Support/<名称>`）。为满足"本地配置走 zcode 原路径"，需要在主进程显式固定数据目录（如 `app.setPath("userData", <zcode 原目录>)` 或等效手段），把"应用显示名"和"数据目录名"解耦；不要让改名导致登录态、设置和项目记录"看起来丢了"。

注意：在活动监视器的完整命令行参数里仍可能看到 `zcode-media`、`zcode.cjs` 等内部兼容名；“进程名称”列已经是 `opencode / `opencode-*`。

## 3. 应用身份修改

### 3.1 构建期产品身份

文件：

```text
packages/desktop/scripts/desktop-product-identity.mjs
```

当前关键值：

```js
const PRODUCTION_IDENTITY = Object.freeze({
  flavor: "production",
  appId: "dev.opencode.app",
  productName: "opencode",
  // ...
});

const PREVIEW_IDENTITY = Object.freeze({
  flavor: "preview",
  appId: "dev.opencode.app.preview",
  productName: "opencode Preview",
  // ...
});
```

重点：

- `productName` 决定安装包、`.app` 名称、DMG 文件名和 Electron Helper 名称。
- `appId` 从 `dev.zcode.app` 改为 `dev.opencode.app`，这是避开按 Bundle ID 识别原应用的关键。
- Preview 与 Production 保持独立身份，可并排安装。

### 3.2 运行时应用名

文件：

```text
packages/desktop/src/main/desktopRuntimeEnv.ts
```

默认值：

```ts
isLocalDevelopmentRuntime ? "opencode Dev" : isPreviewPackagedRuntime ? "opencode Preview" : "opencode";
```

该值同时影响：

- `app.setName(...)`
- 主进程 `process.title`
- Electron 用户数据目录

保留测试覆盖入口：

```text
ZCODE_DESKTOP_APPLICATION_NAME
```

### 3.3 桌面包 productName

文件：

```text
packages/desktop/package.json
```

当前值：

```json
{
  "productName": "opencode"
}
```

### 3.4 主窗口标题

文件：

```text
packages/desktop/src/renderer/index.html
```

当前值：

```html
<title>opencode</title>
```

### 3.5 开发与 Linux 本地身份

文件：

```text
packages/desktop/scripts/devElectronAppBundle.mjs
packages/desktop/scripts/dev.mjs
packages/desktop/src/main/desktopLinuxDeepLinkRegistration.ts
```

macOS 开发副本使用：

```text
opencode Dev
dev.opencode.app.development
```

Linux deep link desktop entry 的默认展示名同步使用 `opencode。`zcode://` scheme 与 Linux 图标安装名仍保留内部兼容名。

## 4. 进程名修改

### 4.1 Desktop / Host / Renderer / Agent 展示名

文件：

```text
packages/shared/src/process-names.ts
```

进程前缀：

```ts
const ZCODE_PROCESS_PREFIX = "opencode";
```

输出示例：

```text
opencode-main
opencode-gpu
opencode-host
opencode-host-local-1
opencode-renderer-main
opencode-renderer-remote-<workspace>
opencode-agent-<provider>
```

同时把主窗口标题识别值改为：

```ts
"opencode";
"opencode - ";
```

### 4.2 CLI 子进程标题

文件：

```text
apps/zcode-cli/packages/cli/src/process-name.ts
```

当前关键值：

```ts
export const CLI_COMMAND_NAME = "zcode";
export const CLI_PROCESS_NAME = "opencode-cli";
```

注意：

- `CLI_COMMAND_NAME` 保持 `zcode`，用于兼容用户命令和安装脚本。
- `CLI_PROCESS_NAME` 改为 `opencode-cli`，只影响进程展示名。

### 4.3 Node REPL MCP 子进程标题

文件：

```text
apps/zcode-cli/packages/node-repl-host/src/process-title.ts
apps/zcode-cli/packages/node-repl-host/src/server.ts
```

当前值：

```ts
export const NODE_REPL_MCP_PROCESS_TITLE = "opencode-node-repl-mcp";
```

`server.ts` 只从 `process-title.ts` 导入该常量，避免进程标题出现第二条事实源。

## 5. 图标与视觉资产

### 5.1 图标规格

规格文档：

```text
packages/desktop/specs/product-icon.md
packages/desktop/specs/app-asar-repack.md
```

设计：

- 蓝色渐变圆角方形背景
- 白色几何 `T`
- 无文字、无复杂图形
- 16px 到 1024px 全尺寸生成

### 5.2 生成脚本

文件：

```text
packages/desktop/scripts/generate-opencode-icons.mjs
```

命令：

```bash
pnpm --filter @zcode/desktop run icons:opencode
```

脚本会生成：

- `packages/desktop/build/icons/<size>x<size>.png`
- `packages/desktop/build/icon.png`
- `packages/desktop/build/icon.icns`
- `packages/desktop/build/icon.ico`
- `packages/desktop/build/icon_windows.png`
- `packages/desktop/build/icon_installer.*`
- `packages/desktop/build/dmg_background.png`
- `packages/desktop/build/dmg_background@2x.png`
- `public/logo/icons/*`
- `public/icon_512@2x.png`

不要手工单独改某个尺寸的 PNG；应修改生成脚本后统一重生成。

### 5.3 App 内 logo

文件：

```text
packages/ui/src/components/ui/ZCodeAboutLogo.tsx
```

该 SVG 已改为与桌面图标一致的蓝色圆角方形 + 白色 `T`。组件名暂未改，避免无意义的跨包重命名和引用风险。

### 5.4 启动页与草稿空态水印

文件：

```text
packages/desktop/src/renderer/index.html
packages/ui/src/root/RootStartupLoading.tsx
packages/ui/src/v4/ConversationDraftEmptyState.tsx
```

首屏 HTML loading、React 启动 fallback 和会话草稿空态水印都已从旧 `ZCode` 字形改为 opencode 的白色/线框 `T`。其中：

- `index.html` 负责 Electron 首屏中心图；
- `RootStartupLoading.tsx` 负责 React 接管后的启动 fallback；
- `ConversationDraftEmptyState.tsx` 负责首页问候语背后的空态水印。

不要在这些位置重新引入 `packages/ui/src/assets/Z.svg` 或旧的 ZCode path。

#### 实施记录（2026-09-29）

- `index.html` 的旧 ZCode 三段 path 已替换为两个白色 `rect`，组成几何 `T`。
- `RootStartupLoading.tsx` 的启动 fallback 同步替换为相同几何 `T`。
- `ConversationDraftEmptyState.tsx` 删除对 `packages/ui/src/assets/Z.svg` 的引用，改为一个带渐隐 mask 的 `T` 线框。
- `packages/desktop/specs/product-icon.md` 增加启动页和草稿空态验收规则。
- `packages/desktop/test/product-icon.test.mjs` 增加回归测试，防止这些位置重新引用旧 ZCode 字形。

本次已重新执行桌面构建并更新 `/Applications/opencode.app`。验证结果：

```text
相关测试：通过
pnpm typecheck：通过
architecture:check --changed：通过，0 violations
macOS bundle：通过
codesign：通过
安装包内 index.html：已包含 opencode T，不再包含旧 ZCode path
启动截图：中心图为 opencode T；首页水印也已替换
```

## 6. macOS 打包与签名

### 6.1 推荐构建命令

仓库要求 Node `24.14.0`、pnpm `10.33.2`。如果本机默认 pnpm 版本不对，可用 Corepack 固定版本：

```bash
COREPACK_ENABLE_PROJECT_SPEC=0 corepack pnpm@10.33.2 install
```

完整打包：

```bash
ZCODE_ENV=production \
ZCODE_TARGET_OS=mac \
ZCODE_TARGET_ARCH=arm64 \
ZCODE_ENABLE_MAC_SIGN=1 \
APPLE_SIGNING_IDENTITY=- \
pnpm --filter @zcode/desktop run bundle
```

已构建过 `out/` 和 runtime assets 后，可快速重打包：

```bash
ZCODE_ENV=production \
ZCODE_TARGET_OS=mac \
ZCODE_TARGET_ARCH=arm64 \
ZCODE_ENABLE_MAC_SIGN=1 \
APPLE_SIGNING_IDENTITY=- \
pnpm --filter @zcode/desktop run bundle -- --skip-prepare --skip-build
```

说明：

- `ZCODE_ENV=production` 确保不是 Preview / TEST 身份。
- `APPLE_SIGNING_IDENTITY=-` 使用 ad-hoc 签名。
- 本机 macOS 对未签名 arm64 Electron App 可能直接拒绝启动；ad-hoc 签名是本地可运行的关键。
- 正式分发仍需 Developer ID 签名和 notarization。

### 6.2 产物路径

```text
packages/desktop/dist/mac-arm64/opencode.app
packages/desktop/dist/opencode-3.14.3-mac-arm64.dmg
packages/desktop/dist/opencode-3.14.3-mac-arm64.zip
```

版本号来自根 `package.json`，后续版本变化时文件名中的 `3.14.3` 会同步变化。

### 6.3 自动更新已整体关闭（2026-09-29）

#### 决策

rebrand 后自动更新不仅没有意义，而且有害：

1. 官方更新 feed（`ManifestUpdateProvider` 指向 zcode 后端）只分发官方 ZCode 安装包，Bundle ID 是 `dev.zcode.app`、图标和进程名都是原样。自动更新一旦命中并安装，本文件的改造会被整体覆盖回原身份。
2. 本机正是按原 `ZCode` / `dev.zcode.app` 身份拦截原应用；自动更新等于把被拦截的身份装回来。
3. 本副本的升级链路本来就是手动维护（第 11 节 rebase + 重新打包），官方 feed 不感知本副本的身份与版本。

因此自动更新与远端强制升级（force-update）gate 一并关闭，对所有 flavor（production / preview）生效。规格见 `packages/desktop/specs/auto-update-policy.md`。

#### 实现

唯一事实源是能力开关（`packages/shared/src/env.ts`）：

```ts
export const ZCODE_AUTO_UPDATE_ENABLED = false;
```

所有更新入口跟随该开关，不再各自判断 `ZCODE_PRODUCT_FLAVOR`：

| 入口 | 文件 | 关闭后的行为 |
| --- | --- | --- |
| updater 初始化 / 启动检查 / 每小时轮询 | `packages/desktop/src/main/index.ts` | `initAutoUpdater({ enabled: false })`，不配置 feed、不起轮询 |
| 远端强制升级 gate | `packages/desktop/src/main/index.ts` | 一并停用；否则 gate 会把启动锁死在一个无法执行的"自动升级"按钮上 |
| 设置变更刷新更新通道 | `packages/desktop/src/main/index.ts` | `receivePreviewUpdates` 变更不再触发 `refreshAutoUpdaterReleaseChannel` |
| 应用菜单"检查更新" | `packages/desktop/src/main/desktopApplicationMenu.ts` | 不渲染入口（macOS 与 Win/ Linux 菜单两处） |
| Windows 托盘"检查更新" | `packages/desktop/src/main/desktopTray.ts` | 不渲染入口 |
| 手动检查命令兜底 | `packages/desktop/src/main/desktopCommandHandlers.ts` | 只记日志，不发请求 |

`initAutoUpdater({ enabled: false })` 的既有 fail-closed 语义保持：electron-updater 实例保持未配置，`checkForUpdateMenuClick` 内部因 `autoUpdaterDisabledForProductFlavor === true` 直接跳过，即使有遗漏入口也不会向占位 feed 发真实请求。

保持不变的部分：

- `electron-updater` 依赖与 `autoUpdater.ts` 状态机全部保留；将来若自建 feed，把开关改回 `true` 即可恢复。
- renderer 侧"自动下载并安装更新"等设置项与 Preview flavor 现状一致：可显示但无实际效果，不单独清理。

#### 回归测试

```bash
pnpm exec tsx --test packages/desktop/test/auto-update-policy.test.mjs
```

防止：开关被改回 `true`、`initAutoUpdater` 的 `enabled` 重新按 flavor 判断、强更 gate 与开关脱钩、菜单 / 托盘 / 手动检查入口绕过开关。

本次验证记录（2026-09-29，工作副本 `Documents/AICodeAgent/ZCode`，上游 `main` @ `29628c9` 之上）：

```text
回归测试：7/7 通过
pnpm typecheck：通过
oxlint（全仓）：70 warnings / 0 errors，均为上游历史遗留，改动文件未新增
oxfmt --check：改动文件全部通过（全仓另有 34 个上游既有文件不合规，属 bots / 渠道相关历史文件）
architecture:check --changed：OK，0 violations
```

注意：该副本改动尚未提交（上游约定 rebrand 改动集中提交到 `opencode` 分支，见第 11 节）。

## 7. 本机运行验证

启动：

```bash
open -na /Applications/opencode.app
```

验证进程：

```bash
ps axo pid,ppid,stat,etime,comm,args |
  grep -Ei 'opencode|opencode-|zcode-cli|zcode-node-repl-mcp' |
  grep -v grep
```

期望看到：

```text
opencode
opencode Helper
opencode Helper (Renderer)
opencode-host-local-1
opencode-cli
opencode-node-repl-mcp
```

不应再出现：

```text
zcode-cli
zcode-node-repl-mcp
```

Bundle 验证：

```bash
/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' \
  -c 'Print :CFBundleName' \
  -c 'Print :CFBundleIconFile' \
  packages/desktop/dist/mac-arm64/opencode.app/Contents/Info.plist
```

期望：

```text
dev.opencode.app
opencode
icon.icns
```

签名验证：

```bash
codesign --verify --deep --strict --verbose=2 \
  packages/desktop/dist/mac-arm64/opencode.app
```

## 8. 本机安装与数据目录迁移

当前本机最终 `opencode.app` 已移动并安装到：

```text
/Applications/opencode.app
```

仓库 `dist/` 中保留 DMG / ZIP 安装包；下次重新 bundle 后会重新生成 `packages/desktop/dist/mac-arm64/opencode.app`。

打包生产版默认数据目录变为：

```text
~/Library/Application Support/opencode
```

旧 ZCode 数据目录不会自动迁移。如果需要沿用登录态和历史数据，需要评估旧目录结构后手动迁移；不要直接盲目覆盖。

更新（2026-09-29）：按第 2 节新明确的边界，数据目录目标改为**保持 zcode 原有路径**（主进程显式 `app.setPath("userData", ...)` 固定），不再跟随显示名落到 `Application Support/opencode`，本地配置、登录态与项目记录零迁移直接沿用。上文"数据目录变为 opencode"的描述仅在其他工作副本的历史实现中成立，后续以本更新为准。

## 9. 规格与测试

### 9.1 规格

```text
packages/desktop/specs/desktop-product-identity.md
packages/desktop/specs/product-icon.md
packages/desktop/specs/auto-update-policy.md
packages/shared/specs/process-names.md
```

后续修改行为前，先更新对应 spec，再改实现。

### 9.2 测试

```text
packages/desktop/test/desktop-product-identity.test.mjs
packages/desktop/test/product-icon.test.mjs
packages/desktop/test/app-asar-repack.test.mjs
packages/desktop/test/required-runtime-modules.test.mjs
packages/shared/test/process-names.test.ts
apps/zcode-cli/packages/cli/test/process-name.test.ts
apps/zcode-cli/packages/node-repl-host/test/process-title.test.ts
```

运行示例：

```bash
pnpm exec tsx --test \
  packages/desktop/test/desktop-product-identity.test.mjs \
  packages/desktop/test/product-icon.test.mjs \
  packages/shared/test/process-names.test.ts \
  apps/zcode-cli/packages/cli/test/process-name.test.ts \
  apps/zcode-cli/packages/node-repl-host/test/process-title.test.ts
```

## 10. 必跑验证

根仓库：

```bash
pnpm typecheck
pnpm lint
pnpm fmt:check
```

CLI 相关修改还需：

```bash
pnpm exec turbo --skip-infer --cwd apps/zcode-cli run typecheck
```

当前仓库已有一些历史 lint warnings；判断标准是不得引入新的 error / warning。`apps/zcode-cli` 的全量 lint 存在既有 `max-lines` errors，不要把本次进程名或图标改动与那些历史问题混在一起。

架构检查：

```bash
pnpm architecture:check --changed
```

如果当前目录没有 `.git`，该命令无法推导 changed files。可用 `scripts/architecture/index.mjs` 的 `checkArchitecture({ changedFiles })` 显式传入文件列表；本次改动验证结果为无新增违规。

## 11. 上游同步与 Git 管理

本仓库是官网 `zai-org/ZCode` 的本地私有改造副本。分支约定：

- `main`：只跟踪 `origin/main`，不带任何本地提交，保持与官网完全一致。
- `opencode（日常开发分支）：`origin/main` + rebrand 提交。全部应用身份、进程名、图标、specs、测试改动集中在这一个提交里，rebase 冲突面最小。
- 永远不要 push 到 origin；也不要 fork 官网仓库做备份（fork 公共仓库是公开的，rebrand 方案不应公开）。云端备份用独立私有仓库：`git remote add backup <url>` 后 `git push backup opencode。

官网出现新提交时，在 `opencode 分支上同步：

```bash
git fetch origin
git rebase origin/main
```

- 有冲突时解决后 `git add <file>`，再 `git rebase --continue`。
- 已开启 `rerere`（`git config rerere.enabled true`），重复冲突（如每次发版的 `package.json` 版本号）第二次起自动复用上次的解法。
- 同步后判断是否重新打包：纯版本号、文档类更新不需要；源码变化才按第 6 节命令重打包。

查看与官网的全部偏差：

```bash
git log --oneline main..opencode   # 本地多出的提交
git diff main..opencode            # 本地相对官网的全部改动
```

后续新增的本地改动也应提交进 `opencode 分支，保持工作区干净；不要回到"长期未提交改动 + stash 同步"的方式。

## 12. 修改清单速查

### 应用身份

```text
packages/desktop/scripts/desktop-product-identity.mjs
packages/desktop/src/main/desktopRuntimeEnv.ts
packages/desktop/package.json
packages/desktop/src/renderer/index.html
packages/desktop/scripts/devElectronAppBundle.mjs
packages/desktop/scripts/dev.mjs
packages/desktop/src/main/desktopLinuxDeepLinkRegistration.ts
packages/desktop/specs/desktop-product-identity.md
packages/desktop/test/desktop-product-identity.test.mjs
```

### 进程名

```text
packages/shared/src/process-names.ts
packages/shared/specs/process-names.md
packages/shared/test/process-names.test.ts
apps/zcode-cli/packages/cli/src/process-name.ts
apps/zcode-cli/packages/cli/test/process-name.test.ts
apps/zcode-cli/packages/node-repl-host/src/process-title.ts
apps/zcode-cli/packages/node-repl-host/src/server.ts
apps/zcode-cli/packages/node-repl-host/test/process-title.test.ts
```

### 自动更新（已关闭）

```text
packages/shared/src/env.ts
packages/shared/src/index.ts
packages/desktop/src/main/index.ts
packages/desktop/src/main/desktopApplicationMenu.ts
packages/desktop/src/main/desktopTray.ts
packages/desktop/src/main/desktopCommandHandlers.ts
packages/desktop/specs/auto-update-policy.md
packages/desktop/test/auto-update-policy.test.mjs
```

### 图标与文档

```text
packages/desktop/scripts/generate-opencode-icons.mjs
packages/desktop/specs/product-icon.md
packages/desktop/test/product-icon.test.mjs
packages/desktop/build/**
public/logo/icons/**
public/icon_512@2x.png
packages/ui/src/components/ui/ZCodeAboutLogo.tsx
packages/desktop/src/renderer/index.html
packages/ui/src/root/RootStartupLoading.tsx
packages/ui/src/v4/ConversationDraftEmptyState.tsx
README.md
田迎CODETY_REBRAND.md
```

## 13. Auto++ 本地代理适配

### 13.1 问题

opencode 改名后，Auto++ 本地代理会按真实进程身份做白名单校验。请求来自：

```text
process_name: opencode Helper
executable_path: /Applications/opencode.app/Contents/Frameworks/opencode Helper.app/Contents/MacOS/opencode Helper
```

但 Auto++ 内置的 `zcode` 白名单只匹配包含 `zcode` 的进程名或可执行路径，因此 opencode 请求会被本地代理拒绝：

```text
HTTP 403
reason=no-process-match
```

这个问题发生在 Auto++ 本地代理层，与 `~/.zcode/v2/provider_config.json` 里的模型列表无关。

### 13.2 方案

选择把 opencode 映射到 Auto++ 已有的 `opencode` 客户端身份。不要新增独立的 `opencode 工具 ID，否则 Auto++ 的使用统计和后端会看到新的 `opencode 客户端名。

本机修改文件：

```text
~/Library/Python/3.13/lib/python/site-packages/ahclaude_plugin/tool_specs.py
```

备份文件：

```text
~/Library/Python/3.13/lib/python/site-packages/ahclaude_plugin/tool_specs.py.bak-before-opencode-opencode-20260929
```

将 `tool_id="opencode"` 的进程匹配改为：

```python
process_matches={
    "process_name": (
        "re:.*opencode.*",
        "re:.*opencode.*",
    ),
    "executable_path": (
        "re:.*opencode.*",
        "re:.*opencode.*",
    ),
}
```

注意：Auto++ 的正则匹配默认忽略大小写，因此 `opencode Helper` 能命中 `re:.*opencode.*`。

### 13.3 重启与验证

重启 Auto++ 本地代理：

```bash
python3 -m ahclaude_plugin.main proxy stop
```

Auto++ 的 supervisor / LaunchAgent 会重新拉起新子进程。确认状态：

```bash
python3 -m ahclaude_plugin.main proxy status
```

确认新进程加载的是用户目录下的包：

```text
/Users/tianyingli/Library/Python/3.13/lib/python/site-packages/ahclaude_plugin
```

可以用下面的脚本验证 opencode Helper 会匹配为 `opencode`：

```bash
python3 - <<'PY'
from ahclaude_plugin.proxy.process_identity import ProcessIdentity
from ahclaude_plugin.proxy.process_tool_matcher import ProcessToolMatcher

identity = ProcessIdentity(
    status="resolved",
    platform="macos",
    process_name="opencode Helper",
    executable_path="/Applications/opencode.app/Contents/Frameworks/opencode Helper.app/Contents/MacOS/opencode Helper",
)
analysis = ProcessToolMatcher().analyze(identity)
matches = analysis.complete_matches
print([(item.tool_id, item.matched_pattern) for item in matches])
PY
```

期望输出包含：

```text
opencode
```

### 13.4 升级风险

`ahclaude_plugin` 是 Auto++ 安装的 Python 包，不是 ZCode 仓库内的源码。Auto++ 升级后可能覆盖 `tool_specs.py`，届时需要按本节重新应用补丁。

该映射只会让本地进程白名单把 `opencode 识别为已有的 `opencode` 工具身份；不会新增名为 `opencode 的工具 ID。

## 14. 常见问题

### Finder / Dock 仍显示旧图标

可能是 LaunchServices 或 Dock 缓存。确认打开的是新路径：

```text
packages/desktop/dist/mac-arm64/opencode.app
```

必要时移除旧的 Dock 固定项，重新固定新 App。

### 从 DMG 拷贝后无法启动

优先确认包内 App 是否已 ad-hoc 签名：

```bash
codesign --verify --deep --strict /Applications/opencode.app
```

如未签名，可临时执行：

```bash
codesign --force --deep --sign - /Applications/opencode.app
```

### 仍看到 zcode 字符串

先区分位置：

- 活动监视器“进程名称”列不应是 `zcode-cli` / `zcode-node-repl-mcp`
- 完整命令行参数中的 `zcode.cjs`、`zcode-media`、`ZCODE_*` 是内部兼容边界，刻意保留
- UI 文案里如果出现 `ZCode`，属于另一个品牌文案清理任务，不应和进程名 / Bundle ID 混在一起全量替换
