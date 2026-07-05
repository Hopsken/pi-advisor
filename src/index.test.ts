// Tests for the pi-advisor extension entry. PLAN §2.4 / §12 / §14, issue #11.
//
// Two layers:
//   1. Wiring tests (cases 1–5 + env-force) drive `installAdvisor` with a fake
//      `ExtensionAPI`/ctx (structural) and an injected controller factory that
//      returns a spy controller. These assert the entry's event/command wiring
//      and dormancy guard — never the real graph.
//   2. Composition regression: wires the REAL `createAdviseTool` + REAL
//      `EmissionGuard` + REAL `AdvisorController` (fake facade/runner) and
//      drives the tool twice with the same note. Guards against double-
//      guarding: the guard runs ONLY in the tool, `controller.route` must NOT
//      re-check it (see controller.ts `route()` doc comment).
//
// No network, no LLM. Async settles via the spy's immediate resolves.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CONFIG_DIR_NAME, type ExtensionAPI, type ExtensionContext, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { installAdvisor, type AdvisorGraphFactory, type AdvisorControllerPort } from "./index.ts";
import { createAdviseTool } from "./advise-tool.ts";
import { EmissionGuard } from "./emission-guard.ts";
import { BacklogQueue } from "./backlog.ts";
import { AdvisorController, type HostFacade, type AdvisorMessage, type AdvisorRunnerLike, type BranchEntry } from "./controller.ts";
import { DEFAULT_CONFIG, type AdvisorConfig, type Severity } from "./types.ts";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

type AnyHandler = (event: unknown, ctx: unknown) => Promise<unknown> | unknown;

/** Structural fake `ExtensionAPI` recording registrations + dispatching. */
class FakePi {
	readonly handlers = new Map<string, AnyHandler[]>();
	readonly commands = new Map<string, { description?: string; handler: (args: string, ctx: unknown) => Promise<void> }>();
	readonly renderers = new Map<string, (msg: unknown, opts: unknown, theme: unknown) => unknown>();
	readonly sent: { msg: unknown; opts: unknown }[] = [];

	on(event: string, handler: AnyHandler): void {
		const list = this.handlers.get(event);
		if (list) list.push(handler);
		else this.handlers.set(event, [handler]);
	}
	registerCommand(name: string, options: { description?: string; handler: (args: string, ctx: unknown) => Promise<void> }): void {
		this.commands.set(name, options);
	}
	registerMessageRenderer(customType: string, renderer: (msg: unknown, opts: unknown, theme: unknown) => unknown): void {
		this.renderers.set(customType, renderer);
	}
	sendMessage(msg: unknown, opts?: unknown): void {
		this.sent.push({ msg, opts });
	}

	/** Dispatch an event to all registered handlers, in registration order. */
	async dispatch(event: string, ev: unknown, ctx: unknown): Promise<void> {
		for (const h of this.handlers.get(event) ?? []) await h(ev, ctx);
	}

	/** Invoke a registered command's handler. */
	async runCommand(name: string, args: string, ctx: unknown): Promise<void> {
		const cmd = this.commands.get(name);
		if (!cmd) throw new Error(`no command registered for ${name}`);
		await cmd.handler(args, ctx);
	}
}

/** UI + ctx recorder for event/command handlers. */
interface CtxRecorder {
	notify: { text: string; level?: "info" | "warning" | "error" }[];
	setStatus: { key: string; text: string | undefined }[];
}

function makeCtx(opts: { hasUI: boolean; cwd: string; branch?: BranchEntry[] }): { ctx: ExtensionContext; ui: CtxRecorder } {
	const ui: CtxRecorder = { notify: [], setStatus: [] };
	const ctx = {
		hasUI: opts.hasUI,
		cwd: opts.cwd,
		ui: {
			notify: (text: string, level?: "info" | "warning" | "error") => ui.notify.push({ text, level }),
			setStatus: (key: string, text: string | undefined) => ui.setStatus.push({ key, text }),
		},
		sessionManager: { getBranch: () => opts.branch ?? [] },
		signal: undefined,
		modelRegistry: { getAll: () => [], find: () => undefined },
	};
	return { ctx: ctx as unknown as ExtensionContext, ui };
}

/** Command ctx is an ExtensionContext with extra command methods (unused here). */
function asCommandCtx(ctx: ExtensionContext): ExtensionCommandContext {
	return ctx as unknown as ExtensionCommandContext;
}

/**
 * Spy controller + factory. The factory records that it was built; the
 * controller records every method call so the entry's wiring is observable.
 */
function makeSpy() {
	const calls: string[] = [];
	let built = 0;
	let statusResult: { enabled: boolean; backlog: number; model?: string } = { enabled: true, backlog: 0 };
	const controller: AdvisorControllerPort = {
		async enable(): Promise<void> { calls.push("enable"); },
		async disable(): Promise<void> { calls.push("disable"); },
		async handleTurnEnd(): Promise<void> { calls.push("handleTurnEnd"); },
		async handleSessionTree(): Promise<void> { calls.push("handleSessionTree"); },
		async handleSessionCompact(): Promise<void> { calls.push("handleSessionCompact"); },
		noteUserPrompt(): void { calls.push("noteUserPrompt"); },
		noteUserAbort(): void { calls.push("noteUserAbort"); },
		status(): { enabled: boolean; backlog: number; model?: string } { return statusResult; },
	};
	const buildGraph: AdvisorGraphFactory = () => { built++; return { controller }; };
	return {
		calls,
		built: () => built,
		buildGraph,
		setStatus: (r: { enabled: boolean; backlog: number; model?: string }) => { statusResult = r; },
	};
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let dirCounter = 0;
function tmpCwd(): string {
	return mkdtempSync(join(tmpdir(), `pi-advisor-test-${++dirCounter}-`));
}

function readAdvisorJson(cwd: string): unknown {
	try {
		return JSON.parse(readFileSync(join(cwd, CONFIG_DIR_NAME, "advisor.json"), "utf8"));
	} catch {
		return undefined;
	}
}

const FORCE_ENV = "PI_ADVISOR_FORCE";

beforeEach(() => {
	delete process.env[FORCE_ENV];
});
afterEach(() => {
	delete process.env[FORCE_ENV];
});

// ---------------------------------------------------------------------------
// Wiring tests
// ---------------------------------------------------------------------------

describe("advisorExtension / installAdvisor — wiring", () => {
	test("1. dormancy guard: hasUI:false + no env → no graph, no controller calls; `/advisor on` explains", async () => {
		const pi = new FakePi();
		const spy = makeSpy();
		installAdvisor(pi as unknown as ExtensionAPI, { buildGraph: spy.buildGraph });

		const { ctx } = makeCtx({ hasUI: false, cwd: tmpCwd() });
		await pi.dispatch("session_start", { type: "session_start", reason: "startup" }, ctx);

		// No graph built; subsequent events are no-ops (no controller to call).
		expect(spy.built()).toBe(0);
		await pi.dispatch("agent_start", { type: "agent_start" }, ctx);
		await pi.dispatch("turn_end", { type: "turn_end", turnIndex: 0, message: { role: "assistant", stopReason: "stop" }, toolResults: [] }, ctx);
		await pi.dispatch("session_tree", { type: "session_tree", newLeafId: null, oldLeafId: null }, ctx);
		await pi.dispatch("session_compact", { type: "session_compact", reason: "manual", fromExtension: false, willRetry: false }, ctx);
		expect(spy.built()).toBe(0);
		expect(spy.calls.length).toBe(0);

		// `/advisor on` refuses with the inactive explanation, still no graph.
		const cmd = makeCtx({ hasUI: false, cwd: tmpCwd() });
		await pi.runCommand("advisor", "on", cmd.ctx);
		expect(spy.built()).toBe(0);
		expect(cmd.ui.notify.some((n) => /inactive/i.test(n.text) && /PI_ADVISOR_FORCE/.test(n.text))).toBe(true);
	});

	test("1b. env PI_ADVISOR_FORCE=1 lets `/advisor on` through even with hasUI:false", async () => {
		process.env[FORCE_ENV] = "1";
		const pi = new FakePi();
		const spy = makeSpy();
		installAdvisor(pi as unknown as ExtensionAPI, { buildGraph: spy.buildGraph });

		// hasUI:false would normally block activation; the env var overrides the
		// guard so `/advisor on` proceeds.
		const cwd = tmpCwd();
		const { ctx } = makeCtx({ hasUI: false, cwd });
		await pi.dispatch("session_start", { type: "session_start", reason: "startup" }, ctx);
		expect(spy.built()).toBe(0); // config.enabled still false → not auto-active

		await pi.runCommand("advisor", "on", asCommandCtx(ctx));
		expect(spy.built()).toBe(1);
		expect(spy.calls).toContain("enable");
		expect(readAdvisorJson(cwd)).toMatchObject({ enabled: true });
	});

	test("2. `/advisor on` → controller.enable called; config file written with enabled:true", async () => {
		const pi = new FakePi();
		const spy = makeSpy();
		installAdvisor(pi as unknown as ExtensionAPI, { buildGraph: spy.buildGraph });

		const cwd = tmpCwd();
		const { ctx } = makeCtx({ hasUI: true, cwd });
		await pi.dispatch("session_start", { type: "session_start", reason: "startup" }, ctx);
		// Default config (no file) → enabled:false → not active yet.
		expect(spy.built()).toBe(0);

		await pi.runCommand("advisor", "on", asCommandCtx(ctx));
		expect(spy.built()).toBe(1);
		expect(spy.calls).toContain("enable");

		const cfg = readAdvisorJson(cwd) as { enabled?: boolean } | undefined;
		expect(cfg?.enabled).toBe(true);
	});

	test("3. `/advisor status` → output contains model + backlog info", async () => {
		const pi = new FakePi();
		const spy = makeSpy();
		installAdvisor(pi as unknown as ExtensionAPI, { buildGraph: spy.buildGraph });

		const { ctx, ui } = makeCtx({ hasUI: true, cwd: tmpCwd() });
		await pi.dispatch("session_start", { type: "session_start", reason: "startup" }, ctx);
		await pi.runCommand("advisor", "on", asCommandCtx(ctx));
		spy.setStatus({ enabled: true, backlog: 3, model: "haiku" });

		// The entry holds `graph` in closure, so a command against the same ctx
		// observes the spy controller's status.
		await pi.runCommand("advisor", "status", asCommandCtx(ctx));
		const last = ui.notify[ui.notify.length - 1];
		expect(last.text).toContain("haiku");
		expect(last.text).toContain("3");

		// Bare `/advisor` (empty args) behaves the same as `status`.
		await pi.runCommand("advisor", "", asCommandCtx(ctx));
		const bare = ui.notify[ui.notify.length - 1];
		expect(bare.text).toContain("haiku");
	});

	test("4. session_shutdown → controller.disable called; further events no-op", async () => {
		const pi = new FakePi();
		const spy = makeSpy();
		installAdvisor(pi as unknown as ExtensionAPI, { buildGraph: spy.buildGraph });

		const { ctx } = makeCtx({ hasUI: true, cwd: tmpCwd() });
		await pi.dispatch("session_start", { type: "session_start", reason: "startup" }, ctx);
		await pi.runCommand("advisor", "on", asCommandCtx(ctx));
		const enableCalls = spy.calls.length;

		await pi.dispatch("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);
		expect(spy.calls).toContain("disable");

		// After shutdown, a turn_end must not re-invoke the controller.
		await pi.dispatch("turn_end", { type: "turn_end", turnIndex: 0, message: { role: "assistant", stopReason: "stop" }, toolResults: [] }, ctx);
		expect(spy.calls.length).toBe(enableCalls + 1); // only the `disable` call was added
	});

	test("5. user-abort heuristic: aborted turn_end → noteUserAbort before handleTurnEnd; agent_start → noteUserPrompt", async () => {
		const pi = new FakePi();
		const spy = makeSpy();
		installAdvisor(pi as unknown as ExtensionAPI, { buildGraph: spy.buildGraph });

		const { ctx } = makeCtx({ hasUI: true, cwd: tmpCwd() });
		await pi.dispatch("session_start", { type: "session_start", reason: "startup" }, ctx);
		await pi.runCommand("advisor", "on", asCommandCtx(ctx));
		spy.calls.length = 0; // reset to focus on abort wiring

		// Aborted turn: noteUserAbort fires BEFORE handleTurnEnd.
		await pi.dispatch(
			"turn_end",
			{ type: "turn_end", turnIndex: 0, message: { role: "assistant", stopReason: "aborted" }, toolResults: [] },
			ctx,
		);
		const abortIdx = spy.calls.indexOf("noteUserAbort");
		const handleIdx = spy.calls.indexOf("handleTurnEnd");
		expect(abortIdx).toBeGreaterThanOrEqual(0);
		expect(handleIdx).toBeGreaterThan(abortIdx);

		// A new user prompt clears the flag.
		await pi.dispatch("agent_start", { type: "agent_start" }, ctx);
		expect(spy.calls).toContain("noteUserPrompt");

		// A normal (non-aborted) turn_end does NOT re-flag an abort.
		const abortsBefore = spy.calls.filter((c) => c === "noteUserAbort").length;
		await pi.dispatch(
			"turn_end",
			{ type: "turn_end", turnIndex: 1, message: { role: "assistant", stopReason: "stop" }, toolResults: [] },
			ctx,
		);
		const abortsAfter = spy.calls.filter((c) => c === "noteUserAbort").length;
		expect(abortsAfter).toBe(abortsBefore);
	});

	test("renderer is registered for the `advisor` customType and formats via the card helper", () => {
		const pi = new FakePi();
		const spy = makeSpy();
		installAdvisor(pi as unknown as ExtensionAPI, { buildGraph: spy.buildGraph });

		const renderer = pi.renderers.get("advisor");
		expect(typeof renderer).toBe("function");
		// Drive it with a fake theme + a blocker-severity detail; the pure
		// helper's BLOCKER label must appear in the rendered text.
		if (typeof renderer !== "function") throw new Error("advisor renderer not registered");
		const fakeTheme = { fg: (_c: string, t: string) => t };
		const out = renderer(
			{ customType: "advisor", content: "stop: missing transaction", display: true, details: { severity: "blocker" } },
			{ expanded: false },
			fakeTheme,
		);
		// The renderer returns a Text component; its constructor stores the
		// formatted string. We assert the formatted text contains the label +
		// the note. Reading the rendered string via the public `render` API.
		expect(out).toBeDefined();
		// `Text.render(width)` returns the lines; join to inspect content.
		const rendered = (out as { render(width: number): string[] }).render(80).join("\n");
		expect(rendered).toContain("BLOCKER");
		expect(rendered).toContain("stop: missing transaction");
	});
});

// ---------------------------------------------------------------------------
// Composition regression — real tool + real guard + real controller.route
// ---------------------------------------------------------------------------

/** Minimal fake facade for the composition test: records sendMessage calls. */
class FakeFacade implements HostFacade {
	readonly sent: AdvisorMessage[] = [];
	branch: BranchEntry[] = [];
	readonly statuses: { key: string; text: string | null }[] = [];
	readonly notifications: { text: string; level?: "info" | "warning" | "error" }[] = [];

	getBranchEntries(): BranchEntry[] { return [...this.branch]; }
	sendMessage(msg: AdvisorMessage): void { this.sent.push(msg); }
	setStatus(key: string, text: string | null): void { this.statuses.push({ key, text }); }
	notify(text: string, level?: "info" | "warning" | "error"): void { this.notifications.push({ text, level }); }
}

/** Minimal fake runner — the composition test drives the tool directly. */
class FakeRunner implements AdvisorRunnerLike {
	async ensureSession(): Promise<void> {}
	async review(): Promise<void> {}
	async reset(): Promise<void> {}
	async dispose(): Promise<void> {}
}

const COMPOSITION_CTX = {} as ExtensionContext;

/** Pull the first text part out of a tool result. */
function firstText(res: { content: Array<{ type: string; text?: string }> }): string {
	const first = res.content[0];
	return first && first.type === "text" ? (first.text ?? "") : "";
}

describe("composition regression — guard applied once (in the tool, not route)", () => {
	test("real createAdviseTool + real EmissionGuard + real controller.route: one send, then duplicate", async () => {
		const facade = new FakeFacade();
		const runner = new FakeRunner();
		const guard = new EmissionGuard();
		const config: AdvisorConfig = { ...DEFAULT_CONFIG };
		let controller: AdvisorController = undefined as unknown as AdvisorController;
		const backlog = new BacklogQueue({
			review: (batch, epoch) => controller.review(batch, epoch),
			onFailureGiveUp: (err) => controller.handleGiveUp(err),
		});
		controller = new AdvisorController({ facade, runner, guard, backlog, config });

		// The tool's route is `controller.route` — the SAME seam the real graph
		// binds. The guard is shared. If `route` re-checked the guard, the first
		// accepted note would be double-consumed and the send dropped.
		const tool = createAdviseTool({
			guard,
			route: (note: string, severity: Severity) => controller.route(note, severity),
		});

		const r1 = await tool.execute(
			"c1",
			{ note: "Add retry back-off before the write", severity: "concern" },
			undefined,
			undefined,
			COMPOSITION_CTX,
		);
		expect(firstText(r1)).toBe("Recorded.");
		expect(facade.sent.length).toBe(1);
		expect(facade.sent[0].content).toBe("Add retry back-off before the write");

		// Second call with the same note: the guard dedupes in the tool, so
		// `route` is never called and no second sendMessage occurs.
		const r2 = await tool.execute(
			"c2",
			{ note: "Add retry back-off before the write", severity: "concern" },
			undefined,
			undefined,
			COMPOSITION_CTX,
		);
		expect(firstText(r2)).toBe("Duplicate advice ignored.");
		expect(facade.sent.length).toBe(1);
	});
});
