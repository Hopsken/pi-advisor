pi-advisor extension 设计方案 (PLAN)

一个 pi coding agent 的 extension,复刻 oh-my-pi 的 advisor 能力:一个**独立模型**旁听主 agent 的**每个 turn**,评审后把建议注入主对话(像结对编程的 navigator)。

- 参考实现:oh-my-pi(`/Users/wshao2/work/tries/oh-my-pi`,`packages/coding-agent/src/advisor/`)——内核级 advisor,是本方案的行为蓝本。
- 宿主平台:pi coding agent(`/Users/wshao2/work/tries/pi`),oh-my-pi 即 fork 自它,架构同源。
- 关键约束:只能用 pi extension 暴露的 hook/API(不能改内核),把 advisor 的内部机制**映射到 extension 原语**。

> 本文档为中间过程产物,正文中文,代码/标识符英文。所有关键结论均已核对 pi / oh-my-pi 源码,标注 `文件:行`。

---

## 0. 术语

- **主 agent**:用户直接对话的 pi agent(宿主会话)。
- **advisor 子 session**:extension 用 `createAgentSession` 起的独立评审 agent。
- **turn**:主 agent 的一次 LLM 采样 + 其工具执行(`turn_end` 事件的粒度,pi `agent-loop.ts:218`)。
- **delta**:主 branch 自 advisor 上次消费点以来的增量(压缩后喂给 advisor)。
- **severity**:advisor 建议的三档 `nit | concern | blocker`。

---

## 1. 架构总览(已锁定:方案 B)

**in-process `createAgentSession`**,不用 subprocess、不用轻量 `complete()`。这是成熟扩展 `@tintinweb/pi-subagents` 验证过的路线(`agent-runner.ts`)。

```ts
import {
  createAgentSession, DefaultResourceLoader,
  SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";

const { session } = await createAgentSession({
  cwd, agentDir,
  modelRegistry: ctx.modelRegistry,
  model,                                   // 独立模型(见 §9)
  tools: ["read", "grep", "glob"],         // 只读工具 allowlist(字符串名,非 createReadOnlyTools)
  sessionManager: advisorSessionManager,   // 常驻,固定 sessionId → prompt cache(见 §5)
  settingsManager,
  resourceLoader: new DefaultResourceLoader({
    cwd, agentDir,
    systemPromptOverride: () => ADVISOR_SYSTEM_PROMPT,  // 系统 prompt 没有独立入参,必须走这里
    noSkills: true, noContextFiles: true, noPromptTemplates: true, noThemes: true,
  }),
  thinkingLevel,
});
await session.bindExtensions({ onError });
session.subscribe(onAdvisorEvent);         // turn_end / message_end(usage) / tool_execution_*
// 评审:await session.prompt(compressedDelta)
```

关键事实(pi 源码):
- 系统 prompt 无独立参数,只能 `DefaultResourceLoader.systemPromptOverride`。
- `tools` 是**字符串名 allowlist**(pi `sdk.ts:CreateAgentSessionOptions`),不是 `createReadOnlyTools()`。
- `createAgentSession` 会 restore `sessionManager` 已有 messages(`sdk.ts:363` `agent.state.messages = existingSession.messages`)——用于分支重放。
- prompt cache key = `sessionManager.getSessionId()`(`sdk.ts:349` → provider `prompt_cache_key`,见 `openai-responses.ts:229` 等)。

**与 pi-subagents 的本质差异(不能照抄)**:它是按需、工具触发的任务 agent;advisor 是**被动、逐 turn 观察者**。pi-subagents **从不 hook 主 agent 的 `turn_end`**——那层观察循环是本 extension 全新的。

---

## 2. 三层持久化模型(必须分清)

| 层 | 是什么 | pi 落点 | 是否进主 tree / 随 branch |
|---|---|---|---|
| **① advisor 累积上下文** | 喂给子 session 的评审历史(cache 靠它) | 子 session 自己的 `SessionManager`(内存,固定 sessionId) | 不进主 tree;branch 时 reset+重放(§4) |
| **② 建议卡片** | 注入主对话的 advisory | `pi.sendMessage({customType:"advisor"})` → 主 tree 的 message | 进 tree,随 branch/fork 自动走 |
| **③ 观测/计费日志** | oh-my-pi 的 `__advisor.jsonl` | 自写派生文件(**非** `appendEntry`) | 不进 tree,跟随 session file。**v1 暂缓** |

**坑**:`pi.appendEntry` → `sessionManager.appendCustomEntry`(pi `agent-session.ts:2265`),写的 CustomEntry **进主 tree 并随 fork 复制**。要复刻 `__advisor.jsonl` 那种独立日志,**不能用 appendEntry**,须像 oh-my-pi `AdvisorTranscriptRecorder` 自己 `SessionManager.create(<派生路径>)` 写文件。v1 不做(见 §12)。

---

## 3. 核心循环

```
主 agent turn_end
  → observe(ctx):                 // 同步、快
      curBranch = ctx.sessionManager.getBranch()   // 带稳定 id
      LCP 对齐(§4)→ 算出增量 delta or 需 reset
      compress(delta)(§8)→ push #pending, backlog++
      kick #drain()(不 await)
  → 若 backlog ≥ high 阈值:await waitForCatchup(...)   // 有界背压(§7)

#drain()(异步、单飞 #busy):
  while pending:
    splice(0) 合并所有积压 delta → 一个 batch
    await advisorSession.prompt(batch)
    解析 advisor 输出 → severity + note
    emissionGuard.accept(note)(§10)→ route(§6)注入主对话
    backlog -= coveredTurns;唤醒 catchup 等待者
```

**回路闸(必做)**:`observe` 里必须**跳过 advisor 自己注入的消息 / 由 advisor 触发的响应 turn**,不计入 delta、不重新评审。等同 oh-my-pi `#renderDelta` 的 `.filter(customType==="advisor")`。这是切断「注入→触发→再评审→再注入」死循环的闸。

---

## 4. 上下文对齐:entry-id LCP(兼容 branch 的核心)

**地基**(pi `session-manager.ts`):每个 `SessionEntry` 有稳定 `id`/`parentId`(:48-49);`getBranch(fromId?)` 沿 parentId 回溯返回当前活跃路径;`branch()` 同文件改叶、id 稳定;`createBranchedSession()`(fork)`{...entry, parentId}`(:1337)**保留 entry id**、只换 header id。→ **branch/rewind/fork 三种形态下 entry id 都稳定**,LCP 可靠。

**状态**:`fedEntryIds: string[]` = 已喂给 advisor 的主 branch entry id 序列。

**每次 observe / branch 事件后**:
```
curIds = getBranch().map(e => e.id)
k = longestCommonPrefixLen(fedEntryIds, curIds)
```

| 情况 | 条件 | 处理 |
|---|---|---|
| 纯前进 | `k === fedEntryIds.length && curIds.length > k` | 压缩 `branch[k:]` → 追加(cache 全热) |
| 无变化 | `k === fed.length === cur.length` | no-op |
| 分叉 | `k < fedEntryIds.length` | advisor 上下文 `[k:]` 属旧分支,回退(见下) |

**为何鲁棒**:纯 id 比对,不靠事件。即使漏接 branch 事件或 rewind,下个 turn_end 的 LCP 也会发现 `k < fed.length` 自动触发回退。

**分叉恢复(已锁定:先 A 后 B 分阶段)**:
- **档 A(v1)**:dispose advisor session → 新 sessionId → 用当前整条 `getBranch()` 压缩快照重放。cache 冷一次,简单鲁棒。= oh-my-pi 的 `reset()`(游标归零、重放当前分支)。
- **档 B(后续优化)**:保持同 advisor sessionId,截断到共享前缀第 k 段(靠「新建装了前 k 段 advisor messages 的同-sessionId SessionManager + createAgentSession restore」实现),只喂 `branch[k:]`。前缀 `[0:k]` cache 仍命中。需维护「delta ↔ entryId 边界 + advisor message 位置」映射。

**事件 vs 判定分工**:`session_tree` / `session_start(fork|resume|new)` 事件用来**及时触发**重对齐 + abort 在途(§7);LCP 用来**判定**分叉点 + 兜底。双保险。

---

## 5. 常驻子 session + prompt cache(已锁定)

- **常驻**:一个 advisor 子 session,**固定 sessionId**(不随 turn 变)。pi 的 prompt cache key = sessionId(`sdk.ts:349`),常驻 → key 稳定 → 命中;用完即弃每次新 sessionId → cache 冷,成本随对话线性爆炸。
- 每 turn **纯追加** delta(`.prompt()`),绝不回改前文 → 前缀稳定 → cache 热。
- 膨胀:禁用 advisor 子 session 的 auto-compaction(v1);或档 B 的 LCP 截断天然控长。compaction 会让 cache 失效一次,故 v1 尽量不触发。

---

## 6. 投递矩阵(severity → deliverAs,已锁定)

pi `sendCustomMessage`(`agent-session.ts:1339`)真实语义(**deliverAs 只在 streaming 时区分,idle 靠 triggerTurn**):

| deliverAs | streaming 中 | idle |
|---|---|---|
| `nextTurn` | 挂进下个 turn context,不触发 | 同左(等下次 prompt 带出) |
| `followUp` | `agent.followUp()` 排队,当前 turn 结束后**主动处理并回应** | 被忽略 → 看 triggerTurn |
| `steer` | `agent.steer()` **打断** | 被忽略 → 看 triggerTurn |
| (idle) triggerTurn:true | — | 立即起新 turn |

**映射**(采纳 oh-my-pi「传达 vs 唤醒分离」哲学,三通道 `aside/steer/preserve` → pi 原语):

- **nit → `{deliverAs:"nextTurn"}`**:传达,不唤醒(= aside)。
- **concern → 默认 `{deliverAs:"followUp"}`**:streaming 时主 agent 忙完主动回应一次(followUp≈「值得回应」,区别于 nit 的「仅参考」);idle 时降级见下。
- **blocker → 默认 `{deliverAs:"steer", triggerTurn:true}`**:streaming 打断;idle 靠 triggerTurn 唤醒。

参考 oh-my-pi `resolveAdvisorDeliveryChannel`(`advise-tool.ts:108`):
```
if (!interrupting(severity))                       return "aside";    // nit
if (autoResumeSuppressed && (aborting||!streaming)) return "preserve"; // 用户刚停/idle
if (interruptImmuneTurnActive)                     return "aside";    // 冷却窗口降级
return "steer";
```

---

## 7. 唤醒逻辑(已锁定:默认唤醒 + 三闸防循环 + 降级永不丢)

**核心原则(用户定)**:advisor 的意义必须被**传达并处理**,但避免死循环。oh-my-pi 的答案 = **传达与唤醒分离**:所有通道都保证建议进入主 agent 可见上下文(传达),区别只在要不要主动起 turn(唤醒)。

**默认倾向唤醒**(concern/blocker),但三层降级——**降级是降到 `nextTurn`(仍传达、下个 turn 必被读到),不是丢弃**:

1. **emission guard 去重(第一道、最强)**:route 前 `if (!accept(note)) return`(oh-my-pi `#routeAdvice` 开头)。重复/无意义 note 在源头掐掉,根本不唤醒。防死循环的根。
2. **immune 窗口**:一次 steer 打断后记 `immuneTurnStart = completedTurns+1`,`immuneTurns` 个 turn 内后续 concern/blocker **降级 nextTurn**(不再连环唤醒,但仍传达)。参考 `isAdvisorInterruptImmuneTurnActive`(`advise-tool.ts:81`)。
3. **autoResumeSuppressed(用户主动停时)**:用户按停后 idle/aborting 状态降级 `nextTurn`(不替用户把 agent 拉起来);若之后是用户驱动的 resume(turn 又在跑),steer 不 auto-resume,允许 live 投递。

**配置** `advisor.autoResume`:默认 `concern`(concern+blocker 唤醒);可选 `blocker`(只 blocker)/`off`/`all`(不推荐)。

---

## 8. 上下文压缩(喂给 advisor 的 delta 格式)

移植 oh-my-pi `session-history-format.ts` 的精简序列化思路:
- **丢弃**:工具结果正文(read 文件内容、bash/grep 输出)→ 只留 `→ read(path) ⇒ ok · N lines` 一行 + 行数;工具参数截断到 ~120 字符。
- **保留**:user/assistant 正文、assistant thinking(`includeThinking`)、edit/apply_patch 的 unified diff(`expandEditDiffs`)、plan-mode 约束逐字(`expandPrimaryContext`,含 dedup 折叠成 `(unchanged)`)。
- 秘密混淆:v1 不做(§12)。

目的:advisor 看懂主 agent 在干什么、改了什么、受什么约束,但不吞下全部字节(纯追加友好 → cache 热)。

---

## 9. 背压(已锁定:滞回有界阻塞,阻塞是 safety valve)

**原则**:尽量不阻塞,只在明显 delay 才兜底。advisor 用 slow model,慢是常态,故阈值要大。

**地基**:pi extension 的 `turn_end` handler 被主 agent **await**(`agent-loop.ts:218` `await emit(turn_end)`;`agent-session.ts:661`;`runner.ts:774-776` 串行 await handlers)→ 在 handler 里 `await` 能阻塞主 agent 下一个 turn。

**机制**:
1. **单飞**:同时只一个评审(`#busy`)。
2. **排队合并,不 abort**:在途时新 turn → push `#pending`、backlog++,**不打断**;跑完 `splice(0)` 合并成一个 batch(经 LCP)。不丢任何 turn。合并让 advisor 一次追多个 turn,且看到的是**最新全貌**(故大阈值安全,建议不过时)。
3. **滞回双水位有界阻塞**:
   - 触发:backlog ≥ **high**(默认 `advisor.syncBacklog = 10`)
   - 放行:backlog ≤ **low = high/2**(或超时),避免阈值边缘抖动
   - 超时:默认 **45s**(slow model 友好)
   - 阻塞时 `ctx.ui.setStatus("advisor", "catching up (N behind)…")`,避免静默 hang
   - `advisor.syncBacklog = off` → 从不阻塞(尽力式)
4. **abort 只在 branch/reset 边界**(§4),正常背压**绝不** abort。
5. **失败保护**:连续失败 N 次丢 backlog + 通知,防主 agent 被 catchup 永久卡死(oh-my-pi 有)。

**extension 特有顾虑**:runner 串行 await handlers → 阻塞会连带拖住同 turn_end 的其他 extension handler,故超时不宜过长(≤45s)且罕见触发。

---

## 10. Emission guard(噪音控制,load-bearing)

移植 oh-my-pi `emission-guard.ts` 简化版——纯逻辑,不依赖内核:
- 归一化 note;抑制 content-free 短语(`Stop.` `Done.` `LGTM.` `No issue; continue.` …)。
- 跨评审 dedup 已见 note。
- 每次评审至多放行 **1** 条。
- 抑制对 advisor 模型**不可见**(仍报 `Recorded.`),避免它换个说法绕过去。

历史依据:oh-my-pi issue #3520(单会话 309 次 advise / 114 次 "Stop.")证明纯 prompt 约束拦不住,必须代码强制。这是防死循环的第一道闸(§7)。

---

## 11. 配置项

| key | 默认 | 说明 |
|---|---|---|
| `advisor.enabled` | false | 总开关 |
| `advisor.model` | (强模型,fuzzy 名) | advisor 模型;fuzzy 解析到 available |
| `advisor.thinkingLevel` | medium | advisor 思考档 |
| `advisor.autoResume` | `concern` | idle 唤醒档:`off`/`blocker`/`concern`/`all` |
| `advisor.immuneTurns` | 2 | 打断后冷却窗口(concern/blocker 降级 nextTurn) |
| `advisor.syncBacklog` | 10 | 背压高水位;`off` = 不阻塞 |
| `advisor.catchupTimeoutMs` | 45000 | 背压超时 |

命令:`/advisor [on|off|status]`(`pi.registerCommand`)。

---

## 12. v1 范围与已知 gap

**v1 做**:§1 架构、§3 循环、§4 LCP+档 A、§5 常驻 cache、§6 投递、§7 唤醒三闸、§8 压缩、§9 滞回背压、§10 emission guard、§11 配置、②建议卡片进 tree。

**v1 暂缓(标注 gap)**:
- ③ `__advisor.jsonl` 观测/计费日志(advisor token 不单独归因、Hub 无只读 transcript)。
- 分叉恢复档 B(LCP 截断增量)——先 A 跑通再升级。
- 秘密混淆(喂 advisor 前 redact)。
- 评审 subagent 的 turn(v1 只评审主 agent)。

---

## 13. 文件结构(建议)

```
pi-advisor/
├── package.json            # deps: @earendil-works/pi-coding-agent 等
├── PLAN.md
└── src/
    ├── index.ts            # 入口:注册事件/命令/renderer,装配 AdvisorController
    ├── controller.ts       # AdvisorController:turn_end 观察、背压、生命周期、branch 事件
    ├── runner.ts           # 常驻 advisor 子 session 的创建/prompt/reset(参考 pi-subagents agent-runner)
    ├── align.ts            # fedEntryIds + LCP 对齐 + 分叉判定
    ├── compress.ts         # delta 压缩序列化(移植 session-history-format 思路)
    ├── deliver.ts          # severity → 通道 → sendMessage(移植 resolveAdvisorDeliveryChannel)
    ├── emission-guard.ts   # 去重/抑制/每评审 1 条(移植)
    ├── backlog.ts          # #pending / #drain / waitForCatchup 滞回
    ├── config.ts           # 读 settings
    ├── prompts/advisor-system.md
    └── ui/advisor-card.ts  # registerMessageRenderer("advisor", ...)
```

---

## 14. 分阶段实现步骤

**阶段 0 — 骨架**:extension 入口 + `advisor.enabled` + `/advisor` 命令 + 起一个常驻 advisor 子 session(固定 sessionId,只读工具,systemPromptOverride)。验证 `createAgentSession` 跑通。

**阶段 1 — 观察→评审→投递(happy path)**:`turn_end` observe → 全量 `getBranch()` 压缩(先不做增量)→ `session.prompt` → 解析 severity+note → `sendMessage` 注入。验证建议能出现在主对话。回路闸(过滤 advisor 自身消息)必须在此就位。

**阶段 2 — LCP 增量对齐 + 常驻 cache**:引入 `fedEntryIds` + LCP,纯前进走增量追加(cache 热);分叉走档 A 全量重放。接 `session_tree`/`session_start(fork|resume|new)` 事件触发 reset + abort 在途(epoch)。**这是 branch 兼容的核心里程碑。**

**阶段 3 — 投递矩阵 + 唤醒三闸**:severity → nextTurn/followUp/steer+triggerTurn;emission guard;immune 窗口;autoResumeSuppressed。`advisor.autoResume`/`immuneTurns` 配置。

**阶段 4 — 背压**:单飞 + 排队合并(不 abort)+ 滞回有界阻塞(high/low/timeout)+ 失败保护 + status 提示。

**阶段 5 — UI/打磨**:`registerMessageRenderer` advisor 卡片(severity 配色)、`/advisor status`(backlog/落后/模型/用量)、compress 的 thinking/diff/plan 约束保留细节。

**(后续)**:档 B 截断增量、`__advisor.jsonl`、秘密混淆、subagent 评审。

---

## 15. 测试建议(契约级)

- **align.ts**:LCP 三情况(纯前进/无变化/分叉);fork 后 entry id 稳定 → LCP 算出共享前缀;rewind 无事件也能靠 LCP 兜底判定分叉。
- **emission-guard**:content-free 抑制、跨评审 dedup、每评审 1 条、抑制对模型不可见(返回 Recorded.)。
- **deliver**:severity→通道映射;immune 窗口内 concern/blocker 降级 nextTurn;autoResumeSuppressed 降级;回路闸(advisor 自身注入不触发再评审)。
- **backlog**:合并多 pending 成一 batch;滞回(high 触发、low 放行、超时放行);连续失败丢 backlog。
- **branch 集成**:主 agent branch/fork/rewind 后,advisor 下次评审基于**当前分支**(不喂旧分支);在途评审被 abort 作废(epoch 不匹配丢弃)。
- 避免:源码 grep 式断言;断言内部字段;无语义的 not.toThrow。测行为/输出/状态迁移。

---

## 16. 关键代码引用

**pi(宿主 API)**:
- `createAgentSession` 选项/返回:`packages/coding-agent/src/core/sdk.ts:34,166,363`
- turn_end 被 await:`packages/agent/src/agent-loop.ts:218`;`packages/coding-agent/src/core/agent-session.ts:654,661`;`runner.ts:774-776`
- `sendCustomMessage` deliverAs 语义:`agent-session.ts:1339-1367`
- prompt cache = sessionId:`sdk.ts:349`;`packages/ai/src/api/openai-responses.ts:229`
- session tree/branch:`session-manager.ts:48(id),1177(getBranch),1277(branch),1322(createBranchedSession),1337(保留 id)`
- appendEntry 进 tree 的坑:`agent-session.ts:2265`(appendCustomEntry)
- 事件清单/ExtensionAPI:`docs/extensions.md`;`core/extensions/types.d.ts`

**oh-my-pi(行为蓝本)**:
- 通道解析/severity:`packages/coding-agent/src/advisor/advise-tool.ts:74,81,108`
- `#routeAdvice`/preserve/idle steer+triggerTurn:`session/agent-session.ts:2558,1960`
- immune/autoResumeSuppressed:`agent-session.ts:1538-1540,2225-2243`
- runtime 单飞/backlog/drain/waitForCatchup/reset:`advisor/runtime.ts`
- emission guard:`advisor/emission-guard.ts`
- 压缩序列化:`session/session-history-format.ts`
- transcript recorder(③,派生文件):`advisor/transcript-recorder.ts`

**参考扩展**:`@tintinweb/pi-subagents`(`/Users/wshao2/work/tries/pi-subagents`)——`src/agent-runner.ts`(createAgentSession 装配、session.subscribe、abort 转发)、`src/agent-manager.ts`(并发/队列)。

