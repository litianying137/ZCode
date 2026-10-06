# 产品图标（codety 官方资产）

> 状态：已实现
> 关联文档：仓库根目录《田迎CODETY_REBRAND.md》第 1.1、5 节

## 资产来源

所有应用图标直接取自 codety 官方源码
`packages/desktop/icons/prod/`（深色圆角方块 + 白色回形 Mark），不再使用任何本地生成的
"蓝底 + T" 方案：

```text
icon.icns（macOS，标准网格重合成）
icon.ico（Windows / 托盘）
icon.png（512x512 源）
```

macOS icns 边距规则：官方 `icon.png` 是满幅 512 方块，直接转 icns 会让 Dock 图标比
其他 app 大一圈。icns 必须按 macOS 标准网格重合成——内容占画布 824/1024（≈80.5%）、
四周透明留白（与 codety 官方 `icons/README.md` 用 Image2Icon Big Sur preset 的原因
一致）。当前 icns 由官方 512 源合成，SHA-256 锚定在
`packages/desktop/test/product-icon.test.mjs`；ico / png 保持满幅（Windows/Linux 无此惯例）。

macOS Dock 运行时规则：`app.dock.setIcon()`（`applyAppIcon`）会在每次启动时覆盖 bundle
icns，因此 darwin 的 `iconPath` 必须指向**带边距的** `build/icon_dock.png`（1024 画布、
内容 824/1024），由 electron-builder extraResources 打进 `resources/icon_dock.png`。
满幅 `icon.png` 只用于 Linux/打包资源与 About 窗口图标。

zcode 侧落点：

| 文件 | 来源 / 生成方式 |
| --- | --- |
| `packages/desktop/build/icon.icns` / `icon.ico` / `icon.png` | 官方 prod 三件原样复制 |
| `packages/desktop/build/icon_installer.icns` / `.ico` / `.png` | 与应用图标一致（官方无独立安装图标） |
| `packages/desktop/build/icon_windows.png` | 官方 `icon.png` |
| `packages/desktop/build/icons/<n>x<n>.png` | `sips` 从官方 `icon.png` 重采样（16–1024） |
| `packages/desktop/build/dmg_background.png` / `@2x.png` | 本地生成：浅底 + CODETY 字样 + 拖拽箭头（540x380 / 1080x760） |
| `public/logo/icons/**`、`public/icon_512@2x.png` | 与 build 同源重采样 |

electron-builder 的 `mac.icon` / `win.icon` 走默认约定 `build/icon.icns` / `build/icon.ico`，
DMG 背景 / 安装图标已在 `packages/desktop/electron-builder.config.js` 中指向上述文件。

## 应用内品牌图形

SVG 品牌组件移植自 codety 官方 `packages/ui/src/components/logo.tsx`（Mark 16x20、
Logo 字标 234x42），按 currentColor + 透明度（weak 0.35 / base 0.85 / strong 1）映射：

- `packages/ui/src/components/ui/ZCodeAboutLogo.tsx`（组件名保留，避免跨包重命名）
- `packages/ui/src/root/RootStartupLoading.tsx`
- `packages/ui/src/v4/ConversationDraftEmptyState.tsx`（水印不再分明暗两套资源，`Z.svg` 引用移除）
- `packages/ui/src/assets/codety-mark-badge.svg`（顶栏 / 侧栏小徽标）
- `packages/desktop/src/renderer/index.html`（Electron 首屏）
- `packages/desktop/src/main/aboutWindow.ts`（自定义 About 对话框）
- `packages/web/index.html`（Web 启动页，含 `<title>`）

不得在这些位置重新引入旧 ZCode "Z" 字形（`packages/ui/src/assets/Z.svg` 不再被引用）。
`provider-icons/logo-zai.svg` 是 Z.ai 供应商图标，与应用品牌无关，保留。

## 回归测试

`packages/desktop/test/product-icon.test.mjs` 以官方资产的 SHA-256 为锚，防止图标被
替换回非官方素材或 Z 字形回潮。
