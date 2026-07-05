// Tests for the backlog queue & backpressure (PLAN §10, issue #06).
//
// Single-flight drain with merge-on-catchup, hysteresis bounded blocking,
// abort responsiveness, and failure protection. Review completion is governed
// by deferred promises resolved manually — no fake timers, no fixed sleeps;
// real timeouts are kept small (≤50ms) and only used where the timeout path
// itself is under test. The nine cases mirror the issue spec 1:1.

import { describe, expect, test } from "bun:test";

import { BacklogQueue, type BacklogOptions } from "./backlog.ts";

/** Manual completion handle for controlling async review timing in tests. */
class Deferred<T> {
	readonly promise: Promise<T>;
	resolve!: (v: T) => void;
	reject!: (e: unknown) => void;
	constructor() {
		this.promise = new Promise<T>((resolve, reject) => {
			this.resolve = resolve;
			this.reject = reject;
		});
	}
}

/** Recorded review invocation. */
interface ReviewCall {
	batch: string[];
	epoch: number;
}

/**
 * Injected review runner whose completion the test controls via `parked`.
 * Each call records itself, fulfills the next pending `waitForCall` waiter
 * (so the test can await the Nth call event-driven), then parks on a fresh
 * deferred the test resolves. `onEnter` / `onExit` bracket the active window
 * for the single-flight concurrency assertion.
 */
function makeController(opts: { onEnter?: () => void; onExit?: () => void } = {}) {
	const calls: ReviewCall[] = [];
	const parked: Deferred<void>[] = [];
	const callWaiters: Array<() => void> = [];
	const review: BacklogOptions["review"] = async (batch, epoch) => {
		calls.push({ batch, epoch });
		opts.onEnter?.();
		callWaiters.shift()?.();
		const p = new Deferred<void>();
		parked.push(p);
		try {
			await p.promise;
		} finally {
			opts.onExit?.();
		}
	};
	/** Resolves when the next review call AFTER this registration occurs. */
	const waitForCall = (): Promise<void> => new Promise<void>((r) => callWaiters.push(r));
	return { calls, parked, review, waitForCall };
}

describe("BacklogQueue", () => {
	// Spec case 1: two pushes while first review in flight → second review
	// called once with both deltas merged.
	test("merges pending deltas into the next review after an in-flight one finishes", async () => {
		const { calls, parked, review, waitForCall } = makeController();
		const q = new BacklogQueue({ review });

		const firstCall = waitForCall();
		q.push("a");
		await firstCall;
		expect(calls[0].batch).toEqual(["a"]);

		q.push("b");
		q.push("c");
		// Still single-flight: only the first review is running.
		expect(parked.length).toBe(1);

		const secondCall = waitForCall();
		parked[0].resolve();
		await secondCall;
		expect(calls.length).toBe(2);
		expect(calls[1].batch).toEqual(["b", "c"]);

		parked[1].resolve();
		await q.idle();
	});

	// Spec case 2: single-flight — review never concurrently invoked.
	test("never invokes review concurrently", async () => {
		let active = 0;
		let maxActive = 0;
		const { parked, review, waitForCall } = makeController({
			onEnter: () => {
				active++;
				maxActive = Math.max(maxActive, active);
			},
			onExit: () => {
				active--;
			},
		});
		const q = new BacklogQueue({ review });

		const firstCall = waitForCall();
		for (const d of ["a", "b", "c", "d", "e"]) q.push(d);
		await firstCall;
		// The first push kicked the drain before the rest queued, so the first
		// review drains only ["a"]; the remainder is merged into review #2.
		expect(parked.length).toBe(1);

		const secondCall = waitForCall();
		parked[0].resolve();
		await secondCall;
		expect(parked.length).toBe(2);

		parked[1].resolve();
		await q.idle();
		expect(maxActive).toBe(1);
	});

	// Spec case 3: waitForCatchup resolves immediately under high.
	test("waitForCatchup resolves immediately when backlog < high", async () => {
		const { review } = makeController();
		const q = new BacklogQueue({ review });
		const start = Date.now();
		await q.waitForCatchup({ high: 10, low: 5, timeoutMs: 1000 });
		expect(Date.now() - start).toBeLessThan(20);
	});

	// Spec case 4: blocks at high=2 with 3 backlog, resolves when drain
	// brings it ≤ low=1.
	test("waitForCatchup blocks above high and resolves when drain reaches low", async () => {
		const { parked, review, waitForCall } = makeController();
		const statuses: { backlog: number; blocked: boolean }[] = [];
		const q = new BacklogQueue({ review, onStatus: (s) => statuses.push(s) });

		const firstCall = waitForCall();
		q.push("a");
		await firstCall;
		q.push("b");
		q.push("c");
		expect(q.backlog).toBe(3); // 1 in-flight + 2 pending

		const blocking = q.waitForCatchup({ high: 2, low: 1, timeoutMs: 1000 });
		expect(statuses).toEqual([{ backlog: 3, blocked: true }]);

		// First review settles: backlog drops to 2 (pending b,c). Still > low.
		const secondCall = waitForCall();
		parked[0].resolve();
		await secondCall;
		expect(q.backlog).toBe(2);

		// Second review settles: backlog drops to 0 ≤ low → release.
		parked[1].resolve();
		await blocking;
		expect(q.backlog).toBe(0);
		expect(statuses).toEqual([
			{ backlog: 3, blocked: true },
			{ backlog: 0, blocked: false },
		]);
		await q.idle();
	});

	// Spec case 5: waitForCatchup timeout resolves (never rejects).
	test("waitForCatchup timeout resolves rather than rejecting", async () => {
		const { parked, review, waitForCall } = makeController();
		const statuses: { backlog: number; blocked: boolean }[] = [];
		const q = new BacklogQueue({ review, onStatus: (s) => statuses.push(s) });

		const firstCall = waitForCall();
		q.push("a");
		await firstCall;
		q.push("b");
		q.push("c");
		expect(q.backlog).toBe(3);

		const start = Date.now();
		await q.waitForCatchup({ high: 2, low: 1, timeoutMs: 20 });
		const elapsed = Date.now() - start;
		expect(elapsed).toBeGreaterThanOrEqual(15);
		expect(elapsed).toBeLessThan(200);
		// Timeout releases with backlog still 3 (review never resolved).
		expect(statuses).toEqual([
			{ backlog: 3, blocked: true },
			{ backlog: 3, blocked: false },
		]);

		// Clean up the dangling drain so the test leaves no hanging work.
		const secondCall = waitForCall();
		parked[0].resolve();
		await secondCall;
		parked[1].resolve();
		await q.idle();
	});

	// Spec case 6: waitForCatchup abort path resolves promptly.
	test("waitForCatchup abort resolves promptly", async () => {
		const { review, waitForCall } = makeController();
		const statuses: { backlog: number; blocked: boolean }[] = [];
		const q = new BacklogQueue({ review, onStatus: (s) => statuses.push(s) });

		const firstCall = waitForCall();
		q.push("a");
		await firstCall;
		q.push("b");
		q.push("c");
		expect(q.backlog).toBe(3);

		const ac = new AbortController();
		const start = Date.now();
		const blocking = q.waitForCatchup({ high: 2, low: 1, timeoutMs: 5000, signal: ac.signal });
		await Promise.resolve(); // let the abort listener register
		ac.abort();
		await blocking;
		expect(Date.now() - start).toBeLessThan(50);
		expect(statuses).toEqual([
			{ backlog: 3, blocked: true },
			{ backlog: 3, blocked: false },
		]);
	});

	// Spec case 7: hysteresis — after unblocking at low, doesn't re-block
	// until backlog ≥ high again.
	test("hysteresis: after unblocking at low, does not re-block until >= high again", async () => {
		const { parked, review, waitForCall } = makeController();
		const statuses: { backlog: number; blocked: boolean }[] = [];
		const q = new BacklogQueue({ review, onStatus: (s) => statuses.push(s) });

		// Build backlog=4: one in-flight review (a) + 3 pending.
		const c1 = waitForCall();
		q.push("a");
		await c1;
		q.push("b");
		q.push("c");
		q.push("d");
		expect(q.backlog).toBe(4);

		const blocking1 = q.waitForCatchup({ high: 4, low: 2, timeoutMs: 1000 });
		expect(statuses).toEqual([{ backlog: 4, blocked: true }]);

		// Drain: resolve a (backlog 3), then merged b,c,d (backlog 0 ≤ low).
		const c2 = waitForCall();
		parked[0].resolve();
		await c2;
		expect(q.backlog).toBe(3);
		parked[1].resolve();
		await blocking1;
		expect(q.backlog).toBe(0);
		expect(statuses).toEqual([
			{ backlog: 4, blocked: true },
			{ backlog: 0, blocked: false },
		]);
		await q.idle();

		// Push one delta: backlog=1, between low(2) and high(4) → no re-block.
		const c3 = waitForCall();
		q.push("e");
		await c3;
		const start = Date.now();
		await q.waitForCatchup({ high: 4, low: 2, timeoutMs: 1000 });
		expect(Date.now() - start).toBeLessThan(20);
		expect(statuses.length).toBe(2); // no new transition
		parked[2].resolve();
		await q.idle();

		// Push back up to high → re-blocks.
		const c4 = waitForCall();
		q.push("f");
		await c4;
		q.push("g");
		q.push("h");
		q.push("i");
		expect(q.backlog).toBe(4);

		const blocking2 = q.waitForCatchup({ high: 4, low: 2, timeoutMs: 1000 });
		expect(statuses[2]).toEqual({ backlog: 4, blocked: true });

		const c5 = waitForCall();
		parked[3].resolve();
		await c5;
		parked[4].resolve();
		await blocking2;
		await q.idle();
	});

	// Spec case 8: 3 consecutive failures drop pending, call
	// onFailureGiveUp once, reset backlog to 0.
	test("3 consecutive failures drop pending and trip onFailureGiveUp once", async () => {
		const giveUps: unknown[] = [];
		const { calls, parked, review, waitForCall } = makeController();
		const q = new BacklogQueue({ review, onFailureGiveUp: (e) => giveUps.push(e) });

		const c1 = waitForCall();
		q.push("a");
		await c1;
		parked[0].reject(new Error("f1"));
		await q.idle();
		expect(q.backlog).toBe(0);

		const c2 = waitForCall();
		q.push("b");
		await c2;
		parked[1].reject(new Error("f2"));
		await q.idle();

		// Third consecutive failure with a pending delta that must be dropped.
		const c3 = waitForCall();
		q.push("c");
		await c3;
		q.push("d"); // pending — must be dropped by the give-up
		expect(q.backlog).toBe(2); // 1 in-flight (c) + 1 pending (d)

		parked[2].reject(new Error("f3"));
		await q.idle();

		expect(giveUps.length).toBe(1);
		expect((giveUps[0] as Error).message).toBe("f3");
		expect(q.backlog).toBe(0);
		// No fourth review was launched (pending dropped, drain returned).
		expect(calls.length).toBe(3);
	});

	// Spec case 8 (cont.): a successful review between failures resets the
	// streak so 2 subsequent failures do NOT trip the give-up.
	test("a successful review between failures resets the failure streak", async () => {
		const giveUps: unknown[] = [];
		const { parked, review, waitForCall } = makeController();
		const q = new BacklogQueue({ review, onFailureGiveUp: (e) => giveUps.push(e) });

		const c1 = waitForCall();
		q.push("a");
		await c1;
		parked[0].reject(new Error("f1"));
		await q.idle();

		const c2 = waitForCall();
		q.push("b");
		await c2;
		parked[1].reject(new Error("f2"));
		await q.idle();

		// Success resets the streak to 0.
		const c3 = waitForCall();
		q.push("c");
		await c3;
		parked[2].resolve();
		await q.idle();

		const c4 = waitForCall();
		q.push("d");
		await c4;
		parked[3].reject(new Error("f3"));
		await q.idle();

		const c5 = waitForCall();
		q.push("e");
		await c5;
		parked[4].reject(new Error("f4"));
		await q.idle();

		// Only 2 consecutive failures after the reset — no give-up.
		expect(giveUps.length).toBe(0);
	});

	// Spec case 9: bumpEpoch clears pending; a stale review completion
	// doesn't corrupt backlog count or emit late status.
	test("bumpEpoch clears pending and a stale completion does not corrupt backlog or emit status", async () => {
		const statuses: { backlog: number; blocked: boolean }[] = [];
		const { calls, parked, review, waitForCall } = makeController();
		const q = new BacklogQueue({ review, onStatus: (s) => statuses.push(s) });

		const c1 = waitForCall();
		q.push("a");
		await c1;
		q.push("b");
		q.push("c");
		expect(q.backlog).toBe(3); // 1 in-flight + 2 pending

		// Block a waitForCatchup with low=0 so clearing pending (backlog→1)
		// does not release it; only the stale completion path is in question.
		const ac = new AbortController();
		const blocking = q.waitForCatchup({ high: 2, low: 0, timeoutMs: 5000, signal: ac.signal });
		expect(statuses).toEqual([{ backlog: 3, blocked: true }]);

		// Bump epoch: pending cleared, in-flight review invalidated.
		const epoch = q.bumpEpoch();
		expect(epoch).toBe(1);
		expect(q.backlog).toBe(1); // pending 0 + in-flight 1
		expect(calls[0].epoch).toBe(0);
		// bumpEpoch must not emit a status transition.
		expect(statuses).toEqual([{ backlog: 3, blocked: true }]);

		// Stale review completes: must not unblock the waiter, not emit
		// status, and not launch a new review (pending was cleared).
		parked[0].resolve();
		await q.idle();
		expect(q.backlog).toBe(0);
		expect(calls.length).toBe(1);
		expect(statuses).toEqual([{ backlog: 3, blocked: true }]);

		// Release the still-blocked waiter via abort; only now does the
		// blocked:false transition fire.
		ac.abort();
		await blocking;
		expect(statuses).toEqual([
			{ backlog: 3, blocked: true },
			{ backlog: 0, blocked: false },
		]);

		// A push after bumpEpoch runs a fresh review at the new epoch.
		const c2 = waitForCall();
		q.push("d");
		await c2;
		expect(calls[1].epoch).toBe(1);
		expect(calls[1].batch).toEqual(["d"]);
		parked[1].resolve();
		await q.idle();
	});
});
