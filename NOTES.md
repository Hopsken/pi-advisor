# Engineering notes & findings (v1 build, 2026-07)

Operational lessons from building v1 with sequenced sub-agent runs (glm-5p2) plus design findings not captured in PLAN/PRD. Read this before phase-2 work.

## 1. glm-5p2 sub-agent operations (important)

- **Failure mode: silent zero-output death.** glm-5p2 (fireworks) has a **16.4K max-output cap per response, shared between reasoning and content**. On design-heavy tasks it burns the whole budget in one giant reasoning pass and dies with `stopReason: "length"` before its first tool call → the agent run ends with "No output", no files, no commit, and no error surfaced. Happened 3× on issue #06 (async backpressure) and 1× on #10 (controller integration).
- **Diagnosis method**: run the sub-agent in background, then inspect the raw output file (path returned at spawn, `/tmp/pi-subagents-*/.../tasks/<id>.output`) — look for `"stopReason":"length"` with output ≈ 16384 and 100% `reasoning_content`.
- **What fixed it** (in effectiveness order):
  1. **Act-first protocol in the prompt**: "never reason more than ~10 sentences before a tool call; externalize design by writing skeleton code, not by thinking; build in test slices (2-3 cases → run → implement → run)". With this, even `thinking: xhigh` completed the two hardest issues (#10, #11, #12).
  2. Lowering `thinking` to `low` also worked (#06) but user preference + observed quality favor max thinking **plus** the act-first protocol.
- **Other prompt ingredients that mattered**: absolute paths everywhere (`cd` + `pwd` check — one run worked in the wrong dir), explicit `~/.bun/bin/bun` (PATH not inherited in sub-agent shells), "report commit hash and verify with `git log` before finishing" (catches no-op runs), "one commit, only files X may change" (kept diffs reviewable).
- **Quality**: with the protocol in place, glm-5p2 output was good — faithful blueprint ports, sensible documented deviations, honest reports. Every run still needs orchestrator verification (see §2).

## 2. Trust-but-verify catches: integration bugs unit tests can't see

- **Double-guard bug (fixed in `b0f7487`)**: #10's `controller.route()` called `guard.accept()`, but the production advise tool (#07) also calls `guard.accept()` before invoking route. Composition ⇒ second accept always returns `duplicate` ⇒ **every advice silently dropped in production**, while all 104 unit tests stayed green (the test seam's fake runner bypasses the tool). Lessons:
  - When two independently-tested modules share a stateful dependency (the guard), require a **composition regression test** in the assembly issue (now in #11's spec and test suite: real tool + real guard + real controller ⇒ exactly one sendMessage, second call ⇒ "Duplicate advice ignored.").
  - Sub-agent reports describe intent, not outcome; specifically re-review anything sitting on a seam boundary between issues.
- **Immune-window nuance (same commit)**: originally gated on `deliverAs === "steer" && triggerTurn`. Wrong: `triggerTurn` only governs *idle wake-up*; a steer delivered mid-run preempts regardless (e.g. blocker with `autoResume: "off"` while streaming). Window now starts on **any** steer delivery.

## 3. Implementation findings worth remembering (phase-2 inputs)

- **`streaming` is approximated as `false`** in `AdvisorController.delivery` (delivery happens from backlog review kicked by `turn_end`, i.e. usually idle-ish). A precise in-run signal (from `agent_start`/`agent_end`) would make `resolveDelivery`'s suppressed-but-streaming branch meaningful. Revisit in phase 2.
- **User-abort heuristic (v1)**: `turn_end` with assistant `stopReason === "aborted"` ⇒ `noteUserAbort()`, cleared on `agent_start`. Set *before* `handleTurnEnd` so the same turn's delivery already downgrades. This is the fuzziest port point (blueprint used a kernel interrupt label) — validate against real usage; PLAN §8 research task.
- **Severity → renderer threading**: `controller.route`'s facade call carries no severity in `details`; `src/index.ts` wraps the tool's route with a closure cell that the facade reads to attach `details: {severity}`. Works because route is the only sendMessage caller, but it's a smell — consider adding severity to the facade message type in phase 2.
- **bun text imports vs tsc**: `import x from "./f.md" with { type: "text" }` fails `tsc --noEmit` under `module: ES2022`. Chosen pattern: `readFileSync(join(dirname(fileURLToPath(import.meta.url)), ...))` — module-relative (survives foreign cwd), sync, no `md.d.ts`.
- **`isOverflowError`** (runner) is a message-pattern port of pi `packages/ai/src/utils/overflow.ts` with generic patterns (`too many tokens`, `token limit exceeded`) deliberately dropped to avoid rate-limit false positives. If providers change wording, overflow→reset stops firing and reviews just fail — watch for this in live use.
- **Smoke-test recipe** (offline, real session): faux provider via `@earendil-works/pi-ai/compat` `registerFauxProvider` (NOT the main export), `DefaultResourceLoader({ additionalExtensionPaths: [src/index.ts] })`, hermetic `PI_CODING_AGENT_DIR` + `HOME` temp dirs, `bindExtensions({})` without uiContext ⇒ `hasUI: false` — which doubles as the dormancy-guard fixture. Positive control: `PI_ADVISOR_FORCE=1` ⇒ model gets called.
- **Dormancy guard limitation**: activation requires `ctx.hasUI === true` or `PI_ADVISOR_FORCE=1`; headless `pi -p` therefore needs the env var. Better host-session detection is an open question (PLAN §2.4).

## 4. Process findings

- **Issue-file-driven pipeline worked well**: 12 sequenced specs in `issues/` with exact APIs, enumerated TDD cases, blueprint file:line pointers, and "only files X may change" ⇒ sub-agents needed no mid-run steering; every issue landed as one reviewable commit; the orchestrator only re-ran `bun test` + typecheck + spot-read the seams.
- **Spec precision pays twice**: the two bugs found (§2) were both in the *one* place the specs were ambiguous ("a steer that fires") or under-specified (guard ownership across #07/#10). Ambiguity in a spec becomes a coin-flip decision by the implementing agent.
- **Keep per-issue scope below the model's design horizon**: the issues that died were exactly the two with the most novel concurrent/stateful design. If an issue needs >1 architectural decision, either pre-decide it in the spec or split the issue.

## 5. Deferred (tracked in PLAN §13, restated for visibility)

extraTools + extension inheritance (minus-self via `extensionsOverride` + dormancy guard already in place); `/tree` divergence cache optimization (档 B); `__advisor.jsonl` observability/cost attribution; secret obfuscation of deltas; subagent-turn review; multi-advisor roster; overflow model-upgrade path.
