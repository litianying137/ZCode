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
import { existsSync, readFileSync } from "node:fs";
import { app, BrowserWindow } from "electron";
import { WebSocket } from "ws";
import { DEFAULT_ZCODE_ENDPOINT_ORIGIN, ZCODE_VERSION } from "@zcode/shared";

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

// ── relay 客户端状态 ──

export type RelayState =
  | "idle"
  | "connecting"
  | "registering"
  | "authenticating"
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
  private qrUrl: string | null = null;
  private error: string | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private connectTimeout: NodeJS.Timeout | null = null;
  private disposed = false;

  constructor(private options: RelayClientOptions) {
    this.passHash = createPassHash(createPassword());
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

  private handleMessage(msg: Record<string, unknown>): void {
    const type = msg.type as string;
    switch (type) {
      case "device_register_ack": {
        this.deviceSid = (msg.device_sid as string) ?? null;
        if (this.deviceSid) {
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
        const pairStatus = (msg.pair_status as string) ?? "";
        if (pairStatus === "paired" || type === "auth_ack") {
          this.setState("paired");
        }
        break;
      }
      case "data": {
        // 数据转发（手机→桌面的操作指令）——最小实现暂不处理
        break;
      }
      case "error": {
        this.error = (msg.message as string) ?? (msg.code as string) ?? "relay error";
        this.setState("error");
        break;
      }
    }
  }

  private setState(next: RelayState): void {
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
