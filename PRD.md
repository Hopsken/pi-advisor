# PRD: pi-advisor extension

> 状态:草稿 v2(已按本机 pi v0.80.3 / oh-my-pi 源码核对修订;issue tracker 未配置,先本地落地)。
> 设计依据见同目录 `PLAN.md`;行为蓝本为 oh-my-pi 内核 advisor,宿主为 pi coding agent。

## Problem Statement

我在用 pi 跑长会话 / 复杂任务时,主 agent 可能走偏、遗漏一个我没想到的角度、或引入一个当下不明显的问题(比如加了重试却没退避)。今天我只有两个选择:要么全程盯着它的每个 turn,要么等它做完才发现问题——这时代码可能已经错了好几轮。我需要一个「第二双眼睛」在旁边实时把关,而不是事后 code review。

## Solution

一个可随时开关的 **advisor**:一个**独立模型**旁听主 agent 的**每个 turn**,像结对编程的 navigator。它有专属的评审者系统 prompt,并继承项目的既定规范(AGENTS.md、skills)——但以「监督主 agent 遵守」的立场,而非自己执行。它发现问题时,通过结构化的 `advise` 工具以**分级建议**(nit / concern / blocker)注入对话——不重要的静静留作参考,值得处理的确保主 agent 会**主动响应**,严重的会在下一次 LLM 调用前**抢占**主 agent 的注意力(或在其空闲时唤醒它)。它能自己 `read`/`grep`/`find`/`ls` 核实代码;正常情况下不拖慢主 agent;成本因复用模型 prompt cache 而可控;并且在我 branch / fork / rewind 会话后,它仍能正确跟上**当前分支**,不会拿着旧分支的上下文乱评审。

## User Stories

1. 作为 pi 用户,我想用一个开关(`/advisor on|off` 或配置项)启停 advisor,以便只在需要第二意见时启用它;会话中途开启时它能以当前对话快照起步。
2. 作为 pi 用户,我想让 advisor 自动旁听主 agent 的**每一个 turn**,以便任何一步走偏都能被及时发现,而不是等任务结束。
3. 作为 pi 用户,我想让 advisor 用**独立于主 agent 的模型**(可配、通常是更强的 slow model),以便它带来主 agent 视角之外的判断。
4. 作为 pi 用户,我想让 advisor 有**专属的评审者系统 prompt**(navigator 角色、沉默纪律、证据要求),而不是复用主 agent 的行动者 prompt,以便它明确以顾问身份工作而非「又一个干活的 agent」。
5. 作为 pi 用户,我想让 advisor 知道我的项目规范(AGENTS.md)与 skills,并以「监督主 agent 遵守」的立场使用它们(而非把它们当作自己要执行的指令),以便它按我的既定规则评审、一发现主 agent 偏离规范就指出。
6. 作为 pi 用户,我想让 advisor 的建议**分三档 severity**(nit / concern / blocker),以便区分「仅供参考」「值得处理」「必须拦下」。
7. 作为 pi 用户,我想让 **nit** 级建议被动注入、绝不打扰,以便琐碎提示不干扰我和主 agent 的节奏。
8. 作为 pi 用户,我想让 **concern** 级建议在主 agent 忙完当前任务后被**主动处理并回应一次**,以便重要意见不被晾着。
9. 作为 pi 用户,我想让 **blocker** 级建议在主 agent 当前 turn 的工具执行结束后、**下一次 LLM 调用前抢占式送达**(不打断进行中的生成或工具执行——那是危险的),或在其空闲时唤醒它,以便严重问题在造成更多错误前被拦下。
10. 作为 pi 用户,我想让 advisor 的建议在主 agent **已经停下来(idle)** 时也能按 severity 唤醒它去处理(concern/blocker),以便「做完了但其实有问题」这个最该把关的时刻不被漏掉。
11. 作为 pi 用户,我想通过 `autoResume` 配置 idle 唤醒的激进度(`off` / `blocker` / `concern` / `all`),以便按我的口味在「及时」和「安静」之间取舍。
12. 作为 pi 用户,我想让 advisor **绝不陷入死循环**(建议→唤醒→再评审→再建议),以便它永远不会和主 agent 自己没完没了地互相触发。
13. 作为 pi 用户,我想让 advisor **不刷屏**:重复的、无意义的建议(如 "Stop." "LGTM.")被自动抑制,每次评审至多一条,同一条建议只有在严重度升级时才允许重发,以便我只看到真正有价值的意见。
14. 作为 pi 用户,我想让 advisor 能自己 `read`/`grep`/`find`/`ls` 读代码,以便它的建议基于实际文件而非只看到的对话摘要。
15. 作为 pi 用户,我想让 advisor **默认只读**(工具授权层面不含写/执行),并由 prompt 约束其观察者纪律,以便它默认是安全的旁观者;后续版本可由我显式扩权(如 web/MCP 工具)。
16. 作为 pi 用户,我想让 advisor 的建议以独立、带 severity 配色的卡片呈现在对话里,以便一眼区分它和主 agent 的输出。
17. 作为 pi 用户,我想让 advisor 建议作为对话的一部分随会话保存,以便我 branch / fork 后这些建议跟着对应的分支走。
18. 作为 pi 用户,我从某个历史节点 **branch / fork / rewind** 会话后,想让 advisor 立刻跟上**当前分支**,以便它不会拿着被放弃分支的上下文给出错误建议。
19. 作为 pi 用户,我在 `/tree` 切换分支时想让 advisor **正在进行、针对旧分支的评审被作废**,以便旧分支的建议不会串到新分支里。
20. 作为 pi 用户,我想让 advisor 的运行成本可控(靠复用模型 prompt cache),以便长会话下它不会让费用随对话长度爆炸。
21. 作为 pi 用户,我想让 advisor 在**正常情况下不拖慢主 agent**,以便它是无感的后台旁听者。
22. 作为 pi 用户,我想让 advisor 只在**明显落后很多个 turn**时才短暂让主 agent 等它追上(有上限、有提示),以便它既不永久落后、也不频繁卡住我。
23. 作为 pi 用户,当 advisor 暂时阻塞主 agent 以追赶时,我想看到状态提示(如「advisor catching up (N behind)」),并且我按 Esc 中止时阻塞**立即放行**,以便我永远不会被 advisor 卡死。
24. 作为 pi 用户,我想让 advisor 落后时把积压的多个 turn **合并成一次评审**(基于当前最新全貌),以便它追上时给的是针对现状的建议,而不是逐个补过时的旧 turn。
25. 作为 pi 用户,我想让 advisor 看到主 agent 的 thinking、代码 diff、以及 plan/goal 约束,以便它理解主 agent 的意图与受到的限制。
26. 作为 pi 用户,我**不**想让 advisor 收到全部工具输出正文(如整段文件内容、命令输出),以便它的上下文精简、成本低、cache 友好。
27. 作为 pi 用户,我想用 `/advisor status` 查看 advisor 的模型、落后 turn 数、以及用量,以便了解它的运行状况。
28. 作为 pi 用户,当我**主动打断**主 agent 后,我不想让 advisor 又把它自动拉起来跑,以便打断意味着控制权真正回到我手里。
29. 作为 pi 用户,我想让 advisor 的建议即使这次不唤醒主 agent,也**必然被注入上下文、下个 turn 被读到**,以便「不唤醒」不等于「石沉大海」。
30. 作为 pi 用户,我想让 advisor 一次抢占后有一个「冷却窗口」,窗口内后续 concern/blocker 降级为不打扰(但仍传达),以便避免连环打断。
31. 作为 pi 用户,我想配置背压阈值与超时(`syncBacklog` / `catchupTimeoutMs`),以便按我的模型速度调节。
32. 作为 pi 用户,我想让 advisor 出错(如模型连续失败)或自身上下文写满时不拖垮主 agent——它会放弃积压/重置自身并提示,以便主 agent 不被永久卡住。
33. 作为 pi 用户,当其他扩展(如 subagent 扩展)创建子会话时,我**不**想让 advisor 在那些子会话里再各起一个 advisor,以便不出现嵌套评审和成本爆炸。
34. 作为 pi extension 开发者,我想让 advisor 的模型、思考档、知识面(skills/AGENTS.md)都可配置,以便按项目调整。
35. 作为 pi extension 开发者,我想让 advisor 的接入尽量集中在一个「观察→评审→投递」控制器上,以便行为可测、边界清晰。

## Implementation Decisions

**架构(方案 B)**:advisor 是一个 **in-process 的独立 agent session**,通过宿主 SDK 的 `createAgentSession` 起一个子会话:只读内建工具 allowlist(`read`/`grep`/`find`/`ls`——宿主无 `glob`,对应 `find`),外加一个自定义 **`advise(note, severity)` 工具**(宿主支持 `customTools`)。系统 prompt 走资源加载器的**独立 `systemPrompt` 入参**(该入参存在;旧草稿「必须走 override」的说法已修正)。不采用子进程 spawn,也不采用无工具的一次性补全调用。此路线经成熟扩展 `@tintinweb/pi-subagents` 验证。

**advisor 的角色与知识面**:
- 系统 prompt **完全独立**,移植 oh-my-pi 的 advisor system.md(navigator 角色、severity 评级标准、沉默纪律、「只引用亲自查证的证据」、「不对 intent/process 提建议」)+ advise 工具协议。
- **继承项目知识但换立场**:AGENTS.md 与 skills 清单随子会话系统 prompt 注入(宿主会在自定义 prompt 后自动 append),但 advisor prompt 用重构叙述框定其立场——「这些是**驱动 agent** 的约束与剧本,你负责监督遵守/核对执行,而非自己执行」(移植 oh-my-pi context-files.md 的措辞)。与蓝本的刻意分歧:oh-my-pi 不给 advisor skills,我们默认给(清单紧凑、cache 前缀只付费一次、advisor 可按需 `read` SKILL.md 核对主 agent 是否遵守),可配置关闭。
- **工具面两层控制**(对齐 oh-my-pi):代码控**授权**(v1 固定只读内建集),prompt 控**用法**(观察者纪律、每次 advise 2–3 次工具调用)。「只读」是默认姿态而非硬不变量——扩权(extension/MCP 工具,如 web 访问)由用户显式配置,**延后到下一阶段**(见 Out of Scope)。

**评审输出 = advise 工具,不解析文本**:severity 结构化、「沉默 = 不调用工具」语义干净,且噪音抑制只有在工具返回值层才能对模型不可见(被抑制仍返回「已记录」,防止换措辞绕过)。这是对旧草稿「解析 advisor 输出」的修正,与蓝本一致。

**观察循环(全新)**:宿主的 `turn_end` 事件是唯一的观察入口——advisor 在此读取当前分支、计算增量、触发评审。宿主本身不提供「旁听主 agent」的现成机制,这层被动逐 turn 观察是本扩展新增的。

**三层持久化(必须分清)**:
- ① advisor 的累积评审上下文 → 活在子会话自己的会话管理器里(内存、**固定会话 id**),不进主对话树。
- ② advisor 的建议卡片 → 作为自定义消息注入主对话,进入主对话树,随 branch/fork 自动携带。
- ③ 独立观测/计费日志(对标 `__advisor.jsonl`)→ 范围外。注意:宿主的「追加自定义 entry」API 会写进主对话树并随 fork 复制,不适合做独立日志。

**生命周期与分支对齐(核心事实已修正)**:宿主在 `/fork`、`/new`、`/resume` 时**销毁并重建 extension 实例**。因此:
- fork/resume 的「跟上当前分支」由实例重建天然保证:新实例从零开始,首次观察即用当前分支全量快照重放(cache 冷一次)。**全量重放不是权宜,是结构性必然**。
- 需要主动对齐的只有**同实例存续期内**改变活跃路径的两种操作:`/tree` 导航与 compaction。此处用 entry-id **最长公共前缀 (LCP)** 判定:advisor 维护「已喂 entry id 序列」,与当前分支序列比对——纯前进则增量追加(cache 热),分叉则重置重放并**作废在途评审**。判定是纯数据比对,不依赖事件;事件(`session_tree`/`session_compact`)只负责及时触发。
- 中途开启(`/advisor on`)同样以当前分支快照 seed。
- 后续优化(范围外):`/tree` 场景下截断到共享前缀、只喂增量的 cache 优化。

**常驻会话 + prompt cache + overflow**:子会话常驻、会话 id 固定(宿主 prompt cache key 即会话 id),每 turn 纯追加增量、绝不回改前文。禁用子会话自动压缩;**子会话上下文写满时重置并以当前分支快照重放**(旧草稿未覆盖此路径,属 crash bug)。

**投递矩阵(severity → 交付通道,语义已修正)**:宿主的 `steer` 不会中断进行中的生成——它在**当前 turn 的工具执行结束后、下一次 LLM 调用前**注入;`triggerTurn` 仅对 steer/followUp 生效,用于 idle 唤醒。映射:

```
nit      → nextTurn                                    // 传达,不唤醒
concern  → followUp + triggerTurn(autoResume ≥ concern) // 忙完主动回应;idle 按配置唤醒
blocker  → steer   + triggerTurn(autoResume ≥ blocker)  // 下次 LLM 调用前抢占;idle 唤醒
```
(旧草稿 concern 漏了 triggerTurn,会导致 idle 时的 concern 石沉大海。)

**唤醒逻辑(默认唤醒 + 三闸防循环 + 降级永不丢)**:concern/blocker 默认倾向唤醒;三层降级——且**降级降到 nextTurn(仍传达、下个 turn 必被读),不是丢弃**:
1. emission guard 去重(advise 工具 handler 内拦截重复/无意义 note;同一 note 仅 severity 升级时放行重发)——最强的一道。
2. immune 冷却窗口(一次抢占后 N 个 turn 内后续 concern/blocker 降级 nextTurn)。
3. 用户主动打断抑制(用户停后降级;下次用户 prompt 清除)。**已知移植风险**:蓝本靠内核打断标记判定「用户主动打断」,extension 侧需从可观察状态推断,判据需实测选定。
必须有**回路闸**:观察时跳过 advisor 自身注入的消息(`customType === "advisor"`),不计入增量;主 agent 对建议的响应 turn 照常评审(防循环靠闸+去重+限额+冷却的组合,与蓝本一致)。

**背压(滞回有界阻塞,阻塞为 safety valve)**:宿主 `turn_end` handler 被主 agent await(串行、**无超时机制**),故可在其中有界 `await` 阻塞主 agent 下一个 turn。机制:单飞评审;在途时新 turn 排队合并(不 abort、不丢 turn);滞回双水位——backlog ≥ high(默认 10)触发阻塞,降到 low(high/2)或超时(默认 45s)放行;阻塞时挂状态提示,并 **race 用户 abort 信号(`ctx.signal`)立即放行**;`syncBacklog=off` 则从不阻塞;abort 仅发生在重置边界;连续失败 3 次放弃积压并提示。合并使 advisor 追上时看到当前最新全貌,故大阈值安全。

**防递归(v1 必做)**:两个方向——① 自己的子会话不加载任何 extension(`noExtensions`),自递归结构性不可能;② 其他扩展(如 pi-subagents)会把本 extension 绑进**它们的**子会话 → 需 dormancy guard:激活前判定「是否宿主主会话」,判定不了则不激活(判据阶段 0 实测选定)。

**配置(机制已修正)**:宿主 settings **不支持** extension 自定义 key。按官方惯例用自有配置文件:项目级 `<cwd>/.pi/advisor.json`(受 project trust 门控)+ 全局 `<agentDir>/advisor.json`。键:`enabled`(默认 false)、`model`(fuzzy)、`thinkingLevel`、`autoResume`(off/blocker/concern/all,默认 concern)、`immuneTurns`(默认 2)、`syncBacklog`(默认 10,off=不阻塞)、`catchupTimeoutMs`(默认 45000)、`skills`(默认 true)、`contextFiles`(默认 true)。命令 `/advisor [on|off|status]`。建议卡片经宿主「消息渲染器注册」自定义呈现。

## Testing Decisions

**什么是好测试**:只断言**外部可观察行为**(注入了什么建议、以什么交付模式、什么时机;背压是否阻塞/放行;分支切换后喂给 advisor 的是否为当前分支),不断言内部字段赋值、私有方法调用或实现细节。禁止源码 grep 式断言与无语义的 `not.toThrow`。

**主 seam(单一、最高)**:`AdvisorController` × 注入的门面——受控的宿主扩展 API 门面 + fake advisor 子会话。fake 的 `prompt()` 不真跑 LLM,而是**按预设调用 advise 工具 handler**(评审结论经工具回调而非返回文本——与实现一致)。从该 seam 驱动 `turn_end` / `session_tree` / `session_compact` 事件,断言对「发送自定义消息」的调用(customType / deliverAs / triggerTurn / 时机)与背压行为。

**被测模块**:
- 主:`AdvisorController`(观察→评审→投递→背压→重对齐)经上述 seam 做集成测试。
- 补充(纯函数、更低 seam):LCP 对齐、emission guard(含 severity 升级放行)、压缩序列化、severity→通道映射、背压滞回。

**关键契约用例**:
- severity 映射与降级(immune 窗口内降级 nextTurn;用户打断后降级;concern/blocker 的 triggerTurn 随 autoResume;回路闸使 advisor 自身注入不进增量)。
- 背压:多积压 turn 合并为一次评审;滞回触发/放行/超时;**用户 abort 立即放行**;连续失败放弃积压。
- 生命周期集成:`/tree` 后基于当前分支评审、在途评审作废;fork/resume 后(新实例)首次观察即全量快照;compaction 后重放;中途开启 seed;dormancy guard(被绑进他人子会话时不激活)。

**Prior art**:参考 `@tintinweb/pi-subagents` 的 `test/agent-runner-e2e.test.ts`、`test/helpers/print-mode-runner.ts`(faux provider 驱动受控 agent 会话并断言可观察输出;vitest)。

## Out of Scope

- **`extraTools` 扩权与 extension 继承**(给 advisor 加 web/MCP 等 extension 工具、`extensions: "inherit"` 滤自身加载)——有明确价值(为评审提供更多上下文),但复杂度高(工具授权面、双实例副作用、递归过滤),对验证产品目标非关键,**延后到下一阶段**。届时读性由「默认授权 + prompt 纪律」维持,不做硬不变量。
- 独立的 `__advisor.jsonl` 观测/计费日志(层③)——advisor token 不单独归因、无独立只读 transcript。
- `/tree` 分叉恢复的增量优化(截断到共享前缀,cache 保热)——先全量重放跑通。
- 喂给 advisor 前的秘密混淆(蓝本有 `obfuscateAdvisorDelta`)。
- 评审 subagent 的 turn(v1 只评审主 agent;防递归 guard 反而要确保不被动挂进 subagent)。
- 多 advisor / 角色花名册(oh-my-pi 的 WATCHDOG.yml)。
- 子会话 overflow 时升级更大模型 / re-prime(v1 只做重置重放)。

## Further Notes

- 行为蓝本为 oh-my-pi 内核 advisor,参考实现为成熟扩展 `@tintinweb/pi-subagents`;所有关键 API 结论已按本机源码(pi v0.80.3,与安装版本一致)逐条核对,引用见 `PLAN.md` §17。
- 成本可控性依赖 provider 的 prompt cache 行为(cache key 即会话 id);provider 不支持、cache 冷(fork/resume/重置后必然发生一次)时成本上升——这是设计的已知边界。
- 背压阻塞借助「宿主串行 await 各扩展 turn_end handler、且无超时机制」这一事实实现;副作用是阻塞会连带拖住同一 turn_end 的其他扩展 handler,故超时需有上界(≤45s)且触发罕见,并必须响应用户 abort。
- 「用户主动打断」的判定是 extension 侧最不确定的移植点(蓝本用内核标记),列为阶段 3 research task。
- 发布前置:本仓库尚无 issue tracker / triage label vocabulary 配置;发布到真实 tracker 需先提供仓库与 label(或运行相应 setup)。
