# pi-advisor implementation issues

Sequenced, testable units of work derived from `../PLAN.md`. Do them in order; each issue must land with green tests before the next starts.

## Conventions (apply to every issue)

- **Runtime/tooling**: bun (`~/.bun/bin/bun`, on PATH via `.bashrc`). Tests with `bun test`. TypeScript strict, ESM (`"type": "module"`).
- **TDD, mandatory**: write failing tests FIRST (red), then implement (green), then refactor. Commit should show test + impl together and `bun test` must pass.
- **Test quality bar** (PLAN §16): assert externally observable behavior (outputs, state transitions, calls to injected facades). Never assert private fields, never grep source code in tests, no bare `expect(...).not.toThrow()` without semantic assertions. No network in unit tests.
- **References**:
  - Design: `PLAN.md` / `PRD.md` in repo root (section numbers cited per issue).
  - Host platform source (pi v0.80.3): `~/tries/pi/packages/coding-agent/`
  - Behavior blueprint (oh-my-pi advisor): `~/tries/oh-my-pi/packages/coding-agent/src/`
  - Mature extension prior art: `~/tries/pi-subagents/`
- **File layout**: PLAN §14. Don't create files belonging to later issues.
- **Language**: code, identifiers, comments, tests in English.
- **Commits**: one commit per issue, message `feat(#NN): <title>` (or `chore`/`test` as fitting).

## Issue index

| # | Title | Depends on |
|---|-------|-----------|
| 01 | Scaffold, shared types, config loader | — |
| 02 | Emission guard (dedup/suppression) | 01 |
| 03 | Branch alignment (entry-id LCP) | 01 |
| 04 | Delta compression (transcript serializer) | 01 |
| 05 | Delivery policy (severity → channel) | 01 |
| 06 | Backlog & backpressure (single-flight drain, hysteresis) | 01 |
| 07 | `advise` custom tool | 02, 05 |
| 08 | Advisor system prompt assembly | 01 |
| 09 | Advisor runner (child session lifecycle) | 07, 08 |
| 10 | AdvisorController (observe→review→deliver integration) | 03, 04, 06, 09 |
| 11 | Extension entry: commands, renderer, dormancy guard | 10 |
| 12 | Smoke wiring + README | 11 |
