// AdvisorController — the observe→align→compress→review→deliver integration
// core. PLAN §4/§5/§7/§8/§10, issue #10.
//
// Ties every prior module together against a narrow `HostFacade` seam over the
// pi ExtensionAPI/ctx (constructor-injected, fake in tests). The controller
// owns: branch observation (entry-id alignment via `planAlignment`), delta
// compression (`compressEntries`), backpressure hand-off (`BacklogQueue`), the
// advisor child-session lifecycle (`AdvisorRunner`), the emission guard, and
// the delivery decision (`resolveDelivery` → `facade.sendMessage`).
//
// Wiring model (PLAN §16): the `BacklogQueue` is constructor-injected but its
// `review` / `onFailureGiveUp` callbacks are wired to controller methods by the
// caller — the controller is the integration point, so it exposes `review`,
// `route`, and `handleGiveUp` as the seams the backlog / advise-tool / fake
// runner call back into. The real (#11) and test wiring both close over the
// controller instance lazily (the backlog is constructed before the controller
// exists), which is why these are public.

import { planAlignment, type AlignmentPlan } from "./align.ts";
import { compressEntries, type SessionEntryLike } from "./compress.ts";
import { resolveDelivery, type DeliveryDecision, type DeliveryState } from "./deliver.ts";
import type { BacklogQueue } from "./backlog.ts";
import type { EmissionGuard } from "./emission-guard.ts";
import type { AdvisorConfig, Severity } from "./types.ts";

/**
 * Structural seam over {@link AdvisorRunner}. The real runner class has
 * private state, which blocks structural faking; this public-method interface
 * lets tests inject a fake runner whose `review` calls back into `route` with
 * scripted advice (PLAN §16). `AdvisorRunner` satisfies it structurally.
 */
export interface AdvisorRunnerLike {
	ensureSession(): Promise<void>;
	review(batch: string, opts?: { signal?: AbortSignal }): Promise<void>;
	reset(): Promise<void>;
	dispose(): Promise<void>;
}

/**
 * A branch entry as surfaced by the host facade: a stable entry `id` (used for
 * `planAlignment`) plus the entry payload in the `SessionEntryLike` shape that
 * `compressEntries` consumes. The id is carried separately from the payload so
 * the alignment layer never has to understand the payload's internal shape —
 * and so the host can keep its own id even if the payload's nested id differs.
 */
export interface BranchEntry {
	id: string;
	entry: SessionEntryLike;
}

/** Narrow seam over the pi ExtensionAPI/ctx. Constructor-injected (fake in tests). */
export interface HostFacade {
	/** Current main-session branch entries (id + payload), in branch order. */
	getBranchEntries(): BranchEntry[];
	/** Inject an accepted advisor note into the main session. */
	sendMessage(msg: {
		customType: "advisor";
		content: string;
		display: true;
		deliverAs: "nextTurn" | "followUp" | "steer";
		triggerTurn?: boolean;
	}): void;
	/** Set/clear a status-bar line under the `advisor` key. */
	setStatus(key: string, text: string | null): void;
	/** Surface a user-visible notification. */
	notify(text: string, level?: "info" | "warning" | "error"): void;
}

/** Delivery-channel message emitted via `facade.sendMessage`. */
export interface AdvisorMessage {
	customType: "advisor";
	content: string;
	display: true;
	deliverAs: "nextTurn" | "followUp" | "steer";
	triggerTurn: boolean;
}

/** Status snapshot returned by `AdvisorController.status()`. */
export interface ControllerStatus {
	enabled: boolean;
	backlog: number;
	model?: string;
}

/** Constructor dependencies for {@link AdvisorController}. */
export interface AdvisorControllerDeps {
	facade: HostFacade;
	runner: AdvisorRunnerLike;
	guard: EmissionGuard;
	backlog: BacklogQueue;
	config: AdvisorConfig;
}

/** Separator between merged deltas in one review batch. */
const DELTA_SEPARATOR = "\n\n";

/** customType of the advisor's own injected cards (loop-gate marker). */
const ADVISOR_CUSTOM_TYPE = "advisor";

/**
 * Loop gate (PLAN §4 回路闸): true if `entry` is one of the advisor's own
 * injected cards. Such entries ARE recorded in `fedIds` (so they neither
 * trigger divergence nor re-feed) but are EXCLUDED from the compressed delta
 * text — see issue #10 test 2 for the resolution and rationale.
 */
function isAdvisorEntry(entry: SessionEntryLike): boolean {
	if (entry.type === "custom_message") return entry.customType === ADVISOR_CUSTOM_TYPE;
	if (entry.type === "message") {
		const m = entry.message;
		return m.role === "custom" && m.customType === ADVISOR_CUSTOM_TYPE;
	}
	return false;
}

/**
 * The observe→align→compress→review→deliver loop. Stateful but synchronous in
 * its observe step; review/delivery happen asynchronously via the backlog
 * drain, which calls back into {@link AdvisorController.review}.
 */
export class AdvisorController {
	private readonly facade: HostFacade;
	private readonly runner: AdvisorRunnerLike;
	private readonly guard: EmissionGuard;
	private readonly backlog: BacklogQueue;
	private readonly config: AdvisorConfig;

	private enabled = false;
	/** Entry ids the advisor has consumed (advisor ids included silently). */
	private fedIds: string[] = [];
	/**
	 * Delivery state snapshot handed to `resolveDelivery`. `streaming` is held at
	 * `false`: delivery happens inside the backlog review, which is kicked from
	 * `handleTurnEnd` (the turn just ended → the main agent is idle), and a
	 * precise in-turn signal needs the #11 `agent_start` hook. The issue spec
	 * allows this simple, documented approximation; the streaming=true branch of
	 * rule 3 is therefore not exercised here.
	 */
	private delivery: DeliveryState = {
		streaming: false,
		autoResumeSuppressed: false,
		completedTurns: 0,
		immuneTurnStart: null,
	};

	constructor(deps: AdvisorControllerDeps) {
		this.facade = deps.facade;
		this.runner = deps.runner;
		this.guard = deps.guard;
		this.backlog = deps.backlog;
		this.config = deps.config;
	}

	// --- lifecycle --------------------------------------------------------

	/** Late-enable: seed = compressed full-branch snapshot (PLAN §5). */
	async enable(): Promise<void> {
		this.enabled = true;
		await this.runner.ensureSession();
		this.seedFullBranch();
	}

	/** Disable: dispose runner, bump epoch, clear status and advisor state. */
	async disable(): Promise<void> {
		this.enabled = false;
		await this.runner.dispose();
		this.backlog.bumpEpoch();
		this.facade.setStatus("advisor", null);
		this.fedIds = [];
		this.delivery = {
			streaming: false,
			autoResumeSuppressed: false,
			completedTurns: 0,
			immuneTurnStart: null,
		};
	}

	// --- pi hook bodies ---------------------------------------------------

	/** Hook body for pi "turn_end". */
	async handleTurnEnd(ev: { signal?: AbortSignal } = {}): Promise<void> {
		if (!this.enabled) return;
		this.delivery.completedTurns++;
		await this.observeAndFeed();
		await this.applyBackpressure(ev.signal);
	}

	/** Hook body for pi "session_tree" — re-align without a turn_end (PLAN §5). */
	async handleSessionTree(): Promise<void> {
		if (!this.enabled) return;
		await this.observeAndFeed();
	}

	/** Hook body for pi "session_compact" — re-align after a compaction. */
	async handleSessionCompact(): Promise<void> {
		if (!this.enabled) return;
		await this.observeAndFeed();
	}

	/** Clear autoResumeSuppressed (agent_start with user input). */
	noteUserPrompt(): void {
		this.delivery.autoResumeSuppressed = false;
	}

	/** Set autoResumeSuppressed (best-effort user-stop detection; wired in #11). */
	noteUserAbort(): void {
		this.delivery.autoResumeSuppressed = true;
	}

	// --- backlog / advise-tool seams (PLAN §16) --------------------------

	/**
	 * Backlog `review` callback: clear the per-update guard budget, then prompt
	 * the advisor child session with the merged batch. The fake runner (in
	 * tests) / advise-tool (in production) calls back into `route` from within
	 * `runner.review`.
	 */
	async review(batch: string[], _epoch: number): Promise<void> {
		this.guard.beginUpdate();
		await this.runner.review(batch.join(DELTA_SEPARATOR));
	}

	/**
	 * Advise-tool / fake-runner route: decide delivery for a GUARD-ACCEPTED note
	 * and emit via `facade.sendMessage`. The emission guard is applied exactly
	 * once, by the advise tool's execute handler (#07) before it calls this route
	 * — the tool needs the guard decision to answer "Recorded." vs "Duplicate
	 * advice ignored." Re-checking here would double-consume the guard (the
	 * second accept() of the same note always reports `duplicate`) and silently
	 * drop every advice in production. When a steer is delivered (it preempts the
	 * main agent's next LLM call regardless of `triggerTurn`, which only governs
	 * idle wake-up), record the immune-window start turn so subsequent
	 * concern/blocker notes downgrade.
	 */
	route(note: string, severity: Severity): void {
		const d: DeliveryDecision = resolveDelivery(severity, this.delivery, this.config);
		const msg: AdvisorMessage = {
			customType: "advisor",
			content: note,
			display: true,
			deliverAs: d.deliverAs,
			triggerTurn: d.triggerTurn,
		};
		this.facade.sendMessage(msg);
		if (d.deliverAs === "steer") {
			this.delivery.immuneTurnStart = this.delivery.completedTurns;
		}
	}

	/**
	 * Backlog `onFailureGiveUp` callback: 3 consecutive review rejections. Notify
	 * the user, clear status; the advisor stays enabled so the next turn_end
	 * still observes (issue #10 test 10).
	 */
	handleGiveUp(_err: unknown): void {
		this.facade.notify("advisor: giving up after repeated failures …", "warning");
		this.facade.setStatus("advisor", null);
	}

	// --- status -----------------------------------------------------------

	status(): ControllerStatus {
		return {
			enabled: this.enabled,
			backlog: this.backlog.backlog,
			model: this.config.model,
		};
	}

	// --- internals --------------------------------------------------------

	/** Observe the branch and feed the backlog per the alignment plan. */
	private async observeAndFeed(): Promise<void> {
		const entries = this.facade.getBranchEntries();
		const curIds = entries.map((e) => e.id);
		const plan: AlignmentPlan = planAlignment(this.fedIds, curIds);
		switch (plan.kind) {
			case "noop":
				return;
			case "advance": {
				// New suffix = entries past the fed prefix; drop advisor cards.
				const newEntries = entries
					.slice(this.fedIds.length)
					.filter((e) => !isAdvisorEntry(e.entry));
				if (newEntries.length > 0) {
					this.backlog.push(compressEntries(newEntries.map((e) => e.entry)));
				}
				this.fedIds = curIds;
				return;
			}
			case "divergence": {
				await this.resetFlow();
				return;
			}
		}
	}

	/**
	 * Divergence reset flow (PLAN §5 档 A): bump epoch, reset the runner (fresh
	 * session), seed with the compressed full branch, and rebase fedIds.
	 */
	private async resetFlow(): Promise<void> {
		this.backlog.bumpEpoch();
		await this.runner.reset();
		this.seedFullBranch();
	}

	/**
	 * Compress the full current branch (minus advisor cards) and push it as the
	 * seed delta; rebase fedIds to the current branch ids. Used by `enable` and
	 * the divergence reset flow.
	 */
	private seedFullBranch(): void {
		const entries = this.facade.getBranchEntries();
		const curIds = entries.map((e) => e.id);
		const payload = entries.filter((e) => !isAdvisorEntry(e.entry)).map((e) => e.entry);
		if (payload.length > 0) {
			this.backlog.push(compressEntries(payload));
		}
		this.fedIds = curIds;
	}

	/**
	 * Backpressure (PLAN §10): after a push, if syncBacklog is on and the
	 * backlog is at/above the high watermark, surface a "catching up" status and
	 * block until the drain reaches the low watermark, the timeout elapses, or
	 * the signal aborts. Status is cleared on every release path.
	 */
	private async applyBackpressure(signal: AbortSignal | undefined): Promise<void> {
		const high = this.config.syncBacklog;
		if (high === "off") return;
		if (this.backlog.backlog < high) return;
		const behind = this.backlog.backlog;
		this.facade.setStatus("advisor", `catching up (${behind} behind)…`);
		const low = Math.ceil(high / 2);
		try {
			await this.backlog.waitForCatchup({
				high,
				low,
				timeoutMs: this.config.catchupTimeoutMs,
				signal,
			});
		} finally {
			this.facade.setStatus("advisor", null);
		}
	}
}
