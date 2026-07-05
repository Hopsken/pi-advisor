# #06 Backlog & backpressure

## Goal
Single-flight review drain with merge-on-catchup, hysteresis bounded blocking, abort responsiveness, and failure protection. PLAN §10; blueprint `~/tries/oh-my-pi/packages/coding-agent/src/advisor/runtime.ts:155-179,314-320`.

## Scope — `src/backlog.ts`
```ts
interface BacklogOptions {
  review: (batch: string[], epoch: number) => Promise<void>; // injected; runs advisor prompt
  onStatus?: (s: { backlog: number; blocked: boolean }) => void;
  onFailureGiveUp?: (err: unknown) => void;
}
class BacklogQueue {
  push(delta: string): void;                 // enqueue + kick drain (never awaits review)
  get backlog(): number;                     // pending + in-flight count (in turns pushed)
  bumpEpoch(): number;                       // invalidate in-flight review (reset boundary)
  waitForCatchup(opts: { high: number; low: number; timeoutMs: number; signal?: AbortSignal }): Promise<void>;
  idle(): Promise<void>;                     // for tests: resolves when drain loop parked
}
```
Behavior:
1. **Single-flight**: only one `review()` in flight; new pushes queue up.
2. **Merge**: when a review finishes and N deltas are pending, next call gets ALL of them (`splice(0)`) as one batch. Never abort an in-flight review because of new pushes.
3. **Epoch**: each `review` gets the epoch at batch start; `bumpEpoch()` clears pending AND makes results of stale epochs ignored (their completion must not decrement backlog below 0 / must not double-fire status). Caller (controller) aborts the actual session separately.
4. **waitForCatchup**: resolves immediately if `backlog < high`; otherwise blocks until `backlog ≤ low` OR `timeoutMs` elapses OR `signal` aborts (abort ⇒ resolve, not reject — the caller just stops blocking; PLAN §10 "race ctx.signal"). Emits `onStatus` blocked:true/false transitions.
5. **Failure protection**: 3 consecutive `review()` rejections → drop all pending, reset backlog to 0, call `onFailureGiveUp(lastErr)`; a successful review resets the counter.

## TDD test cases (`src/backlog.test.ts`) — use deferred promises to control `review` completion; keep timeouts small (e.g. 20ms), no fake-timer lib needed
1. two pushes while first review in flight → second review called once with both deltas merged.
2. single-flight: `review` never concurrently invoked (track active counter).
3. waitForCatchup resolves immediately under high.
4. waitForCatchup blocks at high=2 with 3 backlog, resolves when drain brings it ≤ low.
5. waitForCatchup timeout path resolves.
6. waitForCatchup abort path resolves promptly (AbortController.abort during block).
7. hysteresis: after unblocking at low, doesn't re-block until ≥ high again.
8. 3 consecutive failures → pending dropped, `onFailureGiveUp` called once, backlog 0; success in between resets streak.
9. bumpEpoch: pending cleared; stale review completion doesn't corrupt backlog count or emit late status.

## Acceptance
`bun test` green, no flaky sleeps (poll or event-driven assertions).
