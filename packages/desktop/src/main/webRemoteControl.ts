/**
 * Web 远程控制 relay 客户端——从旧版 ZCode.app 逆向移植。
 *
 * 协议：桌面端连 zcode 云端 relay WS → 发 device_register_init → 收 device_register_ack
 * (含 device_sid + passHash) → 发 auth_init → 收 auth_challenge → 发 auth_response(含 proof)
 * → 收 auth_ack → paired。手机端打开 mobile URL 后通过同一 relay 桥接到桌面。
 *
 * relay WS 地址：endpoint origin 为 zcode.z.ai 时用 wss://zcode.z.ai/ws
 * mobile URL base：${endpointOrigin}/remote/v4
 */
import { createHash, createHmac, randomBytes } from "node:crypto";
import { homedir, hostname, networkInterfaces } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { app, BrowserWindow } from "electron";
import { WebSocket } from "ws";
import { DEFAULT_ZCODE_ENDPOINT_ORIGIN, ZCODE_VERSION } from "@zcode/shared";
// crc32/base64 实现在 @zcode/shared 的 wire-binary.ts（未顶层 reexport），
// 这里内联其导出函数，保持与旧端/SPA 端一致的校验算法。

// stdout 管道断开（终端关闭/Ctrl+C 后进程仍在）时 console.log 会抛 EIO 导致
// uncaught exception 弹窗；所有诊断日志必须走安全输出。
function safeLog(message: string): void {
  try {
    safeLog(message);
  } catch {
    // swallow EIO/EPIPE
  }
}

// ── auth 加密 ──

function createPassword(): string {
  return randomBytes(24).toString("base64url");
}

function createPassHash(password: string): string {
  return createHash("sha256").update(password).digest("base64");
}

function calculateProof(passHash: string, nonce: string, role: string, deviceSid: string): string {
  // 旧版实测：proof = HMAC-SHA256(key=passHash, msg=`${nonce}|${role}|${sid}`) base64url。
  // 之前误用 createHash(passHash 作数据) 导致 relay 拒绝 auth_response。
  return createHmac("sha256", passHash).update(`${nonce}|${role}|${deviceSid}`).digest("base64url");
}

// ── deviceMid / deviceName ──

function readDeviceMid(): string {
  const stateFile = join(homedir(), ".zcode", "v2", "telemetry-state.json");
  if (existsSync(stateFile)) {
    try {
      const parsed = JSON.parse(readFileSync(stateFile, "utf-8")) as { deviceMid?: unknown };
      if (typeof parsed.deviceMid === "string" && parsed.deviceMid.trim()) {
        return parsed.deviceMid.trim();
      }
    } catch {
      // ignore
    }
  }
  // 兜底：用 hostname 作为 deviceMid
  return hostname() || "unknown-device";
}

function resolveDeviceName(): string {
  // 优先返回 LAN IP（和旧版一致，URL 里 name=192.168.x.x）
  const interfaces = networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] ?? []) {
      if (iface.family === "IPv4" && !iface.internal) {
        return iface.address;
      }
    }
  }
  return hostname() || "unknown";
}

// ── relay WS URL + mobile URL ──

// relay 实测（2026-10-06 curl 握手探测）：wss://zcode.z.ai/ws 返回 HTTP 101（存活），
// chatglm.site 已不可达。手机端 SPA 也部署在 zcode.z.ai，两端必须连同一 relay。
const RELAY_WS_DEFAULT = "wss://zcode.z.ai/ws";
const MOBILE_URL_DEFAULT = "https://zcode.z.ai/remote/v4";

function resolveRelayWsUrl(_endpointOrigin: string): string {
  const override = process.env.ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL?.trim();
  return override || RELAY_WS_DEFAULT;
}

function resolveMobileUrl(_endpointOrigin: string): string {
  const override = process.env.ZCODE_WEB_REMOTE_CONTROL_URL?.trim();
  return override || MOBILE_URL_DEFAULT;
}

function buildQrUrl(params: {
  baseUrl: string;
  deviceSid: string;
  passHash: string;
  deviceMid: string;
  deviceName: string;
  appVersion: string;
}): string {
  const url = new URL(params.baseUrl);
  url.searchParams.set("sid", params.deviceSid);
  url.searchParams.set("hash", params.passHash);
  url.searchParams.set("t", String(Date.now()));
  url.searchParams.set("mid", params.deviceMid);
  url.searchParams.set("name", params.deviceName);
  url.searchParams.set("app_version", params.appVersion);
  return url.toString();
}

// ── 会话持久化 ──
// 桌面每次重启随机换 sid+passHash 时，手机端残留页面（旧 sid）重连 relay 会判定
// 会话冲突并 KICKED 桌面，新二维码也随之作废——"扫一次码就永久失联"的根因。
// 旧版 persisted 模式：注册成功后把 {deviceSid, passHash} 存盘，重启/重连复用
// 同一身份，旧二维码与已配对手机跨重启存活。AUTH_FAILED 时清除并回退注册。

interface PersistedRelayAuth {
  deviceSid: string;
  passHash: string;
}

function relayAuthStoragePath(): string {
  return join(homedir(), ".zcode", "v2", "web-remote-control-auth.json");
}

function loadPersistedRelayAuth(): PersistedRelayAuth | null {
  const file = relayAuthStoragePath();
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8")) as Partial<PersistedRelayAuth>;
    if (typeof parsed.deviceSid === "string" && parsed.deviceSid.trim() && typeof parsed.passHash === "string" && parsed.passHash.trim()) {
      return { deviceSid: parsed.deviceSid.trim(), passHash: parsed.passHash.trim() };
    }
  } catch {
    // ignore malformed
  }
  return null;
}

function savePersistedRelayAuth(auth: PersistedRelayAuth): void {
  try {
    writeFileSync(relayAuthStoragePath(), JSON.stringify(auth, null, 2), "utf-8");
  } catch {
    // best effort；写不进只是回到每次换码的旧行为
  }
}

function clearPersistedRelayAuth(): void {
  try {
    unlinkSync(relayAuthStoragePath());
  } catch {
    // ignore missing
  }
}

// ── relay 客户端状态 ──

export type RelayState =
  | "idle"
  | "connecting"
  | "registering"
  | "authenticating"
  | "waiting_terminal"
  | "paired"
  | "error";

export interface RelayStatus {
  state: RelayState;
  qrUrl: string | null;
  deviceSid: string | null;
  error: string | null;
}

// ── relay 客户端 ──

interface RelayClientOptions {
  relayWsUrl: string;
  deviceMid: string;
  deviceName: string;
  appVersion: string;
  endpointOrigin: string;
  onStateChange: (status: RelayStatus) => void;
}

class RelayClient {
  private ws: WebSocket | null = null;
  private state: RelayState = "idle";
  private deviceSid: string | null = null;
  private passHash: string;
  // persisted 模式：复用磁盘上的 sid+passHash，跨重启保持同一设备身份。
  private authMode: "register" | "persisted";
  // persisted 身份被 relay 拒绝（AUTH_FAILED）时清存储回退注册模式，只重试一次防循环。
  private invalidPersistedRetryUsed = false;
  private qrUrl: string | null = null;
  private error: string | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private connectTimeout: NodeJS.Timeout | null = null;
  // 旧版心跳：paired / waiting_terminal 每 ~10s 发 pair_status_query，relay 回
  // pair_status_ack；超过 watchdog 窗口没收到 ack 视为连接僵死，重连。
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private lastPairStatusAckAt = 0;
  private disposed = false;

  constructor(private options: RelayClientOptions) {
    const persisted = loadPersistedRelayAuth();
    if (persisted) {
      this.authMode = "persisted";
      this.passHash = persisted.passHash;
      this.deviceSid = persisted.deviceSid;
      // persisted 恢复不走 device_register_ack，二维码在构造时直接按存储身份构建；
      // 同一 sid+hash 意味着重启后旧二维码依然有效。
      this.qrUrl = buildQrUrl({
        baseUrl: resolveMobileUrl(options.endpointOrigin),
        deviceSid: persisted.deviceSid,
        passHash: persisted.passHash,
        deviceMid: options.deviceMid,
        deviceName: options.deviceName,
        appVersion: options.appVersion,
      });
      safeLog(`[web-remote-control] using persisted device identity sid=${persisted.deviceSid}`);
    } else {
      this.authMode = "register";
      this.passHash = createPassHash(createPassword());
    }
  }

  start(): void {
    this.disposed = false;
    this.connect();
  }

  dispose(): void {
    this.disposed = true;
    this.clearTimers();
    if (this.ws) {
      this.ws.removeAllListeners();
      if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
        this.ws.close();
      }
      this.ws = null;
    }
    this.setState("idle");
  }

  private clearTimers(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.connectTimeout) {
      clearTimeout(this.connectTimeout);
      this.connectTimeout = null;
    }
    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  // 旧版 scheduleHeartbeat：paired / waiting_terminal 状态下周期发 pair_status_query。
  // 无 ack 超过 30s（3 个周期）判定僵死，主动断开走重连。
  private scheduleHeartbeat(): void {
    if (this.heartbeatTimer || this.disposed) return;
    this.heartbeatTimer = setTimeout(() => {
      this.heartbeatTimer = null;
      if (this.disposed || !this.deviceSid) return;
      if (this.state !== "paired" && this.state !== "waiting_terminal") return;
      if (this.lastPairStatusAckAt && Date.now() - this.lastPairStatusAckAt > 30_000) {
        safeLog("[web-remote-control] heartbeat watchdog fired, reconnecting");
        this.ws?.close();
        return;
      }
      this.send({ type: "pair_status_query", device_sid: this.deviceSid, client_ts: Date.now() });
      this.scheduleHeartbeat();
    }, 10_000);
  }

  private connect(): void {
    if (this.disposed) return;
    this.setState("connecting");
    safeLog(`[web-remote-control] connecting to ${this.options.relayWsUrl}`);

    const ws = new WebSocket(this.options.relayWsUrl);
    this.ws = ws;

    // 10 秒连接超时
    this.connectTimeout = setTimeout(() => {
      if (this.state === "connecting" || this.state === "registering") {
        safeLog("[web-remote-control] connection timeout");
        this.error = "连接超时，请检查网络";
        this.setState("error");
        try {
          ws.close();
        } catch {
          /* ignore */
        }
      }
    }, 10_000);

    ws.on("open", () => {
      if (this.disposed || ws !== this.ws) return;
      if (this.authMode === "persisted" && this.deviceSid) {
        safeLog(`[web-remote-control] ws connected, resuming persisted session sid=${this.deviceSid}`);
        this.sendAuthInit(this.deviceSid);
        return;
      }
      safeLog("[web-remote-control] ws connected, registering device");
      this.setState("registering");
      this.send({
        type: "device_register_init",
        device_mid: this.options.deviceMid,
        pass_hash: this.passHash,
        meta: {
          platform: process.platform,
          version: this.options.appVersion,
          name: this.options.deviceName,
        },
        client_ts: Date.now(),
      });
    });

    ws.on("message", (data: Buffer) => {
      if (this.disposed || ws !== this.ws) return;
      if (this.connectTimeout) {
        clearTimeout(this.connectTimeout);
        this.connectTimeout = null;
      }
      try {
        const msg = JSON.parse(data.toString("utf-8"));
        const raw = JSON.stringify(msg);
        safeLog(
          `[web-remote-control] recv type=${msg.type}${msg.type === "error" || msg.type === "auth_ack" ? ` body=${raw.slice(0, 500)}` : ""}`,
        );
        this.handleMessage(msg);
      } catch {
        // ignore malformed
      }
    });

    ws.on("close", (code: number, reason: Buffer) => {
      if (this.disposed || ws !== this.ws) return;
      safeLog(
        `[web-remote-control] ws closed code=${code} reason=${reason?.toString("utf-8") ?? ""}`,
      );
      this.ws = null;
      this.clearTimers();
      if (this.state !== "error") {
        this.scheduleReconnect();
      }
    });

    ws.on("error", (err: Error) => {
      if (this.disposed || ws !== this.ws) return;
      safeLog(`[web-remote-control] ws error: ${err.message}`);
      this.error = err.message;
      this.setState("error");
    });
  }

  private scheduleReconnect(): void {
    if (this.disposed) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 3000);
  }

  private send(msg: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  // 旧版 sendAuthInit：auth_init(role=device) 后走 challenge→proof→ack。
  private sendAuthInit(deviceSid: string): void {
    this.deviceSid = deviceSid;
    this.setState("authenticating");
    this.send({
      type: "auth_init",
      role: "device",
      device_sid: deviceSid,
      meta: {
        platform: process.platform,
        version: this.options.appVersion,
        name: this.options.deviceName,
      },
      client_ts: Date.now(),
    });
  }

  private handleMessage(msg: Record<string, unknown>): void {
    const type = msg.type as string;
    switch (type) {
      case "device_register_ack": {
        this.deviceSid = (msg.device_sid as string) ?? null;
        if (this.deviceSid) {
          // persisted：注册成功即落盘，重启后复用同一身份（旧版 onRegisteredAuth）。
          savePersistedRelayAuth({ deviceSid: this.deviceSid, passHash: this.passHash });
          this.authMode = "persisted";
          // 构建 QR URL
          this.qrUrl = buildQrUrl({
            baseUrl: resolveMobileUrl(this.options.endpointOrigin),
            deviceSid: this.deviceSid,
            passHash: this.passHash,
            deviceMid: this.options.deviceMid,
            deviceName: this.options.deviceName,
            appVersion: this.options.appVersion,
          });
          this.setState("authenticating");
          // 发 auth_init
          this.send({
            type: "auth_init",
            role: "device",
            device_sid: this.deviceSid,
            meta: {
              platform: process.platform,
              version: this.options.appVersion,
              name: this.options.deviceName,
            },
            client_ts: Date.now(),
          });
        }
        break;
      }
      case "auth_challenge": {
        if (!this.deviceSid) {
          this.error = "auth_challenge before device_sid";
          this.setState("error");
          return;
        }
        const nonce = (msg.nonce as string) ?? "";
        const proof = calculateProof(this.passHash, nonce, "device", this.deviceSid);
        this.send({
          type: "auth_response",
          device_sid: this.deviceSid,
          proof,
          client_ts: Date.now(),
        });
        break;
      }
      case "auth_ack":
      case "pair_status_ack": {
        // auth_ack 的 pair_status 可能是 waiting（设备已认证、等手机扫码）
        // 或 paired（手机已配对）。旧版语义：waiting → waiting_terminal。
        const pairStatus = (msg.pair_status as string) ?? "";
        if (pairStatus === "paired") {
          this.setState("paired");
        } else if (type === "auth_ack" || pairStatus === "waiting") {
          this.setState("waiting_terminal");
        }
        // 心跳 ack 节流日志：约每 30s 一条，确认 relay 会话存活
        if (Date.now() - this.lastPairStatusAckAt > 30_000) {
          safeLog(`[web-remote-control] heartbeat ok (pair_status=${pairStatus || "n/a"})`);
        }
        this.lastPairStatusAckAt = Date.now();
        this.scheduleHeartbeat();
        break;
      }
      case "data": {
        // 手机→桌面的 RPC 帧。当前记录帧摘要用于逆向 RPC 层（下一阶段接 workspace bridge）。
        const payload = msg.payload;
        const summary =
          typeof payload === "string"
            ? payload.slice(0, 200)
            : JSON.stringify(payload)?.slice(0, 200);
        safeLog(`[web-remote-control] data frame: ${summary ?? "(empty)"}`);
        break;
      }
      case "error": {
        const code = (msg.code as string) ?? "";
        if (code === "KICKED") {
          // 旧版语义：会话冲突被踢。persisted 身份保留（清掉会让已配对手机永久失联），
          // 直接断开重连，重连后用同一 sid 恢复。
          safeLog("[web-remote-control] kicked by relay (session conflict), reconnecting with same identity");
          this.ws?.close();
          return;
        }
        if (code === "AUTH_FAILED" && this.authMode === "persisted" && !this.invalidPersistedRetryUsed) {
          // persisted 身份已失效（relay 侧会话被清理）。清存储回退注册模式，换新身份。
          this.invalidPersistedRetryUsed = true;
          clearPersistedRelayAuth();
          this.authMode = "register";
          this.passHash = createPassHash(createPassword());
          this.deviceSid = null;
          this.qrUrl = null;
          safeLog("[web-remote-control] persisted auth rejected, falling back to fresh register");
          this.ws?.close();
          this.scheduleReconnectNow();
          return;
        }
        this.error = (msg.message as string) ?? code ?? "relay error";
        this.setState("error");
        break;
      }
    }
  }

  // AUTH_FAILED 回退需要立刻重连（close 事件里也会 schedule，这里 0 延迟抢跑一次）。
  private scheduleReconnectNow(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 0);
  }

  /** 向 relay 发送任意 data 帧（设备→手机）。 */
  sendPayload(payload: Record<string, unknown>): void {
    const ready = this.ws?.readyState === WebSocket.OPEN;
    safeLog(
      `[web-remote-control] send data zcode_type=${String(payload.zcode_type)} requestId=${String(payload.requestId ?? "")} state=${this.state} wsOpen=${ready}`,
    );
    this.send({ type: "data", payload, client_ts: Date.now() });
  }

  private setState(next: RelayState): void {
    if (this.state !== next) {
      safeLog(`[web-remote-control] state ${this.state} -> ${next}`);
    }
    this.state = next;
    this.options.onStateChange({
      state: this.state,
      qrUrl: this.qrUrl,
      deviceSid: this.deviceSid,
      error: this.error,
    });
  }

  getStatus(): RelayStatus {
    return {
      state: this.state,
      qrUrl: this.qrUrl,
      deviceSid: this.deviceSid,
      error: this.error,
    };
  }
}

// ── 管理器（单例）──

let client: RelayClient | null = null;

// ── 控制载荷路由（data 帧 → 本地服务）──

// 每 10s 推送 workspace-list-updated。旧版通过对比签名避免冗余推送。
let workspaceListPushTimer: NodeJS.Timeout | null = null;
function scheduleWorkspaceListPush(): void {
  if (workspaceListPushTimer) return;
  workspaceListPushTimer = setInterval(() => {
    if (!client) {
      clearInterval(workspaceListPushTimer!);
      workspaceListPushTimer = null;
      return;
    }
    const status = client.getStatus();
    if (status.state !== "paired") return;
    safeLog("[web-remote-control] push workspace list updated");
    client.sendPayload({
      zcode_type: "workspace-list-updated",
      result: buildWorkspaceList(),
    });
  }, 10_000);
}

function routeControlPayload(payload: Record<string, unknown>): void {
  const ztype = payload.zcode_type as string;
  switch (ztype) {
    case "bootstrap-request": {
      const requestId = payload.requestId as string;
      sendToRelay({
        zcode_type: "bootstrap-response",
        requestId,
        success: true,
        result: buildBootstrapResult(),
      });
      break;
    }
    case "workspace-list-request": {
      const requestId = payload.requestId as string;
      sendToRelay({
        zcode_type: "workspace-list-response",
        requestId,
        success: true,
        result: buildWorkspaceList(),
      });
      break;
    }
    case "workspace-bridge-open": {
      safeLog(`[web-remote-control] workspace-bridge-open received: workspaceKey=${payload.workspaceKey as string} bridgeSessionId=${payload.bridgeSessionId as string}`);
      // 手机请求打开某个工作区的 bridge。旧版经 host MessagePort 建双向 RPC 桥
      // （rpc-frame ⇄ AcknowledgedRelayProtocol ⇄ host ServiceCollection）。
      // 当前简化实现：直接回复 workspace-bridge-ready（stub bridge，无 rpc-frame 通道），
      // 手机 SPA 可进入工作区界面，但无实时数据推送。
      handleWorkspaceBridgeOpen(payload).catch((err) => {
        safeLog(`[web-remote-control] workspace-bridge-open failed: ${err.message}`);
        sendToRelay({
          zcode_type: "workspace-bridge-error",
          requestId: payload.requestId as string,
          bridgeSessionId: payload.bridgeSessionId as string,
          ...(payload.bridgeGeneration !== undefined ? { bridgeGeneration: payload.bridgeGeneration as number } : {}),
          // reason 必须在 SPA sg 枚举内，否则整条 payload 校验失败被静默丢弃
          reason: "unsupported-action",
          error: err.message,
        });
      });
      break;
    }
    case "workspace-reconnect-request": {
      sendToRelay({
        zcode_type: "workspace-reconnect-response",
        requestId: payload.requestId as string,
        workspaceKey: payload.workspaceKey as string,
        success: false,
        error: "not-implemented",
      });
      break;
    }
    case "platform-request": {
      const requestId = payload.requestId as string;
      const method = payload.method as string;
      safeLog(`[web-remote-control] platform request: method=${method} args=${JSON.stringify(payload.args as unknown).slice(0, 500)}`);
      try {
        const result = handlePlatformRequest(method, payload.args as Record<string, unknown> | undefined);
        sendToRelay({
          zcode_type: "platform-response",
          requestId,
          method,
          success: true,
          result,
        });
      } catch (err) {
        sendToRelay({
          zcode_type: "platform-response",
          requestId,
          method,
          success: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      break;
    }
    case "mobile-view-state-update": {
      safeLog(`[web-remote-control] mobile view state update: ${JSON.stringify(payload.viewState as Record<string, unknown>).slice(0, 200)}`);
      break;
    }
    case "telemetry-report": {
      // 静默忽略
      break;
    }
    case "mobile-diagnostic": {
      safeLog(`[web-remote-control] mobile diagnostic: ${JSON.stringify(payload as Record<string, unknown>).slice(0, 300)}`);
      break;
    }
    default:
      safeLog(`[web-remote-control] unhandled payload type: ${ztype}`);
  }
}

function sendToRelay(payload: Record<string, unknown>): void {
  if (!client) return;
  const status = client.getStatus();
  if (status.state !== "paired" && status.state !== "waiting_terminal") return;
  client.sendPayload(payload);
}

function buildBootstrapResult(): Record<string, unknown> {
  // SPA 端 zod schema（dg）：initialViewState/mobileViewState 是 .optional()，
  // 只允许缺省（undefined），传 null 会让整个 payload safeParse 失败被静默丢弃
  // ——即"已配对但桌面响应超时"的根因。workspaces 条目必填 label（ag schema）。
  return {
    windowControlSessionId: client?.getStatus().deviceSid ?? "unknown",
    desktopAppVersion: ZCODE_VERSION,
    workspaces: getWorkspaces(),
    tasks: [],
  };
}

function buildWorkspaceList(): Record<string, unknown> {
  const workspaces = getWorkspaces();
  return {
    workspaces,
    tasks: [],
    activeWorkspaceKey: workspaces[0]?.workspacePath,
  };
}

// 旧版 ul()：路径最后一段作为展示 label。
function workspaceLabel(path: string): string {
  const segments = path.replace(/\\/g, "/").split("/").filter(Boolean);
  return segments[segments.length - 1] ?? path;
}

function getWorkspaces(): Record<string, unknown>[] {
  const windows = BrowserWindow.getAllWindows();
  if (windows.length === 0) {
    return [];
  }
  // TODO(下一阶段): 从主窗口解析真实工作区路径并聚合 remote 会话；
  // 当前返回单一本地工作区 stub，字段按 SPA ag schema 补齐（label 必填）。
  const workspacePath = "default";
  return [
    {
      kind: "local",
      workspacePath,
      label: workspaceLabel(workspacePath),
      connectionState: "connected",
    },
  ];
}

// 内联实现 @zcode/shared 的 crc32WireBytes / encodeWireBytesBase64（wire-binary.ts），
// 保持与旧版 relay / 手机 SPA 一致的校验算法。
const WIRE_BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function wireCrc32(bytes: Uint8Array): string {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return ((crc ^ 0xffffffff) >>> 0).toString(16).padStart(8, "0");
}
function wireBase64Encode(bytes: Uint8Array): string {
  let result = "";
  for (let offset = 0; offset < bytes.byteLength; offset += 3) {
    const a = bytes[offset] ?? 0;
    const hasB = offset + 1 < bytes.byteLength;
    const b = hasB ? (bytes[offset + 1] ?? 0) : 0;
    const hasC = offset + 2 < bytes.byteLength;
    const c = hasC ? (bytes[offset + 2] ?? 0) : 0;
    const triple = (a << 16) | (b << 8) | c;
    result += WIRE_BASE64_ALPHABET[(triple >> 18) & 0x3f];
    result += WIRE_BASE64_ALPHABET[(triple >> 12) & 0x3f];
    result += hasB ? WIRE_BASE64_ALPHABET[(triple >> 6) & 0x3f] : "=";
    result += hasC ? WIRE_BASE64_ALPHABET[triple & 0x3f] : "=";
  }
  return result;
}

async function handleWorkspaceBridgeOpen(payload: Record<string, unknown>): Promise<void> {
  const bridgeSessionId = payload.bridgeSessionId as string;
  const workspaceKey = payload.workspaceKey as string;
  // 简版：回复 bridge-ready 但不建立实际 host bridge（让手机 SPA 进入 UI 界面但不推送数据）
  // bridge 载荷按 SPA cg schema：kind/workspaceKey/workspacePath 必填，initialTaskId 可选。
  sendToRelay({
    zcode_type: "workspace-bridge-ready",
    requestId: payload.requestId as string,
    bridgeSessionId,
    ...(payload.bridgeGeneration !== undefined ? { bridgeGeneration: payload.bridgeGeneration as number } : {}),
    ...(payload.recoveryId !== undefined ? { recoveryId: payload.recoveryId as string } : {}),
    bridge: {
      bridgeSessionId,
      ...(payload.bridgeGeneration !== undefined ? { bridgeGeneration: payload.bridgeGeneration as number } : {}),
      ...(payload.recoveryId !== undefined ? { recoveryId: payload.recoveryId as string } : {}),
      workspaceKey,
      workspacePath: workspaceKey,
      kind: "local",
      // 给 SPA 一个真实的 initialTaskId（即使无任务），避免空值触发错误视图。
      initialTaskId: undefined,
    },
  });
  safeLog(`[web-remote-control] workspace bridge ready (stub) session=${bridgeSessionId} workspace=${workspaceKey}`);

  // SPA 在 bridge ready 后立即建 ChannelClient 并发 Initialize 帧（编码为 rpc-frame 走 data 通道）。
  // 桌面必须在 ~10s 内回 Initialize 确认，否则 SPA 进入恢复循环。
  // 这里同步发一个最小有效 rpc-frame：seq=1, messageSeq=1, 单分片 complete，内容为空 Initialize 响应。
  // RPC Initialize 响应的 VSBuffer bytes = [0, 0, 0, 1, 0]（ChannelClient 识别的 Initialize 响应协议码）。
  const msgBuf = Buffer.from([0, 0, 0, 1, 0]);
  const crc32Val = wireCrc32(new Uint8Array(msgBuf));
  const bridgeGen = (payload.bridgeGeneration as number) ?? 1;
  const rpcFrame = {
    zcode_type: "rpc-frame",
    bridgeSessionId,
    bridgeGeneration: bridgeGen,
    seq: 1,
    messageSeq: 1,
    fragmentIndex: 0,
    fragmentCount: 1,
    messageBytes: msgBuf.length,
    checksum: { algorithm: "crc32", value: crc32Val },
    dataBase64: wireBase64Encode(new Uint8Array(msgBuf)),
  };
  safeLog(`[web-remote-control] rpc-frame Initialize payload: dataBase64=${rpcFrame.dataBase64} crc32=${crc32Val}`);
  if (client) {
    client.sendPayload(rpcFrame as unknown as Record<string, unknown>);
    safeLog(`[web-remote-control] sent rpc-frame Initialize seq=1 msgBytes=${msgBuf.length}`);
  } else {
    safeLog("[web-remote-control] no client for rpc-frame Initialize");
  }
}

function handlePlatformRequest(method: string, args: Record<string, unknown> | undefined): unknown {
  switch (method) {
    case "focus":
      // 手机要求桌面窗口前置
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) {
          win.focus();
          break;
        }
      }
      return true;
    default:
      throw new Error(`Unimplemented platform method: ${method}`);
  }
}

export function startWebRemoteControl(): RelayStatus {
  if (client) {
    return client.getStatus();
  }
  const endpointOrigin = process.env.ZCODE_ENDPOINT_ORIGIN?.trim() || DEFAULT_ZCODE_ENDPOINT_ORIGIN;
  const deviceMid = readDeviceMid();
  const deviceName = resolveDeviceName();

  client = new RelayClient({
    relayWsUrl: resolveRelayWsUrl(endpointOrigin),
    deviceMid,
    deviceName,
    appVersion: ZCODE_VERSION,
    endpointOrigin,
    onStateChange: (status) => {
      // 广播给所有窗口
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) {
          win.webContents.send("web-remote-control:state", status);
        }
      }
    },
  });
  client.start();
  return client.getStatus();
}

export function stopWebRemoteControl(): void {
  if (client) {
    client.dispose();
    client = null;
  }
}

export function getWebRemoteControlStatus(): RelayStatus {
  return client?.getStatus() ?? { state: "idle", qrUrl: null, deviceSid: null, error: null };
}

// ── IPC 注册 ──

import { ipcMain } from "electron";

export function registerWebRemoteControlIpc(): void {
  ipcMain.handle("web-remote-control:start", () => startWebRemoteControl());
  ipcMain.handle("web-remote-control:stop", () => {
    stopWebRemoteControl();
  });
  ipcMain.handle("web-remote-control:get-state", () => getWebRemoteControlStatus());
}
