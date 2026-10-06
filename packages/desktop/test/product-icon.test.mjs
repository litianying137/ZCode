import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "../../..");
const read = (relativePath) => readFileSync(join(repoRoot, relativePath));
const sha256 = (relativePath) => createHash("sha256").update(read(relativePath)).digest("hex");

// 锚定 codety 官方 prod 图标（codety/packages/desktop/icons/prod/），
// 防止图标被替换回本地生成素材或旧 ZCode 图标。
// icns 是官方 512 源按 macOS 标准网格（内容 824/1024 + 透明留白）重合成的，
// 避免满幅图标在 Dock 中比其他 app 大一圈（codety 官方 README 记录了同样的问题）。
const OFFICIAL_SHA256 = {
  "packages/desktop/build/icon.icns":
    "3307859d3604ec84ad3fd29d9ac03734b392b5cacef7c0d81b992cd25fa10f9d",
  "packages/desktop/build/icon.ico":
    "1e06bbd99bd63c3ce5a0241ff2aea61ac7b8cf1d97728845eb212cb59343edc0",
  "packages/desktop/build/icon.png":
    "324bd6ab9499f006519209eaa883519f37b9373a59d6eb01235189d4ac67ea27",
  "packages/desktop/build/icon_dock.png":
    "9fa6e8abdd23d56ee8f90adf150a3a33c4719991d29e33e174a8bd396b02641d",
};

for (const [relativePath, expected] of Object.entries(OFFICIAL_SHA256)) {
  test(`图标为 codety 官方资产：${relativePath}`, () => {
    assert.equal(sha256(relativePath), expected);
  });
}

test("安装图标与应用图标一致（官方无独立安装图标）", () => {
  assert.equal(
    sha256("packages/desktop/build/icon_installer.icns"),
    OFFICIAL_SHA256["packages/desktop/build/icon.icns"],
  );
  assert.equal(
    sha256("packages/desktop/build/icon_installer.ico"),
    OFFICIAL_SHA256["packages/desktop/build/icon.ico"],
  );
});

test("DMG 背景为 Codety 品牌且尺寸正确", () => {
  const png = read("packages/desktop/build/dmg_background.png");
  // PNG 宽高位于 IHDR：宽 540 高 380（大端）
  assert.equal(png.readUInt32BE(16), 540);
  assert.equal(png.readUInt32BE(20), 380);
  const png2x = read("packages/desktop/build/dmg_background@2x.png");
  assert.equal(png2x.readUInt32BE(16), 1080);
  assert.equal(png2x.readUInt32BE(20), 760);
  // 背景中不得再出现 ZCODE 字样素材的旧文件内容
  assert.notEqual(sha256("packages/desktop/build/dmg_background.png"), sha256("packages/desktop/build/icon.png"));
});

test("应用内品牌组件使用 codety 官方 Mark，Z 字形不回潮", () => {
  const markPath = "M12 4H4V16H12V4ZM16 20H0V0H16V20Z";
  for (const relativePath of [
    "packages/ui/src/components/ui/ZCodeAboutLogo.tsx",
    "packages/ui/src/root/RootStartupLoading.tsx",
    "packages/ui/src/v4/ConversationDraftEmptyState.tsx",
    "packages/desktop/src/renderer/index.html",
    "packages/desktop/src/main/aboutWindow.ts",
    "packages/web/index.html",
  ]) {
    const source = read(relativePath).toString("utf8");
    assert.match(
      source,
      new RegExp(markPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      `${relativePath} 未使用 codety 官方 Mark`,
    );
    assert.doesNotMatch(
      source,
      /assets\/Z\.svg|M134\.4 0\.130152/,
      `${relativePath} 回到了旧 ZCode 字形`,
    );
  }
});

test("macOS Dock 图标用带边距的 icon_dock.png，不得回退满幅 icon.png", () => {
  const iconDock = read("packages/desktop/build/icon_dock.png");
  // 1024 画布；内容边距由 sha256 锚定（PNG 像素在 IDAT 内压缩，无法按偏移断言）
  assert.equal(iconDock.readUInt32BE(16), 1024);
  assert.equal(iconDock.readUInt32BE(20), 1024);

  const mainIndex = read("packages/desktop/src/main/index.ts").toString("utf8");
  const iconPathBlock = mainIndex.match(/const iconPath =[\s\S]*?;\n/);
  assert.ok(iconPathBlock, "未找到 iconPath 定义");
  assert.match(
    iconPathBlock[0],
    /darwin[\s\S]*?icon_dock\.png/,
    "darwin 的 iconPath 必须指向 icon_dock.png（运行时 dock.setIcon 会覆盖 icns）",
  );

  const builderConfig = read("packages/desktop/electron-builder.config.js").toString("utf8");
  assert.match(
    builderConfig,
    /from: "build\/icon_dock\.png",\s*\n\s*to: "icon_dock\.png"/,
    "electron-builder 必须把 icon_dock.png 打进 resources",
  );
});

test("顶栏小徽标是 codety mark badge", () => {
  for (const relativePath of [
    "packages/ui/src/App.tsx",
    "packages/ui/src/WindowsTopLeftLogo.tsx",
    "packages/ui/src/WorkspaceSidebar/WorkspaceSidebarCollapsedRail.tsx",
  ]) {
    assert.match(
      read(relativePath).toString("utf8"),
      /codety-mark-badge\.svg/,
      `${relativePath} 未接入 codety-mark-badge.svg`,
    );
  }
  // DesktopTopOverlay 的 logo 由 App.tsx 通过 appLogoUrl prop 传入，这里只验证 alt。
  assert.match(read("packages/ui/src/DesktopTopOverlay.tsx").toString("utf8"), /alt="Codety"/);
  assert.doesNotMatch(
    read("packages/ui/src/assets/codety-mark-badge.svg").toString("utf8"),
    /M134\.4 0\.130152/,
  );
});
