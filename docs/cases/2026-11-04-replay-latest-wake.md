# 繁忙积压唤醒只补最旧一条 → 回复错位、重复（尺的「你我他」串话）

## 现象

- 用户看到什么（原话尽量保留）：
  - 2026-11-04 22:10，苏殇文私聊截图问：「尺好像也搞不清你我他了」。
  - 截图里尺先说「那句是在问他，不是我自己认领」「不过你这么一问，我也有点心虚」，被追问「问他，等一下，先把这句话解释清楚」后又答「我那句是问你的，不是问零」。
  - 同一句话在 22:07 和 22:10 各发了一遍，只是措辞微调。
- 复现步骤（这次的时序）：
  1. 22:06 前后尺在修零的 bug（回合很忙），苏殇文连发追问（seq96/103/104/105）；
  2. 桥记「会话繁忙，暂存唤醒原因」；
  3. 22:10:17 回合结束，桥「补发繁忙期间积压的唤醒：private@seq96」——补的是**最旧**的那条；
  4. 模型看到的最新上下文已经推进到 seq105，却按 seq96 的问题作答，于是错位 + 重复。
- 影响面：所有会「忙」的会话（私聊/群）。不丢消息、不丢数据，但会产生**答非所问、重复解释、指代混乱**；用户侧看起来像「AI 搞不清你我他」。

## 环境

| 项 | 值 |
| --- | --- |
| 系统 / DSH 版本 | Windows 11 / DSH 桌面版 0.2.1-rc.5 |
| SurfCore 版本 | 0.8.6（工作区非 git，未 bump） |
| 安装方式 | 工作区直跑（`C:\deepwork\surfcore`，`node src/bridge.js`） |
| 其它相关版本 | SnowLuma（QQ 网关）、AstrBot 4.29.3（零，服务器侧） |

## 根因

- 代码位置：`src/bridge.js:14039` `replayPendingWakeReasonsV2(key)`（改前）。
- 问题链条：
  1. 繁忙时 `sendWakePromptV2` 把 `{ reason, seq }` 推进 `st.pendingWakeReasons`（两处入队，FIFO）；
  2. 回合结束调用 `replayPendingWakeReasonsV2`，用 `st.pendingWakeReasons.shift()` 取出**最旧**一条；
  3. 消息类用它自己的 `seq` 判「还相不相关」：`st.unread.some((m) => Number(m.seq) >= Number(item.seq))`；
  4. 但 unread 里现在装的是**最新**几条，它们的 seq 必然 ≥ 旧 item 的 seq → 判定「相关」→ 用旧消息的 reason 唤醒；
  5. 模型被唤醒后看到的是最新上下文，却按旧 reason 作答 → 答非所问；若再补一轮，就重复。
- 为什么之前没发现：只在「繁忙」时触发；上一轮修复（PITFALLS #101）只保证「别丢」，没管「补哪一条」，自测只验证了「会补发」而不是「补的是不是最新」。

## 完整逻辑（给用户看的那一遍）

- **链路**：`src/bridge.js`（单进程）内 `socialV2` 状态机。上游：DSH 事件流触发 `turn/start`/`turn/end`、SnowLuma 的入站消息；`pendingWakeReasons` 在 `sendWakePromptV2` 入队；下游：`replayPendingWakeReasonsV2` 在最忙状态结束 / 连接恢复等路径被调用，补发唤醒提示词给 DSH 会话。读这个状态文件的还有控制台 `/api/socialV2/*`、`scripts/test-audit-regressions.mjs` 的 R4。
- **机制**：队列是「先来后到」，但未读窗口是「最新 N 条」；两种语义混用 → 旧消息被当成触发器。`unread.some(seq >= item.seq)` 只能证明「旧消息已经被读过了」，不能证明「它是现在的触发源」。
- **爆炸半径**：1 个桥进程 × 全部 QQ 会话（每次繁忙结束最多一次补发）；不碰用户数据/密钥、不额外花钱（补发唤醒本身的 LLM 调用与正常唤醒同价，且受 token-guard 配额约束）。
- **取舍**：
  - 路线 A（本次）：积压唤醒只按 **seq 最大（最新）** 的一条补发，其余作废，超 3 分钟的直接丢。
  - 路线 B：补发最旧一条，但把它的原文附进提示词——能避免错位，但要改唤醒提示词模板与 token 预算，且用户仍会看到「答旧问题」。
  - 路线 C：全丢（回到 #101 的坑，会漏回）。
  - 选 A：改一处、可回滚、与「上下文本来就是最新的」这一事实一致；同时用 TTL 挡住几十条积压一起补。
- **生效与重启**：改 `src/bridge.js` 后必须重启桥进程（`/api/restart` 或杀进程重起）；运行中的进程不会热更新。

## 修法

- 改了什么（关键片段）：
  - 两处入队加时间戳：`st.pendingWakeReasons.push({ reason, seq, at: Date.now() });`
  - `replayPendingWakeReasonsV2` 重写：
    - 定时器类（timeout/replyCheck/proactiveCheck/其它）先用 `findIndex(isTimerWakeReason)` + `splice` 优先补，语义不变；
    - 消息类：整队取出并清空 → `PENDING_WAKE_REPLAY_TTL_MS = 3 分钟` 过滤旧项（无 `at` 的旧持久化项视为新鲜）→ 按 `seq` 降序取最新一条 → 仍用 `unread.some(seq >= best.seq)` 判「已被本回合处理」→ 补发或跳过；
    - 有丢弃/合并时写日志：「作废 N 条超过 3 分钟的积压唤醒」「积压唤醒 N 条，只按最新一条 seqX 补发，其余 N-1 条并作废」。
  - 同批修的另一半（语义层）：`roles/角色卡.md` §三新增 8–11 条——说「他」先点名、被追问先复述理解、同一句不说两遍、隔几分钟回先点明回哪句。
- 为什么选这个方案：一行队列语义改动就能消除错位；角色卡改的是「被追问时的表达习惯」，两层配合，不需要重写唤醒机制。
- 回滚方式：`cp src/bridge.js.bak-replayfix-20261104_2218 src/bridge.js` 后重启桥；角色卡用 `_backups/` 或直接从版本库外的副本还原（本次只在工作区改，见 HANDOFF）。

## 验证

- 自动化：
  - `node --check src/bridge.js` 通过。
  - `npm run test:audit` → 90/108（18 项失败：`buildVaultMemoryBlock is not defined`、`spawn EPERM` 等**既有问题**；用改前备份 `bridge.js.bak-replayfix-20261104_2218` 复跑同样失败）。
  - `npm run test:regressions` → 15/16（R4「timeout/replyCheck 类暂存唤醒按定时器语义补发」失败；**备份复跑同样失败**，属既有缺陷，不是本轮引入）。
  - 自写临时用例（bridgeHarness）三条全过：积压 `[seq3, seq5]` → 补 seq5、队列清空；三条全超 TTL → 仍补最新 seq9；最新那条已被本回合处理（unread 空）→ `skipped`，不补发。
- 失败路径（用户看到什么 / 下一步 / 失败分支断言）：
  - 唤醒补发失败/被 token-guard 拦：日志 `[token-guard] 跳过唤醒 …` 或 `[reserved2] … 跳过补发`；用户侧就是「这次没动静」，但下一轮正常消息仍能唤醒（@ / 私聊直呼不受配额影响）。
  - 桥重启失败：`state/bridge.lock` 里是旧 PID、3110 不监听；处理方式是删锁后重起 `start.bat`。
- 手工/集成验证（关键输出）：
  - `/api/restart` 后桥 22:25:49 重启，`bridge.lock` PID 与实际监听 PID 一致（10528），单实例；
  - 日志：`桥接已启动。按 Ctrl+C 退出。` + `桥接模式已确定为 reserved2` + 三个会话的主动机会检查已重排。
- 没验证到的部分（老实写）：
  - 「繁忙期间连发多条 → 回合结束」的**真实端到端**时序没复现（要用户配合在尺忙时连发）；
  - 新的「作废 N 条」日志还没在真实溢出场触发过（只单测）。

## 遗留 / 后续

- 需要补的测试：把上面三条临时用例并入 `scripts/test-audit-regressions.mjs`（和 R4 相邻），并把 R4 的既有失败单独修掉。
- 需要改的文档：`docs/PITFALLS.md` #105（已写）；`docs/HANDOFF.md`（已更新）；`docs/RELEASE-QUEUE.md` 顶部批次（已写）。
- 零侧联动的改动不在本仓库（AstrBot 服务器）：`zero_later` 关掉「尺私聊叫醒」；详见 `C:\deepwork\qq\ws\MEMORY.md` 2026-11-04 条目。
