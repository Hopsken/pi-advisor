# #11 Extension entry: commands, renderer, dormancy guard

## Goal
The actual pi extension wiring: default-export function, event registration, `/advisor` command, advisor message renderer, dormancy guard. PLAN §2.4, §12, §14. Read `~/tries/pi` docs `docs/extensions.md` (lifecycle, registerCommand, registerMessageRenderer, sendMessage, events) and mirror pi-subagents' `src/index.ts` registration style.

## Scope — `src/index.ts` (+ `src/ui/advisor-card.ts`)
1. **Entry**: `export default function advisorExtension(pi: ExtensionAPI)` — must typecheck against real pi types.
2. **Dormancy guard** (PLAN §2.4): on `session_start`, decide activation:
   - inactive unless `config.enabled` (or turned on later via command);
   - heuristic guard against foreign child sessions: activate only when `ctx.hasUI === true` OR env `PI_ADVISOR_FORCE=1` (documented limitation: headless `pi -p` needs the env var). Never activate when the guard says no, even if config.enabled.
3. **Event wiring** (only when active): `turn_end` → `controller.handleTurnEnd`; `session_tree` → `handleSessionTree`; `session_compact` → `handleSessionCompact`; `agent_start`(user prompt) → `noteUserPrompt`; user-abort detection → `noteUserAbort` (best-effort: inspect available events — e.g. `agent_end` with aborted flag; document chosen heuristic inline; PLAN §8 research task); `session_shutdown` → dispose.
4. **Command** `/advisor [on|off|status]` via `pi.registerCommand`:
   - `on` → enable (late-enable seed path), persist `enabled:true` to project config file (`<cwd>/.pi/advisor.json`, merge-write);
   - `off` → disable + persist;
   - `status` (or bare `/advisor`) → notify/print: enabled, model, backlog, turns behind.
5. **Renderer**: `pi.registerMessageRenderer("advisor", ...)` — severity-colored card (border/label color by severity: nit=dim/gray, concern=yellow, blocker=red), body = advice note. Keep the renderer a thin function over a pure `formatAdvisorCard(note, severity, theme-ish)` helper in `src/ui/advisor-card.ts` so it's unit-testable.
6. Assemble the real object graph (config → guard → backlog → runner(real factory, buildAdvisorSystemPrompt) → controller) in the entry; keep entry thin — all logic stays in modules.

## TDD test cases
- `src/ui/advisor-card.test.ts`: severity → label/color mapping; note text present; multi-line notes render.
- `src/index.test.ts` with a fake `ExtensionAPI`/ctx (typed structurally): 
  1. guard: `hasUI:false` without env → no event handlers invoke controller (command still responds with "inactive" explanation).
  2. `/advisor on` → controller.enable called; config file written with `enabled:true`.
  3. `/advisor status` → output contains model + backlog info.
  4. `session_shutdown` → controller disposed.
  5. user-abort heuristic: chosen event shape triggers noteUserAbort.
  (Inject a controller factory so index tests use a spy controller, not the real graph.)

## Acceptance
`bun test` + typecheck green. `bun run typecheck` proves entry conforms to real `ExtensionAPI`.
