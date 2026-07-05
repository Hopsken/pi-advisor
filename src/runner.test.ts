// Tests for the advisor runner — child session lifecycle. PLAN §1/§5/§6, issue #09.
//
// The runner owns the persistent advisor child session: lazy creation with a
// seed snapshot, per-batch review prompts, reset (fresh session + re-seed),
// overflow recovery (reset + retry the batch once), and disposal. The single
// seam is the injected `SessionFactory` plus controllable fake handles whose
// `prompt()` behavior the test presets per handle — no LLM, no pi session.
//
// The nine cases below mirror the issue spec 1:1.

import { describe, expect, test } from "bun:test";

import {
	AdvisorRunner,
	isOverflowError,
	type AdvisorSessionHandle,
	type SessionFactory,
} from "./runner.ts";
import { buildAdvisorSystemPrompt } from "./prompts.ts";
import { DEFAULT_CONFIG, type AdvisorConfig } from "./types.ts";

/** Error a fake handle throws to simulate a provider context-window overflow. */
const OVERFLOW_MSG = "prompt is too long: 213462 tokens > 200000 maximum";
class OverflowError extends Error {
	constructor() {
		super(OVERFLOW_MSG);
		this.name = "OverflowError";
	}
}

/** A controllable handle. `promptBehavior` is preset per handle by the factory. */
class FakeHandle implements AdvisorSessionHandle {
	readonly prompts: { text: string; signal?: AbortSignal }[] = [];
	disposed = false;
	abortCount = 0;
	promptBehavior: (text: string, signal?: AbortSignal) => Promise<void> = () => Promise.resolve();

	async prompt(text: string, opts?: { signal?: AbortSignal }): Promise<void> {
		const signal = opts?.signal;
		this.prompts.push({ text, signal });
		await this.promptBehavior(text, signal);
	}

	abort(): void {
		this.abortCount++;
	}

	dispose(): void {
		this.disposed = true;
	}
}

interface FactoryCall {
	systemPrompt: string;
	model?: string;
	tools: string[];
	adviseTool: unknown;
}

/**
 * Fake factory. Each invocation records its params, mints a fresh FakeHandle,
 * and assigns the next preset behavior from `behaviors` (default: resolve
 * void). The test drives handle behavior by preloading behaviors in creation
 * order — handle #1 gets behaviors[0], handle #2 gets behaviors[1], etc.
 */
function makeFactory(behaviors: Array<(text: string, signal?: AbortSignal) => Promise<void>> = []) {
	const queue = [...behaviors];
	const calls: FactoryCall[] = [];
	const handles: FakeHandle[] = [];
	const factory: SessionFactory = async (params) => {
		calls.push(params);
		const h = new FakeHandle();
		h.promptBehavior = queue.shift() ?? (() => Promise.resolve());
		handles.push(h);
		return h;
	};
	return { factory, calls, handles };
}

/** buildSeed that returns a fresh string each call so re-seeding is observable. */
function makeSeed() {
	let n = 0;
	const buildSeed = (): string => `SEED-${++n}`;
	return { buildSeed, count: () => n };
}

function config(over: Partial<AdvisorConfig> = {}): AdvisorConfig {
	return { ...DEFAULT_CONFIG, model: "advisor-model", ...over };
}

const ADVISE_TOOL: unknown = { __sentinel: "advise-tool" };
const TOOLS = ["read", "grep", "find", "ls"];

describe("AdvisorRunner", () => {
	// Spec case 1: lazy creation — first review creates the session and seeds
	// it (buildSeed called once, seed prompted before the batch).
	test("first review lazily creates the session and seeds before the batch", async () => {
		const { factory, calls, handles } = makeFactory();
		const seed = makeSeed();
		const cfg = config();
		const runner = new AdvisorRunner({ factory, buildSeed: seed.buildSeed, config: cfg, adviseTool: ADVISE_TOOL });

		await runner.review("BATCH-1");

		expect(calls.length).toBe(1);
		expect(calls[0]).toEqual({
			systemPrompt: buildAdvisorSystemPrompt(cfg),
			model: "advisor-model",
			tools: TOOLS,
			adviseTool: ADVISE_TOOL,
		});
		expect(seed.count()).toBe(1);
		expect(handles[0].prompts.map((p) => p.text)).toEqual(["SEED-1", "BATCH-1"]);
	});

	// Spec case 2: subsequent reviews reuse the session (factory called once).
	test("subsequent reviews reuse the same session", async () => {
		const { factory, calls, handles } = makeFactory();
		const seed = makeSeed();
		const runner = new AdvisorRunner({ factory, buildSeed: seed.buildSeed, config: config(), adviseTool: ADVISE_TOOL });

		await runner.review("B1");
		await runner.review("B2");

		expect(calls.length).toBe(1);
		expect(seed.count()).toBe(1); // seeded once, on first create only
		expect(handles[0].prompts.map((p) => p.text)).toEqual(["SEED-1", "B1", "B2"]);
	});

	// Spec case 3: reset() disposes the old handle, invokes the factory again,
	// and re-seeds the new session with a fresh buildSeed() output.
	test("reset disposes the old handle and re-seeds a fresh session", async () => {
		const { factory, calls, handles } = makeFactory();
		const seed = makeSeed();
		const runner = new AdvisorRunner({ factory, buildSeed: seed.buildSeed, config: config(), adviseTool: ADVISE_TOOL });

		await runner.review("B1");
		const firstHandle = handles[0];
		expect(firstHandle.disposed).toBe(false);

		await runner.reset();

		expect(calls.length).toBe(2);
		expect(firstHandle.disposed).toBe(true);
		expect(seed.count()).toBe(2); // fresh seed for the new session
		expect(handles[1].prompts.map((p) => p.text)).toEqual(["SEED-2"]);
	});

	// Spec case 4: overflow from the batch prompt → reset + re-seed + retry the
	// batch on the NEW session; success resolves.
	test("overflow on the batch prompts a reset, re-seed, and retried batch on the new session", async () => {
		const overflowOnBatch = (text: string): Promise<void> => {
			if (text.startsWith("BATCH")) throw new OverflowError();
			return Promise.resolve();
		};
		const { factory, calls, handles } = makeFactory([overflowOnBatch, () => Promise.resolve()]);
		const seed = makeSeed();
		const runner = new AdvisorRunner({ factory, buildSeed: seed.buildSeed, config: config(), adviseTool: ADVISE_TOOL });

		await runner.review("BATCH");

		expect(calls.length).toBe(2);
		expect(handles[0].disposed).toBe(true);
		// handle #1: seed ok, batch threw overflow.
		expect(handles[0].prompts.map((p) => p.text)).toEqual(["SEED-1", "BATCH"]);
		// handle #2: fresh seed, then retried batch succeeds.
		expect(handles[1].prompts.map((p) => p.text)).toEqual(["SEED-2", "BATCH"]);
	});

	// Spec case 5: overflow twice → rejects (no infinite retry).
	test("a second overflow rejects without further retry", async () => {
		const overflowOnBatch = (text: string): Promise<void> => {
			if (text.startsWith("BATCH")) throw new OverflowError();
			return Promise.resolve();
		};
		const { factory, calls, handles } = makeFactory([overflowOnBatch, overflowOnBatch]);
		const seed = makeSeed();
		const runner = new AdvisorRunner({ factory, buildSeed: seed.buildSeed, config: config(), adviseTool: ADVISE_TOOL });

		await expect(runner.review("BATCH")).rejects.toThrow(OVERFLOW_MSG);

		expect(calls.length).toBe(2); // original + one reset, no third attempt
		expect(handles[0].disposed).toBe(true);
		expect(handles[1].disposed).toBe(false); // left for caller to dispose()
	});

	// Spec case 6: a non-overflow error propagates without a reset.
	test("a non-overflow error propagates without resetting", async () => {
		const failOnBatch = (text: string): Promise<void> => {
			if (text.startsWith("BATCH")) throw new Error("network failure");
			return Promise.resolve();
		};
		const { factory, calls, handles } = makeFactory([failOnBatch]);
		const seed = makeSeed();
		const runner = new AdvisorRunner({ factory, buildSeed: seed.buildSeed, config: config(), adviseTool: ADVISE_TOOL });

		await expect(runner.review("BATCH")).rejects.toThrow("network failure");

		expect(calls.length).toBe(1); // no reset → factory not called again
		expect(handles[0].disposed).toBe(false);
		expect(seed.count()).toBe(1); // only the initial seed
	});

	// Spec case 7: dispose() disposes the underlying handle; a review after
	// dispose RECREATES the session lazily (dispose is not final — the caller
	// controls teardown by stopping review calls).
	test("dispose drops the handle; a later review recreates the session lazily", async () => {
		const { factory, calls, handles } = makeFactory();
		const seed = makeSeed();
		const runner = new AdvisorRunner({ factory, buildSeed: seed.buildSeed, config: config(), adviseTool: ADVISE_TOOL });

		await runner.review("B1");
		const firstHandle = handles[0];
		await runner.dispose();
		expect(firstHandle.disposed).toBe(true);

		await runner.review("B2");

		expect(calls.length).toBe(2);
		expect(seed.count()).toBe(2); // re-seeded on recreate
		expect(handles[1].prompts.map((p) => p.text)).toEqual(["SEED-2", "B2"]);
	});

	// Spec case 8: the review abort signal is passed through to handle.prompt.
	test("review forwards the abort signal to the batch prompt", async () => {
		const { factory, handles } = makeFactory();
		const seed = makeSeed();
		const runner = new AdvisorRunner({ factory, buildSeed: seed.buildSeed, config: config(), adviseTool: ADVISE_TOOL });

		const ac = new AbortController();
		await runner.review("BATCH", { signal: ac.signal });

		expect(handles[0].prompts[0].signal).toBeUndefined(); // seed has no signal
		expect(handles[0].prompts[1].signal).toBe(ac.signal); // batch got the signal
	});

	// Spec case 8 (cont.): ensureSession is idempotent — a second call does not
	// recreate or re-seed.
	test("ensureSession is idempotent", async () => {
		const { factory, calls, handles } = makeFactory();
		const seed = makeSeed();
		const runner = new AdvisorRunner({ factory, buildSeed: seed.buildSeed, config: config(), adviseTool: ADVISE_TOOL });

		await runner.ensureSession();
		await runner.ensureSession();

		expect(calls.length).toBe(1);
		expect(seed.count()).toBe(1);
		expect(handles[0].prompts.map((p) => p.text)).toEqual(["SEED-1"]);
	});
});

describe("isOverflowError", () => {
	// Spec case 9: message-matching heuristic over provider overflow strings.
	test("recognizes common provider context-window overflow messages", () => {
		expect(isOverflowError(new Error("prompt is too long: 213462 tokens > 200000 maximum"))).toBe(true);
		expect(isOverflowError(new Error("Your input exceeds the context window of this model"))).toBe(true);
		expect(isOverflowError(new Error("Requested token count exceeds the model's maximum context length of 131072 tokens"))).toBe(true);
		expect(isOverflowError(new Error("This model's maximum prompt length is 131072 but the request contains 537812 tokens"))).toBe(true);
		expect(isOverflowError(new Error("Please reduce the length of the messages or completion"))).toBe(true);
		expect(isOverflowError(new Error("context_length_exceeded"))).toBe(true);
	});

	test("rejects non-overflow errors", () => {
		expect(isOverflowError(new Error("network failure"))).toBe(false);
		expect(isOverflowError(new Error("authentication failed"))).toBe(false);
		expect(isOverflowError(new Error("Rate limit exceeded"))).toBe(false);
		expect(isOverflowError(new Error("Too many requests, please wait"))).toBe(false);
	});

	test("handles non-Error inputs safely", () => {
		expect(isOverflowError(undefined)).toBe(false);
		expect(isOverflowError(null)).toBe(false);
		expect(isOverflowError("prompt is too long")).toBe(true);
		expect(isOverflowError({ message: "exceeds the context window" })).toBe(true);
		expect(isOverflowError(42)).toBe(false);
	});
});
