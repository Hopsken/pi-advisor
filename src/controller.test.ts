// Tests for the AdvisorController — the observe→align→compress→review→deliver
// integration core. PLAN §4/§5/§7/§8/§10, issue #10.
//
// Test seam (PLAN §16): a fake `HostFacade` + fake `AdvisorRunnerLike` whose
// `review()` calls back into the controller's `route` with scripted advice.
// The controller wires the REAL `EmissionGuard` → `resolveDelivery` →
// `facade.sendMessage` path, and a REAL `BacklogQueue` whose `review` /
// `onFailureGiveUp` callbacks close over the controller lazily. No LLM, no pi
// session. Async is kept deterministic via deferred promises and small
// (≤50ms) timeouts only on the timeout-under-test path.

import { describe, expect, test } from "bun:test";

import { AdvisorController, type AdvisorRunnerLike, type HostFacade, type AdvisorMessage, type BranchEntry } from "./controller.ts";
import { BacklogQueue } from "./backlog.ts";
import { EmissionGuard } from "./emission-guard.ts";
import { DEFAULT_CONFIG, type AdvisorConfig, type Severity } from "./types.ts";

// --- test doubles ----------------------------------------------------------

/** Manual completion handle for controlling async review timing. */
class Deferred<T = void> {
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

/** Fake facade: records every observable call and owns the mutable branch. */
class FakeFacade implements HostFacade {
	branch: BranchEntry[] = [];
	sent: AdvisorMessage[] = [];
	statuses: { key: string; text: string | null }[] = [];
	notifications: { text: string; level?: "info" | "warning" | "error" }[] = [];

	getBranchEntries(): BranchEntry[] {
		return [...this.branch];
	}
	sendMessage(msg: AdvisorMessage): void {
		this.sent.push(msg);
	}
	setStatus(key: string, text: string | null): void {
		this.statuses.push({ key, text });
	}
	notify(text: string, level?: "info" | "warning" | "error"): void {
		this.notifications.push({ text, level });
	}
}

/** A single scripted advise item emitted during one fake review. */
interface AdviceItem {
	note: string;
	severity: Severity;
}

/** A per-review script: emit some advice, or throw to simulate a review failure. */
type Script = { advise: AdviceItem[] } | { fail: unknown };

/**
 * Fake runner. Each `review` records the batch, optionally awaits a `gate`
 * deferred (for backpressure timing), then consumes the next scripted script:
 * emit each advise item via `route` (sync), or throw to fail the review.
 */
class FakeRunner implements AdvisorRunnerLike {
	reviews: string[] = [];
	resets = 0;
	ensureSessions = 0;
	disposes = 0;
	scripts: Script[] = [];
	/** If set, each review awaits this before running its script. */
	gate: Deferred<void> | null = null;

	private route: (note: string, severity: Severity) => void = () => {};

	setRoute(fn: (note: string, severity: Severity) => void): void {
		this.route = fn;
	}

	async ensureSession(): Promise<void> {
		this.ensureSessions++;
	}
	async review(batch: string, _opts?: { signal?: AbortSignal }): Promise<void> {
		this.reviews.push(batch);
		if (this.gate) await this.gate.promise;
		const s = this.scripts.shift();
		if (!s) return;
		if ("fail" in s) throw s.fail;
		for (const item of s.advise) this.route(item.note, item.severity);
	}
	async reset(): Promise<void> {
		this.resets++;
	}
	async dispose(): Promise<void> {
		this.disposes++;
	}
}

// --- branch entry builders --------------------------------------------------

let entryCounter = 0;
function resetIds(): void {
	entryCounter = 0;
}

function userEntry(id: string, text: string): BranchEntry {
	return {
		id,
		entry: {
			id,
			parentId: null,
			timestamp: "0",
			type: "message",
			message: { role: "user", content: text },
		},
	};
}

function advisorEntry(id: string, text: string): BranchEntry {
	return {
		id,
		entry: {
			id,
			parentId: null,
			timestamp: "0",
			type: "custom_message",
			customType: "advisor",
			content: text,
			display: true,
		},
	};
}

function compactionEntry(id: string, summary: string): BranchEntry {
	return {
		id,
		entry: { id, parentId: null, timestamp: "0", type: "compaction", summary },
	};
}

// --- wiring harness --------------------------------------------------------

interface Harness {
	ctrl: AdvisorController;
	facade: FakeFacade;
	runner: FakeRunner;
	guard: EmissionGuard;
	backlog: BacklogQueue;
}

/** Wire a real guard + real backlog + fake facade/runner into a controller. */
function makeController(configOver: Partial<AdvisorConfig> = {}): Harness {
	const facade = new FakeFacade();
	const runner = new FakeRunner();
	const guard = new EmissionGuard();
	const config: AdvisorConfig = { ...DEFAULT_CONFIG, ...configOver };
	let ctrl: AdvisorController;
	const backlog = new BacklogQueue({
		review: (batch, epoch) => ctrl.review(batch, epoch),
		onFailureGiveUp: (err) => ctrl.handleGiveUp(err),
	});
	ctrl = new AdvisorController({ facade, runner, guard, backlog, config });
	runner.setRoute((note, sev) => ctrl.route(note, sev));
	return { ctrl, facade, runner, guard, backlog };
}

/** Enable the controller and wait for the seed review to finish. */
async function enable(h: Harness): Promise<void> {
	await h.ctrl.enable();
	await h.backlog.idle();
}

/** Yield to the event loop so pending microtasks (drain, backpressure) settle. */
function tick(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("AdvisorController", () => {
	test("1. happy path: turn_end feeds compressed delta; concern → followUp+triggerTurn", async () => {
		resetIds();
		const h = makeController();
		h.facade.branch = [userEntry("e1", "do the thing")];
		await enable(h);

		h.facade.branch = [userEntry("e1", "do the thing"), userEntry("e2", "did it differently")];
		h.runner.scripts.push({ advise: [{ note: "Use the buffered write path", severity: "concern" }] });
		await h.ctrl.handleTurnEnd();
		await h.backlog.idle();

		// seed review (full branch) + one increment review
		expect(h.runner.reviews.length).toBe(2);
		expect(h.runner.reviews[1]).toContain("did it differently");
		expect(h.runner.reviews[1]).not.toContain("do the thing");
		expect(h.facade.sent.length).toBe(1);
		expect(h.facade.sent[0]).toEqual({
			customType: "advisor",
			content: "Use the buffered write path",
			display: true,
			deliverAs: "followUp",
			triggerTurn: true,
		});
	});

	test("2. loop gate: advisor entry recorded in fedIds but excluded from delta text", async () => {
		resetIds();
		const h = makeController();
		h.facade.branch = [userEntry("e1", "original")];
		await enable(h);

		// Branch grows by the advisor's own injected card AND a new user msg.
		h.facade.branch = [
			userEntry("e1", "original"),
			advisorEntry("a1", "Stop: missing await on writeStream.end"),
			userEntry("e2", "next step"),
		];
		h.runner.scripts.push({ advise: [] });
		await h.ctrl.handleTurnEnd();
		await h.backlog.idle();

		// The delta excludes the advisor's own card text; only the new user msg.
		expect(h.runner.reviews.length).toBe(2);
		expect(h.runner.reviews[1]).toContain("next step");
		expect(h.runner.reviews[1]).not.toContain("missing await");
		// fedIds includes a1 silently: a no-op turn_end does NOT churn a reset.
		await h.ctrl.handleTurnEnd();
		await h.backlog.idle();
		expect(h.runner.reviews.length).toBe(2);
		expect(h.runner.resets).toBe(0);
	});

	test("3. divergence → bumpEpoch + runner.reset with full-branch seed; advance resumes", async () => {
		resetIds();
		const h = makeController();
		h.facade.branch = [userEntry("e1", "first"), userEntry("e2", "second")];
		await enable(h);

		// Branch rewinds mid-history: e2 is replaced by a different e3.
		h.facade.branch = [userEntry("e1", "first"), userEntry("e3", "third")];
		h.runner.scripts.push({ advise: [] });
		await h.ctrl.handleTurnEnd();
		await h.backlog.idle();

		expect(h.runner.resets).toBe(1);
		// Seed review = compressed full branch (e1 + e3), not the stale e2.
		expect(h.runner.reviews[1]).toContain("first");
		expect(h.runner.reviews[1]).toContain("third");
		expect(h.runner.reviews[1]).not.toContain("second");

		// Subsequent advance works from the new fedIds.
		h.facade.branch = [
			userEntry("e1", "first"),
			userEntry("e3", "third"),
			userEntry("e4", "fourth"),
		];
		h.runner.scripts.push({ advise: [{ note: "minor polish", severity: "nit" }] });
		await h.ctrl.handleTurnEnd();
		await h.backlog.idle();
		expect(h.runner.reviews.length).toBe(3);
		expect(h.runner.reviews[2]).toContain("fourth");
		expect(h.runner.reviews[2]).not.toContain("first");
	});

	test("4. session_tree with changed branch → reset flow without a turn_end", async () => {
		resetIds();
		const h = makeController();
		h.facade.branch = [userEntry("e1", "first"), userEntry("e2", "second")];
		await enable(h);

		// Branch rewinds mid-history (a subtree fork) without a turn_end firing.
		h.facade.branch = [userEntry("e1", "first"), userEntry("e3", "third")];
		h.runner.scripts.push({ advise: [] });
		await h.ctrl.handleSessionTree();
		await h.backlog.idle();

		expect(h.runner.resets).toBe(1);
		expect(h.runner.reviews[1]).toContain("first");
		expect(h.runner.reviews[1]).toContain("third");
		expect(h.runner.reviews[1]).not.toContain("second");
		// completedTurns is not incremented by session_tree.
		h.runner.scripts.push({ advise: [{ note: "polish", severity: "nit" }] });
		h.facade.branch = [
			userEntry("e1", "first"),
			userEntry("e3", "third"),
			userEntry("e4", "fourth"),
		];
		await h.ctrl.handleTurnEnd();
		await h.backlog.idle();
		expect(h.runner.reviews[2]).toContain("fourth");
	});

	test("5. session_compact → reset flow re-seeds from compacted branch", async () => {
		resetIds();
		const h = makeController();
		h.facade.branch = [userEntry("e1", "first"), userEntry("e2", "second")];
		await enable(h);

		// A compaction replaces history with a summary + new entry; ids all change.
		h.facade.branch = [
			compactionEntry("c1", "prior work summarized"),
			userEntry("e3", "after compact"),
		];
		h.runner.scripts.push({ advise: [] });
		await h.ctrl.handleSessionCompact();
		await h.backlog.idle();

		expect(h.runner.resets).toBe(1);
		expect(h.runner.reviews[1]).toContain("prior work summarized");
		expect(h.runner.reviews[1]).toContain("after compact");
		expect(h.runner.reviews[1]).not.toContain("second");
	});

	test("6. late enable(): seed is compressed full branch; first turn_end feeds only the increment", async () => {
		resetIds();
		const h = makeController();
		// Branch already populated before enable (mid-session opt-in).
		h.facade.branch = [
			userEntry("e1", "alpha"),
			userEntry("e2", "beta"),
			userEntry("e3", "gamma"),
		];
		await enable(h);

		// Seed review = compressed full branch snapshot.
		expect(h.runner.reviews.length).toBe(1);
		expect(h.runner.reviews[0]).toContain("alpha");
		expect(h.runner.reviews[0]).toContain("beta");
		expect(h.runner.reviews[0]).toContain("gamma");

		// First turn_end after enable feeds only the increment.
		h.facade.branch = [
			userEntry("e1", "alpha"),
			userEntry("e2", "beta"),
			userEntry("e3", "gamma"),
			userEntry("e4", "delta"),
		];
		h.runner.scripts.push({ advise: [{ note: "note", severity: "concern" }] });
		await h.ctrl.handleTurnEnd();
		await h.backlog.idle();
		expect(h.runner.reviews.length).toBe(2);
		expect(h.runner.reviews[1]).toContain("delta");
		expect(h.runner.reviews[1]).not.toContain("alpha");
	});

	test("7. backpressure: blocks at high watermark; drain and abort both release and clear status", async () => {
		resetIds();
		const cfg: Partial<AdvisorConfig> = { syncBacklog: 2, catchupTimeoutMs: 1000 };

		// --- drain path: 3rd turn_end blocks until the gated review completes ---
		{
			const h = makeController(cfg);
			await enable(h); // empty branch → no seed

			const g1 = new Deferred<void>();
			h.runner.gate = g1;
			h.facade.branch = [userEntry("e1", "one")];
			await h.ctrl.handleTurnEnd(); // backlog=1, no block
			g1.resolve();
			await h.backlog.idle();

			const g2 = new Deferred<void>();
			h.runner.gate = g2;
			h.facade.branch = [userEntry("e1", "one"), userEntry("e2", "two")];
			await h.ctrl.handleTurnEnd(); // backlog=1, no block (review2 gated)

			h.facade.branch = [
				userEntry("e1", "one"),
				userEntry("e2", "two"),
				userEntry("e3", "three"),
			];
			let turn3Done = false;
			const turn3 = h.ctrl.handleTurnEnd().then(() => (turn3Done = true));
			await tick();
			expect(turn3Done).toBe(false); // blocked at waitForCatchup
			expect(h.facade.statuses.some((s) => s.text?.startsWith("catching up (2 behind)"))).toBe(true);

			g2.resolve(); // review2 completes → backlog drains to low → release
			await turn3;
			expect(turn3Done).toBe(true);
			expect(h.facade.statuses[h.facade.statuses.length - 1]).toEqual({ key: "advisor", text: null });
			await h.backlog.idle();
		}

		// --- abort path: signal abort releases promptly, status cleared ---
		{
			const h = makeController(cfg);
			await enable(h);

			const g1 = new Deferred<void>();
			h.runner.gate = g1;
			h.facade.branch = [userEntry("e1", "one")];
			await h.ctrl.handleTurnEnd();
			g1.resolve();
			await h.backlog.idle();

			const g2 = new Deferred<void>();
			h.runner.gate = g2;
			h.facade.branch = [userEntry("e1", "one"), userEntry("e2", "two")];
			await h.ctrl.handleTurnEnd();

			const ac = new AbortController();
			h.facade.branch = [
				userEntry("e1", "one"),
				userEntry("e2", "two"),
				userEntry("e3", "three"),
			];
			let turn3Done = false;
			const turn3 = h.ctrl.handleTurnEnd({ signal: ac.signal }).then(() => (turn3Done = true));
			await tick();
			expect(turn3Done).toBe(false);
			expect(h.facade.statuses.some((s) => s.text?.startsWith("catching up (2 behind)"))).toBe(true);

			ac.abort(); // releases promptly
			await turn3;
			expect(turn3Done).toBe(true);
			expect(h.facade.statuses[h.facade.statuses.length - 1]).toEqual({ key: "advisor", text: null });

			g2.resolve(); // ungate the parked review so the drain can settle
			await h.backlog.idle();
		}
	});

	test("8. immune window: blocker steers once, downgrades within immuneTurns, steers again after", async () => {
		resetIds();
		const h = makeController(); // default immuneTurns=2, autoResume=concern
		h.facade.branch = [userEntry("e1", "root")];
		await enable(h);

		// turn_end 1: blocker fires a steer → immune window opens.
		h.facade.branch = [userEntry("e1", "root"), userEntry("e2", "step a")];
		h.runner.scripts.push({ advise: [{ note: "Blocker: missing transaction", severity: "blocker" }] });
		await h.ctrl.handleTurnEnd();
		await h.backlog.idle();
		expect(h.facade.sent[0]).toMatchObject({ deliverAs: "steer", triggerTurn: true });

		// turn_end 2: still within immuneTurns=2 → downgrade to nextTurn.
		h.facade.branch = [
			userEntry("e1", "root"),
			userEntry("e2", "step a"),
			userEntry("e3", "step b"),
		];
		h.runner.scripts.push({ advise: [{ note: "Blocker: still missing transaction", severity: "blocker" }] });
		await h.ctrl.handleTurnEnd();
		await h.backlog.idle();
		expect(h.facade.sent[1]).toMatchObject({ deliverAs: "nextTurn", triggerTurn: false });

		// turn_end 3: window expired → steer restored.
		h.facade.branch = [
			userEntry("e1", "root"),
			userEntry("e2", "step a"),
			userEntry("e3", "step b"),
			userEntry("e4", "step c"),
		];
		h.runner.scripts.push({ advise: [{ note: "Blocker: transaction still absent", severity: "blocker" }] });
		await h.ctrl.handleTurnEnd();
		await h.backlog.idle();
		expect(h.facade.sent[2]).toMatchObject({ deliverAs: "steer", triggerTurn: true });
	});

	test("9. autoResumeSuppressed: abort downgrades idle blocker; prompt restores steer", async () => {
		resetIds();
		const h = makeController();
		h.facade.branch = [userEntry("e1", "root")];
		await enable(h);

		h.ctrl.noteUserAbort();

		// turn_end 1: idle blocker with autoResumeSuppressed → nextTurn downgrade.
		h.facade.branch = [userEntry("e1", "root"), userEntry("e2", "step a")];
		h.runner.scripts.push({ advise: [{ note: "Blocker: data loss risk", severity: "blocker" }] });
		await h.ctrl.handleTurnEnd();
		await h.backlog.idle();
		expect(h.facade.sent[0]).toMatchObject({ deliverAs: "nextTurn", triggerTurn: false });

		// noteUserPrompt clears the flag → steer restored.
		h.ctrl.noteUserPrompt();
		h.facade.branch = [
			userEntry("e1", "root"),
			userEntry("e2", "step a"),
			userEntry("e3", "step b"),
		];
		h.runner.scripts.push({ advise: [{ note: "Blocker: data loss still present", severity: "blocker" }] });
		await h.ctrl.handleTurnEnd();
		await h.backlog.idle();
		expect(h.facade.sent[1]).toMatchObject({ deliverAs: "steer", triggerTurn: true });
	});

	test("10. give-up: 3 review failures notify + clear status; next turn_end still observes", async () => {
		resetIds();
		const h = makeController();
		h.facade.branch = [userEntry("e1", "root")];
		await enable(h);

		const fail = new Error("review failed");
		// Three consecutive review failures trip the give-up. The branch grows
		// each turn (clean advance) so each observe pushes a fresh delta → a
		// fresh failing review, without any divergence reset muddying the count.
		const growth = [
			userEntry("e2", "step a"),
			userEntry("e3", "step b"),
			userEntry("e4", "step c"),
		];
		const branch = [userEntry("e1", "root")];
		for (const entry of growth) {
			branch.push(entry);
			h.facade.branch = [...branch];
			h.runner.scripts.push({ fail });
			await h.ctrl.handleTurnEnd();
			await h.backlog.idle();
		}

		expect(h.facade.notifications.length).toBe(1);
		expect(h.facade.notifications[0]).toEqual({
			text: "advisor: giving up after repeated failures …",
			level: "warning",
		});
		expect(h.facade.statuses[h.facade.statuses.length - 1]).toEqual({ key: "advisor", text: null });

		// The advisor stays enabled: the next turn_end still observes + reviews.
		h.facade.branch = [
			userEntry("e1", "root"),
			userEntry("e2", "step a"),
			userEntry("e3", "step b"),
			userEntry("e4", "step c"),
			userEntry("e5", "step d"),
		];
		h.runner.scripts.push({ advise: [{ note: "concern after recovery", severity: "concern" }] });
		await h.ctrl.handleTurnEnd();
		await h.backlog.idle();
		expect(h.runner.reviews[h.runner.reviews.length - 1]).toContain("step d");
		expect(h.facade.sent[0]).toMatchObject({ deliverAs: "followUp", triggerTurn: true });
	});
});
