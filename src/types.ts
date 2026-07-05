// Shared types for pi-advisor. PLAN §12.
//
// `ThinkingLevel` mirrors pi's `@earendil-works/pi-agent-core` ThinkingLevel
// (off|minimal|low|medium|high|xhigh) so an `AdvisorConfig.thinkingLevel` can be
// handed straight to `createAgentSession({ thinkingLevel })` in later issues,
// without importing the host package here (keeps the config module decoupled
// and unit-testable in isolation).

/** Severity of an advisor note. PLAN §0/§12. */
export type Severity = "nit" | "concern" | "blocker";

/** Total order over severity: nit < concern < blocker. Used by emission guard
 *  (severity-upgrade re-emit) and delivery policy. */
export const SEVERITY_RANK: Record<Severity, number> = {
	nit: 0,
	concern: 1,
	blocker: 2,
};

/** Idle wake-up aggressiveness. PLAN §8/§12. */
export type AutoResume = "off" | "blocker" | "concern" | "all";

/** Thinking level for the advisor sub-session. Mirrors pi's ThinkingLevel. */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

/** High-water mark for backpressure; `off` disables blocking. PLAN §10/§12. */
export type SyncBacklog = number | "off";

/** Full advisor configuration. Every key has a default in `DEFAULT_CONFIG`. */
export interface AdvisorConfig {
	/** Master switch. Default off — dormancy guard plus opt-in. */
	enabled: boolean;
	/** Advisor model (fuzzy-resolved at runtime). Undefined = host default. */
	model?: string;
	/** Advisor thinking level. */
	thinkingLevel: ThinkingLevel;
	/** Idle wake-up policy. */
	autoResume: AutoResume;
	/** Cooldown turns after a preemption; concern/blocker downgrade to nextTurn. */
	immuneTurns: number;
	/** Backpressure high-water mark; `off` = never block. */
	syncBacklog: SyncBacklog;
	/** Backpressure timeout (ms), slow-model friendly. */
	catchupTimeoutMs: number;
	/** Inject skills manifest into advisor system prompt. PLAN §2.2. */
	skills: boolean;
	/** Inject AGENTS.md / context files into advisor system prompt. PLAN §2.2. */
	contextFiles: boolean;
}

/** PLAN §12 config table. */
export const DEFAULT_CONFIG: AdvisorConfig = {
	enabled: false,
	model: undefined,
	thinkingLevel: "medium",
	autoResume: "concern",
	immuneTurns: 2,
	syncBacklog: 10,
	catchupTimeoutMs: 45000,
	skills: true,
	contextFiles: true,
};
