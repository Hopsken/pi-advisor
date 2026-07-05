pi-advisor extension 设计方案 (PLAN)

一个 pi coding agent 的 extension,复刻 oh-my-pi 的 advisor 能力:一个**独立模型**旁听主 agent 的**每个 turn**,评审后把建议注入主对话(像结对编程的 navigator)。

- 参考实现:oh-my-pi(`~/tries/oh-my-pi`,`packages/coding-agent/src/advisor/`)——内核级 advisor,是本方案的行为蓝本。
- 宿主平台:pi coding agent(`~/tries/pi`,与本机安装版本一致 **v0.80.3**),oh-my-pi 即 fork 自它,架构同源。
- 关键约束:只能用 pi extension 暴露的 hook/API(不能改内核),把 advisor 的内部机制**映射到 extension 原语**。

> 本文档为中间过程产物,正文中文,代码/标识符英文。所有关键结论均已核对本机 pi / oh-my-pi 源码(v0.80.3),标注 `文件:行`。

---

## 0. 术语

- **主 agent**:用户直接对话的 pi agent(宿主会话)。
- **advisor 子 session**:extension 用 `createAgentSession` 起的独立评审 agent(child session)。
- **turn**:主 agent 的一次 LLM 采样 + 其工具执行(`turn_end` 事件的粒度)。
- **delta**:主 branch 自 advisor 上次消费点以来的增量(压缩后喂给 advisor)。
- **severity**:advisor 建议的三档 `nit | concern | blocker`。
- **extension 实例生命周期(关键事实)**:`/fork`、`/new`、`/resume` 会 `session_shutdown` → **销毁并重建 extension 实例** → 新实例收到 `session_start {reason}`(pi `docs/extensions.md` 生命周期图)。只有 `/tree` 导航(`session_tree`)和 compaction 发生在**同一实例存续期内**。这决定了 §5 的对齐设计。

---

## 1. 架构总览(已锁定:方案 B)

**in-process `createAgentSession`**,不用 subprocess、不用轻量 `complete()`。这是成熟扩展 `@tintinweb/pi-subagents` 验证过的路线(`src/agent-runner.ts:572-608`)。

```ts
import {
  createAgentSession, DefaultResourceLoader,
  SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";

const { session } = await createAgentSession({
  cwd, agentDir,
  modelRegistry: ctx.modelRegistry,
  model,                                    // 独立模型(见 §12 配置)
  tools: ["read", "grep", "find", "ls"],    // 只读内建工具 allowlist(pi 无 "glob",对应 "find")
  customTools: [adviseTool],                // advise(note, severity) 自定义工具(§4/§11)
  sessionManager: SessionManager.inMemory(cwd),  // 常驻、固定 sessionId → prompt cache(§6)
  settingsManager: SettingsManager.create(cwd, agentDir),
  resourceLoader: new DefaultResourceLoader({
    cwd, agentDir,
    systemPrompt: buildAdvisorSystemPrompt(),   // 独立入参存在(见下),skills/AGENTS.md 会自动 append
    noExtensions: true,                     // v1 不给子 session 载 extension(§2.3)
    noPromptTemplates: true, noThemes: true,
    // noSkills / noContextFiles 保持 false:知识面继承(§2.2)
  }),
  thinkingLevel,
});
// v1 不调用 session.bindExtensions()(noExtensions 下无可绑定项,天然无递归)
session.subscribe(onAdvisorEvent);          // message_end(usage) / tool_execution_* 等
// 评审:await session.prompt(compressedDelta) —— advise 工具在 prompt 执行期间被调用并路由(§4)
```

关键事实(pi 源码,均已本机核对):
- `CreateAgentSessionOptions`(`core/sdk.ts:34-84`):`tools` 是**字符串名 allowlist**;**`customTools: ToolDefinition[]` 存在**(:71)——advise 工具走这里;`sessionManager` restore 已有 messages;返回 `{ session, extensionsResult, modelFallbackMessage }`。
- **系统 prompt 有独立入参**:`DefaultResourceLoaderOptions.systemPrompt`(`core/resource-loader.ts:140`)。旧版 PLAN「必须走 systemPromptOverride」的说法**有误**。走 `systemPrompt`(= `buildSystemPrompt` 的 `customPrompt` 分支)的好处:`<project_context>`(AGENTS.md)与 skills 清单会**自动 append 在其后**(`core/system-prompt.ts:53-74`,skills 需 `read` 在 allowlist 内——满足)。
- prompt cache key = `sessionManager.getSessionId()`(`sdk.ts:313` → provider `prompt_cache_key`,`packages/ai/src/api/openai-responses.ts:229`)。
- `SessionManager.inMemory(cwd)` 存在(`session-manager.ts:1467`)。
- 子 session 的 abort 转发、subscribe 清理、dispose 兜底:照抄 pi-subagents 的 finally 模式。

**与 pi-subagents 的本质差异(不能照抄)**:它是按需、工具触发的任务 agent;advisor 是**被动、逐 turn 观察者**。pi-subagents **从不 hook 主 agent 的 `turn_end`**——那层观察循环是本 extension 全新的。

---

## 2. advisor 的 prompt、知识面与工具面

### 2.1 系统 prompt:完全独立,不复用主 agent prompt(对齐 oh-my-pi)

oh-my-pi 的 advisor 用专属 `prompts/advisor/system.md`(navigator 角色、advise 协议、severity 评级标准、沉默纪律、「只引用亲自查证的证据」、「不许对 intent/process 提建议」),组装为 `system.md + context 重构叙述 + 共享指令`(oh-my-pi `agent-session.ts:2408-2411`)。**v1 直接移植该 system.md 为基底**(battle-tested),加上 advise 工具协议说明。

### 2.2 知识面:继承 AGENTS.md 与 skills,但必须「换立场」

- oh-my-pi 把同样的 AGENTS.md 内容用**评审者立场**模板包装(`prompts/advisor/context-files.md`):「这些是驱动 agent 必须遵守的用户既定指令——**监督它遵守、一走偏就指出;绝不建议违背这些文件**」。直接 append pi 默认的 `<project_context>` 框架(「你要遵守的项目指南」)立场是错的(把 advisor 当 actor)。
- **v1 实现(务实路线)**:保留 loader 的自动 append(`noSkills`/`noContextFiles` 均为 false),在 advisor system prompt 里放一段**重构叙述 preamble**(移植 context-files.md 措辞):「下方 `<project_context>` 与 skills 清单是**驱动 agent** 的约束与剧本;你的职责是监督其遵守/核对其执行,而非自己执行」。后续可升级为自渲染模板(完全对齐 oh-my-pi)。
- **与蓝本的刻意分歧**:oh-my-pi **不给** advisor skills。我们默认给(`advisor.skills: true`)——skills 清单紧凑(名字+描述+路径)、进 cache 前缀只付费一次,且 advisor 有 `read` 可按需打开 SKILL.md 核对主 agent 是否遵守 skill 工作流。可配置关闭。

### 2.3 工具面:两层控制——代码控**授权**,prompt 控**用法**(对齐 oh-my-pi)

- oh-my-pi:默认授权只读子集;`WATCHDOG.yml tools:` 可授**任意内建工具**含 edit/bash(「the advisor is a full agent」,`advisor/config.ts:12-18`);prompt 约束「仅在核实确需时才碰(已授权的)mutating 工具」。advisor **不获得任何 MCP/extension 工具**(仅 `BUILTIN_TOOLS`)。
- **v1**:固定只读内建集 `read/grep/find/ls`,读性由授权保证。prompt 同时写明观察者纪律(「只为收集上下文/核实而用工具,每次 advise 2–3 次调用」)。
- **deferred(下一阶段,见 §13)**:`advisor.extraTools`(显式追加工具名,含 extension/MCP 工具——web 访问、docs 查询等对评审确有价值)与 `advisor.extensions: "inherit"`(经 `extensionsOverride` 滤掉自身,`resource-loader.ts:143`)。读性届时由「默认授权 + prompt 纪律」维持,不做硬不变量——advisor 通常是强模型,遵循指令可靠;扩权是用户显式行为。

### 2.4 防递归 guard(v1 必做)

- **自身子 session**:`noExtensions: true` + 不 `bindExtensions` → 我们自己的 child 里根本不会加载本 extension,自递归在 v1 结构性不可能。
- **他人的子 session(真实泄漏面)**:pi-subagents 等扩展对**它们的** child 调 `bindExtensions`,会把本 extension 载进去 → 每个 subagent 各带一个 advisor。v1 必须有 dormancy guard:本 extension 激活前判定「我是否在宿主主会话中」。候选手段(阶段 0 实测后选定):检查 `session_start` 事件形态 / `ctx.hasUI` 启发式 / 子会话 sessionId 约定。判定不了则宁可不激活(enabled 默认 false 也兜底)。

---

## 3. 三层持久化模型(必须分清)

| 层 | 是什么 | pi 落点 | 是否进主 tree / 随 branch |
|---|---|---|---|
| **① advisor 累积上下文** | 喂给子 session 的评审历史(cache 靠它) | 子 session 自己的 `SessionManager`(内存,固定 sessionId) | 不进主 tree;/tree 分叉时 reset+重放(§5) |
| **② 建议卡片** | 注入主对话的 advisory | `pi.sendMessage({customType:"advisor"})` → 主 tree 的 message | 进 tree,随 branch/fork 自动走 |
| **③ 观测/计费日志** | oh-my-pi 的 `__advisor.jsonl` | 自写派生文件(**非** `appendEntry`) | 不进 tree,跟随 session file。**v1 暂缓** |

**坑**:`pi.appendEntry` 写的 CustomEntry **进主 tree 并随 fork 复制**(`agent-session.ts` appendCustomEntry → `session-manager.ts:1104` `_appendEntry`)。要复刻 `__advisor.jsonl` 那种独立日志,**不能用 appendEntry**,须像 oh-my-pi `AdvisorTranscriptRecorder` 自己写派生文件。v1 不做(见 §13)。

---

## 4. 核心循环(advise 工具版)

```
主 agent turn_end
  → observe(ctx):                 // 同步、快
      curBranch = ctx.sessionManager.getBranch()   // 带稳定 id
      LCP 对齐(§5)→ 算出增量 delta or 需 reset
      compress(delta)(§9)→ push #pending, backlog++
      kick #drain()(不 await)
  → 若 backlog ≥ high 阈值:await waitForCatchup(...)   // 有界背压(§10),race ctx.signal

#drain()(异步、单飞 #busy):
  while pending:
    splice(0) 合并所有积压 delta → 一个 batch
    await advisorSession.prompt(batch)
      // 评审结论不靠解析文本输出:advisor 模型在 prompt 执行期间调用
      // advise(note, severity) 自定义工具(customTools 注入,schema 同 oh-my-pi
      // advise-tool.ts:16-19)。工具 handler 内:
      //   emissionGuard.accept(note, severity)(§11)
      //     → 通过:route(§7)注入主对话,工具返回 "Recorded."
      //     → 拦截:工具返回 "Recorded."(去重则 "Duplicate advice ignored.")
      //   —— 抑制对模型不可见,防止换措辞绕过(load-bearing)
    backlog -= coveredTurns;唤醒 catchup 等待者
```

**为什么必须是工具而不是解析输出**:① severity 结构化、无解析歧义;② 「沉默」有干净语义(不调用工具即沉默);③ emission guard 的「抑制不可见」性质只有在工具返回值层才能忠实实现;④ 与蓝本一致。pi 的 `customTools`(`sdk.ts:71`)使其可行。

**回路闸(必做)**:`observe` 里必须**跳过 advisor 自己注入的消息**(`customType === "advisor"`),不计入 delta。等同 oh-my-pi `runtime.ts:169` 的 filter。主 agent 对建议的**响应 turn 照常评审**(蓝本同);防循环靠「闸 + guard 去重 + 每评审一条 + immune 窗口」的组合(§8)。

---

## 5. 生命周期与上下文对齐:entry-id LCP

**地基**(pi `session-manager.ts`):每个 `SessionEntry` 有稳定 `id`/`parentId`;`getBranch()` 返回当前活跃路径(:1177);`branch()` 同文件改叶、id 稳定(:1277);`createBranchedSession()`(fork)保留 entry id(:1322)。

**生命周期修正(重要,推翻旧版叙述)**:fork/new/resume 会**重建 extension 实例**(§0)。因此:
- **fork/resume 不需要「对齐」**:新实例 `fedEntryIds = []`,首个 `turn_end` 自然走全量快照重放。**档 A 不是「较简单的选项」,而是结构性必然**;cache 在 fork/resume 后必冷,档 B 对此永远无能为力。
- **LCP 机制的真正用武之地是 `/tree` 导航(`session_tree` 事件)**——唯一在实例存续期内改变活跃路径的操作;也只有这里存在「作废在途评审」问题。
- **主会话 compaction**(`/compact` 或自动)同样在实例存续期内改写活跃路径:hook `session_compact` 触发重对齐(LCP 会判定分叉 → 全量重放一次,接受 cache 冷)。旧版遗漏了此场景。

**状态**:`fedEntryIds: string[]` = 已喂给 advisor 的主 branch entry id 序列。

**每次 observe / `session_tree` / `session_compact` 后**:
```
curIds = getBranch().map(e => e.id)
k = longestCommonPrefixLen(fedEntryIds, curIds)
```

| 情况 | 条件 | 处理 |
|---|---|---|
| 纯前进 | `k === fed.length && cur.length > k` | 压缩 `branch[k:]` → 追加(cache 全热) |
| 无变化 | `k === fed.length === cur.length` | no-op |
| 分叉 | `k < fed.length` | advisor 上下文 `[k:]` 属旧分支,回退(见下) |

**为何鲁棒**:纯 id 比对,不靠事件。即使漏接事件,下个 turn_end 的 LCP 也会发现 `k < fed.length` 自动触发回退。事件(`session_tree`/`session_compact`)只负责**及时触发**重对齐 + abort 在途评审(epoch 作废)。

**分叉恢复(先 A 后 B)**:
- **档 A(v1)**:dispose advisor session → 新 sessionId → 用当前整条 `getBranch()` 压缩快照重放。cache 冷一次,简单鲁棒。= oh-my-pi 的 `reset()`。
- **档 B(后续,仅优化 `/tree` 场景)**:保持同 advisor sessionId,截断到共享前缀第 k 段重放。需维护「delta ↔ entryId 边界」映射。

**late-enable(v1 必做)**:`/advisor on` 在会话中途开启时,同样走「当前分支压缩快照」作为 seed(= oh-my-pi `seedTo()`)。

---

## 6. 常驻子 session + prompt cache + overflow

- **常驻**:一个 advisor 子 session,**固定 sessionId**。prompt cache key = sessionId,常驻 → key 稳定 → 命中;用完即弃 → cache 冷,成本随对话线性爆炸。
- 每 turn **纯追加** delta(`.prompt()`),绝不回改前文 → 前缀稳定 → cache 热。
- **膨胀/overflow(v1 必须处理,旧版为 crash path)**:禁用 advisor 子 session 的 auto-compaction;当子 session 上下文溢出(provider 报错或逼近窗口)→ **reset + 当前分支压缩快照重放**(同档 A 路径)。oh-my-pi 的做法是升级更大模型或 re-prime(`agent-session.ts:2758-2825`),v1 只做 reset 版。
- 已知边界:cache 行为随 provider 而异;fork/resume 后必冷一次(§5)。

---

## 7. 投递矩阵(severity → deliverAs)

**pi 真实语义(已修正)**:`Agent.steer()` = 「排队,**在当前 assistant turn 的工具执行结束后、下一次 LLM 调用前**注入」(`packages/agent/src/agent.ts:274`)——**不是中断进行中的生成**。没有任何 deliverAs 会 abort 在途采样(这也是想要的行为:中断进行中的工具执行是危险的)。`triggerTurn: true` 仅对 `steer`/`followUp` 生效:idle 时立即起新 turn(`docs/extensions.md` sendMessage)。

| deliverAs | streaming 中 | idle(带 triggerTurn:true) |
|---|---|---|
| `nextTurn` | 挂进下个 turn context,不触发 | 同左(triggerTurn 被忽略) |
| `followUp` | 当前 agent run 全部收尾后送达、主 agent 主动回应 | 立即起新 turn |
| `steer` | 当前 turn 工具跑完后、下次 LLM 调用前**抢占式**送达 | 立即起新 turn |

**映射**(采纳 oh-my-pi「传达 vs 唤醒分离」哲学):

- **nit → `{deliverAs:"nextTurn"}`**:传达,不唤醒(= aside)。
- **concern → `{deliverAs:"followUp", triggerTurn: autoResume≥concern}`**:streaming 时主 agent 忙完主动回应一次;idle 时是否唤醒由 `advisor.autoResume` 决定(**旧版漏了 triggerTurn,idle 的 concern 会石沉大海**)。
- **blocker → `{deliverAs:"steer", triggerTurn: autoResume≥blocker}`**:streaming 下一个 LLM 调用前抢占;idle 唤醒。

参考 oh-my-pi `resolveAdvisorDeliveryChannel`(`advise-tool.ts:109-134`):
```
if (!interrupting(severity))                       return "aside";    // nit
if (autoResumeSuppressed && (aborting||!streaming)) return "preserve"; // 用户刚停/idle
if (interruptImmuneTurnActive)                     return "aside";    // 冷却窗口降级
return "steer";
```

---

## 8. 唤醒逻辑(默认唤醒 + 三闸防循环 + 降级永不丢)

**核心原则**:advisor 的意义必须被**传达并处理**,但避免死循环。所有通道都保证建议进入主 agent 可见上下文(传达),区别只在要不要主动起 turn(唤醒)。

**默认倾向唤醒**(concern/blocker),三层降级——**降级是降到 `nextTurn`(仍传达、下个 turn 必被读到),不是丢弃**:

1. **emission guard 去重(第一道、最强)**:advise 工具 handler 里 `accept()` 不过则不路由(§11)。防死循环的根。
2. **immune 窗口**:一次 steer 打断后记 `immuneTurnStart`,`immuneTurns` 个 turn 内后续 concern/blocker **降级 nextTurn**。参考 oh-my-pi `advise-tool.ts:98-102`(`completedTurns < start + N`)。
3. **autoResumeSuppressed(用户主动停时)**:用户按停后 idle/aborting 状态降级 `nextTurn`(不替用户把 agent 拉起来);下一次用户 prompt 时清除(oh-my-pi 在 `agent-session.ts:8414` 置位、`:7334` 清除)。**移植风险(阶段 3 research task)**:oh-my-pi 靠内核 interrupt label 判定「用户主动打断」;extension 侧需从可观察状态推断(如 agent run 的 abort 形态、`agent_end` 事件),无法保证完全等价,需实测选定判据。

**配置** `advisor.autoResume`:默认 `concern`(concern+blocker 唤醒);可选 `blocker`/`off`/`all`(不推荐)。

---

## 9. 上下文压缩(喂给 advisor 的 delta 格式)

移植 oh-my-pi `session-history-format.ts` 的精简序列化思路:
- **丢弃**:工具结果正文(read 文件内容、bash/grep 输出)→ 只留 `→ read(path) ⇒ ok · N lines` 一行 + 行数;工具参数截断到 ~120 字符。
- **保留**:user/assistant 正文、assistant thinking(`includeThinking`)、edit/apply_patch 的 unified diff(`expandEditDiffs`)、plan-mode 约束逐字(`expandPrimaryContext`,重复折叠成 `(unchanged — still in effect)`,oh-my-pi `runtime.ts:192-198`)。
- 秘密混淆:v1 不做(§13;oh-my-pi 有 `obfuscateAdvisorDelta`)。

目的:advisor 看懂主 agent 在干什么、改了什么、受什么约束,但不吞下全部字节(纯追加友好 → cache 热)。

---

## 10. 背压(滞回有界阻塞,阻塞是 safety valve)

**原则**:尽量不阻塞,只在明显 delay 才兜底。advisor 用 slow model,慢是常态,故阈值要大。

**地基**:pi extension 的 `turn_end` handler 被主 agent **await**(`agent-loop.ts:164` `await emit(turn_end)`;`extensions/runner.ts:776` 串行 await handlers;**无 handler 超时机制**)→ 在 handler 里 `await` 能阻塞主 agent 下一个 turn。

**机制**:
1. **单飞**:同时只一个评审(`#busy`)。
2. **排队合并,不 abort**:在途时新 turn → push `#pending`、backlog++,**不打断**;跑完 `splice(0)` 合并成一个 batch(经 LCP)。不丢任何 turn。合并让 advisor 一次追多个 turn,且看到的是**最新全貌**(故大阈值安全,建议不过时)。
3. **滞回双水位有界阻塞**:
   - 触发:backlog ≥ **high**(默认 `advisor.syncBacklog = 10`)
   - 放行:backlog ≤ **low = high/2**(或超时),避免阈值边缘抖动
   - 超时:默认 **45s**(slow model 友好;oh-my-pi 内核默认 30s)
   - **race `ctx.signal`(v1 必做,旧版遗漏)**:`turn_end` 期间 `ctx.signal` 有值;用户 Esc/abort 必须立即放行阻塞,否则用户被卡死在我们 handler 里。
   - 阻塞时 `ctx.ui.setStatus("advisor", "catching up (N behind)…")`,避免静默 hang
   - `advisor.syncBacklog = off` → 从不阻塞(尽力式)
4. **abort 只在 reset 边界**(§5 的 `/tree`、compaction、overflow),正常背压**绝不** abort。
5. **失败保护**:连续失败 3 次丢 backlog + 通知(oh-my-pi `runtime.ts:314-320` 同为 3),防主 agent 被 catchup 永久卡死。

**extension 特有顾虑**:runner 串行 await handlers → 阻塞会连带拖住同 turn_end 的其他 extension handler,故超时不宜过长(≤45s)且罕见触发。

---

## 11. Emission guard(噪音控制,load-bearing)

移植 oh-my-pi `emission-guard.ts`,**实现位置在 advise 工具 handler 内**(§4)——纯逻辑,不依赖内核:
- 归一化 note(lowercase、NFKC、非字母数字折叠为空格);抑制 content-free 短语(`Stop.` `Done.` `LGTM.` `No issue; continue.` …)。
- 跨评审 dedup 已见 note(FIFO 淘汰,容量 4096);**同一 note 仅在 severity 升级(nit→concern→blocker)时放行重发**(蓝本行为,旧版遗漏)。
- 每次评审(`beginUpdate()`)至多放行 **1** 条;被抑制的调用不消耗预算。
- 抑制对 advisor 模型**不可见**:工具照常返回 `Recorded.`(去重返回 `Duplicate advice ignored.`),避免它换个说法绕过去。

历史依据:oh-my-pi issue #3520(单会话 309 次 advise / 114 次 "Stop.")证明纯 prompt 约束拦不住,必须代码强制。这是防死循环的第一道闸(§8)。

---

## 12. 配置项

**机制修正(旧版有误)**:pi 的 `SettingsManager` **不支持** extension 自定义 key,extension 没有读宿主 settings 任意键的 API。按官方惯例用**自有配置文件**(`docs/extensions.md:920-938`):项目级 `join(ctx.cwd, CONFIG_DIR_NAME, "advisor.json")`(受 project trust 门控)+ 全局 `<agentDir>/advisor.json`,项目覆盖全局。`/advisor` 命令改运行时状态,可选持久化回文件。

| key | 默认 | 说明 |
|---|---|---|
| `enabled` | false | 总开关 |
| `model` | (强模型,fuzzy 名) | advisor 模型;fuzzy 解析到 available |
| `thinkingLevel` | medium | advisor 思考档 |
| `autoResume` | `concern` | idle 唤醒档:`off`/`blocker`/`concern`/`all` |
| `immuneTurns` | 2 | 打断后冷却窗口(concern/blocker 降级 nextTurn) |
| `syncBacklog` | 10 | 背压高水位;`off` = 不阻塞 |
| `catchupTimeoutMs` | 45000 | 背压超时 |
| `skills` | true | 知识面:skills 清单注入(§2.2) |
| `contextFiles` | true | 知识面:AGENTS.md 注入(§2.2) |

**deferred(下一阶段)**:`extraTools`(显式追加工具授权,含 extension/MCP 工具)、`extensions`(`"none"`/`"inherit"`,inherit = 发现集減自身)、`excludeExtensions`。见 §2.3。

命令:`/advisor [on|off|status]`(`pi.registerCommand`)。

---

## 13. v1 范围与 deferred

**v1 做**:§1 架构、§2.1-2.2 prompt/知识面、§2.4 防递归 guard、§4 advise 工具循环 + 回路闸、§5 LCP+档 A+compaction+late-enable、§6 常驻 cache+overflow reset、§7 投递、§8 唤醒三闸、§9 压缩、§10 滞回背压(含 ctx.signal race)、§11 emission guard、§12 配置文件、②建议卡片进 tree + renderer。

**deferred(下一阶段,标注 gap)**:
- **`advisor.extraTools` + extension 继承(§2.3)**——对验证产品目标非关键,且涉及 extensionsOverride 滤自身、工具授权面、双实例副作用等复杂度;v1 固定只读内建集。
- ③ `__advisor.jsonl` 观测/计费日志(advisor token 不单独归因)。
- 分叉恢复档 B(仅优化 `/tree` 场景的 cache)。
- 秘密混淆(oh-my-pi `obfuscateAdvisorDelta`)。
- 评审 subagent 的 turn(v1 只评审主 agent;dormancy guard 反而要防止被动挂进 subagent)。
- 多 advisor / WATCHDOG.yml 花名册。
- overflow 时升级更大模型 / re-prime(v1 只做 reset)。

---

## 14. 文件结构(建议)

```
pi-advisor/
├── package.json            # peerDeps: @earendil-works/pi-coding-agent(参照 pi-subagents)
├── PLAN.md / PRD.md
└── src/
    ├── index.ts            # 入口:注册事件/命令/renderer,装配 AdvisorController;dormancy guard
    ├── controller.ts       # AdvisorController:turn_end 观察、背压、生命周期、session_tree/compact
    ├── runner.ts           # 常驻 advisor 子 session 的创建/prompt/reset/overflow(参考 pi-subagents agent-runner)
    ├── advise-tool.ts      # advise(note, severity) ToolDefinition;handler 内接 guard + deliver
    ├── align.ts            # fedEntryIds + LCP 对齐 + 分叉判定
    ├── compress.ts         # delta 压缩序列化(移植 session-history-format 思路)
    ├── deliver.ts          # severity → 通道 → sendMessage(移植 resolveAdvisorDeliveryChannel)
    ├── emission-guard.ts   # 去重/抑制/升级放行/每评审 1 条(移植)
    ├── backlog.ts          # #pending / #drain / waitForCatchup 滞回(race signal)
    ├── config.ts           # 读 .pi/advisor.json + <agentDir>/advisor.json
    ├── prompts/
    │   ├── advisor-system.md    # 移植 oh-my-pi prompts/advisor/system.md + advise 协议
    │   └── context-reframe.md   # 知识面重构叙述 preamble(移植 context-files.md 措辞)
    └── ui/advisor-card.ts  # registerMessageRenderer("advisor", ...)
```

---

## 15. 分阶段实现步骤

**阶段 0 — 骨架**:extension 入口 + 配置文件读取 + `/advisor` 命令 + 起一个常驻 advisor 子 session(固定 sessionId,只读工具,`systemPrompt` 入参,advise customTool 注册)。**实测并选定 dormancy guard 判据**(§2.4)。验证 `createAgentSession` 跑通、advise 工具可被子模型调用。

**阶段 1 — 观察→评审→投递(happy path)**:`turn_end` observe → 全量 `getBranch()` 压缩(先不做增量)→ `session.prompt` → advise 工具 handler → `sendMessage` 注入。验证建议出现在主对话。回路闸(过滤 `customType==="advisor"`)必须在此就位。

**阶段 2 — LCP 增量对齐 + 常驻 cache**:引入 `fedEntryIds` + LCP,纯前进走增量追加(cache 热);分叉走档 A 全量重放。接 `session_tree` + `session_compact` 触发 reset + abort 在途(epoch)。late-enable seed。overflow → reset。**这是 branch 兼容的核心里程碑。**(fork/resume 无需处理:实例重建天然全量重放,写集成测试确认即可。)

**阶段 3 — 投递矩阵 + 唤醒三闸**:severity → nextTurn/followUp/steer(含 triggerTurn 按 autoResume);emission guard(含升级放行);immune 窗口;autoResumeSuppressed(**research task**:extension 侧判定「用户主动打断」的可行判据,§8)。

**阶段 4 — 背压**:单飞 + 排队合并(不 abort)+ 滞回有界阻塞(high/low/timeout + race ctx.signal)+ 失败保护 + status 提示。

**阶段 5 — UI/打磨**:advisor 卡片(severity 配色)、`/advisor status`(backlog/落后/模型/用量,用量来自子 session `message_end` usage)、compress 的 thinking/diff/plan 约束保留细节、知识面 preamble 打磨。

**(后续)**:extraTools + extension 继承、档 B、`__advisor.jsonl`、秘密混淆、subagent 评审。

---

## 16. 测试建议(契约级)

**主 seam(单一、最高)**:`AdvisorController` × 注入的门面——受控的宿主扩展 API 门面 + fake advisor 子 session。fake 的 `prompt()` 不真跑 LLM,而是**按预设调用 advise 工具 handler**(工具版 seam:评审结论经工具回调而非返回文本)。从该 seam 驱动 `turn_end` / `session_tree` / `session_compact` 事件,断言对 `sendMessage` 的调用(customType/deliverAs/triggerTurn/时机)与背压行为。

**用例**:
- **align.ts**:LCP 三情况;`/tree` 后基于当前分支;rewind 无事件也靠 LCP 兜底;compaction 触发重放。
- **emission-guard**:content-free 抑制、跨评审 dedup、severity 升级放行、每评审 1 条、抑制返回 `Recorded.`。
- **deliver**:severity→通道映射(含 concern/blocker 的 triggerTurn 随 autoResume);immune 窗口降级;autoResumeSuppressed 降级;回路闸(advisor 自身注入不进 delta)。
- **backlog**:合并多 pending 成一 batch;滞回(high 触发、low 放行、超时放行);**ctx.signal abort 立即放行**;连续 3 次失败丢 backlog。
- **lifecycle 集成**:fork/resume 后(新实例)首个 turn_end 走全量重放;在途评审被 epoch 作废;dormancy guard(被 bind 进他人 child 时不激活)。
- 避免:源码 grep 式断言;断言内部字段;无语义的 not.toThrow。测行为/输出/状态迁移。

**Prior art**:pi-subagents `test/agent-runner-e2e.test.ts` / `test/helpers/print-mode-runner.ts`(faux provider 驱动受控 agent session,`PI_E2E_LIVE` 切真模型;vitest;dedup `@earendil-works/pi-ai` 保证共享 provider registry)。

---

## 17. 关键代码引用(已按本机 v0.80.3 核对)

**pi(宿主 API,`~/tries/pi`)**:
- `createAgentSession` 选项/返回:`packages/coding-agent/src/core/sdk.ts:34-94`(`tools`:68、`customTools`:71、`excludeTools`:69)
- `DefaultResourceLoaderOptions`:`core/resource-loader.ts:125-160`(`systemPrompt`:140、`extensionsOverride`:143、`noExtensions`:135)
- systemPrompt 后自动 append context/skills:`core/system-prompt.ts:53-74`
- turn_end 被 await、handlers 串行、无超时:`packages/agent/src/agent-loop.ts:164`;`core/extensions/runner.ts:776`
- `steer()`/`followUp()` 真实语义(turn 边界注入,非中断):`packages/agent/src/agent.ts:274-281`
- `sendMessage` deliverAs/triggerTurn:`docs/extensions.md`(sendMessage 节);`core/agent-session.ts:1337-1367`
- prompt cache = sessionId:`sdk.ts:313`;`packages/ai/src/api/openai-responses.ts:229`
- session tree/branch:`core/session-manager.ts:1177(getBranch),1277(branch),1322(fork 保留 id),1467(inMemory)`
- appendEntry 进 tree 的坑:`session-manager.ts:1104`
- extension 生命周期(fork/new/resume 重建实例)、事件清单、配置文件惯例(CONFIG_DIR_NAME):`docs/extensions.md:270-340,920-938`
- 内建工具名(read/bash/edit/write/grep/find/ls,无 glob):`core/tools/`

**oh-my-pi(行为蓝本,`~/tries/oh-my-pi`,`packages/coding-agent/src/`)**:
- advise 工具 schema/返回值:`advisor/advise-tool.ts:16-19,201-208`
- 通道解析/immune:`advisor/advise-tool.ts:98-102,109-134`
- `#routeAdvice`/idle steer+triggerTurn:`session/agent-session.ts:2594-2631`
- advisor session 组装(system prompt 组合、`-advisor` sessionId、promptCacheKey):`session/agent-session.ts:2404-2453,2560-2562`
- advisor 工具面(builtin-only、config 可授 mutating):`advisor/config.ts:12-18`;`sdk.ts:2660-2700`
- 知识面重构叙述:`prompts/advisor/context-files.md`;`sdk.ts:2689-2692`
- autoResumeSuppressed 置位/清除:`agent-session.ts:8414,7334,2291`
- runtime 单飞/backlog/drain/失败保护(3 次):`advisor/runtime.ts:155-179,314-320`
- emission guard:`advisor/emission-guard.ts`
- 压缩序列化:`session/session-history-format.ts:230-358`
- overflow 升级/re-prime:`agent-session.ts:2758-2825`
- transcript recorder(③,派生文件):`advisor/transcript-recorder.ts`

**参考扩展**:`@tintinweb/pi-subagents`(`~/tries/pi-subagents`)——`src/agent-runner.ts:572-608`(createAgentSession 装配、subscribe、abort 转发、finally 清理)、`src/agent-manager.ts`(并发/队列)、`test/`(faux provider 测试基建)。
