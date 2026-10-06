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
