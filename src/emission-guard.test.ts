// Tests for the emission guard (PLAN §11, issue #02).
//
// Pure-logic port of oh-my-pi's `AdvisorEmissionGuard`, adapted to a
// `GuardDecision` return shape and severity-rank escalation. The eight cases
// below mirror the issue spec 1:1; the normalization block mirrors the
// blueprint's canonical-key assertions since normalization is load-bearing
// for both suppression and dedup.

import { describe, expect, test } from "bun:test";

import { EmissionGuard, normalizeAdvisorNote } from "./emission-guard.ts";

describe("normalizeAdvisorNote", () => {
	test("lowercases, NFKC-folds, collapses non-alphanumeric runs, trims", () => {
		expect(normalizeAdvisorNote("Stop.")).toBe("stop");
		expect(normalizeAdvisorNote("  STOP!  ")).toBe("stop");
		expect(normalizeAdvisorNote("*Stop*")).toBe("stop");
		expect(normalizeAdvisorNote("Done.")).toBe("done");
		expect(normalizeAdvisorNote("No issue; continue.")).toBe("no issue continue");
	});

	test("returns empty string for empty / whitespace / punctuation-only input", () => {
		expect(normalizeAdvisorNote("")).toBe("");
		expect(normalizeAdvisorNote("   ")).toBe("");
		expect(normalizeAdvisorNote("...")).toBe("");
	});

	test("preserves letters and digits, folds internal punctuation to one space", () => {
		expect(normalizeAdvisorNote("Refactor `auth-flow.ts`: drop legacy branch.")).toBe(
			"refactor auth flow ts drop legacy branch",
		);
	});
});

describe("EmissionGuard", () => {
	// Spec case 1: first meaningful note → allowed.
	test("first meaningful note is allowed", () => {
		const guard = new EmissionGuard();
		guard.beginUpdate();
		expect(guard.accept("Add retry back-off", "nit")).toEqual({ allowed: true });
	});

	// Spec case 2: "Stop.", "LGTM!", "  " → content-free (regardless of severity).
	test("content-free filler is suppressed with reason 'content-free' even at blocker", () => {
		const guard = new EmissionGuard();
		guard.beginUpdate();
		expect(guard.accept("Stop.", "blocker")).toEqual({ allowed: false, reason: "content-free" });
		expect(guard.accept("LGTM!", "blocker")).toEqual({ allowed: false, reason: "content-free" });
		expect(guard.accept("  ", "blocker")).toEqual({ allowed: false, reason: "content-free" });
	});

	// Spec case 3: same note twice (same severity) across two updates → duplicate.
	test("same note at same severity across updates is a duplicate", () => {
		const guard = new EmissionGuard();
		guard.beginUpdate();
		expect(guard.accept("Race in #handleRetry", "concern")).toEqual({ allowed: true });
		guard.beginUpdate();
		expect(guard.accept("Race in #handleRetry", "concern")).toEqual({
			allowed: false,
			reason: "duplicate",
		});
	});

	// Spec case 4: normalization dedup.
	test("dedup keys on normalized text, ignoring casing and punctuation", () => {
		const guard = new EmissionGuard();
		guard.beginUpdate();
		expect(guard.accept("Add retry back-off!", "nit")).toEqual({ allowed: true });
		guard.beginUpdate();
		expect(guard.accept("add retry  back-off", "nit")).toEqual({
			allowed: false,
			reason: "duplicate",
		});
	});

	// Spec case 5: escalation re-pass (nit→concern→blocker).
	test("strictly higher severity re-allows an already-seen note and updates the stored rank", () => {
		const guard = new EmissionGuard();
		const note = "Missing await on writeStream.end()";
		guard.beginUpdate();
		expect(guard.accept(note, "nit")).toEqual({ allowed: true });
		guard.beginUpdate();
		expect(guard.accept(note, "concern")).toEqual({ allowed: true });
		guard.beginUpdate();
		expect(guard.accept(note, "concern")).toEqual({ allowed: false, reason: "duplicate" });
		guard.beginUpdate();
		expect(guard.accept(note, "blocker")).toEqual({ allowed: true });
		guard.beginUpdate();
		// Down-ranking after a higher rank was emitted is NOT an escalation.
		expect(guard.accept(note, "nit")).toEqual({ allowed: false, reason: "duplicate" });
	});

	// Spec case 6: budget.
	test("at most one allowed note per update; beginUpdate resets the budget", () => {
		const guard = new EmissionGuard();
		guard.beginUpdate();
		expect(guard.accept("First concern: missing await", "concern")).toEqual({ allowed: true });
		expect(guard.accept("Second concern: wrong env var", "concern")).toEqual({
			allowed: false,
			reason: "budget",
		});
		guard.beginUpdate();
		expect(guard.accept("Third concern: cache eviction never fires", "concern")).toEqual({
			allowed: true,
		});
	});

	// Spec case 7: suppressed call doesn't consume budget.
	test("a content-free call does not consume the per-update budget", () => {
		const guard = new EmissionGuard();
		guard.beginUpdate();
		expect(guard.accept("Stop.", "blocker")).toEqual({ allowed: false, reason: "content-free" });
		expect(guard.accept("Concrete: read race in #handleRetry", "concern")).toEqual({
			allowed: true,
		});
	});

	// Spec case 8: FIFO eviction at constructor-injectable capacity.
	test("evicted notes can resurface after FIFO eviction at capacity", () => {
		const guard = new EmissionGuard({ capacity: 3 });
		guard.beginUpdate();
		expect(guard.accept("first", "nit")).toEqual({ allowed: true });
		guard.beginUpdate();
		expect(guard.accept("second", "nit")).toEqual({ allowed: true });
		guard.beginUpdate();
		expect(guard.accept("third", "nit")).toEqual({ allowed: true });
		// "first" still in history.
		guard.beginUpdate();
		expect(guard.accept("first", "nit")).toEqual({ allowed: false, reason: "duplicate" });
		// Fourth unique entry evicts "first".
		guard.beginUpdate();
		expect(guard.accept("fourth", "nit")).toEqual({ allowed: true });
		guard.beginUpdate();
		expect(guard.accept("first", "nit")).toEqual({ allowed: true });
	});

	test("default capacity is 4096", () => {
		// Indirectly: a note seen once is remembered across many updates, well
		// under the 4096 default. We assert the guard does NOT evict at counts
		// far below the default capacity (sanity check on the constant).
		const guard = new EmissionGuard();
		for (let i = 0; i < 1000; i++) {
			guard.beginUpdate();
			expect(guard.accept(`unique note number ${i}`, "nit")).toEqual({ allowed: true });
		}
		// The very first note must still be deduped (not evicted).
		guard.beginUpdate();
		expect(guard.accept("unique note number 0", "nit")).toEqual({
			allowed: false,
			reason: "duplicate",
		});
	});
});
