# 自动更新策略（私有改造副本）

> 状态：已实现
> 关联文档：仓库根目录《田迎CODETY_REBRAND.md》

## 决策

本仓库是对官网 `zai-org/ZCode` 的私有改造副本，对外身份为 `opencode`。自动更新**整体关闭**，对所有产品 flavor（production / preview）一律生效，不允许被构建参数或运行时开关重新打开。

原因：

1. 官方更新 feed 只分发官方 ZCode 安装包（Bundle ID `dev.zcode.app`、原图标、原进程名）。自动更新一旦命中并安装，rebrand 后的应用会被整体覆盖回原身份，改造全部作废。
2. 本机正是按原 `ZCode` / `dev.zcode.app` 身份拦截原应用的；自动更新等于把被拦截的身份装回来。
3. 本副本的升级链路是手动维护：`git fetch origin && git rebase origin/main` 后按文档重新打包（见《田迎CODETY_REBRAND.md》第 11 节）。官方 feed 不感知本副本的版本与身份。

## 实现约定

唯一事实源是 `packages/shared/src/env.ts` 中的能力开关：

```ts
export const ZCODE_AUTO_UPDATE_ENABLED = false;
```

所有更新相关入口必须跟随该开关，而不是各自判断 `ZCODE_PRODUCT_FLAVOR`：

| 入口 | 文件 | 行为 |
| --- | --- | --- |
| updater 初始化 / 启动检查 / 轮询 | `packages/desktop/src/main/index.ts` | `initAutoUpdater({ enabled: false })`，模块内部 fail-closed |
| 远端强制升级 gate | `packages/desktop/src/main/index.ts` | 随更新能力一起停用；否则 gate 会把启动锁死在一个无法执行的"自动升级"按钮上 |
| 设置变更刷新更新通道 | `packages/desktop/src/main/index.ts` | `receivePreviewUpdates` 变更不再触发 `refreshAutoUpdaterReleaseChannel` |
| 应用菜单"检查更新" | `packages/desktop/src/main/desktopApplicationMenu.ts` | 不渲染入口 |
| Windows 托盘"检查更新" | `packages/desktop/src/main/desktopTray.ts` | 不渲染入口 |
| 手动检查命令兜底 | `packages/desktop/src/main/desktopCommandHandlers.ts` | 只记日志，不发请求 |

`initAutoUpdater({ enabled: false })` 的既有语义保持不变：清掉轮询定时器后直接返回，electron-updater 实例保持未配置；`checkForUpdateMenuClick` 内部因 `autoUpdaterDisabledForProductFlavor === true` 而 fail-closed，即使有遗漏入口也不会向占位 feed 发起真实请求。

## 保持不变

- renderer 侧更新相关设置项（"自动下载并安装更新"等）与 Preview flavor 现状一致：可显示但无实际效果，不在本次范围内清理。
- `electron-updater` 依赖与 `autoUpdater.ts` 状态机代码全部保留，便于将来自建 feed 后把开关改回 `true` 即可恢复更新能力。

## 回归测试

`packages/desktop/test/auto-update-policy.test.mjs` 防止以下回退：

- 能力开关被改回 `true`；
- 任何更新入口绕过开关、重新直接判断 `ZCODE_PRODUCT_FLAVOR === "production"`；
- 强更 gate 与 `initAutoUpdater` 的 `enabled` 脱钩。

修改更新链路前，先更新本 spec，再改实现与测试。
