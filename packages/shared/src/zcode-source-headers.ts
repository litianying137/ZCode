import { DEFAULT_ZCODE_ENDPOINT_ORIGIN } from "./zcodeEndpoint.js";

export const ZCODE_SOURCE_HEADERS = {
  "User-Agent": "ZCode/unknown",
  "HTTP-Referer": DEFAULT_ZCODE_ENDPOINT_ORIGIN,
  "X-Title": "Z Code@electron",
} as const;

export interface BuildZCodeSourceHeadersFromContextOptions {
  appVersion?: string;
  arch?: string;
  clientLanguage?: string;
  clientTimezone?: string;
  deviceMid?: string;
  endpointOrigin?: string;
  osVersion?: string;
  platform?: string;
  releaseChannel?: string;
  sourceTitle?: string;
}

export function normalizeZCodeSourceHeaderValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || !/^[\x20-\x7e]+$/.test(trimmed)) {
    return undefined;
  }
  return trimmed;
}

export function buildZCodeSourceHeadersFromContext(
  options: BuildZCodeSourceHeadersFromContextOptions = {},
): Record<string, string> {
  const appVersion = normalizeZCodeSourceHeaderValue(options.appVersion);
  const arch = normalizeZCodeSourceHeaderValue(options.arch);
  const clientLanguage = normalizeZCodeSourceHeaderValue(options.clientLanguage) ?? "unknown";
  const clientTimezone = normalizeZCodeSourceHeaderValue(options.clientTimezone) ?? "unknown";
  const deviceMid = normalizeZCodeSourceHeaderValue(options.deviceMid);
  const endpointOrigin =
    normalizeZCodeSourceHeaderValue(options.endpointOrigin) ?? DEFAULT_ZCODE_ENDPOINT_ORIGIN;
  const osVersion = normalizeZCodeSourceHeaderValue(options.osVersion);
  const platform = normalizeZCodeSourceHeaderValue(options.platform);
  const releaseChannel = normalizeZCodeSourceHeaderValue(options.releaseChannel);
  const sourceTitle = normalizeZCodeSourceHeaderValue(options.sourceTitle) ?? "electron";

  return {
    ...ZCODE_SOURCE_HEADERS,
    "HTTP-Referer": endpointOrigin,
    "User-Agent": `ZCode/${appVersion ?? "unknown"}`,
    ...(appVersion ? { "X-ZCode-App-Version": appVersion } : {}),
    "X-Title": `Z Code@${sourceTitle}`,
    ...(platform && arch ? { "X-Platform": `${platform}-${arch}` } : {}),
    ...(releaseChannel ? { "X-Release-Channel": releaseChannel } : {}),
    "X-Client-Language": clientLanguage,
    "X-Client-Timezone": clientTimezone,
    ...(platform ? { "X-Os-Category": normalizeOsCategory(platform) } : {}),
    ...(osVersion ? { "X-Os-Version": osVersion } : {}),
    ...(deviceMid ? { "X-Device-Mid": deviceMid } : {}),
  };
}

/** zcode 命名/归因 header 的放行域：z.ai 与 bigmodel.cn 自有后端。 */
export function isZCodeOwnedBaseUrl(baseUrl: string | undefined): boolean {
  const trimmed = baseUrl?.trim();
  if (!trimmed) return false;
  try {
    const hostname = new URL(trimmed).hostname.toLowerCase();
    return (
      hostname === "z.ai" ||
      hostname.endsWith(".z.ai") ||
      hostname === "bigmodel.cn" ||
      hostname.endsWith(".bigmodel.cn")
    );
  } catch {
    return false;
  }
}

/**
 * 按目标 baseURL 分流归因 header：z.ai / bigmodel.cn 自有域保留 ZCode 归因全集
 * （Coding Plan 后端依赖 User-Agent / X-Title / X-ZCode-* 做客户端识别与路由）；
 * 第三方 openai-compatible 供应商（自定义 baseURL）不得从 header 识别出客户端是
 * zcode —— 剥离 zcode 命名与指向自有域的 Referer，UA / X-Title 换成 OpenCode。
 */
export function scopeZCodeSourceHeadersForBaseUrl(
  headers: Record<string, string>,
  baseUrl: string | undefined,
): Record<string, string> {
  if (isZCodeOwnedBaseUrl(baseUrl)) {
    return headers;
  }

  const scoped: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (key === "HTTP-Referer" || key === "X-ZCode-App-Version" || key === "X-ZCode-Agent") {
      continue;
    }
    if (key === "User-Agent" && value.startsWith("ZCode/")) {
      scoped[key] = `OpenCode/${value.slice("ZCode/".length)}`;
      continue;
    }
    if (key === "X-Title" && value.startsWith("Z Code@")) {
      scoped[key] = `OpenCode@${value.slice("Z Code@".length)}`;
      continue;
    }
    scoped[key] = value;
  }
  return scoped;
}

function normalizeOsCategory(platform: string): string {
  switch (platform) {
    case "darwin":
      return "macos";
    case "win32":
      return "windows";
    default:
      return "linux";
  }
}
