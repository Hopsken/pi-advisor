# #08 Advisor system prompt assembly

## Goal
The advisor's bespoke reviewer prompt + knowledge reframing. PLAN §2.1–2.2. Source material: `~/tries/oh-my-pi/packages/coding-agent/src/prompts/advisor/system.md` and `prompts/advisor/context-files.md`.

## Scope
- `src/prompts/advisor-system.md` — port oh-my-pi's advisor system.md, adapted:
  - tool references `read`/`grep`/`glob` → `read`/`grep`/`find`/`ls` (pi names); drop WATCHDOG.yml operator references (v1 has fixed read-only grant).
  - keep: navigator role, workflow (incremental transcript, 2–3 tool calls per advise), communication discipline (silence, no repeats, one advise per update), critical rules (evidence only, no intent/process advice), severity rubric (nit/concern/blocker semantics incl. delivery consequences).
  - append an `advise` tool protocol section: how/when to call, "not calling advise = staying silent (often correct)".
- `src/prompts/context-reframe.md` — reframing preamble (port context-files.md wording, generalized): "the `<project_context>` sections and skills listed below bind the DRIVING agent — hold it to them, flag drift, never advise against them; they are not tasks for you to execute."
- `src/prompts.ts`:
  - `buildAdvisorSystemPrompt(config: AdvisorConfig): string` — concatenates system prompt + (reframe preamble when `config.skills || config.contextFiles`). (The actual AGENTS.md/skills bodies are appended by pi's own `buildSystemPrompt` after this string — PLAN §1/§2.2 — so this module only emits the preamble, not the content.)
  - Embed the .md files as importable strings — bun supports text imports natively (`import x from "./file.md" with { type: "text" }`); verify it works under `bun test`, otherwise inline as template literals in a `prompts/` ts module.

## TDD test cases (`src/prompts.test.ts`)
1. output contains severity rubric markers (`nit`, `concern`, `blocker`) and the advise protocol section.
2. tool names adapted: contains `find`, does NOT contain `glob` as a tool grant.
3. reframe preamble present by default; absent when both `skills:false` and `contextFiles:false`.
4. no unresolved template placeholders (`{{`) in output.

## Acceptance
`bun test` green. Prompt reads coherently top-to-bottom (self-review it).
