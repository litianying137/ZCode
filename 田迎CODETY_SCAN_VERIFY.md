# codety-scan 分支：Codety 身份 + 手机扫码远控验证记录

> 更新：2026-10-06 20:00。分支 `codety-scan`（基于 main@29628c9）。
> 用途：验证「手机扫描 → 连接桌面」功能的独立分支，品牌身份为 **Codety**。

## 1. 分支内容

### 1.1 身份（提交 467f2a9）

在 `opencode` 分支全部 10 个提交（rebrand + 扫码远控）之上，品牌值翻转：

| 项目 | 值 |
| --- | --- |
| appId | `ai.codety.desktop`（beta/dev 档同规则派生） |
| 显示名 / productName | `Codety`（dev 档 `Codety Dev`） |
| 进程前缀 | `codety`（codety-main / codety-host / codety-renderer / codety-agent） |
| CLI 子进程 | `codety-cli`（命令名 `zcode` 保留） |
| Node REPL MCP | `codety-node-repl-mcp` |
| 数据目录 | `~/Library/Application Support/Codety`（独立，见 1.2） |
| 产物 | `packages/desktop/dist/mac-arm64/Codety.app`、`Codety-3.14.3-mac-arm64.dmg/.zip` |

**刻意保留**（上游继承 / 外部真实引用，勿改）：
- `settingsSync.agent.openCode` i18n 键与值（从官方 OpenCode 导入设置的外部工具名）
- `opencode-session.ts` / `isOpenCodeGoBaseUrl`（检测 opencode.ai zen 网关）
- `onOpenCodeViewer` / `handleOpenCodeViewer*` 标识符（fork 继承，跨上游文件引用）
- `opencode/packages/...` 出处注释（品牌图形取自官方源码）
- `~/.zcode`、`zcode://`、`ZCODE_*`、CLI 命令 `zcode` 等内部兼容边界

### 1.2 独立数据目录（与 OpenCode 并行运行）

`desktopRuntimeEnv.ts` 的 `runtimeDataDirName` 从沿用 `ZCode` 改为 `Codety`：
两者共用 userData 时 Electron 单实例锁冲突，后启动者**无声退出**
（`requestSingleInstanceLock` 失败 → `app.quit()`，无任何日志）。
登录态经 `~/.zcode` 凭据路径保留，不受此改动影响。

## 2. 扫码远控修复清单（本次新增）

全部在 `packages/desktop/src/main/webRemoteControl.ts`：

1. **safeLog 无限递归**：函数体内调用自身而非 `console.log`，每次日志触发
   栈溢出被 catch 吞掉——**所有诊断日志静默失效**。这是此前"看不到任何
   `[web-remote-control]` 日志、疑似旧包"的根因。
2. **pair_status 值**：relay 实际推 `matched`（非 `paired`），状态机原先
   永远到不了 paired。旧 app 反编译确认：`applyPairStatus` 只认
   `waiting` / `matched`。
3. **error 后不重连**：relay KICKED（terminal 异常断开后踢设备重置会话）
   是常态，原先 error 态不走 `scheduleReconnect`，设备永久卡死。
   现在任何 close 都重连（重新注册新 sid）。
4. **data 帧路由**：`routeControlPayload` 按 `zcode_type` 分发——
   bootstrap-request / workspace-list-request / platform-request /
   mobile-view-state-update / telemetry-report / mobile-diagnostic /
   workspace-bridge-open（stub ready）/ workspace-reconnect-request。
5. **qr url 日志**：注册成功即打印完整二维码 URL，供黑盒终端模拟器提取。
6. **sendPayload 日志**：发送侧打 zcode_type/requestId/state/wsOpen。

## 3. 关键协议发现（黑盒验证 + 旧 app 反编译 + 手机 SPA 逆向）

- **relay 撮合要求 terminal 连接带 `Origin: https://zcode.z.ai` 头**。
  node ws 默认不带 → auth 通过但永远 waiting；浏览器天然带 → matched。
  这是「模拟器连不上、手机能连」的差异根源。
- terminal 认证：`auth_init{role:"terminal", device_sid}` → challenge →
  `proof = HMAC-SHA256(key=passHash, msg="${nonce}|terminal|${sid}")` base64url。
- 手机 SPA（/remote/v4）完整协议面：控制载荷（bootstrap/workspace-list/
  platform/bridge-open/reconnect/view-state）+ `rpc-frame`/`rpc-frame-ack`
  （AcknowledgedRelayProtocol：seq/messageSeq/ack/crc32/分片 ≤1MB 帧 /
  16MB 消息 / 30s 组装超时 / 重放 / 降级）。
- workspaceKey = `workspaceIdentity?.trim() || workspacePath`（SPA `gO`）。
- host 侧桥接机制上游完整保留：`attach-service-port`（clientMode
  `web-remote-replayable`，schema 注释明说「手机 shared-host 必须 replayable」）+
  `windowHostAttachmentRegistry` + `wrapElectronPort`。被删的只是 main 侧。

## 4. 实测记录（2026-10-06）

| 阶段 | 结果 |
| --- | --- |
| Codety.app 启动（与 OpenCode 并行） | ✅ 进程名 Codety / codety-*，独立数据目录 |
| relay 连接+注册+HMAC auth | ✅ auth_ack(waiting) |
| QR URL 日志输出 | ✅ |
| terminal 模拟器（带 Origin）配对 | ✅ auth_ack(matched)，桌面 waiting_terminal→paired |
| bootstrap-request/response 往返 | ✅ 模拟器收到完整 bootstrap-response |
| workspace-list-request/response 往返 | ✅ |
| workspace-bridge-open → ready(stub) | ✅ |
| 真实手机 SPA（浏览器打开 QR URL） | ✅ 页面 "Paired. Loading workspace…" |
| SPA bootstrap 超时 | ⚠️ 见下（relay 风控嫌疑） |
| 断线重连 / KICKED 恢复 | ✅ paired→waiting_terminal→再配对 |
| rpc-frame 桥（真实任务列表） | ❌ 未实现（下一阶段） |

**relay 服务端风控观察**：19:29-19:30 匹配/转发正常（模拟器往返 + SPA 配对
均成功）；同 IP 高频 terminal auth 后（40 分钟 10+ 次）relay 停止撮合
（auth_ack 恒为 waiting）并开始 KICKED terminal。期间代码零变化。
SPA 的 bootstrap 超时与后续所有失败与此时间线吻合——**转发降级嫌疑大于
代码 bug**（同一代码 30 秒内先成功后失败）。冷却后复测方法见 §5。

## 5. 复测方法

```bash
# 1. 启动（与 OpenCode 可并行）
cd /Users/litianying/Documents/AICodeAgent/ZCode
./packages/desktop/dist/mac-arm64/Codety.app/Contents/MacOS/Codety

# 2. 从日志取 QR（每次启动/重连后都是新码，旧码作废）
grep 'qr url:' /tmp/codety-run.log | tail -1

# 3a. 真手机扫码（推荐，走蜂窝网络避开本机 IP 风控）
# 3b. 黑盒终端模拟器（必须带 Origin 头，脚本已含）
cp /tmp/terminal-sim.mjs . && node ./terminal-sim.mjs "<qrUrl>" [delayMs]

# 3c. 本机浏览器打开 QR URL（真实 SPA）
```

期望日志序列：`state ... -> waiting_terminal` → 周期 `heartbeat ok` →
配对后 `state waiting_terminal -> paired` → `data frame: zcode_type=bootstrap-request`
→ `send data zcode_type=bootstrap-response ... wsOpen=true`。

## 5.1 最终全链路验证（2026-10-06 23:5x，commit 5534c0f）

| 阶段 | 结果 |
| --- | --- |
| 扫码配对（matched） | ✅ relay 需要 device WS 带 `?mid=` query（根因修复） |
| 首页工作区+任务计数 | ✅ 6 工作区 · 15 任务，与 tasks-index.sqlite 一致 |
| bridge rpc-frame 双向 | ✅ AcknowledgedRelayProtocol 移植（分片/ACK/重放） |
| 任务详情（完整会话历史） | ✅ 点开任务渲染对话/工具调用/表格/文件引用 |
| app 重启恢复 | ✅ 持久化 sid + SPA Try Again 自动重连 |
| 刷新/主题等交互 | ✅ |

关键实现：
- `webRemoteControlRpcTransport.ts`：旧版协议类型化移植 + 4 单测
- `webRemoteControlTaskIndex.ts`：windowWorkspaceMap 工作区 + tasks-index 只读查询
- relay 撮合前提：device WS URL 必须带 `?mid=<deviceMid>`（旧版 endpoint resolver 行为）

## 6. 剩余工作（下一阶段）

1. **rpc-frame 桥**（核心）：`new MessageChannelMain()` → host
   `attach-service-port`（web-remote-replayable, scope local）→ port ↔
   AcknowledgedRelayProtocol ↔ relay data 帧。协议细节已全部逆向
   （旧 app chunk-C6VCYWB4.js / chunk-GJUBRD53.js，SPA 镜像实现）。
2. **真实任务列表**：bootstrap/workspace-list 的 tasks 从 window-controller
   `listTaskList` 取（main 侧开 desktop-continuous 附件查询），
   workspace 列表用真实路径（当前 stub："default" / tasks:[]）。
3. 会话持久化（跨重启复用 sid+passHash，旧版 persisted 模式）。
4. workspace-list-updated 推送加签名去重（当前固定 10s 全量）。

## 7. 环境备注

- 本机 deviceMid 曾临时改为 `de0898f4-...`（排查 relay 状态污染），
  备份在 `~/.zcode/v2/telemetry-state.json.bak-scan-test`，验证完恢复。
- 打包命令同 田迎WEB_REMOTE_CONTROL.md §6（`--skip-prepare` 需要
  mock-cdn runtime assets 在位）。

## Web 远程控制版本号纪律（2026-10-07 事故定案，禁止回退）

症状：手机扫码配对成功、"同步工作区"后整页 404 "Not Found"。

机制：
1. SPA 配对成功后读取 bootstrap-response 的 `desktopAppVersion`，把页面 URL
   的 `app_version` 改写成该值并刷新 —— 桌面版本号会"回灌"手机 URL。
2. zcode.z.ai 对 `/remote/v4` 的 `app_version` 白名单只放行线上发布版本
   （2026-10-07 实测仅 3.14.3/3.14.4；3.13.x 与一切自编版本号 → 404）。
   白名单校验：`curl -s -o /dev/null -w '%{http_code}' 'https://zcode.z.ai/remote/v4?app_version=X'`
3. relay 的 pair_status 实际值是 `matched`（非 `paired`），必须两个都接受。
4. OpenCode 与 Codety 共享 deviceMid，两 app 同时开远控互踢（KICKED 循环），
   同一时刻只保持一个在线。

纪律：
- `webRemoteControl.ts` 顶部 `RELAY_COMPAT_APP_VERSION` 是手机端版本号的
  唯一来源，覆盖四个出口：QR URL、注册/认证 meta、persisted 恢复构造器、
  bootstrap `desktopAppVersion`。本地 package.json 升版本（如 3.14.10）
  时严禁把它"顺手统一"成 package.json 的值。
- 换兼容版本前必须先 curl 确认在白名单内；曾因自编 3.14.5~3.14.9 连环
  触发本问题，b3b8264 时代无症状只因 app 本就是官方 3.14.3。
- 排障锚点：配对成功但"同步工作区"后 Not Found = 白名单违规；桌面实况看
  `~/.zcode/v2/logs/` 的 `[wrc-diag]` 与 `pair_status` 日志。

## 主进程 OOM crash 定案（2026-10-07，修复已随 opencode 同步回本分支）

症状：一天两次 crash，签名一致——`EXC_BREAKPOINT (brk 0)`、主线程
CrBrowserMain、node::InternalMakeCallback + JIT JS 帧。

定位方法：`~/.zcode/v2/logs/YYYY-MM-DD.log` 的 `[memory] role=main` 行——
crash 实例临终 heapUsedKb≈4062175（V8 4GB 上限），暴涨时点与手机建 bridge
精确同步，arrayBuffersKb=0（纯 JS 字符串）。crash 报告只有 brk 0，V8
FATAL 文案随 Finder 启动的 stderr 丢弃，`[memory]` 采样是唯一现场。

根因：transport `flush()` 每条新消息全量重发未 ACK 队列 → N 条突发 O(N²)
base64+JSON 帧字符串 → 主进程堆破 4GB。次因：分片二分探测临时串、手写
逐字符 base64、outbound 无滞留上限、无发送背压、KICKED 后不销毁 bridge、
safeLog 自递归吞掉全部日志（首次合并冲突丢失修复行所致）。

修复（已在分支内）：flush 按 seq 只发一次+显式 replayUnacknowledged、
64MB 滞留上限（retentionOverflow）、Buffer base64、解析式分片、
8MB 背压丢帧、KICKED/AUTH_FAILED/停止 dispose bridge、发送 try/catch、
safeLog 修复+接入文件日志、30s `[wrc-diag]` 观测、perMessageDeflate、
超 1MiB 信封拒发、收端 30s 组装超时。

纪律：重度使用后看最新 `[wrc-diag]`——retainedKB 不回落/dropped 增长/
heapMB 单调爬升任一出现即停用回报；改远控代码必跑
`node --test packages/desktop/test/web-remote-control-rpc-transport.test.ts`。
