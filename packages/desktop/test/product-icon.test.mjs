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

// 锚定 opencode 官方 prod 图标（opencode/packages/desktop/icons/prod/），
// 防止图标被替换回本地生成素材或旧 ZCode 图标。
const OFFICIAL_SHA256 = {
  "packages/desktop/build/icon.icns":
    "0c6c7f9481ec4a1e3f8df934ba41baa525c86fd5046d69a3dc8de8caac61d955",
  "packages/desktop/build/icon.ico":
    "1e06bbd99bd63c3ce5a0241ff2aea61ac7b8cf1d97728845eb212cb59343edc0",
  "packages/desktop/build/icon.png":
    "324bd6ab9499f006519209eaa883519f37b9373a59d6eb01235189d4ac67ea27",
};

for (const [relativePath, expected] of Object.entries(OFFICIAL_SHA256)) {
  test(`图标为 opencode 官方资产：${relativePath}`, () => {
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

test("DMG 背景为 OpenCode 品牌且尺寸正确", () => {
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

test("应用内品牌组件使用 opencode 官方 Mark，Z 字形不回潮", () => {
  const markPath = "M12 4H4V16H12V4ZM16 20H0V0H16V20Z";
  for (const relativePath of [
    "packages/ui/src/components/ui/ZCodeAboutLogo.tsx",
    "packages/ui/src/root/RootStartupLoading.tsx",
    "packages/ui/src/v4/ConversationDraftEmptyState.tsx",
    "packages/desktop/src/renderer/index.html",
  ]) {
    const source = read(relativePath).toString("utf8");
    assert.match(
      source,
      new RegExp(markPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      `${relativePath} 未使用 opencode 官方 Mark`,
    );
    assert.doesNotMatch(
      source,
      /assets\/Z\.svg|M134\.4 0\.130152/,
      `${relativePath} 回到了旧 ZCode 字形`,
    );
  }
});

test("顶栏小徽标是 opencode mark badge", () => {
  for (const relativePath of [
    "packages/ui/src/App.tsx",
    "packages/ui/src/WindowsTopLeftLogo.tsx",
    "packages/ui/src/WorkspaceSidebar/WorkspaceSidebarCollapsedRail.tsx",
  ]) {
    assert.match(
      read(relativePath).toString("utf8"),
      /opencode-mark-badge\.svg/,
      `${relativePath} 未接入 opencode-mark-badge.svg`,
    );
  }
  // DesktopTopOverlay 的 logo 由 App.tsx 通过 appLogoUrl prop 传入，这里只验证 alt。
  assert.match(read("packages/ui/src/DesktopTopOverlay.tsx").toString("utf8"), /alt="OpenCode"/);
  assert.doesNotMatch(
    read("packages/ui/src/assets/opencode-mark-badge.svg").toString("utf8"),
    /M134\.4 0\.130152/,
  );
});
