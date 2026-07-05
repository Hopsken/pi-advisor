// Backlog & backpressure — single-flight review drain with merge-on-catchup,
// hysteresis bounded blocking, abort responsiveness, and failure protection.
// PLAN §10; issue #06. Blueprint: oh-my-pi
// `packages/coding-agent/src/advisor/runtime.ts:155-179,314-320`.
//
// The host platform's `turn_end` handler is awaited serially by pi's extension
// runner, so a handler can bound the primary agent's next turn by awaiting a
// `waitForCatchup` promise. The advisor runs a slow model, so a finished review
// must NEVER be aborted just because more turns arrived — instead, new deltas
// queue and the next review merges ALL of them (`splice(0)`) into one batch, so
// the advisor catches up several turns at once and sees the latest full
// picture. Blocking is a safety valve: it only fires at a high watermark and
// releases at a lower one (hysteresis) to avoid edge jitter, with a timeout and
// an abort-signal race so a user-initiated cancel always releases promptly.
//
// `review` is injected so this module is pure scheduling logic — the
// `AdvisorController` (issue #10) supplies a function that runs the advisor
// prompt against a child session. The epoch mechanism lets the controller
// invalidate an in-flight review at a reset boundary (compaction, branch
// switch, overflow): a bumped epoch clears pending turns and makes a stale
// review's completion a no-op for backlog/status/failure accounting. The
// controller separately aborts the actual advisor session.

/** Injected review runner. Receives the merged batch and the epoch at batch
 *  start. A rejection counts toward the failure streak. */
export interface BacklogOptions {
	review: (batch: string[], epoch: number) => Promise<void>;
	/** Called on blocked:true / blocked:false transitions (hysteresis edges). */
	onStatus?: (s: { backlog: number; blocked: boolean }) => void;
	/** Called once when 3 consecutive `review` rejections trip the give-up. */
	onFailureGiveUp?: (err: unknown) => void;
}

/** Options for {@link BacklogQueue.waitForCatchup}. */
export interface WaitForCatchupOptions {
	/** Block while `backlog >= high`. */
	high: number;
	/** Release once `backlog <= low` (hysteresis low watermark). */
	low: number;
	/** Maximum block duration; elapsing releases (resolves, not rejects). */
	timeoutMs: number;
	/** Aborting releases promptly (resolves, not rejects). PLAN §10 "race ctx.signal". */
	signal?: AbortSignal;
}

interface Waiter {
	threshold: number;
	finish: () => void;
}

/** Number of consecutive `review` rejections before the give-up trips. */
const FAILURE_LIMIT = 3;

/**
 * Single-flight drain queue with hysteresis backpressure.
 *
 * - `push` enqueues a delta and kicks the drain; it never awaits `review`.
 * - The drain pops ALL pending deltas as one batch per review (merge-on-
 *   catchup) and runs at most one `review` at a time.
 * - `backlog` is the live count of pending + in-flight turns (pushes not yet
 *   covered by a fresh, successful review).
 * - `bumpEpoch` clears pending and invalidates an in-flight review's result.
 * - `waitForCatchup` blocks the caller above `high` until `low`/timeout/abort.
 */
export class BacklogQueue {
	#opts: BacklogOptions;
	#pending: string[] = [];
	/** Turns currently under review (the in-flight batch size). 0 when parked. */
	#inFlight = 0;
	#epoch = 0;
	#consecutiveFailures = 0;
	#drainRunning = false;
	#waiters: Waiter[] = [];
	#idleWaiters: Array<() => void> = [];
	/** Number of active blocking waitForCatchup callers; drives status edges. */
	#blockCount = 0;

	constructor(opts: BacklogOptions) {
		this.#opts = opts;
	}

	/** Pending + in-flight turn count. Never negative. */
	get backlog(): number {
		return this.#pending.length + this.#inFlight;
	}

	/** Enqueue a delta and kick the drain. Never awaits `review`. */
	push(delta: string): void {
		this.#pending.push(delta);
		void this.#drain();
	}

	/**
	 * Invalidate an in-flight review at a reset boundary (compaction, branch
	 * switch, overflow). Clears pending deltas and bumps the epoch so the
	 * in-flight review's completion is a no-op for backlog, status, and
	 * failure accounting. Returns the new epoch. The controller aborts the
	 * actual advisor session separately.
	 */
	bumpEpoch(): number {
		this.#epoch++;
		this.#pending = [];
		this.#notifyWaiters();
		return this.#epoch;
	}

	/**
	 * For tests: resolves when the drain loop is parked (no in-flight review
	 * and no pending deltas). Resolves immediately if already parked.
	 */
	idle(): Promise<void> {
		if (!this.#drainRunning && this.#pending.length === 0 && this.#inFlight === 0) {
			return Promise.resolve();
		}
		return new Promise<void>((resolve) => this.#idleWaiters.push(resolve));
	}

	/**
	 * Block the caller while `backlog >= high`, releasing once `backlog <= low`,
	 * `timeoutMs` elapses, or `signal` aborts. All release paths RESOLVE (never
	 * reject) — the caller simply stops blocking. Resolves immediately if
	 * `backlog < high`. Emits `onStatus` blocked:true on entry to a block and
	 * blocked:false when the last blocker releases (hysteresis edges).
	 */
	async waitForCatchup(opts: WaitForCatchupOptions): Promise<void> {
		if (this.backlog < opts.high) return;
		this.#enterBlock();
		try {
			await this.#awaitRelease(opts);
		} finally {
			this.#exitBlock();
		}
	}

	#enterBlock(): void {
		this.#blockCount++;
		if (this.#blockCount === 1) {
			this.#opts.onStatus?.({ backlog: this.backlog, blocked: true });
		}
	}

	#exitBlock(): void {
		this.#blockCount = Math.max(0, this.#blockCount - 1);
		if (this.#blockCount === 0) {
			this.#opts.onStatus?.({ backlog: this.backlog, blocked: false });
		}
	}

	#awaitRelease(opts: WaitForCatchupOptions): Promise<void> {
		return new Promise<void>((resolve) => {
			let done = false;
			const finish = () => {
				if (done) return;
				done = true;
				clearTimeout(timer);
				opts.signal?.removeEventListener("abort", onAbort);
				this.#removeWaiter(waiter);
				resolve();
			};
			const waiter: Waiter = { threshold: opts.low, finish };
			this.#waiters.push(waiter);
			const timer = setTimeout(finish, opts.timeoutMs);
			const onAbort = () => finish();
			opts.signal?.addEventListener("abort", onAbort, { once: true });
			// Race: backlog may have already dropped to <= low between the
			// entry check and registration. Re-check before parking.
			if (this.backlog <= opts.low) finish();
		});
	}

	#removeWaiter(waiter: Waiter): void {
		const i = this.#waiters.indexOf(waiter);
		if (i >= 0) this.#waiters.splice(i, 1);
	}

	/** Release every waiter whose `backlog <= threshold`. */
	#notifyWaiters(): void {
		for (let i = this.#waiters.length - 1; i >= 0; i--) {
			const w = this.#waiters[i];
			if (this.backlog <= w.threshold) {
				w.finish();
			}
		}
	}

	/** Single-flight drain. Pops all pending as one batch per review. */
	async #drain(): Promise<void> {
		if (this.#drainRunning) return;
		this.#drainRunning = true;
		try {
			while (this.#pending.length > 0) {
				const batch = this.#pending.splice(0);
				const epoch = this.#epoch;
				this.#inFlight = batch.length;
				try {
					await this.#opts.review(batch, epoch);
					if (epoch === this.#epoch) {
						this.#consecutiveFailures = 0;
					}
				} catch (err) {
					if (epoch === this.#epoch) {
						this.#consecutiveFailures++;
						if (this.#consecutiveFailures >= FAILURE_LIMIT) {
							const last = err;
							this.#pending = [];
							this.#consecutiveFailures = 0;
							this.#inFlight = 0;
							this.#opts.onFailureGiveUp?.(last);
							this.#notifyWaiters();
							return;
						}
					}
				} finally {
					// Release in-flight turns. For stale epochs this drops them
					// without decrementing any separate counter (backlog is
					// computed live, so it cannot go below 0); for fresh epochs
					// the now-empty in-flight simply reflects completion.
					this.#inFlight = 0;
				}
				if (epoch === this.#epoch) {
					this.#notifyWaiters();
				}
			}
		} finally {
			this.#drainRunning = false;
			const idle = this.#idleWaiters;
			this.#idleWaiters = [];
			for (const resolve of idle) resolve();
		}
	}
}
