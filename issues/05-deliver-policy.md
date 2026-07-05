# #05 Delivery policy (severity → channel)

## Goal
Pure decision function mapping an accepted advice to a pi delivery mode. PLAN §7–§8; blueprint `~/tries/oh-my-pi/packages/coding-agent/src/advisor/advise-tool.ts:98-134` (`resolveAdvisorDeliveryChannel` + immune window).

## Scope — `src/deliver.ts`
```ts
interface DeliveryState {
  streaming: boolean;            // main agent mid-run at delivery time
  autoResumeSuppressed: boolean; // user manually interrupted; not yet cleared
  completedTurns: number;        // main-session completed turn counter
  immuneTurnStart: number | null;// set when a steer interrupt landed
}
interface DeliveryDecision {
  deliverAs: "nextTurn" | "followUp" | "steer";
  triggerTurn: boolean;
  downgraded: boolean;           // true when concern/blocker got demoted to nextTurn
}
resolveDelivery(severity: Severity, state: DeliveryState, config: AdvisorConfig): DeliveryDecision
```
Rules (in order):
1. `nit` → `{ nextTurn, triggerTurn:false, downgraded:false }` always.
2. immune window active (`immuneTurnStart !== null && completedTurns < immuneTurnStart + config.immuneTurns`) → concern/blocker downgrade to `nextTurn` (downgraded:true, triggerTurn:false).
3. `autoResumeSuppressed && !streaming` → downgrade to `nextTurn` (user stopped it; don't restart. Still delivered — "降级永不丢").
4. otherwise: `concern` → `followUp`, `blocker` → `steer`; `triggerTurn = autoResumeAllows(config.autoResume, severity)` where `off→never`, `blocker→blocker only`, `concern→concern+blocker`, `all→all` (nit still never triggers — rule 1 wins).
- Also export `autoResumeAllows(autoResume, severity): boolean` and `isImmune(state, config): boolean` for reuse/tests.

## TDD test cases (`src/deliver.test.ts`)
1. nit always nextTurn regardless of state/config.
2. blocker while streaming, clean state → steer + triggerTurn (autoResume=concern default).
3. concern idle, autoResume=concern → followUp + triggerTurn:true; autoResume=blocker → followUp + triggerTurn:false.
4. blocker with autoResume=off → steer + triggerTurn:false.
5. immune window: blocker with `immuneTurnStart=5, completedTurns=6, immuneTurns=2` → nextTurn downgraded; at `completedTurns=7` → steer again.
6. autoResumeSuppressed + idle → concern/blocker downgraded to nextTurn; suppressed but streaming → NOT downgraded (steer proceeds — matches blueprint gate `aborting||!streaming`).
7. `autoResumeAllows` truth table.

## Acceptance
`bun test` green; pure function, imports only types.
