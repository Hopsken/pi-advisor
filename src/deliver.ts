// Delivery policy for pi-advisor. PLAN §7-§8, issue #05.
//
// Pure decision function mapping an *accepted* advisor note (severity already
// vetted by the emission guard) to a pi delivery mode. The decision encodes
// the "convey vs. wake" split from oh-my-pi: every note is conveyed (reaches
// the main agent's visible context); the only question is whether it also
// *wakes* an idle agent. Three lowering guards keep that from looping:
//
//   1. `nit` always rides `nextTurn` — conveys, never wakes (rule 1).
//   2. The post-interrupt immune window downgrades `concern`/`blocker` to
//      `nextTurn` for `immuneTurns` turns after a steer landed (rule 2).
//   3. After a deliberate user stop (`autoResumeSuppressed`), an idle/tearing-
//      down agent is left parked at `nextTurn` rather than restarted; but once
//      a turn is actively streaming again the note steers live, since steering
//      into a running turn does not auto-resume anything (rule 3, blueprint
//      gate `aborting || !streaming`).
//
// Downgrade is always to `nextTurn` — never a drop ("降级永不丢").
//
// Reference: oh-my-pi `advisor/advise-tool.ts:98-134`
// (`resolveAdvisorDeliveryChannel` + immune window). The channel vocabulary
// here (`nextTurn`/`followUp`/`steer`) is the pi extension `sendMessage`
// vocabulary, with `triggerTurn` separated out per PLAN §7.

import type { AdvisorConfig, AutoResume, Severity } from "./types.ts";

/** Inputs to the delivery decision — a snapshot of the main session. */
export interface DeliveryState {
	/** Main agent mid-run (a turn is actively streaming) at delivery time. */
	streaming: boolean;
	/** User manually interrupted the run; the flag is not yet cleared. */
	autoResumeSuppressed: boolean;
	/** Main-session completed-turn counter. */
	completedTurns: number;
	/** Turn index at which a steer interrupt landed, or null if none active. */
	immuneTurnStart: number | null;
}

/** How an accepted note reaches the main agent. PLAN §7. */
export interface DeliveryDecision {
	/** pi `sendMessage` delivery mode. */
	deliverAs: "nextTurn" | "followUp" | "steer";
	/** Whether to trigger a new turn when the agent is idle (steer/followUp). */
	triggerTurn: boolean;
	/** True when a `concern`/`blocker` was demoted to `nextTurn` by a guard. */
	downgraded: boolean;
}

/**
 * Truth table for whether `autoResume` permits waking the agent for a severity.
 * `off` never; `blocker` blocker-only; `concern` concern+blocker; `all` all
 * (including nit — but rule 1 in `resolveDelivery` short-circuits nits before
 * this is consulted, so nit never triggers in practice).
 */
export function autoResumeAllows(autoResume: AutoResume, severity: Severity): boolean {
	switch (autoResume) {
		case "off":
			return false;
		case "blocker":
			return severity === "blocker";
		case "concern":
			return severity === "concern" || severity === "blocker";
		case "all":
			return true;
	}
}

/** Whether the post-interrupt immune cooldown window is currently active. */
export function isImmune(state: DeliveryState, config: AdvisorConfig): boolean {
	return (
		state.immuneTurnStart !== null &&
		state.completedTurns < state.immuneTurnStart + config.immuneTurns
	);
}

/**
 * Decide how an accepted advisor note of `severity` is delivered, given the
 * main-session `state` and `config`. Rules applied in order; first match wins.
 *
 *   1. `nit` → `nextTurn`, never triggers, never "downgraded".
 *   2. immune window active → `concern`/`blocker` downgrade to `nextTurn`.
 *   3. `autoResumeSuppressed && !streaming` → downgrade to `nextTurn` (still
 *      delivered; the user's stop is honored).
 *   4. otherwise: `concern` → `followUp`, `blocker` → `steer`; `triggerTurn`
 *      follows `autoResumeAllows(config.autoResume, severity)`.
 */
export function resolveDelivery(
	severity: Severity,
	state: DeliveryState,
	config: AdvisorConfig,
): DeliveryDecision {
	// Rule 1: nits convey but never wake, regardless of state or config.
	if (severity === "nit") {
		return { deliverAs: "nextTurn", triggerTurn: false, downgraded: false };
	}

	// Rule 2: post-interrupt cooldown — downgrade to a non-interrupting aside.
	if (isImmune(state, config)) {
		return { deliverAs: "nextTurn", triggerTurn: false, downgraded: true };
	}

	// Rule 3: user stopped the run and the agent is idle/tearing down — don't
	// restart it on the advisor's behalf, but still convey the note. A note
	// arriving while a turn is actively streaming steers live: steering into a
	// running turn never auto-resumes anything, and parking it would strand it.
	if (state.autoResumeSuppressed && !state.streaming) {
		return { deliverAs: "nextTurn", triggerTurn: false, downgraded: true };
	}

	// Rule 4: normal delivery. `concern` follows up after the current run;
	// `blocker` steers in before the next LLM call. Waking an idle agent is
	// gated by `autoResume`.
	const deliverAs: DeliveryDecision["deliverAs"] =
		severity === "blocker" ? "steer" : "followUp";
	return {
		deliverAs,
		triggerTurn: autoResumeAllows(config.autoResume, severity),
		downgraded: false,
	};
}
