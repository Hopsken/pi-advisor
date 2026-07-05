// Tests for the delivery policy (PLAN §7-§8, issue #05).
//
// Pure decision function mapping an accepted advisor note (severity already
// vetted by the emission guard) to a pi delivery mode. The seven cases below
// mirror the issue spec 1:1: the nit short-circuit, the normal concern/blocker
// channels with `triggerTurn` driven by `autoResume`, the immune cooldown
// window, the `autoResumeSuppressed` gate (park when idle, steer when live),
// and the `autoResumeAllows` truth table. `isImmune` is covered separately for
// reuse by later issues.

import { describe, expect, test } from "bun:test";

import { autoResumeAllows, isImmune, resolveDelivery, type DeliveryState } from "./deliver.ts";
import type { AdvisorConfig, AutoResume, Severity } from "./types.ts";
import { DEFAULT_CONFIG } from "./types.ts";

const CLEAN: DeliveryState = {
	streaming: false,
	autoResumeSuppressed: false,
	completedTurns: 0,
	immuneTurnStart: null,
};

function config(over: Partial<AdvisorConfig> = {}): AdvisorConfig {
	return { ...DEFAULT_CONFIG, ...over };
}

describe("resolveDelivery", () => {
	// Spec case 1: nit always nextTurn, never triggers, never "downgraded" —
	// regardless of streaming, suppression, immune window, or autoResume.
	test("nit always rides nextTurn regardless of state/config", () => {
		const states: DeliveryState[] = [
			{ ...CLEAN },
			{ streaming: true, autoResumeSuppressed: true, completedTurns: 99, immuneTurnStart: 5 },
			{ streaming: false, autoResumeSuppressed: false, completedTurns: 6, immuneTurnStart: 5 },
		];
		const orders: AutoResume[] = ["off", "blocker", "concern", "all"];
		for (const state of states) {
			for (const autoResume of orders) {
				expect(resolveDelivery("nit", state, config({ autoResume }))).toEqual({
					deliverAs: "nextTurn",
					triggerTurn: false,
					downgraded: false,
				});
			}
		}
	});

	// Spec case 2: blocker while streaming, clean state -> steer + triggerTurn
	// (autoResume defaults to "concern", which allows blocker).
	test("blocker while streaming with clean state steers and triggers", () => {
		const state: DeliveryState = { ...CLEAN, streaming: true };
		expect(resolveDelivery("blocker", state, config())).toEqual({
			deliverAs: "steer",
			triggerTurn: true,
			downgraded: false,
		});
	});

	// Spec case 3: concern idle -> followUp; triggerTurn follows autoResume.
	test("concern idle delivers as followUp; triggerTurn follows autoResume", () => {
		const state: DeliveryState = { ...CLEAN, streaming: false };
		expect(resolveDelivery("concern", state, config({ autoResume: "concern" }))).toEqual({
			deliverAs: "followUp",
			triggerTurn: true,
			downgraded: false,
		});
		expect(resolveDelivery("concern", state, config({ autoResume: "blocker" }))).toEqual({
			deliverAs: "followUp",
			triggerTurn: false,
			downgraded: false,
		});
	});

	// Spec case 4: blocker with autoResume=off -> steer but no trigger.
	test("blocker with autoResume=off steers without triggering", () => {
		const state: DeliveryState = { ...CLEAN, streaming: true };
		expect(resolveDelivery("blocker", state, config({ autoResume: "off" }))).toEqual({
			deliverAs: "steer",
			triggerTurn: false,
			downgraded: false,
		});
	});

	// Spec case 5: immune window downgrades concern/blocker to nextTurn until
	// completedTurns reaches immuneTurnStart + immuneTurns; at the boundary the
	// note steers again.
	test("immune window downgrades to nextTurn until completedTurns reaches start + immuneTurns", () => {
		const base = { streaming: true, autoResumeSuppressed: false, immuneTurnStart: 5 };
		// Inside the window: 6 < 5 + 2.
		expect(
			resolveDelivery("blocker", { ...base, completedTurns: 6 }, config({ immuneTurns: 2 })),
		).toEqual({
			deliverAs: "nextTurn",
			triggerTurn: false,
			downgraded: true,
		});
		// At the boundary: 7 < 7 is false -> steer resumes.
		expect(
			resolveDelivery("blocker", { ...base, completedTurns: 7 }, config({ immuneTurns: 2 })),
		).toEqual({
			deliverAs: "steer",
			triggerTurn: true,
			downgraded: false,
		});
	});

	// Spec case 6: autoResumeSuppressed gate. Idle (or tearing down) is parked
	// as a visible nextTurn card so the user's stop is honored ("降级永不丢");
	// but once a turn is actively streaming again the note steers live (matches
	// the blueprint gate `aborting || !streaming`).
	test("autoResumeSuppressed + idle downgrades; suppressed + streaming proceeds", () => {
		const idle: DeliveryState = {
			streaming: false,
			autoResumeSuppressed: true,
			completedTurns: 0,
			immuneTurnStart: null,
		};
		// Idle: both concern and blocker downgraded to nextTurn (still delivered).
		expect(resolveDelivery("concern", idle, config())).toEqual({
			deliverAs: "nextTurn",
			triggerTurn: false,
			downgraded: true,
		});
		expect(resolveDelivery("blocker", idle, config())).toEqual({
			deliverAs: "nextTurn",
			triggerTurn: false,
			downgraded: true,
		});
		// Streaming: NOT downgraded — the user already drove the resume.
		const streaming: DeliveryState = { ...idle, streaming: true };
		expect(resolveDelivery("blocker", streaming, config())).toEqual({
			deliverAs: "steer",
			triggerTurn: true,
			downgraded: false,
		});
		expect(resolveDelivery("concern", streaming, config())).toEqual({
			deliverAs: "followUp",
			triggerTurn: true,
			downgraded: false,
		});
	});
});

describe("autoResumeAllows", () => {
	// Spec case 7: truth table. `off` never; `blocker` blocker-only; `concern`
	// concern+blocker; `all` everything (nit would be allowed here, but rule 1
	// short-circuits nits before this is consulted in resolveDelivery).
	test("off->never; blocker->blocker only; concern->concern+blocker; all->all", () => {
		const table: Record<AutoResume, Record<Severity, boolean>> = {
			off: { nit: false, concern: false, blocker: false },
			blocker: { nit: false, concern: false, blocker: true },
			concern: { nit: false, concern: true, blocker: true },
			all: { nit: true, concern: true, blocker: true },
		};
		const orders: AutoResume[] = ["off", "blocker", "concern", "all"];
		const sevs: Severity[] = ["nit", "concern", "blocker"];
		for (const ar of orders) {
			for (const sev of sevs) {
				expect(autoResumeAllows(ar, sev)).toBe(table[ar][sev]);
			}
		}
	});
});

describe("isImmune", () => {
	test("null immuneTurnStart is never immune", () => {
		expect(isImmune({ ...CLEAN }, config({ immuneTurns: 2 }))).toBe(false);
	});

	test("inside the window is immune; at/after the boundary is not", () => {
		const state = (completedTurns: number): DeliveryState => ({
			streaming: false,
			autoResumeSuppressed: false,
			completedTurns,
			immuneTurnStart: 5,
		});
		expect(isImmune(state(6), config({ immuneTurns: 2 }))).toBe(true);
		expect(isImmune(state(7), config({ immuneTurns: 2 }))).toBe(false);
	});
});
