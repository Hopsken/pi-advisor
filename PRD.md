
# PRD: pi-advisor extension

> 状态:草稿(issue tracker 未配置,先本地落地)。triage label 目标:`ready-for-agent`(待发布)。
> 设计依据见同目录 `PLAN.md`;行为蓝本为 oh-my-pi 内核 advisor,宿主为 pi coding agent。

## Problem Statement

我在用 pi 跑长会话 / 复杂任务时,主 agent 可能走偏、遗漏一个我没想到的角度、或引入一个当下不明显的问题(比如加了重试却没退避)。今天我只有两个选择:要么全程盯着它的每个 turn,要么等它做完才发现问题——这时代码可能已经错了好几轮。我需要一个「第二双眼睛」在旁边实时把关,而不是事后 code review。

## Solution

一个可随时开关的 **advisor**:一个**独立模型**旁听主 agent 的**每个 turn**,像结对编程的 navigator。它发现问题时,以**分级建议**(nit / concern / blocker)注入对话——不重要的静静留作参考,值得处理的确保主 agent 会**主动响应**,严重的会**打断**主 agent。它能自己 `read`/`grep`/`glob` 核实代码;正常情况下不拖慢主 agent;成本因复用模型 prompt cache 而可控;并且在我从历史节点 branch / fork / rewind 会话后,它仍能正确跟上**当前分支**,不会拿着旧分支的上下文乱评审。

## User Stories

1. 作为 pi 用户,我想用一个开关(`/advisor on|off` 或设置项)启停 advisor,以便只在需要第二意见时启用它。
2. 作为 pi 用户,我想让 advisor 自动旁听主 agent 的**每一个 turn**,以便任何一步走偏都能被及时发现,而不是等任务结束。
3. 作为 pi 用户,我想让 advisor 用**独立于主 agent 的模型**(可配、通常是更强的 slow model),以便它带来主 agent 视角之外的判断。
4. 作为 pi 用户,我想让 advisor 的建议**分三档 severity**(nit / concern / blocker),以便区分「仅供参考」「值得处理」「必须拦下」。
5. 作为 pi 用户,我想让 **nit** 级建议被动注入、绝不打断,以便琐碎提示不干扰我和主 agent 的节奏。
6. 作为 pi 用户,我想让 **concern** 级建议在主 agent 忙完当前 turn 后被**主动处理并回应一次**,以便重要意见不被晾着。
7. 作为 pi 用户,我想让 **blocker** 级建议**打断**主 agent(或在其空闲时唤醒它),以便严重问题在造成更多错误前被拦下。
8. 作为 pi 用户,我想让 advisor 的建议在主 agent **已经停下来(idle)** 时也能按 severity 唤醒它去处理(concern/blocker),以便「做完了但其实有问题」这个最该把关的时刻不被漏掉。
9. 作为 pi 用户,我想通过 `advisor.autoResume` 配置 idle 唤醒的激进度(`off` / `blocker` / `concern` / `all`),以便按我的口味在「及时」和「安静」之间取舍。
10. 作为 pi 用户,我想让 advisor **绝不陷入死循环**(建议→唤醒→再评审→再建议),以便它永远不会和主 agent 自己没完没了地互相触发。
11. 作为 pi 用户,我想让 advisor **不刷屏**:重复的、无意义的建议(如 "Stop." "LGTM.")被自动抑制,每次评审至多一条,以便我只看到真正有价值的意见。
12. 作为 pi 用户,我想让 advisor 能自己 `read`/`grep`/`glob` 读代码,以便它的建议基于实际文件而非只看到的对话摘要。
13. 作为 pi 用户,我想让 advisor **不能**改文件 / 跑命令(只读工具),以便它是安全的观察者,不会擅自动我的代码。
14. 作为 pi 用户,我想在 advisor 建议以独立、带 severity 配色的卡片呈现在对话里,以便一眼区分它和主 agent 的输出。
15. 作为 pi 用户,我想让 advisor 建议作为对话的一部分随会话保存,以便我 branch / fork 后这些建议跟着对应的分支走。
16. 作为 pi 用户,我从某个历史节点 **branch / fork / rewind** 会话后,想让 advisor 立刻跟上**当前分支**,以便它不会拿着被放弃分支的上下文给出错误建议。
17. 作为 pi 用户,我在 branch 时想让 advisor **正在进行、针对旧分支的评审被作废**,以便旧分支的建议不会串到新分支里。
18. 作为 pi 用户,我想让 advisor 的运行成本可控(靠复用模型 prompt cache),以便长会话下它不会让费用随对话长度爆炸。
19. 作为 pi 用户,我想让 advisor 在**正常情况下不拖慢主 agent**,以便它是无感的后台旁听者。
20. 作为 pi 用户,我想让 advisor 只在**明显落后很多个 turn**时才短暂让主 agent 等它追上(有上限、有提示),以便它既不永久落后、也不频繁卡住我。
21. 作为 pi 用户,当 advisor 被暂时阻塞主 agent 以追赶时,我想看到状态提示(如「advisor catching up (N behind)」),以便我知道主 agent 不是卡死了。
22. 作为 pi 用户,我想让 advisor 落后时把积压的多个 turn **合并成一次评审**(基于当前最新全貌),以便它追上时给的是针对现状的建议,而不是逐个补过时的旧 turn。
23. 作为 pi 用户,我想让 advisor 看到主 agent 的 thinking、代码 diff、以及 plan/goal 约束,以便它理解主 agent 的意图与受到的限制。
24. 作为 pi 用户,我**不**想让 advisor 收到全部工具输出正文(如整段文件内容、命令输出),以便它的上下文精简、成本低、cache 友好。
25. 作为 pi 用户,我想用 `/advisor status` 查看 advisor 的模型、落后 turn 数、以及用量,以便了解它的运行状况。
26. 作为 pi 用户,当我**主动打断**主 agent 后,我不想让 advisor 又把它自动拉起来跑,以便打断意味着控制权真正回到我手里。
27. 作为 pi 用户,我想让 advisor 的建议即使这次不唤醒主 agent,也**必然被注入上下文、下个 turn 被读到**,以便「不唤醒」不等于「石沉大海」。
28. 作为 pi 用户,我想让 advisor 一次打断后有一个「冷却窗口」,窗口内后续 concern/blocker 降级为不打断(但仍传达),以便避免连环打断。
29. 作为 pi 用户,我想配置背压阈值与超时(`advisor.syncBacklog` / `catchupTimeoutMs`),以便按我的模型速度调节。
30. 作为 pi 用户,我想让 advisor 出错(如模型连续失败)时不拖垮主 agent——它会放弃积压并提示,以便主 agent 不被永久卡住。
31. 作为 pi extension 开发者,我想让 advisor 的模型、思考档、只读工具集都可配置,以便按项目调整。
32. 作为 pi extension 开发者,我想让 advisor 的接入尽量集中在一个「观察→评审→投递」控制器上,以便行为可测、边界清晰。

## Implementation Decisions

**架构(方案 B)**:advisor 是一个 **in-process 的独立 agent session**,通过宿主提供的「创建 agent 会话」能力起一个只读工具(`read`/`grep`/`glob`)的子会话,系统 prompt 通过资源加载器的「系统 prompt 覆盖」入口注入(该能力无独立系统 prompt 参数)。不采用子进程 spawn,也不采用无工具的一次性补全调用。此路线经成熟扩展 `@tintinweb/pi-subagents` 验证。

**观察循环(全新)**:宿主的 `turn_end` 事件是唯一的观察入口——advisor 在此读取当前分支、计算增量、触发评审。宿主本身不提供「旁听主 agent」的现成机制(成熟扩展都是按需触发的任务 agent),这层被动逐 turn 观察是本扩展新增的。

**三层持久化(必须分清)**:
- ① advisor 的累积评审上下文 → 活在 advisor 子会话自己的会话管理器里(内存、**固定会话 id**),不进主对话树。
- ② advisor 的建议卡片 → 作为自定义消息注入主对话,进入主对话树,随 branch/fork 自动携带。
- ③ 独立观测/计费日志(对标 oh-my-pi 的 `__advisor.jsonl`)→ **本 PRD 范围外**(见 Out of Scope)。注意:宿主的「追加自定义 entry」API 会写进主对话树并随 fork 复制,因此不适合做独立日志。

**上下文对齐(兼容 branch 的核心)**:主对话每个 entry 有稳定 id,且 branch(同文件改叶)、rewind、fork(新文件)三种形态下 entry id 均保留。advisor 维护「已喂给它的 entry id 序列」,每次观察时与当前分支的 entry id 序列求**最长公共前缀 (LCP)**,据此判定:

```
k = LCP(fedEntryIds, currentBranchIds)
- k === fed.length && cur.length > k  → 纯前进:压缩 branch[k:] 追加(cache 全热)
- k === fed.length === cur.length     → 无变化:跳过
- k < fed.length                      → 分叉:advisor 上下文 [k:] 属旧分支,需回退
```
(此判定逻辑为设计推演的精确编码,非最终代码。)判定不依赖事件,是纯数据比对,因此对漏接的事件或 rewind 天然兜底。分支/切换事件仅用于**及时触发**重对齐并作废在途评审。

**分叉恢复(先 A 后 B)**:v1 采用**全量重放**(新会话 id + 用当前整条分支的压缩快照重放,cache 冷一次,简单鲁棒);后续优化为**截断到共享前缀**(保持同一会话 id、只喂分叉后增量,前缀 cache 仍命中)。

**常驻会话 + prompt cache**:advisor 子会话常驻、会话 id 固定(宿主的 prompt cache key 即会话 id),每 turn **纯追加**增量、绝不回改前文,以最大化 provider 前缀 cache 命中。v1 禁用 advisor 子会话的自动压缩(compaction 会使 cache 失效一次)。

**投递矩阵(severity → 交付通道)**:宿主自定义消息的交付模式在主 agent streaming 时才区分,idle 时靠「触发新 turn」标志。映射(编码了 oh-my-pi「传达与唤醒分离」的决策):

```
nit      → nextTurn                     // 传达,不唤醒
concern  → followUp                     // streaming: 主 agent 忙完主动回应一次
blocker  → steer + triggerTurn:true     // streaming 打断 / idle 唤醒
```

**唤醒逻辑(默认唤醒 + 三闸防循环 + 降级永不丢)**:concern/blocker 默认倾向唤醒;三层降级——且**降级降到 nextTurn(仍传达、下个 turn 必被读),不是丢弃**:
1. emission guard 去重(route 前拦截重复/无意义 note,源头防循环)——最强的一道。
2. immune 冷却窗口(一次打断后 N 个 turn 内后续 concern/blocker 降级 nextTurn)。
3. 用户主动打断抑制(用户停后 idle/aborting 时降级;用户自己驱动的 resume 允许 live 投递)。
必须有**回路闸**:观察时跳过 advisor 自身注入的消息 / 由 advisor 触发的响应 turn,不计入增量、不重新评审。

**背压(滞回有界阻塞,阻塞为 safety valve)**:宿主 `turn_end` handler 被主 agent await(且宿主串行 await 各 handler),故可在其中有界 `await` 阻塞主 agent 下一个 turn。机制:单飞评审;在途时新 turn 排队合并(**不 abort**,不丢 turn);滞回双水位——backlog ≥ high(默认 10)触发阻塞,降到 low(high/2)或超时(默认 45s)放行,阻塞时挂状态提示;`syncBacklog=off` 则从不阻塞;abort 仅发生在 branch/reset 边界;连续失败 N 次放弃积压并提示。合并使 advisor 追上时看到当前最新全貌,故大阈值安全。

**噪音控制(emission guard,load-bearing)**:归一化 note、抑制无意义短语、跨评审 dedup、每次评审至多一条;抑制对 advisor 模型不可见(仍回报「已记录」),避免它换措辞绕过。历史依据:纯 prompt 约束无法拦住刷屏,必须代码强制。

**上下文压缩**:喂给 advisor 的增量丢弃工具结果正文、截断工具参数;保留 user/assistant 正文、assistant thinking、编辑 diff、plan 约束(逐字,含重复折叠)。

**配置项**:`advisor.enabled`、`advisor.model`(fuzzy)、`advisor.thinkingLevel`、`advisor.autoResume`(off/blocker/concern/all,默认 concern)、`advisor.immuneTurns`(默认 2)、`advisor.syncBacklog`(默认 10,off=不阻塞)、`advisor.catchupTimeoutMs`(默认 45000)。命令 `/advisor [on|off|status]`。建议卡片经宿主的「消息渲染器注册」自定义呈现。

## Testing Decisions

**什么是好测试**:只断言**外部可观察行为**(注入了什么建议、以什么交付模式、什么时机;背压是否阻塞/放行;branch 后喂给 advisor 的是否为当前分支),不断言内部字段赋值、私有方法调用或实现细节。禁止源码 grep 式断言与无语义的 `not.toThrow`。

**主 seam(单一、最高)**:`AdvisorController` × 注入的门面——受控的宿主扩展 API 门面 + fake advisor agent 会话(`prompt()` 返回预设评审文本,不真跑 LLM)。从该 seam 驱动 `turn_end` / `session_tree` / `session_start(fork|resume)` 事件,断言对「发送自定义消息」的调用与背压行为。这是「扩展对宿主可观察行为」的最高接缝,一个 seam 覆盖绝大多数特性。

**被测模块**:
- 主:`AdvisorController`(观察→评审→投递→背压→branch 重对齐)经上述 seam 做集成测试。
- 补充(纯函数、更低 seam,仅在主 seam 难充分覆盖分支时):LCP 对齐(三情况 + fork 后 id 稳定 + rewind 无事件兜底)、emission guard、压缩序列化、severity→通道映射、背压滞回。

**关键契约用例**:
- severity 映射与降级(immune 窗口内 concern/blocker 降级 nextTurn;用户打断后降级;回路闸使 advisor 自身注入不触发再评审)。
- 背压:多个积压 turn 合并为一次评审;滞回触发/放行/超时;连续失败放弃积压。
- branch 集成:branch/fork/rewind 后 advisor 基于当前分支评审(不喂旧分支);在途评审被作废。

**Prior art**:参考 `@tintinweb/pi-subagents` 的 `test/agent-runner-e2e.test.ts`、`test/print-mode-runner.ts`(如何在测试中驱动受控 agent 会话并断言其可观察输出)。

## Out of Scope

- 独立的 `__advisor.jsonl` 观测/计费日志(层③)——v1 不做,导致 advisor token 不单独归因、无独立只读 transcript。
- 分叉恢复的档 B(截断到共享前缀、只喂增量的 cache 优化)——先用档 A 全量重放跑通。
- 喂给 advisor 前的秘密混淆(secret redaction)。
- 评审 subagent 的 turn(v1 只评审主 agent)。
- 多 advisor / 角色花名册(oh-my-pi 的 WATCHDOG.yml)。

## Further Notes

- 行为蓝本为 oh-my-pi 内核 advisor,参考实现为成熟扩展 `@tintinweb/pi-subagents`;两者路径均已核对(详见 `PLAN.md` §16 代码引用)。
- 成本可控性依赖 provider 的 prompt cache 行为(cache key 即会话 id);provider 不支持或 cache 冷时,成本可能上升——这是设计的已知边界。
- 背压阻塞借助「宿主串行 await 各扩展 turn_end handler」这一事实实现;副作用是阻塞会连带拖住同一 turn_end 的其他扩展 handler,故超时需有上界且触发罕见。
- 发布前置:本仓库尚无 issue tracker / triage label vocabulary 配置;发布到真实 tracker 需先提供仓库与 label(或运行相应 setup)。

