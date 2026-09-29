import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "../../..");
const read = (relativePath) => readFileSync(join(repoRoot, relativePath), "utf8");

const IDENTITY = "packages/desktop/scripts/desktop-product-identity.mjs";
const RUNTIME_ENV = "packages/desktop/src/main/desktopRuntimeEnv.ts";
const DESKTOP_PKG = "packages/desktop/package.json";
const DEV_BUNDLE = "packages/desktop/scripts/devElectronAppBundle.mjs";
const WEB_MAIN = "packages/web/src/main.tsx";

test("构建期身份取 opencode 官方值", () => {
  const source = read(IDENTITY);
  // 官方 prod / beta（opencode/packages/desktop/electron-builder.config.ts）
  assert.match(source, /appId: "ai\.opencode\.desktop"/);
  assert.match(source, /productName: "OpenCode"/);
  assert.match(source, /appId: "ai\.opencode\.desktop\.beta"/);
  assert.match(source, /productName: "OpenCode Beta"/);
  assert.match(source, /linuxExecutableName: "opencode"/);
  assert.match(source, /linuxPackageName: "opencode"/);
  assert.doesNotMatch(
    source,
    /dev\.zcode\.app|cn\.aminer\.zcode/,
    "Bundle ID / AUMID 回退到了 zcode 身份",
  );
});

test("运行时显示名是 OpenCode 系，数据目录名保持 zcode 原路径", () => {
  const source = read(RUNTIME_ENV);
  // 显示名跟随官方 opencode 桌面端命名
  assert.match(source, /"OpenCode Dev"/);
  assert.match(source, /"OpenCode Beta"/);
  assert.match(source, /"OpenCode"/);
  // 本地配置 / 登录态继续走 zcode 原有路径（显示名与数据目录名解耦）
  assert.match(source, /const runtimeDataDirName =/);
  assert.match(
    source,
    /join\(getElectronAppPath\("appData"\), runtimeDataDirName\)/,
    "userData 目录必须由 runtimeDataDirName（zcode 原名）决定",
  );
  assert.doesNotMatch(
    source,
    /join\(getElectronAppPath\("appData"\), runtimeApplicationName\)/,
    "userData 目录不得跟随 opencode 显示名",
  );
});

test("桌面包 productName 是 OpenCode", () => {
  assert.match(read(DESKTOP_PKG), /"productName": "OpenCode"/);
});

test("Dev Electron 副本身份是 OpenCode Dev / ai.opencode.desktop.dev", () => {
  const source = read(DEV_BUNDLE);
  assert.match(source, /DEV_ELECTRON_APP_NAME = "OpenCode Dev"/);
  assert.match(source, /DEV_ELECTRON_APP_BUNDLE_ID = "ai\.opencode\.desktop\.dev"/);
});

test("远控窗口标题与进程名识别值一致（OpenCode - 前缀）", () => {
  const web = read(WEB_MAIN);
  assert.match(web, /document\.title = "OpenCode - Web"/);
  assert.match(web, /document\.title = "OpenCode - Sign In"/);
  const shared = read("packages/shared/src/process-names.ts");
  assert.match(shared, /const remoteWindowPrefix = "OpenCode - ";/);
});

test("About 对话框应用名是 OpenCode", () => {
  const source = read("packages/desktop/src/main/about.ts");
  assert.match(source, /ABOUT_APPLICATION_NAME = "OpenCode Desktop App"/);
  assert.match(source, /About OpenCode/);
  assert.match(source, /关于 OpenCode/);
});

test("CUA Helper 名与 Bundle ID 已切到 opencode 系", () => {
  const source = read("packages/zcode-cua/broker-helper-constants.js");
  assert.match(source, /HELPER_APP_NAME = "OpenCode Computer Use\.app"/);
  assert.match(source, /HELPER_BUNDLE_ID = "ai\.opencode\.cua-helper"/);
  assert.doesNotMatch(source, /ZCode Computer Use|dev\.zcode\.cua-helper/);
});

test("Z.ai 供应商图标不被当作应用 logo 改名", () => {
  // oauthProviderIcon 里的 logo-zai.svg 是 Z.ai OAuth 供应商图标，与应用品牌无关。
  const source = read("packages/ui/src/lib/oauthProviderIcon.tsx");
  assert.match(source, /logo-zai\.svg/);
});
