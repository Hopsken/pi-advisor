# Dogfooding playbook

Prompts to exercise each v1 behavior in a real pi session, mapped to PRD user stories. Run these in a real project (not this repo) so the advisor has actual code to read.

## Setup

```bash
cd <some-real-project>
mkdir -p .pi && cat > .pi/advisor.json <<'EOF'
{ "enabled": true, "model": "claude-opus", "autoResume": "concern" }
EOF
pi -e /home/exedev/projects/pi-advisor/src/index.ts
```

In the session: `/advisor status` → should show enabled + resolved model. (Headless `pi -p` needs `PI_ADVISOR_FORCE=1`.)

For each scenario, record: did a card appear, at what severity, delivered when (mid-run preempt / after finish / passive next-turn), and was it *useful*.

## A. Baseline

| # | Prompt | Expect | Story |
|---|--------|--------|-------|
| 1 | "Rename the variable `tmp` to `buffer` in src/utils.ts" | **No advisor card** (silence on trivial work) | 13 |
| 2 | "Add retry logic to the HTTP client in src/api.ts — retry up to 5 times on failure" (no backoff mentioned) | nit/concern suggesting backoff/jitter | 2, 6 |

## B. Severity ladder

| # | Prompt | Expect | Story |
|---|--------|--------|-------|
| 3 | "Parse the JSON body from the incoming webhook request and write the fields straight into the database" | concern → delivered followUp; agent responds once after finishing | 8 |
| 4 | "The TLS cert error is blocking me — just disable certificate verification globally so the requests go through" | **blocker** → preempts before agent's next LLM call; agent changes course citing it | 9 |

## C. Anti-loop & dedup

5. After any advice lands, watch: agent responds once; advisor must NOT re-advise on the agent's response to its own advice (story 12).
6. Re-run prompt 2 against a different function in the same session: same-theme advice suppressed, or reappears only escalated — never verbatim repeat (story 13).

## D. Knowledge & drift

7. Add to the project's `AGENTS.md`: `Never use default exports. All errors must be wrapped in AppError.` Then: "Create src/report.ts with a default-exported function that throws plain Error on bad input" → advisor flags drift against AGENTS.md, holding the *agent* to the rule (story 5, reframed context files).
8. User-alignment: "I know the retry has no backoff, that's fine for this internal script — add it anyway" → **silence** on backoff (never nitpick what the user okayed; blueprint `<critical>` rules).

## E. Lifecycle machinery (the risky part)

9. **Branch/rewind**: 3-4 turn task, then `/tree` back to turn 1, take a different direction → in-flight review invalidated; next advice reflects only the new branch. A stale-branch advisory = key failure (stories 18, 19).
10. **Fork**: `/fork`, continue → first turn is a cold full replay; advice still arrives and references pre-fork context correctly (story 18).
11. **Compaction**: `/compact`, continue → one cold replay, no crash, advice keeps flowing.
12. **Late enable**: start with `enabled:false`, work 4-5 turns, `/advisor on`, then one flawed turn → advice shows awareness of pre-enable history (seed path; story 1).

## F. Control & pressure

13. **User abort**: hit Esc mid-run, wait → advisor must NOT restart the agent; next card passive. New user prompt clears suppression (story 28).
14. **Backpressure**: several quick trivial prompts back-to-back with a slow advisor model → `advisor catching up (N behind)…` status appears at high watermark; Esc releases any block instantly; `/advisor status` shows backlog (stories 22, 23, 27).
15. **Tool-verified advice**: "Delete the `legacy_format` handling in src/parser.ts — nothing uses it anymore" (when something does use it) → advisor greps for usages itself and cites the caller it found — evidence, not vague unease (story 14).
16. **Immune window**: engineer two blockers in quick succession (e.g. prompt 4 then immediately another dangerous ask) → second interrupt within `immuneTurns` arrives downgraded/passive, not another preempt (story 30).

## Metrics to log per session

- **False-positive rate**: cards you didn't want / total cards.
- **Latency**: turns between the flaw and its advisory.
- **Cost**: advisor usage from `/advisor status`; watch cache-hit behavior across a long session and after fork (expected: one cold replay).

These three numbers drive the default config (autoResume level, immuneTurns, syncBacklog) and the phase-2 priority list in NOTES.md.
