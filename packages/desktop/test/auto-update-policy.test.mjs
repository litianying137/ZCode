import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "../../..");

const read = (relativePath) => readFileSync(join(repoRoot, relativePath), "utf8");

const SHARED_ENV = "packages/shared/src/env.ts";
const MAIN_INDEX = "packages/desktop/src/main/index.ts";
const APP_MENU = "packages/desktop/src/main/desktopApplicationMenu.ts";
const TRAY = "packages/desktop/src/main/desktopTray.ts";
const COMMAND_HANDLERS = "packages/desktop/src/main/desktopCommandHandlers.ts";

test("自动更新能力开关固定为 false", () => {
  const source = read(SHARED_ENV);
  assert.match(
    source,
    /export const ZCODE_AUTO_UPDATE_ENABLED = false;/,
    "能力开关必须是字面量 false；恢复自动更新前先自建 feed 并更新 auto-update-policy spec",
  );
});

test("initAutoUpdater 的 enabled 必须跟随能力开关", () => {
  const source = read(MAIN_INDEX);
  assert.match(
    source,
    /enabled: ZCODE_AUTO_UPDATE_ENABLED,/,
    "initAutoUpdater 不得再按 ZCODE_PRODUCT_FLAVOR 决定启用",
  );
  assert.doesNotMatch(
    source,
    /enabled: ZCODE_PRODUCT_FLAVOR === "production"/,
    "更新启用判断被改回按 flavor 决定，rebrand 身份会被官方更新包覆盖",
  );
});

test("远端强制升级 gate 必须跟随更新能力开关", () => {
  const source = read(MAIN_INDEX);
  const gate = source.match(
    /const forceUpdateGuardResult =\s*\n([\s\S]*?)\? await maybeBlockStartupForForceUpdate/,
  );
  assert.ok(gate, "未找到 force-update gate 条件");
  assert.match(
    gate[1],
    /ZCODE_AUTO_UPDATE_ENABLED/,
    "更新器关闭时强更 gate 必须一并停用，否则启动会被无法执行的自动升级按钮锁死",
  );
});

test("设置变更不得在更新器关闭时刷新更新通道", () => {
  const source = read(MAIN_INDEX);
  const branch = source.match(
    /if \(typeof patch\.receivePreviewUpdates === "boolean"\) \{([\s\S]*?)\n  \}/,
  );
  assert.ok(branch, "未找到 receivePreviewUpdates 设置分支");
  assert.match(
    branch[1],
    /ZCODE_AUTO_UPDATE_ENABLED/,
    "refreshAutoUpdaterReleaseChannel 必须被能力开关挡住",
  );
});

for (const [label, relativePath] of [
  ["应用菜单", APP_MENU],
  ["Windows 托盘", TRAY],
  ["手动检查命令", COMMAND_HANDLERS],
]) {
  test(`${label}的检查更新入口必须跟随能力开关`, () => {
    const source = read(relativePath);
    assert.match(
      source,
      /ZCODE_AUTO_UPDATE_ENABLED/,
      `${label}入口未接入 ZCODE_AUTO_UPDATE_ENABLED`,
    );
    assert.doesNotMatch(
      source,
      /ZCODE_PRODUCT_FLAVOR === "production"[\s\S]{0,200}CheckForUpdates|CheckForUpdates[\s\S]{0,200}ZCODE_PRODUCT_FLAVOR === "production"/,
      `${label}入口重新按 flavor 露出检查更新入口`,
    );
  });
}
