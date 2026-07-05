// Emission guard — per-session noise control for advisor `advise()` calls.
// PLAN §11, issue #02. Pure logic: no I/O, no timers.
//
// The advisor system prompt tells the watcher model:
//   - at most one `advise` per update
//   - never repeat advice you already gave
// Real advisor models violate this. The guard makes those rules load-bearing
// in code: it silently drops content-free self-talk, duplicates, and
// over-budget calls at the boundary so the primary transcript stays clean
// even when the advisor misbehaves. Suppressed calls never surface back to
// the advisor model — `AdviseTool` still returns `Recorded.` — to avoid
// teaching the model to rephrase the same useless note to bypass dedup.
//
// Behavior is ported from oh-my-pi's `AdvisorEmissionGuard`, with two
// adaptations required by the issue spec:
//   - `accept` returns a `GuardDecision` discriminated union (`allowed: true`
//     or `allowed: false` + stable reason) instead of a bare boolean, so the
//     caller can log/observe why a note was dropped.
//   - Cross-review dedup is severity-aware: a note already emitted at rank R
//     is re-allowed only at a strictly higher severity rank (nit→concern→
//     blocker). This is the "escalation re-pass" — a watcher may legitimately
//     re-raise the same concern at a higher grade if the agent ignored it.

import { SEVERITY_RANK, type Severity } from "./types.ts";

/**
 * Case-insensitive, punctuation-folded normalization. Lowercases, applies
 * Unicode NFKC, collapses every run of non-letter / non-digit characters into
 * a single space, and trims — so `"Stop."`, `"*Stop*"`, and `"  stop  "` all
 * key to `stop`, while `"No issue; continue."` keys to `no issue continue`.
 *
 * Exported for tests and reuse by the delivery policy / transcript serializer.
 */
export function normalizeAdvisorNote(note: string): string {
	return note
		.toLowerCase()
		.normalize("NFKC")
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim();
}

/**
 * Normalized phrases the advisor occasionally emits that carry no concrete
 * actionable content. Each entry is the output of {@link normalizeAdvisorNote}
 * so a single membership check covers every punctuation/casing variant
 * (`"Stop."`, `"stop"`, `"STOP!"`). Conservative — only short, content-free
 * filler observed driving primary-transcript pollution. A genuine `blocker`
 * like `"Stop: 'await' missing on writeStream.end() will lose buffered
 * writes."` does not match.
 *
 * Ported verbatim from the oh-my-pi blueprint.
 */
const SUPPRESSED_NORMALIZED_PHRASES: Record<string, true> = {
	// Self-stop noise — telling the agent to "stop" without a reason is useless.
	stop: true,
	"stop here": true,
	"stop now": true,
	halt: true,
	abort: true,
	// Completion self-talk — the agent already finished the task.
	done: true,
	"task done": true,
	"task complete": true,
	complete: true,
	finished: true,
	ok: true,
	okay: true,
	"ok done": true,
	// "Nothing to flag" — silence is the correct expression of "no concerns".
	"no issue": true,
	"no issues": true,
	"no issue continue": true,
	"no concerns": true,
	"no concern": true,
	"nothing to add": true,
	"nothing to flag": true,
	"nothing to report": true,
	"no notes": true,
	"no further input": true,
	"no further input needed": true,
	"no further input required": true,
	"no further watcher input": true,
	"no further watcher input needed": true,
	"no further advice": true,
	"no further advice needed": true,
	// Endorsements — equivalent to silence.
	lgtm: true,
	"looks good": true,
	"all good": true,
	"agent is on track": true,
	"agent on track": true,
	"on track": true,
	continue: true,
	"carry on": true,
};

/**
 * Bounds the dedupe history. Sessions with very long advisor activity could
 * otherwise grow the set without bound. Constructor-injectable so tests can
 * exercise FIFO eviction quickly; default 4096 leaves headroom while staying
 * tiny (≤ ~256 KB of normalized strings even at long max).
 */
const DEFAULT_HISTORY_CAPACITY = 4096;

/**
 * Outcome of {@link EmissionGuard.accept}. `allowed: true` means the gate has
 * already recorded the note (consumed the per-update budget and updated the
 * dedupe history) and the caller should deliver it. `allowed: false` carries a
 * stable reason the caller can log; the caller drops the note.
 */
export type GuardDecision =
	| { allowed: true }
	| { allowed: false; reason: "content-free" | "duplicate" | "budget" };

/**
 * Decides whether an advisor note should reach the primary agent.
 *
 * Enforces — in this stable order — the noise filter, session-scoped
 * dedupe with severity-rank escalation, and a per-update rate limit of one
 * accepted note per advisor model prompt. Suppressed calls (content-free or
 * duplicate) never consume the per-update budget — a noise call doesn't burn
 * the slot for a real concern that follows in the same update.
 *
 * Dedupe history is FIFO-evicted at {@link DEFAULT_HISTORY_CAPACITY}. Per-update
 * gate is cleared by {@link beginUpdate} at the start of every advisor model
 * prompt cycle.
 */
export class EmissionGuard {
	/** Normalized note → highest severity rank emitted for it so far. */
	#seen = new Map<string, number>();
	/** Insertion-order log to drive FIFO eviction without a second scan. */
	#seenOrder: string[] = [];
	#consumedThisUpdate = false;
	readonly #capacity: number;

	constructor(opts: { capacity?: number } = {}) {
		this.#capacity = opts.capacity ?? DEFAULT_HISTORY_CAPACITY;
	}

	/**
	 * Clear the per-update rate-limit gate. Called right before each advisor
	 * `agent.prompt(batch)` invocation so the next advisor model cycle starts
	 * with a fresh budget of one advise.
	 */
	beginUpdate(): void {
		this.#consumedThisUpdate = false;
	}

	/**
	 * Decide whether `note` at `severity` should reach the primary. Checks run
	 * in the stable order content-free → duplicate → budget, so the reported
	 * reason is deterministic regardless of per-update state. On `allowed:
	 * true` the gate has consumed the budget and recorded/updated the note.
	 */
	accept(note: string, severity: Severity): GuardDecision {
		const key = normalizeAdvisorNote(note);

		// 1. Content-free: empty or suppression-list filler. Never consumes
		//    budget; a real concern later in the same update still gets through.
		if (!key || SUPPRESSED_NORMALIZED_PHRASES[key]) {
			return { allowed: false, reason: "content-free" };
		}

		const rank = SEVERITY_RANK[severity];
		const prevRank = this.#seen.get(key);

		// 2. Duplicate: already emitted at a rank >= this one. A strictly higher
		//    severity is an escalation re-pass and falls through to acceptance,
		//    updating the stored rank. Same/lower rank is suppressed.
		if (prevRank !== undefined && rank <= prevRank) {
			return { allowed: false, reason: "duplicate" };
		}

		// 3. Budget: at most one accepted note per update. A suppressed call
		//    above did not consume the slot.
		if (this.#consumedThisUpdate) {
			return { allowed: false, reason: "budget" };
		}

		// Accept: consume the slot, record/upgrade the note.
		this.#consumedThisUpdate = true;
		this.#seen.set(key, rank);
		if (prevRank === undefined) {
			// New key — append to the FIFO log and evict if over capacity.
			this.#seenOrder.push(key);
			if (this.#seenOrder.length > this.#capacity) {
				const stale = this.#seenOrder.shift();
				if (stale !== undefined) this.#seen.delete(stale);
			}
		}
		return { allowed: true };
	}
}
