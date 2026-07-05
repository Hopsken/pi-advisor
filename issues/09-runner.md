# #09 Advisor runner (child session lifecycle)

## Goal
Own the persistent advisor child session: creation, prompting, reset (fresh sessionId + snapshot replay), overflow recovery, disposal. PLAN §1, §5 (档 A), §6. Prior art for assembly & cleanup: `~/tries/pi-subagents/src/agent-runner.ts:572-608`.

## Scope — `src/runner.ts`
```ts
interface AdvisorSessionHandle {           // narrow seam over pi AgentSession
  prompt(text: string, opts?: { signal?: AbortSignal }): Promise<void>;
  abort(): Promise<void> | void;
  dispose(): void | Promise<void>;
}
type SessionFactory = (params: { systemPrompt: string; model?: string; tools: string[]; adviseTool: unknown }) => Promise<AdvisorSessionHandle>;

class AdvisorRunner {
  constructor(deps: { factory: SessionFactory; buildSeed: () => string; config; adviseTool })
  ensureSession(): Promise<void>;                       // lazy create; seeds with buildSeed() on first create
  review(batch: string, opts: { signal?: AbortSignal }): Promise<void>; // prompt; on overflow error → reset + retry once
  reset(): Promise<void>;                               // dispose old, create fresh, replay seed snapshot
  dispose(): Promise<void>;
}
```
- **Real factory** `createRealSessionFactory(ctx-ish deps)` in the same file (or `runner-factory.ts`): assembles `createAgentSession` per PLAN §1 code block — `tools: ["read","grep","find","ls"]`, `customTools: [adviseTool]`, `SessionManager.inMemory(cwd)`, `SettingsManager.create(cwd, agentDir)`, `DefaultResourceLoader` with `systemPrompt`, `noExtensions/noPromptTemplates/noThemes: true`, `noSkills/noContextFiles` from config (inverted), model + thinkingLevel from config, does NOT call `bindExtensions`. Must typecheck against the real pi exports.
- **Overflow detection**: treat provider errors matching context-window overflow (inspect how pi surfaces it — check error messages in `~/tries/pi/packages/ai` for "context" / token-limit errors; a pragmatic `isOverflowError(err)` heuristic function is acceptable, exported for testability) → `reset()` then re-prompt the batch once; second failure propagates.
- Cleanup discipline: subscribe/dispose in `finally`, abort forwarded via signal (mirror pi-subagents).

## TDD test cases (`src/runner.test.ts`) — fake `SessionFactory` (controllable handles)
1. lazy creation: first `review` creates session and seeds it (buildSeed called once, seed prompted before batch).
2. subsequent reviews reuse the session (factory called once).
3. `reset()`: disposes old handle, factory called again, new session re-seeded with fresh `buildSeed()` output.
4. overflow error from prompt → reset + seed + retried batch on the NEW session; success → resolves.
5. overflow twice → rejects (no infinite retry).
6. non-overflow error propagates without reset.
7. `dispose()` disposes underlying handle; review after dispose rejects or recreates (pick one, document, test it).
8. abort signal passed through to handle.prompt.
9. `isOverflowError` unit cases.

Real-factory: **typecheck is the contract test** (it must compile against real pi types). No live-LLM test in this issue.

## Acceptance
`bun test` + `bun run typecheck` green.
