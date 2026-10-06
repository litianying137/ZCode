# Web 端远程控制功能 — 完整实现归档

> 分支：`codety-scan`（main@29628c9 之上）。更新：2026-10-07。
> 功能：桌面端弹二维码 → 手机浏览器扫码 → 经 zcode 云端 relay 桥接 → 手机查看/操作工作区任务与会话。
> 状态：**全链路实测通过**（配对 → 真实工作区/任务列表 → 任务会话详情 → 重启恢复）。

## 1. 架构与数据流

```
手机浏览器 SPA                    zcode 云端                     Codety 桌面
(https://zcode.z.ai/remote/v4)    relay (wss://zcode.z.ai/ws)    main process        host (utilityProcess)
   │ terminal 角色                     │                          │ device 角色           │
   ├─ auth_init(role=terminal) ──────►│ 按 sid+mid 撮合 ─────────┤◄─ device_register_init / auth_init
   │ proof=HMAC(passHash,nonce|terminal|sid)                    │    proof=HMAC(passHash,nonce|device|sid)
   │                                   │ matched ──► pair_status_ack(matched) ──► state=paired
   │                                   │                          │
   │ ◄────── 控制面（data 帧payload.zcode_type）──────────────►   │
   │   bootstrap-request/response · workspace-list-request/response
   │   platform-request/response · workspace-bridge-open/ready
   │   mobile-view-state-update · telemetry · diagnostic        │
   │                                   │                          │
   │ ◄────── 数据面（rpc-frame，AcknowledgedRelayProtocol）──►    │
   │   ChannelClient 字节 ⇄ {seq,messageSeq,fragment,crc32,base64}
   │                                   │                          ├─ MessageChannelMain port1
   │                                   │                          │   (WebRemoteControlRpcTransport)
   │                                   │                          └─ port2 ──► AttachServicePort
   │                                   │                               (web-remote-replayable)
   │                                   │                               ChannelServer ⇄ ServiceCollection
```

两层数据通道：

| 层 | 载荷 | 用途 | 实现位置 |
| --- | --- | --- | --- |
| 控制面 | `data` 帧 payload（JSON，按 `zcode_type` 分发） | 配对后引导：工作区/任务列表、平台请求、bridge 建立 | `webRemoteControl.ts` `routeControlPayload` |
| 数据面 | `rpc-frame` / `rpc-frame-ack`（二进制分片+ACK） | 手机 UI 全部实际功能：任务详情、会话消息、发消息、订阅推送 | `webRemoteControlRpcTransport.ts` ⇄ host |

## 2. 修复清单（问题 → 根因 → 修复）

以下每项都是实测定位（非猜测），按发现顺序归档：

### 2.1 safeLog 无限递归——所有日志静默失效

- **现象**：终端里看不到任何 `[web-remote-control]` 日志，多次误判为"跑的是旧包"。
- **根因**：`safeLog` 函数体内调用自身而非 `console.log`；每次日志触发栈溢出被 `catch` 吞掉。
- **修复**（`webRemoteControl.ts`）：

```ts
function safeLog(message: string): void {
  try {
    console.log(message);   // 原来这里是 safeLog(message) —— 无限递归
  } catch {
    // swallow EIO/EPIPE（stdout 管道断开时 console.log 抛 EIO）
  }
}
```

### 2.2 pair_status 实际值是 `matched` 而非 `paired`

- **现象**：手机认证成功但桌面状态机永远停在 `waiting_terminal`。
- **根因**：旧 app 反编译确认 `applyPairStatus` 只认 `waiting` / `matched` 两个值。
- **修复**：

```ts
const pairStatus = (msg.pair_status as string) ?? "";
if (pairStatus === "matched") {      // 原来写的是 "paired"
  this.setState("paired");
}
```

### 2.3 KICKED 后卡死 error 不重连

- **现象**：relay 踢设备（terminal 异常断开的正常重置行为）后，桌面永久下线。
- **修复**：任何 ws close（含 KICKED）都走 3s 重连；KICKED 时保留持久化身份：

```ts
ws.on("close", () => { /* ... */ this.scheduleReconnect(); });  // 去掉 error 态不重连的门

case "error": {
  if (code === "KICKED") {           // 会话冲突：断开重连，身份不变
    this.ws?.close();
    return;
  }
  // ...
}
```

### 2.4 relay 撮合失败的真根因——device WS 缺 `?mid=` query

- **现象**：双方 auth 都成功，`pair_status` 恒为 waiting，约 180s 后被 KICKED；WiFi/4G/本地浏览器全部复现。曾误判为"IP 限流"。
- **根因**：旧版 transport 的 endpoint resolver 会把 deviceMid 放进 relay WS URL query；relay 用 query/header 双重身份把 terminal 的 URL `mid` 与 device socket 配对。
- **修复**（`webRemoteControl.ts`）：

```ts
function resolveRelayWsUrl(_endpointOrigin: string, deviceMid?: string): string {
  const base = process.env.ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL?.trim() || "wss://zcode.z.ai/ws";
  if (!deviceMid) return base;
  const url = new URL(base);
  url.searchParams.set("mid", deviceMid);   // ← 撮合的必要条件
  return url.toString();
}

// 连接时同时带 header（与旧版一致的双保险）：
const ws = new WebSocket(this.options.relayWsUrl, {
  headers: { "X-Device-ID": this.options.deviceMid },
});
```

### 2.5 SPA zod schema 静默丢弃——"已配对但桌面响应超时"

- **现象**：配对成功，桌面日志显示 bootstrap-response 已发出（wsOpen=true），手机仍报 `desktop-bootstrap-timeout`。
- **根因**：手机 SPA 对每条 payload 做 `mg.safeParse`（zod union，逆向自 `src.js`）。三处违规：
  1. `initialViewState: null` / `mobileViewState: null`——`.optional()` 只接受缺省不接受 null；
  2. workspace 条目缺必填 `label`；
  3. `activeTaskId: null` 同上。
  校验失败返回 null，SPA **静默丢弃整条 payload**。
- **修复**（构造侧全部对齐 schema）：

```ts
// dg = {windowControlSessionId, workspaces: ag[], tasks: og[], initialViewState?, mobileViewState?}
return {
  windowControlSessionId: client?.getStatus().deviceSid ?? "unknown",
  desktopAppVersion: ZCODE_VERSION,   // 多余字段被 strip，无害
  workspaces: getWorkspaces(),
  tasks: getTasks(),
  // initialViewState / mobileViewState：直接不传（null 会 safeParse 失败）
};

// ag workspace 条目：label 必填
{ kind: "local", workspacePath, label: workspaceLabel(workspacePath), connectionState: "connected" }
```

### 2.6 会话持久化——重启换 sid 导致"扫一次码永久失联"

- **现象**：桌面每次重启随机生成 passHash/sid；手机残留页面（旧 sid）后台重连 → relay 判冲突 → KICKED 新会话 → 新二维码瞬间作废，循环。
- **修复**（旧版 persisted 模式移植）：

```ts
// ~/.zcode/v2/web-remote-control-auth.json
interface PersistedRelayAuth { deviceSid: string; passHash: string }

constructor(private options: RelayClientOptions) {
  const persisted = loadPersistedRelayAuth();
  if (persisted) {
    this.authMode = "persisted";
    this.passHash = persisted.passHash;
    this.deviceSid = persisted.deviceSid;
    this.qrUrl = buildQrUrl({ ...按存储身份构建… });   // 重启后旧二维码依然有效
  } else {
    this.authMode = "register";
    this.passHash = createPassHash(createPassword());
  }
}

// 重连时复用身份，不发 device_register_init：
ws.on("open", () => {
  if (this.authMode === "persisted" && this.deviceSid) {
    this.sendAuthInit(this.deviceSid);
    return;
  }
  /* register 流程 */
});

// 注册成功即落盘；relay 拒绝（AUTH_FAILED）时清存储回退注册，只重试一次：
case "device_register_ack":
  savePersistedRelayAuth({ deviceSid: this.deviceSid, passHash: this.passHash });
```

### 2.7 弹窗关闭不再断开远控

- **修复**（`WebRemoteControlQrDialog.tsx`）：

```ts
// 关闭弹窗：relay 连接常驻（app 启动即自动连接），弹窗只是二维码展示窗口。
const handleClose = useCallback(() => {
  onOpenChange(false);          // 原来这里还会 window.webRemoteControl?.stop()
}, [onOpenChange]);
```

### 2.8 data 帧控制面路由

```ts
function routeControlPayload(payload: Record<string, unknown>): void {
  switch (payload.zcode_type) {
    case "bootstrap-request":       /* → bootstrap-response（真实工作区+任务） */
    case "workspace-list-request":  /* → workspace-list-response */
    case "workspace-bridge-open":   /* 挂 host MessagePort → workspace-bridge-ready */
    case "workspace-reconnect-request":
    case "platform-request":        /* focus 等桌面能力 */
    case "mobile-view-state-update":
    case "telemetry-report":
    case "mobile-diagnostic":
    case "rpc-frame":
    case "rpc-frame-ack":           /* → transport.acceptPayload */
  }
}
```

### 2.9 数据面 bridge——host ServicePort 挂接

```ts
async function handleWorkspaceBridgeOpen(payload) {
  const host = resolveLocalHostProcess?.();
  if (!host) throw new Error("Local host process is unavailable…");

  disposeActiveBridge();
  const { port1, port2 } = new MessageChannelMain();
  const transport = new WebRemoteControlRpcTransport({
    bridgeSessionId,
    bridgeGeneration,
    sendFrame: (frame) => client?.sendPayload(frame),
    onMessage: (bytes) => activeBridge?.port.postMessage(bytes),   // relay→host
    onFault: (fault) => safeLog(`…fault=${fault.reason}`),
  });
  activeBridge = { bridgeSessionId, bridgeGeneration, port: port1, transport };

  port1.on("message", (event) => {          // host→relay
    const bytes = event.data instanceof Uint8Array ? event.data : null;
    if (bytes) transport.send(bytes);
  });
  port1.start();

  host.postMessage({                        // host 侧接成 ChannelServer
    type: HostMessageTypes.AttachServicePort,
    requestId: randomUUID(),
    attachmentId: randomUUID(),
    clientMode: "web-remote-replayable",    // 上游完整保留的手机桥专用模式
    scope: { kind: "local" },
  }, [port2]);

  sendToRelay({ zcode_type: "workspace-bridge-ready", … });  // 挂接后再通告
}
```

main 进程注入（`index.ts`）：

```ts
setWebRemoteControlHostProcessResolver(() => {
  const first = windowHostProcessMap.values().next();
  return first.done ? undefined : first.value;
});
setWebRemoteControlWorkspaceResolver(() =>
  [...windowWorkspaceMap.values()].flatMap((paths) => [...paths]),
);
```

### 2.10 可靠 rpc-frame 传输（旧版 AcknowledgedRelayProtocol 移植）

新文件 `webRemoteControlRpcTransport.ts`（+ 4 项单测）。核心语义：

```ts
export class WebRemoteControlRpcTransport {
  send(message: Uint8Array): void;              // 分片 ≤1MiB/帧，16MiB/消息，CRC32(整消息)
  acceptPayload(payload: unknown): boolean;     // rpc-frame/rpc-frame-ack 入口
  replayUnacknowledged(): boolean;              // 断线重连后重放未确认消息
  dispose(): void;
}
```

- 物理帧有序 `seq`、逻辑消息 `messageSeq`；组装完成后才校验 CRC、才交付、才回 ACK；
- 累积 ACK 释放重放缓冲；未来 ACK 拒绝；精确重复容忍、冲突重复拒绝；
- 身份三元组（session/generation/recovery）全匹配。

帧结构（与旧版/手机 SPA 完全一致）：

```ts
{ zcode_type: "rpc-frame", bridgeSessionId, bridgeGeneration?, recoveryId?,
  seq, messageSeq, fragmentIndex, fragmentCount, messageBytes,
  checksum: { algorithm: "crc32", value: <8位小写hex> },
  dataBase64: <标准base64> }
{ zcode_type: "rpc-frame-ack", bridgeSessionId, …, ackMessageSeq }
```

### 2.11 真实工作区与任务数据源

- **手机首页计数来自控制面 payload，不是 bridge RPC**——这是"0 个任务"的根因。
- 新文件 `webRemoteControlTaskIndex.ts`：

```ts
// 工作区：main 的窗口工作区注册表（desktopMainIpcPlatform 的 SyncWindowTabs 维护）
export function getWorkspaces() {
  const paths = [...new Set(resolveOpenWorkspacePaths?.() ?? [])].filter(Boolean);
  return paths.map((p) => ({ kind: "local", workspacePath: p, label: workspaceLabel(p), connectionState: "connected" }));
}

// 任务：只读查询 ~/.zcode/v2/tasks-index.sqlite（与 host 写连接 WAL 并发安全）
const stmt = db.prepare(
  "SELECT workspace_path, task_id, title, provider, created_at, updated_at, unread_at, " +
  "pinned, archived, task_status FROM tasks WHERE deleted = 0 ORDER BY updated_at DESC LIMIT ?");
// 映射到 SPA og schema：taskId/title/workspacePath/workspaceLabel/workspaceKind/
//   createdAt/updatedAt/provider?/unreadAt?/displayStatus(idle|running|completed|error)/pinned/archived
```

## 3. 涉及文件

| 文件 | 内容 |
| --- | --- |
| `packages/desktop/src/main/webRemoteControl.ts` | relay 客户端 + 控制面路由 + bridge 挂接（核心） |
| `packages/desktop/src/main/webRemoteControlRpcTransport.ts` | **新增** 可靠 rpc-frame 传输 + 4 单测 |
| `packages/desktop/src/main/webRemoteControlTaskIndex.ts` | **新增** 真实工作区/任务数据源 |
| `packages/desktop/src/main/index.ts` | host/workspace resolver 注入；启动自动连 relay |
| `packages/desktop/src/preload/index.ts` | `window.webRemoteControl` IPC 暴露 |
| `packages/ui/src/WebRemoteControlQrDialog.tsx` | 二维码弹窗（关闭不断连） |
| `packages/ui/src/WorkspaceSidebarFooter.tsx` | 侧边栏二维码入口按钮 |
| `packages/desktop/test/web-remote-control-rpc-transport.test.ts` | **新增** 传输层单测 |

## 4. relay 协议规格速查（逆向成果）

```
连接    device:  wss://zcode.z.ai/ws?mid=<deviceMid>，header X-Device-ID: <deviceMid>
        terminal: wss://zcode.z.ai/ws?mid=<deviceMid>（浏览器自动带 Origin）
注册    device_register_init {device_mid, pass_hash, meta, client_ts} → device_register_ack {device_sid}
认证    auth_init {role: device|terminal, device_sid} → auth_challenge {nonce}
        → auth_response {proof = HMAC-SHA256(passHash, `${nonce}|${role}|${sid}`).base64url}
        → auth_ack {pair_status: waiting|matched}
心跳    paired/waiting 期每 10s pair_status_query → pair_status_ack（30s watchdog 重连）
手机URL https://zcode.z.ai/remote/v4?sid=&hash=&t=&mid=&name=&app_version=
        workspaceKey = workspaceIdentity?.trim() || workspacePath
错误    KICKED（会话冲突/terminal 更替）→ 保留身份重连；AUTH_FAILED → 清持久化重新注册
```

## 5. 验证记录（2026-10-06/07，本地浏览器走真实 relay）

| 验证项 | 结果 |
| --- | --- |
| 配对（matched） | ✅（修复 `?mid=` 后立即生效） |
| 首页 6 工作区 · 15 任务 | ✅ 与 tasks-index.sqlite 逐一对上 |
| 任务详情完整会话历史 | ✅ 消息/工具调用/表格/文件引用全渲染 |
| bridge rpc-frame 双向 + ACK | ✅ 日志持续 seq/messageSeq 往返 |
| app 重启恢复 | ✅ 持久化 sid + Try Again 自动重连 |
| 回归 | ✅ typecheck / lint 0 error / 34 tests |

## 6. 提交清单（main..codety-scan）

```
f268435 feat: disable auto-update and force-update gate for private rebrand
7e1c154 feat: rebrand desktop identity to opencode (official assets)      ← 移植自 opencode 分支
35b1c57 fix: dock/about/web brand icons
d41a198 feat: scrub zcode from user-visible copy and provider identity
29a2c62 feat: restore direct web remote control (scan QR → phone browser → control)
708634c fix: BrowserWindow value import + correct relay endpoint
54ed2bb fix: safeLog guards EIO crash; log relay payloads
458807f fix: relay auth proof is HMAC-SHA256; auto-start relay
dc35b10 fix: relay heartbeat + waiting_terminal state + data frame logging
aab816d docs: 需求与实施记录
a526d0d feat: rebrand identity to Codety（品牌翻转 + 独立数据目录）
b71fc31 fix: safeLog recursion, matched pair status, KICKED reconnect, data routing
29a4c26 fix: SPA schema compliance + persistent session + keep-alive dialog
22286b4 fix: canonical wire crc32/base64 for rpc-frame
5534c0f feat: real task list + reliable rpc transport           ← 全链路达成
4d80c03 docs: 最终全链路验证记录
```

## 7. 遗留与后续

- 任务计数是 SQLite 直读，与桌面 UI 实时投影存在秒级窗口差；可改为 host `window-controller.listTaskList` 投影（main 侧 desktop-continuous 附件）。
- bootstrap 尚未包含 remote（SSH/Docker）工作区；`workspace-reconnect-request` 为未实现响应。
- 大消息（>16MiB）直接拒绝；重放缓冲无字节上限（旧版有 watermark 降级）。
- 手机端"发消息继续对话"依赖 host agent 服务，未专项验证。

## 附录：核心源码全文（归档时点 = commit ee89d09）

### A.1 `webRemoteControl.ts —— relay 客户端 + 控制面路由 + bridge 挂接（核心，约 930 行）`

源文件：`packages/desktop/src/main/webRemoteControl.ts`

```ts
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
import { WebRemoteControlRpcTransport } from "./webRemoteControlRpcTransport.js";
import {
  getTasks,
  getWorkspaces,
  setWebRemoteControlWorkspaceResolver,
} from "./webRemoteControlTaskIndex.js";

export { setWebRemoteControlWorkspaceResolver };

// stdout 管道断开（终端关闭/Ctrl+C 后进程仍在）时 console.log 会抛 EIO 导致
// uncaught exception 弹窗；所有诊断日志必须走安全输出。
function safeLog(message: string): void {
  try {
    console.log(message);
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

    // 旧版 external relay device 必须带 X-Device-ID；relay 用这个 header 将 device
    // socket 与 terminal URL 的 mid 配对。缺失时两边都能 auth，但 pair_status 永远 waiting，
    // 约 180s 后 device 被 KICKED——正是 WiFi/4G 均无法撮合的根因。
    const ws = new WebSocket(this.options.relayWsUrl, {
      headers: { "X-Device-ID": this.options.deviceMid },
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
          safeLog(`[web-remote-control] qr url: ${this.qrUrl}`);
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
        // 旧版实测 pair_status 值为 "waiting"（等手机扫码）或 "matched"（已有手机配对）。
        const pairStatus = (msg.pair_status as string) ?? "";
        if (pairStatus === "matched") {
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
  if (!activeBridge) return;
  activeBridge.transport.dispose();
  try {
    activeBridge.port.close();
  } catch {
    // best effort
  }
  activeBridge = null;
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
    desktopAppVersion: ZCODE_VERSION,
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
    bridge.transport.send(bytes);
    safeLog(`[web-remote-control] host→relay rpc message bytes=${bytes.byteLength}`);
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

```

### A.2 `webRemoteControlRpcTransport.ts —— 可靠 rpc-frame 传输（新增）`

源文件：`packages/desktop/src/main/webRemoteControlRpcTransport.ts`

```ts
/**
 * Ordered, acknowledged relay transport for the binary RPC bridge.
 *
 * The relay carries JSON payloads. This module owns the wire envelope and
 * exposes only Uint8Array messages to its caller.
 */

export const SHARED_MAX_FRAME_BYTES = 1024 * 1024;
const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;
const MAX_FRAGMENTS = 64;

export interface RpcIdentity {
  bridgeSessionId: string;
  bridgeGeneration?: number;
  recoveryId?: string;
}

export interface RpcFrame {
  zcode_type: "rpc-frame";
  bridgeSessionId: string;
  bridgeGeneration?: number;
  recoveryId?: string;
  seq: number;
  messageSeq: number;
  fragmentIndex: number;
  fragmentCount: number;
  messageBytes: number;
  checksum: { algorithm: "crc32"; value: string };
  dataBase64: string;
}

export interface RpcFrameAck extends RpcIdentity {
  zcode_type: "rpc-frame-ack";
  ackMessageSeq: number;
}

export type RpcPayload = RpcFrame | RpcFrameAck;

export interface WebRemoteControlRpcTransportOptions extends RpcIdentity {
  sendFrame: (payload: RpcPayload) => void;
  onMessage: (message: Uint8Array, messageSeq: number) => void;
  maxFrameBytes?: number;
  initialPhysicalSeq?: number;
  initialMessageSeq?: number;
  onFault?: (fault: RpcTransportFault) => void;
}

export interface RpcTransportFault {
  reason:
    | "identityMismatch"
    | "invalidFrame"
    | "checksumMismatch"
    | "physicalGap"
    | "messageGap"
    | "fragmentGap"
    | "metadataMismatch"
    | "lengthMismatch"
    | "futureAck"
    | "conflictingDuplicate";
  seq?: number;
  messageSeq?: number;
}

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function crc32Hex(bytes: Uint8Array): string {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return ((crc ^ 0xffffffff) >>> 0).toString(16).padStart(8, "0");
}

export function encodeBase64(bytes: Uint8Array): string {
  let result = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0;
    const hasB = i + 1 < bytes.length;
    const hasC = i + 2 < bytes.length;
    const b = hasB ? bytes[i + 1]! : 0;
    const c = hasC ? bytes[i + 2]! : 0;
    const value = (a << 16) | (b << 8) | c;
    result += BASE64_ALPHABET[value >>> 18];
    result += BASE64_ALPHABET[(value >>> 12) & 63];
    result += hasB ? BASE64_ALPHABET[(value >>> 6) & 63] : "=";
    result += hasC ? BASE64_ALPHABET[value & 63] : "=";
  }
  return result;
}

function decodeBase64(value: unknown): Uint8Array | null {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  )
    return null;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const result = new Uint8Array((value.length / 4) * 3 - padding);
  let offset = 0;
  for (let i = 0; i < value.length; i += 4) {
    const a = BASE64_ALPHABET.indexOf(value[i]!);
    const b = BASE64_ALPHABET.indexOf(value[i + 1]!);
    const c = value[i + 2] === "=" ? 0 : BASE64_ALPHABET.indexOf(value[i + 2]!);
    const d = value[i + 3] === "=" ? 0 : BASE64_ALPHABET.indexOf(value[i + 3]!);
    const bits = (a << 18) | (b << 12) | (c << 6) | d;
    if (offset < result.length) result[offset++] = bits >>> 16;
    if (offset < result.length) result[offset++] = (bits >>> 8) & 255;
    if (offset < result.length) result[offset++] = bits & 255;
  }
  return result;
}

function sameIdentity(expected: RpcIdentity, actual: Partial<RpcIdentity>): boolean {
  return (
    expected.bridgeSessionId === actual.bridgeSessionId &&
    expected.bridgeGeneration === actual.bridgeGeneration &&
    expected.recoveryId === actual.recoveryId
  );
}

function frameFingerprint(frame: RpcFrame): string {
  return JSON.stringify([
    frame.seq,
    frame.messageSeq,
    frame.fragmentIndex,
    frame.fragmentCount,
    frame.messageBytes,
    frame.checksum.value,
    frame.dataBase64,
  ]);
}

function validSequence(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export class WebRemoteControlRpcTransport {
  private readonly identity: RpcIdentity;
  private readonly sendFrame: (payload: RpcPayload) => void;
  private readonly deliver: (message: Uint8Array, messageSeq: number) => void;
  private readonly maxFrameBytes: number;
  private readonly onFault?: (fault: RpcTransportFault) => void;
  private nextPhysicalSeq: number;
  private nextMessageSeq: number;
  private expectedPhysicalSeq: number;
  private expectedMessageSeq: number;
  private lastAckedMessageSeq = 0;
  private active: { frame: RpcFrame; parts: Uint8Array[]; fingerprints: string[] } | null = null;
  private outbound: Array<{ messageSeq: number; frames: RpcFrame[] }> = [];
  private settledBySeq = new Map<number, string>();
  private disposed = false;

  constructor(options: WebRemoteControlRpcTransportOptions) {
    if (
      !options.bridgeSessionId ||
      !validSequence(options.initialPhysicalSeq ?? 1) ||
      !validSequence(options.initialMessageSeq ?? 1)
    )
      throw new Error("invalid transport options");
    this.identity = {
      bridgeSessionId: options.bridgeSessionId,
      ...(options.bridgeGeneration === undefined
        ? {}
        : { bridgeGeneration: options.bridgeGeneration }),
      ...(options.recoveryId === undefined ? {} : { recoveryId: options.recoveryId }),
    };
    this.sendFrame = options.sendFrame;
    this.deliver = options.onMessage;
    this.onFault = options.onFault;
    this.maxFrameBytes = options.maxFrameBytes ?? SHARED_MAX_FRAME_BYTES;
    if (
      !Number.isSafeInteger(this.maxFrameBytes) ||
      this.maxFrameBytes < 64 ||
      this.maxFrameBytes > SHARED_MAX_FRAME_BYTES
    )
      throw new Error("invalid maxFrameBytes");
    this.nextPhysicalSeq = options.initialPhysicalSeq ?? 1;
    this.nextMessageSeq = options.initialMessageSeq ?? 1;
    this.expectedPhysicalSeq = this.nextPhysicalSeq;
    this.expectedMessageSeq = this.nextMessageSeq;
  }

  send(message: Uint8Array): void {
    if (this.disposed) return;
    if (
      !(message instanceof Uint8Array) ||
      message.length === 0 ||
      message.length > MAX_MESSAGE_BYTES
    )
      throw new Error("invalid RPC message");
    const checksum = { algorithm: "crc32" as const, value: crc32Hex(message) };
    const fragmentCount = Math.max(
      1,
      Math.ceil(message.length / this.fragmentBytes(message.length, checksum)),
    );
    if (fragmentCount > MAX_FRAGMENTS) throw new Error("RPC message requires too many fragments");
    const messageSeq = this.nextMessageSeq++;
    const frames: RpcFrame[] = [];
    const bytesPerFragment = Math.ceil(message.length / fragmentCount);
    for (let index = 0; index < fragmentCount; index += 1) {
      const seq = this.nextPhysicalSeq++;
      const part = message.subarray(
        index * bytesPerFragment,
        Math.min(message.length, (index + 1) * bytesPerFragment),
      );
      frames.push({
        zcode_type: "rpc-frame",
        ...this.identity,
        seq,
        messageSeq,
        fragmentIndex: index,
        fragmentCount,
        messageBytes: message.length,
        checksum,
        dataBase64: encodeBase64(part),
      });
    }
    this.outbound.push({ messageSeq, frames });
    this.flush();
  }

  replayUnacknowledged(): boolean {
    if (this.disposed) return false;
    this.flush();
    return true;
  }

  acceptPayload(payload: unknown): boolean {
    if (this.disposed || typeof payload !== "object" || payload === null) return false;
    const value = payload as Partial<RpcFrame> & Partial<RpcFrameAck>;
    if (!sameIdentity(this.identity, value)) return this.report({ reason: "identityMismatch" });
    if (value.zcode_type === "rpc-frame-ack") return this.acceptAck(value.ackMessageSeq);
    if (value.zcode_type !== "rpc-frame") return this.report({ reason: "invalidFrame" });
    return this.acceptFrame(value as RpcFrame);
  }

  dispose(): void {
    this.disposed = true;
    this.outbound = [];
    this.active = null;
  }

  private fragmentBytes(messageBytes: number, checksum: RpcFrame["checksum"]): number {
    let low = 1;
    let high = messageBytes;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      const probe: RpcFrame = {
        zcode_type: "rpc-frame",
        ...this.identity,
        seq: this.nextPhysicalSeq,
        messageSeq: this.nextMessageSeq,
        fragmentIndex: 0,
        fragmentCount: Math.ceil(messageBytes / mid),
        messageBytes,
        checksum,
        dataBase64: "A".repeat(4 * Math.ceil(mid / 3)),
      };
      if (new TextEncoder().encode(JSON.stringify(probe)).length <= this.maxFrameBytes) low = mid;
      else high = mid - 1;
    }
    return low;
  }

  private flush(): void {
    for (const batch of this.outbound) for (const frame of batch.frames) this.sendFrame(frame);
  }

  private acceptAck(value: unknown): boolean {
    if (!validSequence(value)) return this.report({ reason: "invalidFrame" });
    if (value <= this.lastAckedMessageSeq) return true;
    const highestSent = this.outbound.at(-1)?.messageSeq ?? this.lastAckedMessageSeq;
    if (value > highestSent) return this.report({ reason: "futureAck", messageSeq: value });
    this.lastAckedMessageSeq = value;
    this.outbound = this.outbound.filter((batch) => batch.messageSeq > value);
    return true;
  }

  private acceptFrame(frame: RpcFrame): boolean {
    const bytes = decodeBase64(frame.dataBase64);
    if (
      !validSequence(frame.seq) ||
      !validSequence(frame.messageSeq) ||
      !Number.isInteger(frame.fragmentIndex) ||
      !Number.isInteger(frame.fragmentCount) ||
      frame.fragmentIndex < 0 ||
      frame.fragmentIndex >= frame.fragmentCount ||
      frame.fragmentCount < 1 ||
      frame.fragmentCount > MAX_FRAGMENTS ||
      !Number.isInteger(frame.messageBytes) ||
      frame.messageBytes < 1 ||
      frame.messageBytes > MAX_MESSAGE_BYTES ||
      frame.checksum?.algorithm !== "crc32" ||
      !/^[0-9a-f]{8}$/.test(frame.checksum.value) ||
      bytes === null ||
      bytes.length === 0
    )
      return this.report({ reason: "invalidFrame", seq: frame.seq, messageSeq: frame.messageSeq });
    const fingerprint = frameFingerprint(frame);
    const prior = this.settledBySeq.get(frame.seq);
    if (prior !== undefined) {
      if (prior !== fingerprint)
        return this.report({
          reason: "conflictingDuplicate",
          seq: frame.seq,
          messageSeq: frame.messageSeq,
        });
      return true;
    }
    if (frame.seq < this.expectedPhysicalSeq) return true;
    if (frame.seq > this.expectedPhysicalSeq)
      return this.report({ reason: "physicalGap", seq: frame.seq, messageSeq: frame.messageSeq });
    if (frame.messageSeq !== this.expectedMessageSeq)
      return this.report({ reason: "messageGap", seq: frame.seq, messageSeq: frame.messageSeq });
    if (
      this.active &&
      (frame.fragmentCount !== this.active.frame.fragmentCount ||
        frame.messageBytes !== this.active.frame.messageBytes ||
        frame.checksum.value !== this.active.frame.checksum.value)
    )
      return this.report({
        reason: "metadataMismatch",
        seq: frame.seq,
        messageSeq: frame.messageSeq,
      });
    if (this.active && frame.fragmentIndex !== this.active.parts.length)
      return this.report({ reason: "fragmentGap", seq: frame.seq, messageSeq: frame.messageSeq });
    this.active ??= { frame, parts: [], fingerprints: [] };
    this.active.parts.push(bytes);
    this.active.fingerprints.push(fingerprint);
    this.settledBySeq.set(frame.seq, fingerprint);
    this.expectedPhysicalSeq += 1;
    if (this.active.parts.length < frame.fragmentCount) return true;
    const assembled = new Uint8Array(this.active.parts.reduce((sum, part) => sum + part.length, 0));
    let offset = 0;
    for (const part of this.active.parts) {
      assembled.set(part, offset);
      offset += part.length;
    }
    const messageSeq = frame.messageSeq;
    this.active = null;
    if (assembled.length !== frame.messageBytes)
      return this.report({ reason: "lengthMismatch", seq: frame.seq, messageSeq });
    if (crc32Hex(assembled) !== frame.checksum.value)
      return this.report({ reason: "checksumMismatch", seq: frame.seq, messageSeq });
    try {
      this.deliver(assembled, messageSeq);
    } catch {
      return this.report({ reason: "invalidFrame", messageSeq });
    }
    this.expectedMessageSeq += 1;
    this.sendFrame({ zcode_type: "rpc-frame-ack", ...this.identity, ackMessageSeq: messageSeq });
    return true;
  }

  private report(fault: RpcTransportFault): false {
    this.onFault?.(fault);
    return false;
  }
}

```

### A.3 `webRemoteControlTaskIndex.ts —— 真实工作区/任务数据源（新增）`

源文件：`packages/desktop/src/main/webRemoteControlTaskIndex.ts`

```ts
/**
 * Web 远程控制的工作区与任务数据源。
 *
 * 手机 SPA 首页的工作区列表与任务计数来自控制面 payload（bootstrap-response /
 * workspace-list-response / workspace-list-updated），不走 bridge 后的 RPC 通道；
 * 这里提供真实数据：工作区取 main 的窗口工作区注册表（windowWorkspaceMap），
 * 任务直接只读查询 ~/.zcode/v2/tasks-index.sqlite（与 host 共库，WAL 并发只读）。
 */
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { BrowserWindow } from "electron";

let resolveOpenWorkspacePaths: (() => string[]) | null = null;

/** index.ts 注入窗口工作区注册表快照（windowWorkspaceMap 扁平化）。 */
export function setWebRemoteControlWorkspaceResolver(resolver: () => string[]): void {
  resolveOpenWorkspacePaths = resolver;
}

/** 旧版 ul()：路径最后一段作为展示 label。 */
export function workspaceLabel(path: string): string {
  const segments = path.replace(/\\/g, "/").split("/").filter(Boolean);
  return segments[segments.length - 1] ?? path;
}

export function getWorkspaces(): Record<string, unknown>[] {
  const paths = [...new Set(resolveOpenWorkspacePaths?.() ?? [])].filter(Boolean);
  if (paths.length === 0 && BrowserWindow.getAllWindows().length > 0) {
    paths.push(join(homedir(), ".zcode", "workspace", "default"));
  }
  return paths.map((workspacePath) => ({
    kind: "local",
    workspacePath,
    label: workspaceLabel(workspacePath),
    connectionState: "connected",
  }));
}

// node:sqlite 需走 createRequire（tsup 会把动态 import 改写成 import("sqlite")），
// 与 chromeCookieManager.ts 同一模式。
const nodeRequire = createRequire(import.meta.url);
let sqliteModule: typeof import("node:sqlite") | null = null;
function getSqlite(): typeof import("node:sqlite") | null {
  if (sqliteModule) return sqliteModule;
  try {
    sqliteModule = nodeRequire("node:sqlite") as typeof import("node:sqlite");
  } catch {
    sqliteModule = null;
  }
  return sqliteModule;
}

function mapDisplayStatus(status: string | null): "idle" | "running" | "completed" | "error" {
  if (status === "running" || status === "completed" || status === "error") return status;
  return "idle";
}

/**
 * 只读查询 tasks-index 的任务（SPA og schema 形态）。
 * 任何失败回退空列表，不影响远控主链路。
 */
function readIndexedTasks(limit = 200): Array<Record<string, unknown>> {
  const sqlite = getSqlite();
  if (!sqlite) return [];
  const dbPath = join(homedir(), ".zcode", "v2", "tasks-index.sqlite");
  if (!existsSync(dbPath)) return [];
  let db: import("node:sqlite").DatabaseSync | null = null;
  try {
    db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
    const statement = db.prepare(
      "SELECT workspace_path, task_id, title, provider, created_at, updated_at, unread_at, pinned, archived, task_status FROM tasks WHERE deleted = 0 ORDER BY updated_at DESC LIMIT ?",
    );
    const rows = statement.all(limit) as Array<Record<string, unknown>>;
    return rows.map((row) => {
      const workspacePath = String(row.workspace_path);
      const unreadAt = row.unread_at;
      return {
        taskId: String(row.task_id),
        title: String(row.title ?? ""),
        workspacePath,
        workspaceLabel: workspaceLabel(workspacePath),
        workspaceKind: "local",
        createdAt: Number(row.created_at),
        updatedAt: Number(row.updated_at),
        ...(row.provider ? { provider: String(row.provider) } : {}),
        ...(typeof unreadAt === "number" && unreadAt > 0 ? { unreadAt } : {}),
        displayStatus: mapDisplayStatus(row.task_status ? String(row.task_status) : null),
        pinned: row.pinned === 1,
        archived: row.archived === 1,
      };
    });
  } catch {
    return [];
  } finally {
    try {
      db?.close();
    } catch {
      // best effort
    }
  }
}

/** 当前工作区列表内的真实任务（SPA 首页任务计数与时间线的数据源）。 */
export function getTasks(): Array<Record<string, unknown>> {
  const workspacePaths = new Set(
    (getWorkspaces() as Array<{ workspacePath?: unknown }>)
      .map((workspace) => workspace.workspacePath)
      .filter((path): path is string => typeof path === "string"),
  );
  if (workspacePaths.size === 0) return [];
  return readIndexedTasks().filter((task) => workspacePaths.has(String(task.workspacePath)));
}

```

### A.4 `web-remote-control-rpc-transport.test.ts —— 传输层单测（新增）`

源文件：`packages/desktop/test/web-remote-control-rpc-transport.test.ts`

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  WebRemoteControlRpcTransport,
  crc32Hex,
  type RpcPayload,
} from "../src/main/webRemoteControlRpcTransport.ts";

const identity = {
  bridgeSessionId: "bridge-1",
  bridgeGeneration: 2,
  recoveryId: "recovery-1",
};

function connect(maxFrameBytes = 256) {
  const leftInbound: RpcPayload[] = [];
  const rightInbound: RpcPayload[] = [];
  const leftMessages: Uint8Array[] = [];
  const rightMessages: Uint8Array[] = [];
  const leftFaults: unknown[] = [];
  const rightFaults: unknown[] = [];
  let left!: WebRemoteControlRpcTransport;
  let right!: WebRemoteControlRpcTransport;
  left = new WebRemoteControlRpcTransport({
    ...identity,
    maxFrameBytes,
    sendFrame: (frame) => {
      rightInbound.push(frame);
      right.acceptPayload(frame);
    },
    onMessage: (message) => leftMessages.push(message),
    onFault: (fault) => leftFaults.push(fault),
  });
  right = new WebRemoteControlRpcTransport({
    ...identity,
    maxFrameBytes,
    sendFrame: (frame) => {
      leftInbound.push(frame);
      left.acceptPayload(frame);
    },
    onMessage: (message) => rightMessages.push(message),
    onFault: (fault) => rightFaults.push(fault),
  });
  return {
    left,
    right,
    leftInbound,
    rightInbound,
    leftMessages,
    rightMessages,
    leftFaults,
    rightFaults,
  };
}

test("roundtrips fragmented Uint8Array messages and emits cumulative ACK", () => {
  const maxFrameBytes = 320;
  const link = connect(maxFrameBytes);
  const message = new Uint8Array(900).map((_, index) => index % 251);
  link.left.send(message);
  assert.deepEqual(link.rightMessages, [message]);
  assert.equal(link.leftInbound.at(-1)?.zcode_type, "rpc-frame-ack");
  assert.equal(link.leftInbound.at(-1)?.ackMessageSeq, 1);
  assert.ok(link.rightInbound.filter((frame) => frame.zcode_type === "rpc-frame").length > 1);
  for (const frame of link.rightInbound) {
    if (frame.zcode_type === "rpc-frame") {
      assert.ok(new TextEncoder().encode(JSON.stringify(frame)).byteLength <= maxFrameBytes);
    }
  }
});

test("replays unacknowledged frames and retires them after ACK", () => {
  const sent: RpcPayload[] = [];
  const transport = new WebRemoteControlRpcTransport({
    ...identity,
    sendFrame: (frame) => sent.push(frame),
    onMessage: () => undefined,
  });
  transport.send(new Uint8Array([1, 2, 3]));
  const firstSendCount = sent.length;
  assert.equal(firstSendCount, 1);
  assert.equal(transport.replayUnacknowledged(), true);
  assert.equal(sent.length, firstSendCount * 2);
  assert.equal(
    transport.acceptPayload({
      zcode_type: "rpc-frame-ack",
      ...identity,
      ackMessageSeq: 1,
    }),
    true,
  );
  assert.equal(transport.replayUnacknowledged(), true);
  assert.equal(sent.length, firstSendCount * 2);
});

test("rejects identity mismatch, invalid CRC, and physical gaps", () => {
  const faults: Array<{ reason: string }> = [];
  const frames: RpcPayload[] = [];
  const transport = new WebRemoteControlRpcTransport({
    ...identity,
    sendFrame: (frame) => frames.push(frame),
    onMessage: () => undefined,
    onFault: (fault) => faults.push(fault),
  });
  assert.equal(
    transport.acceptPayload({
      zcode_type: "rpc-frame-ack",
      bridgeSessionId: "other",
      ackMessageSeq: 1,
    }),
    false,
  );
  transport.send(new Uint8Array([9, 8, 7]));
  const frame = frames[0];
  assert.equal(frame.zcode_type, "rpc-frame");
  assert.equal(transport.acceptPayload({ ...frame, seq: frame.seq + 1 }), false);
  assert.equal(
    transport.acceptPayload({ ...frame, checksum: { algorithm: "crc32", value: "00000000" } }),
    false,
  );
  assert.deepEqual(
    faults.map((fault) => fault.reason),
    ["identityMismatch", "physicalGap", "checksumMismatch"],
  );
  assert.equal(crc32Hex(new Uint8Array([9, 8, 7])), frame.checksum.value);
});

test("accepts exact duplicates once and rejects conflicting duplicates", () => {
  const received: Uint8Array[] = [];
  const faults: Array<{ reason: string }> = [];
  const emitted: RpcPayload[] = [];
  const sender = new WebRemoteControlRpcTransport({
    ...identity,
    sendFrame: (frame) => emitted.push(frame),
    onMessage: () => undefined,
  });
  const receiver = new WebRemoteControlRpcTransport({
    ...identity,
    sendFrame: () => undefined,
    onMessage: (message) => received.push(message),
    onFault: (fault) => faults.push(fault),
  });
  sender.send(new Uint8Array([4, 5, 6]));
  const frame = emitted[0];
  assert.equal(receiver.acceptPayload(frame), true);
  assert.equal(receiver.acceptPayload(frame), true);
  assert.equal(received.length, 1);
  assert.equal(receiver.acceptPayload({ ...frame, dataBase64: "BAUA" }), false);
  assert.equal(faults.at(-1)?.reason, "conflictingDuplicate");
});

```

### A.5 `WebRemoteControlQrDialog.tsx —— 二维码弹窗（关闭不断连）`

源文件：`packages/ui/src/WebRemoteControlQrDialog.tsx`

```tsx
import { useCallback, useEffect, useState } from "react";
import QRCode from "qrcode";
import { XIcon, Smartphone, LoaderIcon, CheckCircle2Icon, AlertTriangleIcon } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog.js";

interface RemoteControlState {
  state: string;
  qrUrl: string | null;
  deviceSid: string | null;
  error: string | null;
}

declare global {
  interface Window {
    webRemoteControl?: {
      start: () => Promise<RemoteControlState>;
      stop: () => Promise<void>;
      getState: () => Promise<RemoteControlState>;
      onState: (cb: (status: RemoteControlState) => void) => () => void;
    };
  }
}

const STATE_LABELS: Record<string, string> = {
  idle: "未启动",
  connecting: "连接中…",
  registering: "注册中…",
  authenticating: "认证中…",
  waiting_terminal: "已连接，等待手机扫码",
  paired: "已配对",
  error: "错误",
};

export function WebRemoteControlQrDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [status, setStatus] = useState<RemoteControlState>({
    state: "idle",
    qrUrl: null,
    deviceSid: null,
    error: null,
  });
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);

  // 启动 relay 客户端
  useEffect(() => {
    if (!open) return;
    let unsubscribe: (() => void) | undefined;
    let cancelled = false;

    (async () => {
      // 监听状态
      if (window.webRemoteControl?.onState) {
        unsubscribe = window.webRemoteControl.onState((s) => {
          if (!cancelled) setStatus(s);
        });
      }
      // 启动
      const initial = await window.webRemoteControl?.start();
      if (initial && !cancelled) setStatus(initial);
    })();

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [open]);

  // 关闭弹窗：relay 连接常驻（app 启动即自动连接），弹窗只是二维码展示窗口。
  // 之前关闭即 stop 会让扫码后的已配对手机瞬间失联。
  const handleClose = useCallback(() => {
    onOpenChange(false);
  }, [onOpenChange]);

  // 生成 QR
  useEffect(() => {
    if (!status.qrUrl) {
      setQrDataUrl(null);
      return;
    }
    let cancelled = false;
    void QRCode.toDataURL(status.qrUrl, { margin: 1, width: 240 })
      .then((url) => {
        if (!cancelled) setQrDataUrl(url);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [status.qrUrl]);

  const stateLabel = STATE_LABELS[status.state] ?? status.state;
  const isWorking = ["connecting", "registering", "authenticating", "waiting_terminal"].includes(
    status.state,
  );
  const isPaired = status.state === "paired";
  const isError = status.state === "error";

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Smartphone className="size-4" />
            手机远控
          </DialogTitle>
          <DialogDescription>
            扫码或复制链接，在手机浏览器打开即可控制当前工作区。
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col items-center gap-4 py-2">
          {/* QR */}
          <div className="flex size-60 items-center justify-center rounded-xl border border-border bg-white p-2">
            {qrDataUrl ? (
              <img src={qrDataUrl} alt="QR" className="size-full" />
            ) : isWorking ? (
              <LoaderIcon className="size-8 animate-spin text-foreground-subtle" />
            ) : (
              <span className="text-ui-xs text-foreground-subtle">等待连接…</span>
            )}
          </div>

          {/* 状态 */}
          <div
            className={cn(
              "flex items-center gap-1.5 text-ui-xs",
              isPaired && "text-green-600",
              isError && "text-destructive",
              !isPaired && !isError && "text-foreground-subtle",
            )}
          >
            {isPaired && <CheckCircle2Icon className="size-3.5" />}
            {isError && <AlertTriangleIcon className="size-3.5" />}
            {stateLabel}
            {status.error ? `：${status.error}` : ""}
          </div>

          {/* URL 文本 */}
          {status.qrUrl && (
            <div className="w-full rounded-lg border border-border bg-surface p-2">
              <p className="break-all text-ui-xs text-foreground-subtle">{status.qrUrl}</p>
              <Button
                variant="ghost"
                size="sm"
                className="mt-1 text-ui-xs"
                onClick={() => {
                  if (status.qrUrl) void navigator.clipboard.writeText(status.qrUrl);
                }}
              >
                复制链接
              </Button>
            </div>
          )}
        </div>

        <div className="flex justify-end">
          <Button variant="ghost" onClick={handleClose}>
            <XIcon className="mr-1 size-4" />
            关闭
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

```
