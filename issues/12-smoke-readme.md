# #12 Smoke wiring + README

## Goal
Prove the extension loads in a real pi session and document usage. Final v1 issue.

## Scope
1. **Load smoke test** (`test/smoke.test.ts`): drive a real `createAgentSession` from `@earendil-works/pi-coding-agent` in-process with the extension loaded via `DefaultResourceLoader({ additionalExtensionPaths: [<repo src/index.ts>] })` (see how pi's own tests / pi-subagents e2e boot sessions — `~/tries/pi-subagents/test/helpers/print-mode-runner.ts`). Assertions:
   - extension loads without diagnostics/errors;
   - `/advisor status` command is registered;
   - with `enabled:false` nothing observes (no advisor session created).
   - Gate any live-LLM path behind `PI_ADVISOR_E2E_LIVE=1` (skipped by default); the default smoke must run offline (faux provider or no-turn assertions only).
2. **README.md**: what it is (advisor peer agent for pi), install (bun, path-based extension load), config file reference (all keys + defaults from PLAN §12), `/advisor` command, severity semantics table (what nit/concern/blocker do), known limitations (headless needs `PI_ADVISOR_FORCE=1`; cache goes cold on fork/resume; user-abort detection is heuristic; extraTools/extension-inheritance deferred).
3. **CI-ish check**: `bun test && bun run typecheck` clean from a fresh `bun install` (verify by deleting node_modules once).

## Acceptance
Offline `bun test` green incl. smoke; README accurate against implemented behavior (spot-check each claim).
