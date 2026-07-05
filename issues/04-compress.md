# #04 Delta compression (transcript serializer)

## Goal
Serialize a slice of main-session entries into the compact text fed to the advisor. PLAN §9. Blueprint: `~/tries/oh-my-pi/packages/coding-agent/src/session/session-history-format.ts:230-358` (read for style, don't copy wholesale — our input shape is pi v0.80.3 session entries).

## Scope — `src/compress.ts`
- FIRST inspect real entry/message types: `~/tries/pi/packages/coding-agent/src/core/session-manager.ts` (`SessionEntry`, message entry shape) and `~/tries/pi/packages/agent/src/types.ts` (`AgentMessage`, content blocks: text / thinking / toolCall, tool-result messages). Type the input structurally (narrow local interfaces are fine) so unit tests can build fixtures without the real session manager.
- `compressEntries(entries: readonly SessionEntryLike[], opts?): string`
  Rules:
  - **user / assistant text**: kept verbatim, prefixed with a speaker header (e.g. `[user]`, `[agent]`).
  - **assistant thinking**: kept (`[thinking]` block).
  - **tool calls**: one line `→ toolName({truncated args}) ⇒ <status>` — args JSON truncated to ~120 chars; tool RESULT bodies dropped, replaced by summary `ok · N lines` (or `error: first line`).
  - **exception — edits**: for `edit`/`write`/`apply_patch`-style tools keep the diff/content (`expandEditDiffs`).
  - **repeated identical context blocks** (e.g. plan-mode constraints re-injected verbatim): second occurrence collapses to `(unchanged — still in effect)` (blueprint `runtime.ts:192-198`).
  - **loop gate lives elsewhere**: compress must simply skip entries marked with `customType === "advisor"` when present (defense in depth; controller also filters).
- Deterministic output (stable for prompt-cache friendliness): pure function of input.

## TDD test cases (`src/compress.test.ts`) — fixture-driven
1. user + assistant text preserved with headers.
2. thinking block preserved.
3. `read` tool call: args truncated at 120 chars, result body (e.g. 500-line file) NOT present, summary line with line count present.
4. failed bash call → `⇒ error: <first line>` and no full output.
5. `edit` tool call → diff text present in output.
6. duplicated context text block → second occurrence collapsed.
7. entries with `customType:"advisor"` skipped.
8. determinism: same input twice → identical string.

## Acceptance
`bun test` green. Output is readable prose-ish transcript (eyeball one snapshot fixture, but avoid brittle full-string snapshots — assert on contains/not-contains and counts).
