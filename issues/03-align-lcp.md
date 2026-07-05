# #03 Branch alignment (entry-id LCP)

## Goal
Pure alignment logic per PLAN §5: given the sequence of main-branch entry ids already fed to the advisor vs the current branch's entry ids, decide advance / no-op / divergence.

## Scope — `src/align.ts`
- `longestCommonPrefixLen(a: readonly string[], b: readonly string[]): number`
- `planAlignment(fed: readonly string[], cur: readonly string[]): AlignmentPlan` with
  ```ts
  type AlignmentPlan =
    | { kind: "advance"; newIds: string[] }   // k === fed.length && cur.length > k → feed cur[k:]
    | { kind: "noop" }                        // k === fed.length === cur.length
    | { kind: "divergence"; commonLen: number } // k < fed.length → reset + full replay (档 A)
  ```
- Edge cases: `fed=[]` with non-empty `cur` is `advance` (cold start / post-fork / late-enable all reduce to this — PLAN §5 lifecycle correction); both empty is `noop`; `cur` shorter than `fed` but a strict prefix (rewind) is `divergence`.

## TDD test cases (`src/align.test.ts`)
1. cold start: `fed=[]`, `cur=[a,b]` → advance `[a,b]`.
2. pure advance: `fed=[a,b]`, `cur=[a,b,c,d]` → advance `[c,d]`.
3. no change → noop.
4. divergence mid-branch: `fed=[a,b,c]`, `cur=[a,b,x]` → divergence commonLen 2.
5. rewind (cur strict prefix): `fed=[a,b,c]`, `cur=[a]` → divergence commonLen 1.
6. total divergence: no common prefix → divergence commonLen 0.
7. LCP function: property-style spot checks incl. empty arrays.

## Acceptance
`bun test` green; pure functions, no imports besides types.
