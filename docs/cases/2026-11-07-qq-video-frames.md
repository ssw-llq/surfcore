# 2026-11-07 · QQ 入站视频只能看到「[视频]」：给桥接补抽帧九宫格，让模型真看见画面

## 现象

- 用户原话（2026-11-07 19:38 桌面会话，贴 QQ 截图）：苏问「尺有什么想要的功能吗」，QQ 里的尺回
  「真想的，是想真能看见东西，**现在我只能读字，你发来的视频、你眼里的画面我都接不上**」；
  随后用户问「尺现在B站视频也无法看内容是吧?」，确认 B站 侧只能读字后说「**现在就做吧**」（20:… 前
  的桌面消息 m00240），指 QQ 入站视频这条通道。
- 复现步骤：在 QQ 私聊/群里给「尺」（3868056717）发任意视频 → 桥接把消息送进 DSH 会话时，
  `segmentsToText()` 只给出一行文案 `[视频]`；请求里没有任何视频画面，模型只能看到这行占位。
- 影响面：所有 **QQ 入站视频**（私聊 + 群聊）。不丢用户数据（视频原片本来就不落盘）；无花钱路径；
  不影响文字/图片/表情/语音。恢复方式 = 改代码后重启桥，MCP / DSH 都不用动。

## 环境

| 项 | 值 |
| --- | --- |
| 系统 / DSH 版本 | Windows 11 · DSH 桌面版 `0.2.1-rc.5`（`C:\DSP`，app.asar 路线） |
| SurfCore 版本 | `0.8.6`（编辑会话未 bump；建议随下一批发 **0.8.7**） |
| 安装方式 | 工作区 `C:\deepwork\surfcore`（**不是 git 仓库**，HEAD 无；回退靠 `_backups/`） |
| 其它相关版本 | node `v24.21.0`（`C:\Users\20130\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe`）；ffmpeg `N-92722-gf22fcd4483`（4.1，2018-12，含 libx264/select/tile/scale，本次装在 `~/.dsh/surfcore/bili/bin/ffmpeg.exe`）；SnowLuma 网关 `3100/3101`；桥控制台 `3110` |

## 根因

- 代码位置：
  - `src/bridge.js:1557`：`segmentsToText()` 里 `case 'video': out.push('[视频]'); break;`
    —— 视频在**文本化**阶段就被压成占位符。
  - `src/bridge.js:1611-1664`：`extractMediaFromSegments()` 原来只认 `image` / `mface` / `face`，
    `video` 段直接跳过 → 消息写入 social-v2 state 的 `media` 列表里**没有**视频元数据。
  - `src/bridge.js:9718`（改前是 9601 起的 `fetchMediaData()`）：只处理图片/表情，
    `GET /api/images/message` 自然拿不到视频。
  - MCP 侧 `src/mcp-snowluma-safe.js:1093` 的 `qq_get_message_images` 是纯透传：只把
    `data.images[]` 里带 `{data,mimeType}` 的项转成图片内容，自身不认识视频。
- 问题链条：
  `SnowLuma WS 入站` → `onPrivateMessage/onGroupMessage` → `handleIncoming()` →
  `extractMediaFromSegments()` **丢视频** + `segmentsToText()` 写 `[视频]` → 模型 prompt 只有一行字 →
  （即使模型想调 `qq_get_message_images`）`findMessageMedia()` 在 state 里查不到视频 →
  `media:[]` → 模型永远看不到画面。
- 为什么之前没发现：
  - `state/bridge.log` 全文「视频」出现 **0 次** —— 这条通道从上线起就没收到过真视频；
  - 审计套件没有任何「入站视频段」用例（`test-media-*` 全是图片/表情）；
  - SnowLuma SDK 的 `VideoSegment` 只声明 `{file, url?, thumb?}`（无时长），历史上被当成
    「没法处理」而只在文本层留了 `[视频]`。

## 完整逻辑（给用户看的那一遍）

- **链路**：SnowLuma（专有运行时，`ws://127.0.0.1:3101`）把 QQ 事件推进桥接进程
  `src/bridge.js`（单实例，PID 变化，`state/bridge.lock`）；`handleIncoming()` 把消息写入
  `state/social-v2.json`（recentMessages / messageMediaStore）并拼 prompt 交给 DSH 会话；
  模型在需要看画面时调 MCP 工具 `mcp__snowluma__qq_get_message_images`
  → `src/mcp-snowluma-safe.js` → `GET http://127.0.0.1:3110/api/images/message`
  → 桥接 `findMessageMedia()` → `fetchMediaData()` → 返回 `images[]`（base64）
  → MCP 把每项转成 `{type:'image'}` 交给模型视觉。下游读者：QQ 会话的模型、设置页状态卡、
  审计脚本（读源码）。
- **机制**：真正的原因不是「模型不会看图」（同一 harness 在桌面会话能准确读 QQ 截图），而是
  **视频在桥接入站时被降级成一句占位文本**：契约上 `extractMediaFromSegments()` 只服务图片/表情，
  `mediaHintFor()` 也只提示「图片/表情」；模型看不到提示、也拿不到数据，于是「接不上」。
- **爆炸半径**：1 个进程（bridge）× 3 类读者（模型 prompt、MCP 工具、审计/测试）× 无静默放大；
  只在**用户发视频时**按需下载原片到系统临时目录（`%TEMP%\qq-video-sheets`，处理完立刻删），
  ≥10 分钟缓存上限 8 条；不写用户目录、不碰密钥、不花钱。失败可见（返回文案说明「没下到/抽帧失败」）。
- **取舍**：
  - 路线 A：动 MCP，新增 `qq_get_message_video` 工具 → 需要重启 MCP / DSH，工具面变化、回归面大。
  - 路线 B（**采用**）：桥内下载 + ffmpeg 抽帧成 **3x3 九宫格 jpg**，塞进既有
    `/api/images/message` 的 `images[]` —— 旧 MCP 工具是纯透传，零改动、零重启，
    模型拿到的仍是一张图片。代价：九宫格是「9 个时间点的快照」，不是连续画面（对「看懂发生了什么」足够）。
  - 代价与护栏：单条入站视频上限 `MAX_VIDEO_BYTES=100MB`（可配 `socialV2.media.maxVideoBytes`，
    clamp 1MB–300MB）；下载只收 http(s)，拒绝内网/回环/`file://`（含重定向后的最终 URL）；
    ffmpeg 各步骤都有超时（探测 20s / 渲染 180s），超时被杀掉并回文案。
- **生效与重启**：`src/bridge.js`、`src/video-frames.mjs` 由**桥进程**在启动时 import 一次
  → 改完必须**重启桥**（本次用 `plugins/surfcore/lib/bridge.js` 的 `restart()`，两步：`stop()`
  跑 `scripts/stop-qq-bot.ps1`（失败按 `state/bridge.lock` pid 兜底 kill）→ `start()` spawn
  `node src/bridge.js`）。**MCP / DSH 不用重启**（MCP 只透传）。
  注意：桌面端每次启动会换回环端口，重启桥前先把 `config.json` 的 `dsh.baseUrl` 同步到当前
  GUI 端口（`node scripts/sync-dsh-port.mjs --url <当前 URL>`），否则桥会 `dshReady=false`、
  模式退回 `chat`（本次把 `56543` 同步成 `54626`）。

## 修法

- 新增 `src/video-frames.mjs`（纯函数 + 子进程封装，便于单测）：
  - `pickSheetFps(duration)` = clamp(9 帧 ÷ 时长, **0.001**, 60)；`buildSheetArgs()` 生成
    `-vf fps=<n>,scale=480:270:force_original_aspect_ratio=decrease,pad=480:270:(ow-iw)/2:(oh-ih)/2:black,tile=3x3`；
  - `resolveVideoFfmpeg()`：显式路径 → `~/.dsh/surfcore/bili/bin/ffmpeg(.exe)` → `'ffmpeg'`（PATH）；
  - `fetchHttpVideoBuffer()`：只 http(s)、拒内网/本机、限制字节数、≥1KB；
  - `runProcessTimed()`：永不 throw，超时 SIGKILL 并给 `code:-1`；
  - `buildVideoSheetFromBuffer()`：临时 mp4 → `ffmpeg -i` 探测时长 → 渲染九宫格 → 读回 → finally 删临时文件；
    探测失败/无视频流直接抛「无法解析视频时长…」，由上层转成可见文案。
- 改 `src/bridge.js`（8 处，详见 `_backups/2026-11-07-qq-video-frames/REVERT.md` 的逐条对照）：
  1. `import { execFileSync, spawn }`；新增 `video-frames.mjs` import；
  2. `MAX_VIDEO_BYTES` / `VIDEO_SHEET_TTL_MS`(10min) / `videoSheetCache`(≤8)；
  3. `extractMediaFromSegments()` 新增 `video` 分支（`kind:'video'` + `file/url/thumb/size`）；
  4. `resolveMediaList()`（一代内联路径）遇视频只给文字说明，避免把 mp4 当图片；
  5. 新增 `videoFfmpegPath()` / `fetchVideoBytes()` / `fetchVideoThumb()` / `buildVideoFrames()`：
     先 `media.url`（http）→ 否则 `bot.raw('get_file')` 拿 URL/本地路径 → 再兜底 SnowLuma homeDir 内缓存文件；
     抽帧失败退封面图并注明「这是封面图，不是抽帧」；
  6. `fetchMediaData()` 新增 `media.kind === 'video'` 分支（在 face 之前），九宫格超图片总大小上限时跳过并说明；
  7. `mediaHintFor()` 重写为「图片/表情 + 视频」两段提示：视频提示模型**只调一次**
     `qq_get_message_images`，会拿到按时间均匀抽 9 帧的 3x3 九宫格；
  8. 文本占位 `[视频]` 保留（提示随后会补上，模型不会误以为没有媒体）。
- 改 `scripts/audit-bridge-harness.mjs`：审计套件把 `src/bridge.js` 的顶层 import 逐行剥掉后
  往 `vm` 注入模块导出 —— 必须同步 `import * as videoFrames from '../src/video-frames.mjs'` 并
  `...videoFrames` 进 context，否则 vm 里 `DEFAULT_MAX_VIDEO_BYTES is not defined`（首跑就是这么红的）。
- 新增 `scripts/test-video-frames.mjs`（27 条断言）：纯函数、ffmpeg 查找顺序（假 home 造 exe）、
  下载防护（127.0.0.1 / 192.168 / `file://` 必须拒）、可选真实渲染（lavfi testsrc2 3s → jpg 头/大小/文案）。
- 为什么没选「改 MCP 加新工具」：见上面取舍；为什么没在 `/api/images/message` 里直接调
  SnowLuma SDK 下载视频：SDK 的 `VideoSegment` 只有 `file/url/thumb` 三个定位字段，
  没有稳定的统一下载方法，走 OneBot `get_file` / URL 两条兜底更兼容不同网关版本。
- 回滚方式：`_backups/2026-11-07-qq-video-frames/REVERT.md`（逐条撤销 + `mediaHintFor` 原文）；
  回滚后 `node --check`、重启桥、跑 `test:audit`（基线 94/108）。

## 验证

- 自动化：
  - `node scripts/test-video-frames.mjs` → **27 通过 / 0 失败 / 0 跳过**（含真实 ffmpeg 渲染）。
  - `npm run test:audit` → **95/108**（改前基线 94/108；本批无新增红，失败清单与基线同类：
    setup-guards / history-catchup / closure-wiring / token-economy / reply-wait / admin-prompt-wiring /
    audit-regressions / issue-regressions / v2-initial-prompt / preset-local-tools / qq-mode-plugin /
    release-manifest / snowluma-channel-gate）。
  - `npm run test:regressions` → **1 项失败 = R4 既有红**（基线 15/16，一致）。
- 失败路径（结构化、可见）：视频没下载到 → 卡片文案「视频原片没下载到（网关没给可下载地址），只能看看封面」；
  抽帧抛错 → 「视频画面处理失败：<原因>」；超图片总大小上限 → 「视频九宫格超过单条消息图片总大小上限，已跳过」；
  封面也失败 → 只给文字说明。不会静默当图片塞进去。
- 手工/集成：
  - 用 ffmpeg 造 **真 h264+aac** mp4（640x360/25fps/6.02s/580KB）跑 `buildVideoSheetFromBuffer()`：
    **315ms** → 1440x810 jpg **131KB**，`durationSeconds=6.02`，read_image 确认九宫格画面与时间戳正确。
  - 长视频覆盖率：300s 视频 → fps 0.03 → **九宫格时间戳 16.6s / 49.9 / 83 / 116 / 149 / 183 / 216 / 249 / 283**，
    全片覆盖、1.26s 完成（此前 `MIN_SHEET_FPS=0.05` 会让 >3 分钟的视频只抽到前 3 分钟，已修）。
  - 桥重启后 `/api/status`：`{running:true, pid:40916, port:3110, dshReady:true, mode:"reserved2",
    snowluma:{connected:true, accountOnline:true}}`。
  - 回归：`GET /api/images/message` 对既有图片消息仍正常（返回 gif 1.34MB，`ok:true`）。
- 没验证到的部分（老实写）：**苏真实 QQ 私聊视频的端到端**。需要用户从 QQ 发一条短视频，
  才能确认 SnowLuma 入站 `video` 段真实字段（`file`/`url`/`thumb` 是否齐全、`get_file` 能否拿到下载地址）。
  若网关只给 `file_id` 之类没覆盖的字段，会退化成「只给封面/文字」——届时按日志 `[media] 视频 get_file 失败` 再补。
  **（20:25 已收到苏在群里发的真实 15 分钟视频并端到端跑通，期间补了两处 bug，见下一节。）**

## 真实端到端复验与补丁（2026-11-07 20:25–20:32）

**现象**：苏在群 `1132673495` 发了一条 15 分钟视频（`messageId=1676695895`，SnowLuma 给的 URL 是
`multimedia.nt.qq.com.cn/download?appid=1415&format=origin&orgfmt=t264…`，直接可下，28MB）。`state/bridge.log`
里没有一句「视频」，只有 `[media] 图片获取失败（2 次尝试）… 图片超过大小限制（8388608 字节）`——尺在群里回的是
「视频我这边打不开，只看到一个占位的框」。

**根因（两个）**：
1. `appendSocialV2Message()` 写二代会话状态时把 media 归一化成 `face / sticker / image` 三选一，
   **video 被拍平成 image**（thumb/size 也丢了）；`findMessageMedia()` 又优先读 state、`messageMediaStore` 只在
   state 没有时兜底 → 按需查看拿到 `kind:'image'` → 走图片下载，mp4 28MB 超过 8MB 上限 → 失败，抽帧代码从未被调用。
2. 反过来说，入站那一刻 `extractMediaFromSegments()` 的 `kind:'video'` 是对的（`messageMediaStore` 里有），
   但优先级顺序把它藏住了。

**修法**：
- `src/bridge.js` `appendSocialV2Message` 的 `safeMedia`：`kind:'video'` 原样保留，并保留 `thumb` / `size`；
  注释写明「拍平会让 mp4 被当图片下载」。
- `src/bridge.js` `findMessageMedia`：改为**先查 `messageMediaStore`（入站原始字段最全），再退回 state**；
  state 仍是进程重启后的持久化兜底。
- `scripts/test-video-frames.mjs` 新增 3 条源码级回归（夹住 main() 闭包里够不到的不变量）：safeMedia 保留 video、
  findMessageMedia 先 store 后 state、fetchMediaData 有视频分支。单测 30/30。

**验证（真实消息、走真实链路）**：重启桥（pid 9524）后，把那条视频消息的 state 副本按修复后的形状修正
（`kind:image→video`，仅这一条），用控制台 token + agent token 调 `GET /api/images/message?key=group:1132673495&messageId=1676695895`：

- HTTP **200**，耗时 **29.4s**（28MB 下载 + 900s 视频解码抽帧）；
- `media: [{kind:'video', file:'fad7ffeb….mp4'}]`；
- `images: [{kind:'video', mimeType:'image/jpeg', bytes:207810, text:'视频（约 935.5 秒）：按时间均匀抽 9 帧拼成的 3x3 九宫格…'}]`；
- read_image 看九宫格：画面是「玛蕾Marrow」的 SurfCore/DSH 功能演示视频（人格与记忆、可塑性记忆、语音、B站 身份、Token 额度、QQ 桥接），与苏发的内容一致。
- 回归：`test:audit` 95/108（同上一节）、`test:regressions` 只剩既有 R4、`test-video-frames` 30/30。

**未覆盖**：QQ 群里的模型要下一次唤醒才会重新看到这条消息的「【视频】…想看就调 qq_get_message_images」提示（唤醒上下文里已带 video hint）；
零（AstrBot，另一台服务器）没有视觉，仍只能看文件不能看画面。


## 遗留 / 后续

- 需要补的测试：等真实视频样例到手后，把「video 段 → extractMedia → /api/images/message 返回九宫格」的
  桥接层断言补进审计套件（目前只测到 `video-frames.mjs` 单元与桥内分支静态检查）。
- 需要改的文档：本 case、`docs/cases/README.md`、`docs/HANDOFF.md`、`docs/PITFALLS.md`（#109 审计 harness 注入坑）、
  `docs/RELEASE-QUEUE.md` 待发布批次。
- 另外两件事（不在本批）：① 表情包只有 1 张（用户在截图里提过「多给我几张表情图」）——属于素材/收藏，不是代码；
  ② B站 侧 ffmpeg 已在 19:50 装好并实测抽帧成功（另一条链路，见 MEMORY.md 同日条目）。
