# 手机扫码远控 ZCode/OpenCode — 需求与实施记录

> 更新：2026-10-06 14:15。用途：新会话接续本任务的全部上下文。
> 代码库：`/Users/litianying/Documents/AICodeAgent/ZCode`（`opencode` 分支）。
> 参考实现：旧版 `/Users/litianying/Downloads/ZCode.app`（3.11.x，含完整功能；已解包至 `/tmp/oldzcode-asar`，重启后需重新解包）。

## 1. 需求

原版 ZCode 有「移动端远程控制」：桌面端弹二维码 → 手机浏览器扫码打开
`https://zcode.z.ai/remote/v4?sid=...&hash=...` → 云端 SPA 加载 → 通过 zcode 云端
relay（WebSocket 中继）桥接到桌面 → 手机上查看/操作任务列表。
zcode 开源（3.14.3）后该功能被上游移除，需要在本仓库重建。

**明确不做**：Bot 渠道版「移动端远程控制」（微信/飞书/Lark/Telegram，代码仍在，
入口为侧边栏手机图标）不是本需求；本需求是**直接扫 URL → 手机浏览器**方案。

## 2. 架构（从旧 app 逆向确认）

```
桌面 main 进程                    zcode 云端                     手机浏览器
relayClient ── wss://zcode.z.ai/ws ── relay server ── wss(同域) ── SPA(/remote/v4)
   device 角色                      按 device_sid 配对             terminal 角色
   data 帧 ⇄ workspace bridge ⇄ 本地 RPC（window-controller 等服务）
```

### 2.1 relay 协议（已全部逆向并实测验证）

- 桌面连接 `wss://zcode.z.ai/ws`（实测 HTTP 101 存活；`zcode.chatglm.site` 已死）。
  环境变量覆盖：`ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL` / `ZCODE_WEB_REMOTE_CONTROL_URL`（mobile 页）。
- 发 `{type:"device_register_init", device_mid, pass_hash, meta:{platform,version,name}, client_ts}`
  → 收 `device_register_ack` `{device_sid}`。
- 发 `{type:"auth_init", role:"device", device_sid, meta, client_ts}`
  → 收 `auth_challenge` `{nonce}`
  → 发 `{type:"auth_response", device_sid, proof, client_ts}`。
- **proof = HMAC-SHA256(key=passHash, msg=`${nonce}|device|${device_sid}`).digest("base64url")**
  （关键坑：是 createHmac 不是 createHash，旧 bundle `import{createHash as VW,createHmac as GW}`；
  用错会被 relay 拒绝并踢线。已实测通过）。
- `passHash = SHA256(password).digest("base64")`；`password = randomBytes(24).toString("base64url")`。
  **每次启动随机生成 → 旧二维码随重启失效**。
- 收 `auth_ack` `{pair_status}`：`waiting`=等手机（UI 应显示"等待手机扫码"）、`paired`=已配对。
- **心跳**：paired/waiting_terminal 状态每 ~10s 发
  `{type:"pair_status_query", device_sid, client_ts}`，relay 回 `pair_status_ack`
  （旧版间隔 10s±jitter，带 ack watchdog）。**没有心跳 relay 会判设备僵死 → 手机端"连接已失效"**。
- `data` 帧：手机⇄桌面 RPC 载荷（**本仓库尚未实现处理**，这是剩余主缺口）。
- mobile URL：`${origin}/remote/v4?sid=<device_sid>&hash=<passHash>&t=<ts>&mid=<deviceMid>&name=<deviceName>&app_version=<ver>`。

### 2.2 deviceMid / deviceName

- deviceMid：读 `~/.zcode/v2/telemetry-state.json` 的 `deviceMid`（兜底 hostname）。
- deviceName：LAN IPv4（旧版 URL 里 name=192.168.x.x）。

## 3. 本仓库已完成（文件与提交）

实现集中在 `packages/desktop/src/main/webRemoteControl.ts`（单文件，含 IPC 注册）：

- relay 客户端：连接/注册/auth(HMAC)/状态机(idle→connecting→registering→authenticating
  →waiting_terminal→paired/error)/10s 心跳+30s watchdog/3s 重连/连接超时；
- URL+二维码数据生成（`buildQrUrl`）；
- IPC：`web-remote-control:start/stop/get-state` + `web-remote-control:state` 广播；
  preload 暴露 `window.webRemoteControl`（`packages/desktop/src/preload/index.ts` 末尾）；
- renderer 弹窗 `packages/ui/src/WebRemoteControlQrDialog.tsx`（二维码+URL+复制+状态）；
  入口：侧边栏底部**二维码图标**（`WorkspaceSidebarFooter.tsx`，新增 `QrCode` 按钮）；
- app 启动自动连 relay（`index.ts` 中 `registerWebRemoteControlIpc()` 后调 `startWebRemoteControl()`）；
- 诊断日志（safeLog 防 EIO）：state 变化、每条消息 type、error/auth_ack 完整 body、
  data 帧前 200 字符、心跳节流日志。

提交（opencode 分支，本次功能相关）：
`ba93272` 初版 → `45089f9` BrowserWindow 值导入修复+正确 relay 地址 →
`4399b6a` safeLog+error body 日志 → `1c2d8fd` HMAC 修复+自启动 →
`aef9c67` 心跳+waiting_terminal 状态。最后一个提交可能未完成（diag 日志，
打包被中断，需检查 `git status`/重新打包）。

## 4. 实测进度（手机端）

| 阶段 | 结果 |
| --- | --- |
| relay 连接+注册+HMAC auth | ✅ 实测 auth_ack（含我本机 node 脚本黑盒验证 HMAC 通过） |
| 二维码显示、手机扫码打开云端 SPA | ✅ 手机能看到 OpenCode 页面并进入"配对中" |
| 手机配对后保持连接 | ❌ 曾报"连接超时/连接已失效"（缺心跳，aef9c67 已修但用户复测时疑似未跑到含心跳的包/旧码失效） |
| 手机端显示任务列表（data 桥） | ❌ 未实现——**当前主缺口** |

注意坑：**手机扫的必须是当前运行实例的新码**（每次重启 passHash 变化，旧码失效）；
用户多次复测时存在"跑的还是旧包 / 扫的是旧码"的情况，日志里完全没有
`[web-remote-control]` 行即可判定。

## 5. 下一步（按优先级）

1. **确认基础链路在最新包上工作**：重打包（若 diag 提交未打包）→ 终端启动 →
   确认 `state ... -> waiting_terminal` 与周期 `heartbeat ok` 日志 → 手机扫**新**码。
2. **实现 data 桥（核心剩余工作）**：手机配对后会发 `data` 帧（RPC）。旧 app 里叫
   workspace bridge / relayProtocol / currentBridge（`out/main/index.js` 中
   `handleDataPayload`、`onPayload`、`readyAnnounced`、`flushPendingFrames`），
   手机 SPA 说的是与 `packages/web` 本地 `/ws` 相同的 channel 协议（JSON-RPC 式，
   window-controller.listTaskList / zcode-task.* 等）。需要：
   - 解析 data 帧载荷格式（当前代码已打印前 200 字符，跑一次配对即可采样）；
   - 配对成功后设备端发 ready 通告（旧版 `readyAnnounced` 后 flush pending frames）；
   - 把手机 RPC 帧桥接到本地服务（桌面 main↔host 的 RPC 面，或本地 server），
   并把响应/推送经 `{type:"data", payload}` 回传。
   预计 300–600 行；采样日志是最快入口。
3. 会话密钥持久化（旧版有 persisted 模式：authStorageProvider，跨重启复用
   device_sid+passHash，`webRemoteControlExternalRelayDevice` 设置项已见），
   可让二维码/已配对手机跨重启存活——目前每次重启换新。

## 6. 常用命令

```bash
# 打包（本机无 mise；pnpm shim 在 /tmp/pnpm-bin）
export COREPACK_INTEGRITY_KEYS=0 ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ PATH="/tmp/pnpm-bin:$PATH"
ZCODE_ENV=production ZCODE_TARGET_OS=mac ZCODE_TARGET_ARCH=arm64 ZCODE_ENABLE_MAC_SIGN=1 \
  APPLE_SIGNING_IDENTITY=- pnpm --filter @zcode/desktop run bundle -- --skip-prepare
# 产物：packages/desktop/dist/mac-arm64/OpenCode.app（用户自行运行，勿装 /Applications）

# 终端启动看日志（用户操作）
.../dist/mac-arm64/OpenCode.app/Contents/MacOS/OpenCode
# 关注 [web-remote-control] 前缀日志；手机扫码后重点收集 data frame: 行

# 重新解包旧 app（/tmp 清理后）
npx @electron/asar extract /Users/litianying/Downloads/ZCode.app/Contents/Resources/app.asar /tmp/oldzcode-asar
```

typecheck：`pnpm run typecheck`（root）。lint/fmt：`./node_modules/.bin/oxlint|oxfmt`。
