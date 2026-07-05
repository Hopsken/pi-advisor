# #10 AdvisorController (integration core)

## Goal
The observe→align→compress→review→deliver loop that ties every prior module together. PLAN §4, §5, §7, §8, §10. This is the product's core milestone: after this issue the advisor works end-to-end against fakes.

## Scope — `src/controller.ts`
```ts
interface HostFacade {                    // narrow seam over pi ExtensionAPI/ctx (constructor-injected)
  getBranchEntries(): BranchEntry[];      // id + entry payload (message, customType?)
  sendMessage(msg: { customType: "advisor"; content: string; display: true;
                     deliverAs: "nextTurn"|"followUp"|"steer"; triggerTurn?: boolean }): void;
  setStatus(key: string, text: string | null): void;
  notify(text: string, level?: "info"|"warning"|"error"): void;
}
class AdvisorController {
  constructor(deps: { facade: HostFacade; runner: AdvisorRunner; guard: EmissionGuard;
                      backlog: BacklogQueue; config: AdvisorConfig })
  enable(): Promise<void>;      // late-enable: seed = full current-branch snapshot (PLAN §5)
  disable(): Promise<void>;
  handleTurnEnd(ev: { signal?: AbortSignal }): Promise<void>;  // hook body for pi "turn_end"
  handleSessionTree(): Promise<void>;     // hook body for "session_tree"
  handleSessionCompact(): Promise<void>;  // hook body for "session_compact"
  noteUserPrompt(): void;                 // clears autoResumeSuppressed (agent_start w/ user input)
  noteUserAbort(): void;                  // sets autoResumeSuppressed (best-effort detection, wired in #11)
  status(): { enabled: boolean; backlog: number; model?: string };
}
```
Behavior (all observable through facade/fakes):
1. **observe (handleTurnEnd)**: read branch → filter out `customType==="advisor"` entries (loop gate) → `planAlignment(fedIds, curIds)`:
   - advance → `compressEntries(newEntries)` → `backlog.push(delta)`; update fedIds.
   - divergence → reset flow: `backlog.bumpEpoch()`, `runner.reset()` (seed = compressed full branch), fedIds = current branch.
   - noop → nothing.
2. **route** (passed into advise tool / runner wiring): on accepted advice → `resolveDelivery(severity, deliveryState, config)` → `facade.sendMessage({customType:"advisor", content: formatted, deliverAs, triggerTurn})`; when decision is a steer that fires, record `immuneTurnStart = completedTurns`.
3. **delivery state**: track `completedTurns` (increment per handleTurnEnd), `streaming` approximation (in-turn vs idle: delivery happens during review; treat as streaming iff a turn_end arrived after review started — keep simple, document), `autoResumeSuppressed` via noteUserAbort/noteUserPrompt.
4. **backpressure**: after push, if `config.syncBacklog !== "off"` and `backlog.backlog ≥ high` → `setStatus("advisor", "catching up (N behind)…")`, `await backlog.waitForCatchup({high, low: ceil(high/2), timeoutMs, signal: ev.signal})`, clear status.
5. **session_tree / session_compact** → same divergence reset flow (LCP will confirm; force re-align check even without turn_end).
6. **enable() mid-session**: seeds runner with full-branch snapshot, sets fedIds; **disable()** disposes runner, bumps epoch, clears status.
7. Review failures: `onFailureGiveUp` → `facade.notify("advisor: giving up after repeated failures …", "warning")`, status cleared, advisor stays enabled.

## TDD test cases (`src/controller.test.ts`) — fake facade + fake runner whose `review` invokes the advise-route with scripted advice (tool-callback seam per PLAN §16)
1. happy path: turn_end → runner received compressed delta; scripted `concern` advice → sendMessage with `followUp`, `triggerTurn:true` (default autoResume).
2. loop gate: advisor's own injected message present in branch → not part of next delta (assert compressed payload excludes it) and does not trigger self-review churn (fedIds includes it silently — decide & document: advisor entries ARE recorded in fedIds but excluded from delta text).
3. divergence (branch ids change mid-history) → bumpEpoch + runner.reset with full-branch seed; subsequent advance works from new fedIds.
4. session_tree with changed branch → same as 3 without a turn_end.
5. session_compact → reset flow.
6. late enable(): seed contains compressed full branch; first turn_end after enable only feeds the increment.
7. backpressure: with high=2 and slow fake runner, 3rd turn_end sets status and blocks until drain; abort signal releases promptly; status cleared both paths.
8. immune window: scripted blocker steers once; next scripted blocker within `immuneTurns` → sendMessage with `nextTurn` (downgraded); after window → steer again.
9. autoResumeSuppressed: noteUserAbort() then idle blocker → nextTurn; noteUserPrompt() clears → steer restored.
10. give-up: 3 scripted review failures → notify called, status cleared, next turn_end still observes.

## Acceptance
`bun test` + typecheck green. This test file is the main behavioral contract of the product — keep it readable.
