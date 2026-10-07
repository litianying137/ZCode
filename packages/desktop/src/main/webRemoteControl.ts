/* eslint-disable max-lines */
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
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { homedir, hostname, networkInterfaces } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import {
  BrowserWindow,
  MessageChannelMain,
  type MessagePortMain,
  type UtilityProcess,
} from "electron";
import { HostMessageTypes } from "@zcode/shared";
import { WebSocket } from "ws";
import { DEFAULT_ZCODE_ENDPOINT_ORIGIN, ZCODE_VERSION } from "@zcode/shared";
import { SHARED_MAX_FRAME_BYTES, WebRemoteControlRpcTransport } from "./webRemoteControlRpcTransport.js";
import { logger } from "./logger.js";
import {
  getTasks,
  getWorkspaces,
  setWebRemoteControlWorkspaceResolver,
} from "./webRemoteControlTaskIndex.js";

export { setWebRemoteControlWorkspaceResolver };

// stdout 管道断开（终端关闭/Ctrl+C 后进程仍在）时 console.log 会抛 EIO 导致
// uncaught exception 弹窗；所有诊断日志必须走安全输出。
// 2026-10-07 勘误：此函数曾误写成自递归（栈溢出被自身 catch 吞掉），导致
// 全部远控日志静默丢失、两次 V8 OOM crash 时无任何协议级现场。
function safeLog(message: string): void {
  try {
    console.log(message);
  } catch {
    // swallow EIO/EPIPE
  }
  try {
    logger.info(message);
  } catch {
    // logger 内部已吞写盘错误，这里防御 EIO 类异常
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

// QR URL 与设备注册/认证 meta 里的 app_version 受 zcode.z.ai 服务端校验：
// 1) 页面路由对 app_version 白名单校验，只放行线上已发布版本（2026-10-07
//    实测仅 3.14.3/3.14.4，其余含更新编号一律 404 "Not Found"）；
// 2) SPA 加载后还会按 sid 从 relay 读取设备注册时上报的 meta.version 规范化
//    URL 再刷新——注册报 3.14.6 时，即使 QR 写 3.14.3 也会被改回 3.14.6 后 404。
// 因此两处统一上报我们实际基于的上游基线版本；本地 package.json 版本号仅供
// crash 报告区分构建，与此解耦。
const RELAY_COMPAT_APP_VERSION = "3.14.4";

function resolveRelayWsUrl(_endpointOrigin: string, deviceMid?: string): string {
  const override = process.env.ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL?.trim();
  const base = override || RELAY_WS_DEFAULT;
  // 手机 SPA 与旧桌面 transport 都把 mid 放在 relay WS query；relay 用 query/header
  // 双重 device identity 将 terminal URL 的 mid 与 device socket 配对。
  if (!deviceMid) return base;
  const url = new URL(base);
  url.searchParams.set("mid", deviceMid);
  return url.toString();
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
    if (
      typeof parsed.deviceSid === "string" &&
      parsed.deviceSid.trim() &&
      typeof parsed.passHash === "string" &&
      parsed.passHash.trim()
    ) {
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

// relay WS 发送背压阈值：超过即丢弃后续 data 帧等手机端刷新重取。
const SEND_BACKPRESSURE_BYTES = 8 * 1024 * 1024;

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
  private lastBackpressureLogAt = 0;
  private lastOversizeLogAt = 0;
  private disposed = false;

  constructor(private options: RelayClientOptions) {
    const persisted = loadPersistedRelayAuth();
    if (persisted) {
      this.authMode = "persisted";
      this.passHash = persisted.passHash;
      this.deviceSid = persisted.deviceSid;
      // persisted 恢复不走 device_register_ack，二维码在构造时直接按存储身份构建；
      // 同一 sid+hash 意味着重启后旧二维码依然有效。app_version 必须同样上报
      // 服务端白名单放行的兼容版本，否则重启一次 QR 就退回本地版本号 → 手机 404。
      this.qrUrl = buildQrUrl({
        baseUrl: resolveMobileUrl(options.endpointOrigin),
        deviceSid: persisted.deviceSid,
        passHash: persisted.passHash,
        deviceMid: options.deviceMid,
        deviceName: options.deviceName,
        appVersion: RELAY_COMPAT_APP_VERSION,
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

    // 旧版 external relay device 必须带 X-Device-ID；relay 用这个 header 将 device
    // socket 与 terminal URL 的 mid 配对。缺失时两边都能 auth，但 pair_status 永远 waiting，
    // 约 180s 后 device 被 KICKED——正是 WiFi/4G 均无法撮合的根因。
    // perMessageDeflate 对齐官方设备端（帧是 base64 文本，压缩收益明显）。
    const ws = new WebSocket(this.options.relayWsUrl, {
      headers: { "X-Device-ID": this.options.deviceMid },
      perMessageDeflate: true,
    });
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
        safeLog(
          `[web-remote-control] ws connected, resuming persisted session sid=${this.deviceSid}`,
        );
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
          version: RELAY_COMPAT_APP_VERSION,
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
          `[web-remote-control] recv type=${msg.type}${msg.type === "error" || msg.type === "auth_ack" || msg.type === "pair_status_ack" ? ` body=${raw.slice(0, 500)}` : ""}`,
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
      // 旧版语义：任何断开（含 KICKED / error 后的 close）都走重连；KICKED 是 relay
      // 在 terminal 异常断开后踢设备重置会话，设备必须重连重新注册，不能停在 error。
      this.scheduleReconnect();
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
        version: RELAY_COMPAT_APP_VERSION,
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
          // 构建 QR URL（app_version 用服务端白名单放行的上游基线版本）
          this.qrUrl = buildQrUrl({
            baseUrl: resolveMobileUrl(this.options.endpointOrigin),
            deviceSid: this.deviceSid,
            passHash: this.passHash,
            deviceMid: this.options.deviceMid,
            deviceName: this.options.deviceName,
            appVersion: RELAY_COMPAT_APP_VERSION,
          });
          safeLog(`[web-remote-control] qr url: ${this.qrUrl}`);
          this.setState("authenticating");
          // 发 auth_init
          this.send({
            type: "auth_init",
            role: "device",
            device_sid: this.deviceSid,
            meta: {
              platform: process.platform,
              version: RELAY_COMPAT_APP_VERSION,
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
        // relay 实际会返回 matched（官方线上 app 也兼容 paired）；waiting 表示
        // 设备已认证、仍等手机扫码。
        const pairStatus = (msg.pair_status as string) ?? "";
        safeLog(
          `[web-remote-control] ${type} pair_status=${pairStatus || "n/a"} terminal_sid=${String(msg.terminal_sid ?? "")}`,
        );
        if (pairStatus === "paired" || pairStatus === "matched") {
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
        // 手机→桌面的 RPC 载荷。旧版协议有两种格式：
        // 1. 控制帧（zcode_type="bootstrap-request" / "workspace-list-request" / "platform-request" / 等）
        // 2. RPC 传输帧（zcode_type="rpc-frame" / "rpc-frame-ack"）走 AcknowledgedRelayProtocol，
        //    经 MessagePort 桥到 host workspace 的 ServiceCollection。
        const payload = msg.payload;
        if (typeof payload !== "object" || payload === null) {
          safeLog(
            `[web-remote-control] data frame: non-object payload=${String(payload).slice(0, 200)}`,
          );
          break;
        }
        const p = payload as Record<string, unknown>;
        const ztype = p.zcode_type as string | undefined;
        safeLog(
          `[web-remote-control] data frame: zcode_type=${ztype} seq=${p.seq ?? ""} requestId=${p.requestId ?? ""} bridgeSessionId=${p.bridgeSessionId ?? ""}`,
        );
        try {
          routeControlPayload(p);
        } catch (err) {
          safeLog(
            `[web-remote-control] route payload error: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        break;
      }
      case "error": {
        const code = (msg.code as string) ?? "";
        if (code === "KICKED") {
          // 旧版语义：会话冲突被踢。persisted 身份保留（清掉会让已配对手机永久失联），
          // 直接断开重连，重连后用同一 sid 恢复。
          safeLog(
            "[web-remote-control] kicked by relay (session conflict), reconnecting with same identity",
          );
          disposeActiveBridge();
          this.ws?.close();
          return;
        }
        if (
          code === "AUTH_FAILED" &&
          this.authMode === "persisted" &&
          !this.invalidPersistedRetryUsed
        ) {
          // persisted 身份已失效（relay 侧会话被清理）。清存储回退注册模式，换新身份。
          this.invalidPersistedRetryUsed = true;
          clearPersistedRelayAuth();
          this.authMode = "register";
          this.passHash = createPassHash(createPassword());
          this.deviceSid = null;
          this.qrUrl = null;
          safeLog("[web-remote-control] persisted auth rejected, falling back to fresh register");
          disposeActiveBridge();
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
    // 对齐官方 payloadSerializer：序列化一次 + 复用，超限（>1MiB 帧）直接拒发。
    const envelope = { type: "data" as const, payload, client_ts: Date.now() };
    let json: string;
    try {
      json = JSON.stringify(envelope);
    } catch (err) {
      safeLog(
        `[web-remote-control] send serialize failed zcode_type=${String(payload.zcode_type)} error=${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    const bytes = Buffer.byteLength(json, "utf8");
    if (bytes > SHARED_MAX_FRAME_BYTES) {
      const now = Date.now();
      if (now - this.lastOversizeLogAt > 5_000) {
        this.lastOversizeLogAt = now;
        safeLog(
          `[web-remote-control] send oversize drop zcode_type=${String(payload.zcode_type)} bytes=${bytes} max=${SHARED_MAX_FRAME_BYTES}`,
        );
      }
      return;
    }
    const ws = this.ws;
    const ready = ws?.readyState === WebSocket.OPEN;
    if (!ws || !ready) return;
    // 背压保护：手机侧停止消费（关页面/弱网/后台）时 relay 会把未读数据顶回
    // 本地发送缓冲。继续狂发只会撑爆主进程，丢帧让手机端刷新重取更安全。
    if (ws.bufferedAmount > SEND_BACKPRESSURE_BYTES) {
      const now = Date.now();
      if (now - this.lastBackpressureLogAt > 5_000) {
        this.lastBackpressureLogAt = now;
        safeLog(
          `[web-remote-control] send backpressure drop zcode_type=${String(payload.zcode_type)} buffered=${ws.bufferedAmount}`,
        );
      }
      return;
    }
    safeLog(
      `[web-remote-control] send data zcode_type=${String(payload.zcode_type)} requestId=${String(payload.requestId ?? "")} state=${this.state} bytes=${bytes}`,
    );
    ws.send(json);
  }

  /** 发送缓冲区未冲刷字节数（诊断用；手机停止消费时会持续上涨）。 */
  getSendBufferedAmount(): number {
    return this.ws?.bufferedAmount ?? 0;
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
    // 进入 paired 时启动工作区列表推送
    if (next === "paired") {
      scheduleWorkspaceListPush();
    }
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

// ── host RPC bridge ──

let resolveLocalHostProcess: (() => UtilityProcess | undefined) | null = null;
let activeBridge: {
  bridgeSessionId: string;
  bridgeGeneration: number;
  port: MessagePortMain;
  transport: WebRemoteControlRpcTransport;
} | null = null;

/** index.ts 注入当前 local host process，避免本模块反向依赖 main 的局部 process map。 */
export function setWebRemoteControlHostProcessResolver(
  resolver: () => UtilityProcess | undefined,
): void {
  resolveLocalHostProcess = resolver;
}

function disposeActiveBridge(): void {
  if (activeBridge) {
    const stats = activeBridge.transport.stats();
    safeLog(
      `[web-remote-control] bridge disposed sid=${activeBridge.bridgeSessionId.slice(0, 8)} batches=${stats.outboundBatches} retainedKB=${Math.round(stats.retainedBytes / 1024)} acked=${stats.lastAckedMessageSeq}/${stats.nextMessageSeq - 1} sentFrames=${stats.sentFrameCount} replayed=${stats.replayedFrameCount} dropped=${stats.droppedBatches}`,
    );
  }
  stopBridgeDiagnostics();
  if (!activeBridge) return;
  activeBridge.transport.dispose();
  try {
    activeBridge.port.close();
  } catch {
    // best effort
  }
  activeBridge = null;
}

// ── bridge 内存诊断：30s 一条结构化日志，crash/泄漏事后可溯 ──
// 2026-10-07 两次 V8 4GB OOM 后加：定位时对照 retainedKB/acked/dropped/heap 走势。
let bridgeDiagTimer: NodeJS.Timeout | null = null;

function startBridgeDiagnostics(bridgeSessionId: string): void {
  stopBridgeDiagnostics();
  bridgeDiagTimer = setInterval(() => {
    const bridge = activeBridge;
    if (!bridge) {
      stopBridgeDiagnostics();
      return;
    }
    const stats = bridge.transport.stats();
    const heap = process.memoryUsage();
    safeLog(
      `[wrc-diag] bridge=${bridgeSessionId.slice(0, 8)} batches=${stats.outboundBatches} retainedKB=${Math.round(stats.retainedBytes / 1024)} acked=${stats.lastAckedMessageSeq}/${stats.nextMessageSeq - 1} sentFrames=${stats.sentFrameCount} replayed=${stats.replayedFrameCount} dropped=${stats.droppedBatches} wsBufferedKB=${Math.round((client?.getSendBufferedAmount() ?? 0) / 1024)} heapMB=${Math.round(heap.heapUsed / 1048576)}`,
    );
  }, 30_000);
}

function stopBridgeDiagnostics(): void {
  if (bridgeDiagTimer) {
    clearInterval(bridgeDiagTimer);
    bridgeDiagTimer = null;
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
      safeLog(
        `[web-remote-control] workspace-bridge-open received: workspaceKey=${payload.workspaceKey as string} bridgeSessionId=${payload.bridgeSessionId as string}`,
      );
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
          ...(payload.bridgeGeneration !== undefined
            ? { bridgeGeneration: payload.bridgeGeneration as number }
            : {}),
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
      safeLog(
        `[web-remote-control] platform request: method=${method} args=${JSON.stringify(payload.args as unknown).slice(0, 500)}`,
      );
      try {
        const result = handlePlatformRequest(
          method,
          payload.args as Record<string, unknown> | undefined,
        );
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
      safeLog(
        `[web-remote-control] mobile view state update: ${JSON.stringify(payload.viewState as Record<string, unknown>).slice(0, 200)}`,
      );
      break;
    }
    case "telemetry-report": {
      // 静默忽略
      break;
    }
    case "rpc-frame":
    case "rpc-frame-ack": {
      if (!activeBridge?.transport.acceptPayload(payload)) {
        safeLog(`[web-remote-control] rpc payload rejected type=${ztype}`);
      }
      break;
    }
    case "mobile-diagnostic": {
      safeLog(
        `[web-remote-control] mobile diagnostic: ${JSON.stringify(payload as Record<string, unknown>).slice(0, 300)}`,
      );
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
  // tasks 直接读 tasks-index.sqlite（与 host 共库，WAL 并发只读），
  // 首页每个工作区的任务计数即来自这里，而非 bridge 后的 RPC 通道。
  return {
    windowControlSessionId: client?.getStatus().deviceSid ?? "unknown",
    // SPA 配对后会拿这个值把页面 URL 的 app_version 规范化成桌面版本再刷新
    // （刷新走服务端白名单）。上报自编版本号会让手机在"同步工作区"后 404
    // Not Found——必须与 QR/meta 一致上报白名单内的兼容版本。
    desktopAppVersion: RELAY_COMPAT_APP_VERSION,
    workspaces: getWorkspaces(),
    tasks: getTasks(),
  };
}

function buildWorkspaceList(): Record<string, unknown> {
  const workspaces = getWorkspaces();
  return {
    workspaces,
    tasks: getTasks(),
    activeWorkspaceKey: workspaces[0]?.workspacePath,
  };
}
async function handleWorkspaceBridgeOpen(payload: Record<string, unknown>): Promise<void> {
  const bridgeSessionId = payload.bridgeSessionId as string;
  const workspaceKey = payload.workspaceKey as string;
  const host = resolveLocalHostProcess?.();
  if (!host) throw new Error("Local host process is unavailable for Web remote control bridge");

  disposeActiveBridge();
  const { port1, port2 } = new MessageChannelMain();
  const attachmentId = randomUUID();
  const bridgeGeneration = (payload.bridgeGeneration as number) ?? 1;
  const transport = new WebRemoteControlRpcTransport({
    bridgeSessionId,
    bridgeGeneration,
    // sendPayload 侧超限拒发按整个 relay 信封算 1MiB，帧本体预算留出信封余量，
    // 否则贴着上限造出的帧会在发送口被误杀。
    maxFrameBytes: SHARED_MAX_FRAME_BYTES - 512,
    sendFrame: (frame) => client?.sendPayload(frame as unknown as Record<string, unknown>),
    onMessage: (bytes) => {
      const bridge = activeBridge;
      if (!bridge || bridge.bridgeSessionId !== bridgeSessionId) return;
      bridge.port.postMessage(bytes);
      safeLog(`[web-remote-control] relay→host rpc message bytes=${bytes.byteLength}`);
    },
    onFault: (fault) => safeLog(`[web-remote-control] rpc transport fault=${fault.reason}`),
  });
  activeBridge = { bridgeSessionId, bridgeGeneration, port: port1, transport };
  startBridgeDiagnostics(bridgeSessionId);

  port1.on("message", (event: { data: unknown }) => {
    const bridge = activeBridge;
    if (!bridge || bridge.bridgeSessionId !== bridgeSessionId) return;
    const raw = event.data;
    const bytes =
      raw instanceof Uint8Array ? raw : raw instanceof ArrayBuffer ? new Uint8Array(raw) : null;
    if (!bytes) {
      safeLog(`[web-remote-control] host port control payload ignored type=${typeof raw}`);
      return;
    }
    try {
      bridge.transport.send(bytes);
      safeLog(`[web-remote-control] host→relay rpc message bytes=${bytes.byteLength}`);
    } catch (err) {
      // 超 16MiB 的消息在这里抛错；不捕获会成为主进程 uncaught exception。
      safeLog(
        `[web-remote-control] host→relay rpc send failed bytes=${bytes.byteLength} error=${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });
  port1.start();
  host.postMessage(
    {
      type: HostMessageTypes.AttachServicePort,
      requestId: randomUUID(),
      attachmentId,
      clientMode: "web-remote-replayable",
      scope: { kind: "local" },
    },
    [port2],
  );

  // 仅在 port 已挂到 host 后通知 SPA；host attachment 会立即接管 MessagePort。
  sendToRelay({
    zcode_type: "workspace-bridge-ready",
    requestId: payload.requestId as string,
    bridgeSessionId,
    ...(payload.bridgeGeneration !== undefined ? { bridgeGeneration } : {}),
    ...(payload.recoveryId !== undefined ? { recoveryId: payload.recoveryId as string } : {}),
    bridge: {
      bridgeSessionId,
      ...(payload.bridgeGeneration !== undefined ? { bridgeGeneration } : {}),
      ...(payload.recoveryId !== undefined ? { recoveryId: payload.recoveryId as string } : {}),
      workspaceKey,
      workspacePath: workspaceKey,
      kind: "local",
    },
  });
  safeLog(
    `[web-remote-control] workspace bridge ready session=${bridgeSessionId} attachment=${attachmentId}`,
  );
}

function handlePlatformRequest(
  method: string,
  _args: Record<string, unknown> | undefined,
): unknown {
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
    relayWsUrl: resolveRelayWsUrl(endpointOrigin, deviceMid),
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
  disposeActiveBridge();
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
