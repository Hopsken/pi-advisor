// Tests for branch alignment (entry-id LCP). PLAN §5, issue #03.
//
// Pure functions: `longestCommonPrefixLen` and `planAlignment` decide, from the
// sequence of main-branch entry ids already fed to the advisor (`fed`) versus
// the current branch's entry ids (`cur`), whether the advisor context is still
// a prefix-extension of what it has seen (advance / noop) or has forked
// (divergence → reset + full replay, "档 A").
//
// The seven cases below map 1:1 onto the issue spec. Lifecycle corrections
// from PLAN §5 are encoded as cases: `fed=[]` + non-empty `cur` is `advance`
// (cold start / post-fork / late-enable all reduce to this, since the
// extension instance is rebuilt on fork/new/resume); a rewind where `cur` is a
// strict prefix of `fed` is `divergence` (the advisor has seen ahead of the
// current branch, so its context is stale on a now-abandoned path).

import { describe, expect, test } from "bun:test";

import { longestCommonPrefixLen, planAlignment } from "./align.ts";

describe("longestCommonPrefixLen", () => {
	// Spec case 7: property-style spot checks incl. empty arrays.
	test("empty arrays yield 0", () => {
		expect(longestCommonPrefixLen([], [])).toBe(0);
		expect(longestCommonPrefixLen([], ["a"])).toBe(0);
		expect(longestCommonPrefixLen(["a"], [])).toBe(0);
	});

	test("identical arrays share their full length as prefix", () => {
		expect(longestCommonPrefixLen(["a", "b", "c"], ["a", "b", "c"])).toBe(3);
		expect(longestCommonPrefixLen(["x"], ["x"])).toBe(1);
	});

	test("stops at the first differing element", () => {
		expect(longestCommonPrefixLen(["a", "b", "c"], ["a", "b", "x"])).toBe(2);
		expect(longestCommonPrefixLen(["a", "b"], ["a", "x", "z"])).toBe(1);
		expect(longestCommonPrefixLen(["x"], ["a", "b", "c"])).toBe(0);
	});

	test("is bounded by the shorter array (prefix-of case)", () => {
		expect(longestCommonPrefixLen(["a", "b"], ["a", "b", "c", "d"])).toBe(2);
		expect(longestCommonPrefixLen(["a", "b", "c", "d"], ["a", "b"])).toBe(2);
	});

	test("is symmetric and reflexive (property spot checks)", () => {
		const a = ["e1", "e2", "e3"];
		const b = ["e1", "e2", "e9"];
		expect(longestCommonPrefixLen(a, b)).toBe(longestCommonPrefixLen(b, a));
		expect(longestCommonPrefixLen(a, a)).toBe(a.length);
		// Result never exceeds the shorter length.
		const k = longestCommonPrefixLen(a, b);
		expect(k).toBeLessThanOrEqual(Math.min(a.length, b.length));
	});
});

describe("planAlignment", () => {
	// Spec case 1: cold start. fed=[] with non-empty cur → advance with all of
	// cur (PLAN §5: fork/new/resume rebuild the extension instance, so the
	// first observe always reduces to a full-snapshot replay framed as advance).
	test("cold start: fed=[] , cur=[a,b] → advance [a,b]", () => {
		expect(planAlignment([], ["a", "b"])).toEqual({ kind: "advance", newIds: ["a", "b"] });
	});

	// Spec case 2: pure advance — cur extends fed with new entries.
	test("pure advance: fed=[a,b], cur=[a,b,c,d] → advance [c,d]", () => {
		expect(planAlignment(["a", "b"], ["a", "b", "c", "d"])).toEqual({
			kind: "advance",
			newIds: ["c", "d"],
		});
	});

	// Spec case 3: no change → noop.
	test("no change → noop", () => {
		expect(planAlignment(["a", "b"], ["a", "b"])).toEqual({ kind: "noop" });
	});

	// Spec case 4: divergence mid-branch — k < fed.length, the advisor's
	// context [k:] belongs to an abandoned path.
	test("divergence mid-branch: fed=[a,b,c], cur=[a,b,x] → divergence commonLen 2", () => {
		expect(planAlignment(["a", "b", "c"], ["a", "b", "x"])).toEqual({
			kind: "divergence",
			commonLen: 2,
		});
	});

	// Spec case 5: rewind — cur is a strict prefix of fed. The advisor has seen
	// past the current leaf; its trailing context is stale. Still divergence.
	test("rewind (cur strict prefix): fed=[a,b,c], cur=[a] → divergence commonLen 1", () => {
		expect(planAlignment(["a", "b", "c"], ["a"])).toEqual({ kind: "divergence", commonLen: 1 });
	});

	// Spec case 6: total divergence — no shared prefix.
	test("total divergence: no common prefix → divergence commonLen 0", () => {
		expect(planAlignment(["a", "b", "c"], ["x", "y"])).toEqual({
			kind: "divergence",
			commonLen: 0,
		});
	});

	// Edge: both empty → noop (the advisor is up to date on an empty branch).
	test("both empty → noop", () => {
		expect(planAlignment([], [])).toEqual({ kind: "noop" });
	});

	// Edge: advance newIds is a fresh array slice, not an alias into cur, so
	// callers can mutate it freely without surprising the branch owner.
	test("advance newIds is a copy, not an alias into cur", () => {
		const cur = ["a", "b", "c"];
		const plan = planAlignment([], cur);
		if (plan.kind !== "advance") throw new Error("expected advance");
		expect(plan.newIds).not.toBe(cur);
		plan.newIds.push("MUTATED");
		expect(cur).toEqual(["a", "b", "c"]);
	});
});
