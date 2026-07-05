# #01 Scaffold, shared types, config loader

## Goal
Bun + TypeScript project skeleton and the config subsystem (PLAN §12), so every later module has shared types and settings.

## Scope
- `package.json`: name `pi-advisor`, `"type": "module"`, `@earendil-works/pi-coding-agent@0.80.3` as **peerDependency AND devDependency** (mirror `~/tries/pi-subagents/package.json`), devDeps `typescript`, `@types/bun` (or `bun-types`). Scripts: `test` → `bun test`, `typecheck` → `tsc --noEmit`.
- `tsconfig.json`: strict, ESM, moduleResolution bundler, noEmit.
- `src/types.ts`: shared types —
  - `type Severity = "nit" | "concern" | "blocker"` + `SEVERITY_RANK` (nit=0, concern=1, blocker=2).
  - `type AutoResume = "off" | "blocker" | "concern" | "all"`.
  - `interface AdvisorConfig` with all keys + `DEFAULT_CONFIG` per PLAN §12 table: `enabled:false`, `model?:string`, `thinkingLevel:"medium"`, `autoResume:"concern"`, `immuneTurns:2`, `syncBacklog:10|"off"`, `catchupTimeoutMs:45000`, `skills:true`, `contextFiles:true`.
- `src/config.ts`:
  - `parseConfig(raw: unknown): Partial<AdvisorConfig>` — tolerant: unknown keys ignored, wrong-typed values dropped (fall back to default), enum values validated.
  - `mergeConfig(...layers: Partial<AdvisorConfig>[]): AdvisorConfig` — later layers win, applied over `DEFAULT_CONFIG`.
  - `loadConfig({cwd, agentDir}): AdvisorConfig` — reads `<agentDir>/advisor.json` (global) then `<cwd>/.pi/advisor.json` (project overrides global). Missing/invalid JSON files → treated as empty layer, never throws.

## TDD test cases (`src/config.test.ts`)
1. no config files → exact `DEFAULT_CONFIG`.
2. global file only → merged over defaults.
3. project overrides global on the same key; unrelated keys survive from both.
4. invalid values (`autoResume:"sometimes"`, `syncBacklog:"ten"`, `immuneTurns:-1` or non-number) → dropped, default kept. `syncBacklog:"off"` and numbers ≥1 accepted.
5. malformed JSON file → ignored (defaults), no throw.
6. unknown keys ignored.

Use temp dirs (`fs.mkdtempSync`) for file-based tests.

## Acceptance
`bun test` green, `bun run typecheck` green, `bun install` works.
