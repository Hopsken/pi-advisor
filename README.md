# pi-advisor

A [pi](https://pi.dev) extension that runs an independent **advisor** peer agent.

A strong model shadows every turn of the main agent: after each turn it reviews a
compressed delta of the conversation and, when it has something concrete to flag,
emits a single graded note through an `advise` tool. The note is delivered back
into the main agent's context at one of three severities — **nit**, **concern**,
or **blocker** — each with distinct delivery semantics (passive aside, follow-up
after the current run, or a preempting steer).

The advisor runs in its own isolated pi child session with a read-only tool set
plus the `advise` tool, so it never mutates your project. It is off by default
and opt-in per project.

> Status: v1. This is the final v1 surface; see [Known limitations](#known-limitations)
> for what is intentionally deferred.

---

## Install

pi-advisor is a path-loaded extension (no npm package yet). It needs
[`bun`](https://bun.sh) and pi `0.80.x` as a peer.

```sh
# from the pi-advisor checkout
bun install
```

Then load it into pi by pointing pi at the entry file. There are three
equivalent ways; pick one.

**1. Persistent, global** — add to `~/.pi/agent/settings.json`:

```json
{
  "extensions": ["/absolute/path/to/pi-advisor/src/index.ts"]
}
```

**2. Persistent, project-local** — add to `.pi/settings.json` in your project
(shared with your team after the project is trusted):

```json
{
  "extensions": ["/absolute/path/to/pi-advisor/src/index.ts"]
}
```

**3. One-off run** — pass the path on the CLI:

```sh
pi -e /absolute/path/to/pi-advisor/src/index.ts
```

Paths in `~/.pi/agent/settings.json` resolve relative to `~/.pi/agent`; paths in
`.pi/settings.json` resolve relative to `.pi`. A `.ts` path is loaded directly
(pi uses `jiti` to import it), so no build step is required.

The extension registers a `advisor` custom-message renderer and the `/advisor`
command on load; it does not activate until enabled (see below).

---

## Configuration

Config is two-layer JSON: a **global** layer at `<agentDir>/advisor.json` and a
**project** layer at `<cwd>/.pi/advisor.json`. The project layer overrides the
global layer; both are merged over the defaults. `<agentDir>` is `~/.pi/agent`
by default (override with the `PI_CODING_AGENT_DIR` env var). Missing or
malformed files are ignored — config loading never throws.

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `enabled` | boolean | `false` | Master switch. Even when `true`, the [dormancy guard](#known-limitations) must also pass. `/advisor on` writes this to the project layer. |
| `model` | string \| omitted | omitted | Advisor model. Fuzzy-resolved at activation: `"provider/modelId"` for an exact pin, or a case-insensitive substring of the model `id`/`name` (e.g. `"haiku"`). Omitted → host default model. |
| `thinkingLevel` | `"off"` \| `"minimal"` \| `"low"` \| `"medium"` \| `"high"` \| `"xhigh"` | `"medium"` | Advisor thinking level. |
| `autoResume` | `"off"` \| `"blocker"` \| `"concern"` \| `"all"` | `"concern"` | Idle wake-up policy. Whether a delivered `concern`/`blocker` restarts an idle main agent. `off` never; `blocker` blocker-only; `concern` concern+blocker; `all` all. (`nit` never wakes, regardless.) |
| `immuneTurns` | non-negative integer | `2` | Cooldown turns after a steer lands. During this window, `concern`/`blocker` downgrade to a non-interrupting `nextTurn` aside. |
| `syncBacklog` | positive integer \| `"off"` | `10` | Backpressure high-water mark. When the advisor falls this many turns behind, the main agent's next turn is held until the advisor catches up (hysteresis low watermark = `ceil(syncBacklog/2)`). `"off"` disables blocking. |
| `catchupTimeoutMs` | positive number | `45000` | Backpressure timeout (ms). A held turn is released after this even if the advisor is still behind (slow-model friendly). |
| `skills` | boolean | `true` | Inject the pi skills manifest into the advisor's system prompt. |
| `contextFiles` | boolean | `true` | Inject `AGENTS.md` / project context files into the advisor's system prompt. |

Example project config (`.pi/advisor.json`):

```json
{
  "enabled": true,
  "model": "anthropic/claude-3-5-haiku-20241022",
  "autoResume": "concern",
  "immuneTurns": 2
}
```

---

## The `/advisor` command

```
/advisor on       Enable the advisor for this project (writes enabled:true to
                  .pi/advisor.json and activates now).
/advisor off      Disable the advisor (writes enabled:false and deactivates).
/advisor status   Report enabled/disabled, model, and turns-behind backlog.
/advisor          Bare form is equivalent to /advisor status.
```

`/advisor on` refuses with an explanation when the [dormancy guard](#known-limitations)
blocks activation (e.g. inside a sub-agent session or a headless `pi -p` run
without `PI_ADVISOR_FORCE=1`).

---

## Severity semantics

Every accepted advisor note is *conveyed* (it reaches the main agent's visible
context). The severity decides *how* it is delivered and whether it also wakes an
idle agent. Lowering guards (the post-steer immune window; a recent user abort)
downgrade `concern`/`blocker` to a non-interrupting `nextTurn` aside — a note is
never silently dropped.

| Severity | Delivery | Idle wake-up | Color |
| --- | --- | --- | --- |
| `nit` | `nextTurn` — appended to the next turn's context, never interrupts. | Never (regardless of `autoResume`). | dim (gray) |
| `concern` | `followUp` — queued to run after the current turn completes. | Per `autoResume`: wakes an idle agent when `autoResume` is `"concern"` or `"all"`. | warning (yellow) |
| `blocker` | `steer` — preempts the main agent before its next LLM call. | Per `autoResume`: wakes an idle agent when `autoResume` is `"blocker"`, `"concern"`, or `"all"`. | error (red) |

Downgrade guards (applied in order, first match wins):

1. `nit` → always `nextTurn`, never triggers, never "downgraded".
2. **Immune window** active (within `immuneTurns` of the last steer) →
   `concern`/`blocker` downgrade to `nextTurn`.
3. **User abort** (the user hit Esc; the agent is idle/tearing down) →
   `concern`/`blocker` downgrade to `nextTurn`. A note arriving while a turn is
   actively streaming still steers live (steering into a running turn never
   auto-resumes anything).
4. Otherwise the normal delivery above.

---

## How it works

On `session_start` (when `enabled` is true and the dormancy guard passes) the
extension builds the advisor graph and activates it:

- An **`EmissionGuard`** dedupes notes (same text twice → "Duplicate advice
  ignored.") and applies the per-update severity budget.
- An **`AdvisorRunner`** owns the advisor child session: a real
  `createAgentSession` with a read-only built-in tool allowlist
  (`read`, `grep`, `find`, `ls`) plus the `advise` tool, an in-memory
  `SessionManager` (so the advisor's prompt cache persists across turns), and
  `noExtensions` / `noPromptTemplates` / `noThemes` so the advisor never
  re-enters itself or inherits project extensions.
- A **`BacklogQueue`** merges compressed conversation deltas and runs a
  single-flight review: after each main turn the new suffix is compressed and
  queued; the drain pops the whole queue as one batch and prompts the advisor,
  which either stays silent or calls `advise(note, severity)`.
- An **`AdvisorController`** ties it together: observe → compress → feed →
  review → deliver, with branch alignment (entry-id LCP), backpressure, and the
  downgrade guards above.

The advisor reviews only the **main** host session; the dormancy guard keeps it
dormant inside foreign child sessions (e.g. pi-subagents spawns) and headless
`pi -p` runs.

---

## Known limitations

- **Headless needs `PI_ADVISOR_FORCE=1`.** The dormancy guard activates the
  advisor only when `ctx.hasUI === true` (TUI/RPC modes). Headless `pi -p` and
  `pi -j` runs have no UI, so the advisor stays dormant unless the
  `PI_ADVISOR_FORCE` env var is `1`. Even `enabled:true` cannot override a
  negative guard — an advisor-enabled project loaded inside a sub-agent session
  stays dormant.
- **Prompt cache goes cold on fork/resume/reset.** The advisor keeps an
  in-memory session so its prompt cache persists across turns. A branch
  divergence (fork or `/resume` to a different branch, detected on
  `session_tree`) or an overflow on review triggers a `reset()` — a fresh
  session with a new in-memory sessionId — so the cache is cold once. This is
  the accepted cost of branch/overflow recovery.
- **User-abort detection is heuristic.** pi sets the assistant message's
  `stopReason` to `"aborted"` when the user hits Esc; the extension inspects the
  `turn_end` event for this and marks the session as auto-resume-suppressed
  before the backlog drain's delivery decision. It is best-effort: any turn pi
  labels with a different stop reason is treated as a normal turn.
- **`extraTools` / extension inheritance deferred.** The advisor sub-session
  runs with a fixed read-only built-in allowlist plus `advise` only
  (`noExtensions: true`). Configuring additional tools, or inheriting the host's
  extension tools into the advisor, is not yet implemented.
- **Only the main agent is reviewed.** The advisor shadows the main host
  session's branch. It does not review child sessions spawned by other
  extensions (the dormancy guard keeps it dormant there).

---

## Development

```sh
bun install
bun test          # offline unit + smoke suite (faux provider, no network)
bun run typecheck # tsc --noEmit
```

The smoke test (`test/smoke.test.ts`) boots a real in-process pi session with the
extension loaded via `DefaultResourceLoader({ additionalExtensionPaths: [...] })`
and a faux provider, then asserts: the extension loads with no errors, `/advisor`
is registered, and with `enabled:false` + no UI nothing observes (zero model
calls, no advisor messages). A live-LLM variant is gated behind
`PI_ADVISOR_E2E_LIVE=1` and skipped by default.

## License

MIT
