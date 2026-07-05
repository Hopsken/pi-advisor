# #02 Emission guard

## Goal
Port oh-my-pi's noise control (`~/tries/oh-my-pi/packages/coding-agent/src/advisor/emission-guard.ts`) as pure logic. PLAN §11. This is load-bearing: it is the first anti-loop gate (historical evidence: 309 advises / 114 "Stop." in one session without it).

## Scope — `src/emission-guard.ts`
`class EmissionGuard` (no I/O, no timers):
- `beginUpdate(): void` — starts a review cycle; resets per-update budget (1 emission allowed per update).
- `accept(note: string, severity: Severity): GuardDecision` where `GuardDecision = { allowed: true } | { allowed: false; reason: "content-free" | "duplicate" | "budget" }`.

Rules (port faithfully from the blueprint — read it first):
1. **Normalization**: lowercase, Unicode NFKC, collapse every non-alphanumeric run to a single space, trim.
2. **Content-free suppression**: normalized note that is empty or matches a suppression list (port the blueprint's list; must at least cover `stop`, `done`, `lgtm`, `no issue continue`, `looks good`, `ok`).
3. **Cross-review dedup**: normalized notes already emitted are rejected — EXCEPT when `severity` rank is strictly higher than the highest rank previously emitted for that note (escalation re-pass: nit→concern→blocker). Escalation updates the stored rank.
4. **FIFO capacity 4096**: oldest seen-notes evicted beyond capacity.
5. **Budget**: at most 1 `allowed:true` per update. Suppressed calls do NOT consume budget.
6. Order of checks must make suppression reasons stable: content-free → duplicate → budget.

## TDD test cases (`src/emission-guard.test.ts`)
1. first meaningful note → allowed.
2. `"Stop."`, `"LGTM!"`, `"  "` → `content-free`.
3. same note twice (same severity) across two updates → second is `duplicate`.
4. normalization dedup: `"Add retry back-off!"` vs `"add retry  back-off"` → duplicate.
5. escalation: note at `nit` then same note at `concern` → allowed; again at `concern` → duplicate; at `blocker` → allowed; later at `nit` → duplicate.
6. budget: two distinct notes in one update → second is `budget`; after `beginUpdate()` a new distinct note is allowed.
7. suppressed call doesn't consume budget: content-free note then meaningful note in same update → meaningful one allowed.
8. FIFO eviction: with capacity (make it constructor-injectable, default 4096; test with small capacity e.g. 3) an evicted note is allowed again.

## Acceptance
`bun test` green; module has zero imports besides `types.ts`.
