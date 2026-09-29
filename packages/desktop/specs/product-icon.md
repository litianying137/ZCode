# 产品图标（opencode 官方资产）

> 状态：已实现
> 关联文档：仓库根目录《田迎CODETY_REBRAND.md》第 1.1、5 节

## 资产来源

所有应用图标直接取自 opencode 官方源码
`packages/desktop/icons/prod/`（深色圆角方块 + 白色回形 Mark），不再使用任何本地生成的
"蓝底 + T" 方案：

```text
icon.icns（macOS，含 Big Sur 边距）
icon.ico（Windows / 托盘）
icon.png（512x512 源）
```

zcode 侧落点：

| 文件 | 来源 / 生成方式 |
| --- | --- |
| `packages/desktop/build/icon.icns` / `icon.ico` / `icon.png` | 官方 prod 三件原样复制 |
| `packages/desktop/build/icon_installer.icns` / `.ico` / `.png` | 与应用图标一致（官方无独立安装图标） |
| `packages/desktop/build/icon_windows.png` | 官方 `icon.png` |
| `packages/desktop/build/icons/<n>x<n>.png` | `sips` 从官方 `icon.png` 重采样（16–1024） |
| `packages/desktop/build/dmg_background.png` / `@2x.png` | 本地生成：浅底 + OPENCODE 字样 + 拖拽箭头（540x380 / 1080x760） |
| `public/logo/icons/**`、`public/icon_512@2x.png` | 与 build 同源重采样 |

electron-builder 的 `mac.icon` / `win.icon` 走默认约定 `build/icon.icns` / `build/icon.ico`，
DMG 背景 / 安装图标已在 `packages/desktop/electron-builder.config.js` 中指向上述文件。

## 应用内品牌图形

SVG 品牌组件移植自 opencode 官方 `packages/ui/src/components/logo.tsx`（Mark 16x20、
Logo 字标 234x42），按 currentColor + 透明度（weak 0.35 / base 0.85 / strong 1）映射：

- `packages/ui/src/components/ui/ZCodeAboutLogo.tsx`（组件名保留，避免跨包重命名）
- `packages/ui/src/root/RootStartupLoading.tsx`
- `packages/ui/src/v4/ConversationDraftEmptyState.tsx`（水印，跟随主题色 + 渐隐 mask）
- `packages/ui/src/assets/opencode-mark-badge.svg`（顶栏 / 侧栏小徽标）
- `packages/desktop/src/renderer/index.html`（Electron 首屏）

不得在这些位置重新引入旧 ZCode "Z" 字形（`packages/ui/src/assets/Z.svg` 不再被引用）。
`provider-icons/logo-zai.svg` 是 Z.ai 供应商图标，与应用品牌无关，保留。

## 回归测试

`packages/desktop/test/product-icon.test.mjs` 以官方资产的 SHA-256 为锚，防止图标被
替换回非官方素材或 Z 字形回潮。
