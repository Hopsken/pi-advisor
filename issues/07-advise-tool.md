# #07 `advise` custom tool

## Goal
The advisor model's only output channel: an `advise(note, severity)` tool whose handler runs the emission guard and routes accepted advice. Suppression must be invisible to the model. PLAN §4/§11; blueprint `~/tries/oh-my-pi/packages/coding-agent/src/advisor/advise-tool.ts:16-19,201-208`.

## Scope — `src/advise-tool.ts`
- FIRST inspect pi's custom tool type: `CreateAgentSessionOptions.customTools` (`~/tries/pi/packages/coding-agent/src/core/sdk.ts:71`) → follow to the `ToolDefinition`/`Tool` type it requires (check how schema + `execute` are shaped; pi uses TypeBox-style schemas — mirror what a built-in tool or pi-subagents does).
- `createAdviseTool(deps: { guard: EmissionGuard; route: (note: string, severity: Severity) => void | Promise<void> }): <pi ToolDefinition type>`
  - name `advise`; description ported/adapted from blueprint (one advise per update, prefer silence, severity semantics).
  - params: `note: string` (required, the advice text), `severity: "nit"|"concern"|"blocker"` (required).
  - execute:
    - invalid severity or empty note → tool error result (model-visible, so it can correct the call shape).
    - `guard.accept(note, severity)`:
      - allowed → `await route(note, severity)` → return text `"Recorded."`.
      - reason `duplicate` → return `"Duplicate advice ignored."` (NO route call).
      - reason `content-free` or `budget` → return `"Recorded."` (NO route call) — suppression invisible so the model can't rephrase its way past the guard.
    - `route` throwing must not leak a scary error to the model: return `"Recorded."` and surface via optional `onError` dep.

## TDD test cases (`src/advise-tool.test.ts`) — fake guard + spy route; call the tool's execute directly
1. allowed → route called with (note, severity), returns "Recorded.".
2. duplicate → "Duplicate advice ignored.", route NOT called.
3. budget/content-free → "Recorded.", route NOT called.
4. invalid severity value → error result, guard/route untouched.
5. route rejection → still "Recorded.", onError spy called.
6. schema sanity: tool name/params match what `customTools` expects (typecheck is the main gate; assert name and required fields).

## Acceptance
`bun test` + `bun run typecheck` green (the tool object must satisfy the real pi type import, not a hand-rolled clone).
