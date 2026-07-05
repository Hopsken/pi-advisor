// pi-advisor extension entry. PLAN §2.4 / §12 / §14, issue #11.
//
// Wires every prior module into the real object graph and binds it to pi's
// lifecycle: dormancy guard, event handlers, the `/advisor` command, and the
// `advisor` custom message renderer. The entry stays THIN — every behavior
// lives in its module; this file only assembles + routes.
//
// Graph (PLAN §1): config → EmissionGuard → createAdviseTool({guard, route:
// controller.route}) → AdvisorRunner(real factory, buildAdvisorSystemPrompt)
// → AdvisorController({facade, runner, guard, backlog, config}). The backlog's
// `review` / `onFailureGiveUp` close over the controller lazily (the backlog is
// constructed before the controller exists), mirroring issue #10's harness.
//
// Dormancy guard (PLAN §2.4): the advisor must NOT activate inside foreign
// child sessions (pi-subagents spawns, `pi -p` headless runs). Heuristic:
// activate only when `ctx.hasUI === true` OR `PI_ADVISOR_FORCE=1`. Headless
// `pi -p` needs the env var — a documented limitation. Even `config.enabled`
// cannot override a negative guard, so an advisor-enabled project loaded inside
// a sub-agent session stays dormant. The `/advisor on` command refuses with an
// explanation when the guard says no.
//
// User-abort heuristic (PLAN §8 research task): pi's agent loop sets the
// assistant message's `stopReason` to `"aborted"` when the user hits Esc. The
// `turn_end` event carries that message, so we inspect it there and call
// `noteUserAbort` BEFORE `handleTurnEnd`. Doing it in `turn_end` (rather than
// `agent_end`) means the abort flag is set before the backlog drain's delivery
// decision for the same turn, so an idle blocker downgrades to `nextTurn`
// instead of immediately steering into a session the user just stopped. A new
// user prompt fires `agent_start`, which clears the flag via `noteUserPrompt`.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
	CONFIG_DIR_NAME,
	getAgentDir,
	type ExtensionAPI,
	type ExtensionContext,
	type ExtensionCommandContext,
	type ModelRegistry,
	type CreateAgentSessionOptions,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import { loadConfig } from "./config.ts";
import { EmissionGuard } from "./emission-guard.ts";
import { BacklogQueue } from "./backlog.ts";
import {
	AdvisorController,
	type BranchEntry,
	type HostFacade,
} from "./controller.ts";
import { createAdviseTool } from "./advise-tool.ts";
import {
	AdvisorRunner,
	createRealSessionFactory,
	type SessionFactory,
} from "./runner.ts";
import { formatAdvisorCard } from "./ui/advisor-card.ts";
import { DEFAULT_CONFIG, type AdvisorConfig, type Severity } from "./types.ts";
import type { SessionEntryLike } from "./compress.ts";

/** customType of the advisor's own injected cards (renderer + loop-gate key). */
const ADVISOR_CUSTOM_TYPE = "advisor" as const;

/** Env var that overrides the dormancy guard for headless `pi -p`. */
const FORCE_ENV = "PI_ADVISOR_FORCE";

/**
 * First user prompt handed to a freshly created advisor sub-session (before the
 * compressed-branch seed batch arrives via the backlog drain). A short kickoff:
 * the controller's `enable()` / reset flow separately pushes the compressed
 * current-branch snapshot into the backlog, which becomes the advisor's first
 * `review` batch — so the seed must NOT duplicate that content.
 */
const ADVISOR_SEED_PROMPT =
	"You are now activated as the advisor watcher. The next message contains a " +
	"compressed transcript of the current session state. Review it and emit at most " +
	"one `advise` call only when you have something concrete to flag; otherwise stay silent.";

/**
 * The subset of {@link AdvisorController} the entry calls into. The real
 * controller satisfies it structurally; tests inject a spy that records calls.
 * Keeping the port narrow means the spy doesn't have to fake the controller's
 * internal seams (`review`, `route`, `handleGiveUp`).
 */
export interface AdvisorControllerPort {
	enable(): Promise<void>;
	disable(): Promise<void>;
	handleTurnEnd(ev?: { signal?: AbortSignal }): Promise<void>;
	handleSessionTree(): Promise<void>;
	handleSessionCompact(): Promise<void>;
	noteUserPrompt(): void;
	noteUserAbort(): void;
	status(): { enabled: boolean; backlog: number; model?: string };
}

/** A built advisor graph — the entry holds one while active. */
export interface AdvisorGraph {
	controller: AdvisorControllerPort;
}

/**
 * Builds the real advisor graph from a session context. The entry calls this
 * when activating (either at `session_start` when `config.enabled` + guard
 * pass, or lazily from `/advisor on`). Tests inject a factory that returns a
 * spy controller so the entry's wiring can be asserted without the LLM-bound
 * runner. The factory receives everything stateless it needs (`config`, `ctx`,
 * `pi`); the facade is constructed internally so it can thread the advisor
 * severity into `pi.sendMessage` `details` for the renderer (see below).
 */
export type AdvisorGraphFactory = (params: {
	config: AdvisorConfig;
	ctx: ExtensionContext;
	pi: ExtensionAPI;
}) => AdvisorGraph;

/**
 * Resolve a fuzzy `config.model` name against the host registry. Accepts
 * `"provider/modelId"` (exact) or a case-insensitive substring of the model
 * `id`/`name` (e.g. `"haiku"`). Returns `undefined` when unresolved so the
 * runner falls back to the host default model.
 */
function resolveAdvisorModel(
	registry: ModelRegistry,
	name: string | undefined,
): CreateAgentSessionOptions["model"] {
	if (!name) return undefined;
	if (name.includes("/")) {
		const [provider, modelId] = name.split("/");
		const exact = registry.find(provider, modelId);
		if (exact) return exact;
	}
	const needle = name.toLowerCase();
	const all = registry.getAll();
	return all.find(
		(m) =>
			m.id.toLowerCase().includes(needle) ||
			(typeof m.name === "string" && m.name.toLowerCase().includes(needle)),
	);
}

/**
 * Build the real graph: shared `EmissionGuard`, real `BacklogQueue` whose
 * callbacks close over the controller lazily, real `AdvisorRunner` over the
 * real session factory, and the `advise` tool bound to `controller.route`.
 *
 * Severity threading: `AdvisorController.route` (issue #10, immutable here)
 * sends an `AdvisorMessage` with no `details`, but the `advisor` renderer needs
 * the severity to color the card. The graph wraps the route passed to the tool
 * so it stashes the severity in a closure cell right before `controller.route`
 * runs synchronously, and the facade attaches it as `details: { severity }` on
 * `pi.sendMessage`. `controller.route` is the ONLY caller of
 * `facade.sendMessage`, so the cell is always current. This keeps
 * `controller.ts` unmodified (issue #11 change-scope constraint) while still
 * letting the renderer color by severity.
 */
function defaultBuildGraph({ config, ctx, pi }: { config: AdvisorConfig; ctx: ExtensionContext; pi: ExtensionAPI }): AdvisorGraph {
	/** Last severity handed to `controller.route`, for the renderer's `details`. */
	let lastSeverity: Severity = "concern";

	const facade: HostFacade = {
		getBranchEntries(): BranchEntry[] {
			// pi's `SessionEntry` is structurally compatible with the narrower
			// `SessionEntryLike` compress consumes; the cast is the controller's
			// documented responsibility (compress.ts §"Input typing").
			const entries = ctx.sessionManager.getBranch();
			return entries.map((e) => ({ id: e.id, entry: e as unknown as SessionEntryLike }));
		},
		sendMessage(msg): void {
			pi.sendMessage(
				{
					customType: msg.customType,
					content: msg.content,
					display: msg.display,
					details: { severity: lastSeverity },
				},
				{ deliverAs: msg.deliverAs, triggerTurn: msg.triggerTurn },
			);
		},
		setStatus(key, text): void {
			ctx.ui.setStatus(key, text === null ? undefined : text);
		},
		notify(text, level): void {
			ctx.ui.notify(text, level ?? "info");
		},
	};

	const guard = new EmissionGuard();

	// Lazy closure: the backlog is built before the controller exists, and the
	// controller needs the runner which needs the adviseTool which needs
	// controller.route. Construct the runner with a placeholder adviseTool and
	// rebind via a mutable cell, exactly like issue #10's harness.
	let controller: AdvisorController = undefined as unknown as AdvisorController;
	const backlog = new BacklogQueue({
		review: (batch, epoch) => controller.review(batch, epoch),
		onFailureGiveUp: (err) => controller.handleGiveUp(err),
	});

	const wrappedRoute = (note: string, severity: Severity): void => {
		lastSeverity = severity;
		controller.route(note, severity);
	};

	const adviseTool = createAdviseTool({
		guard,
		route: wrappedRoute,
		onError: (err) => {
			// Transport failure on the advisor's only output channel: surface to
			// the user (the advisor model already saw "Recorded.").
			ctx.ui.notify(
				`advisor: failed to deliver advice — ${err instanceof Error ? err.message : String(err)}`,
				"warning",
			);
		},
	});

	const factory: SessionFactory = createRealSessionFactory({
		cwd: ctx.cwd,
		agentDir: getAgentDir(),
		modelRegistry: ctx.modelRegistry,
		config,
		resolveModel: async (name) => resolveAdvisorModel(ctx.modelRegistry, name),
	});

	const runner = new AdvisorRunner({
		factory,
		buildSeed: () => ADVISOR_SEED_PROMPT,
		config,
		adviseTool,
	});

	controller = new AdvisorController({ facade, runner, guard, backlog, config });

	return { controller };
}

/** Merge-write `enabled` (only) into the project config file. */
function persistEnabled(cwd: string, enabled: boolean): void {
	const dir = join(cwd, CONFIG_DIR_NAME);
	const file = join(dir, "advisor.json");
	let existing: Record<string, unknown> = {};
	try {
		const text = readFileSync(file, "utf8");
		const parsed = JSON.parse(text);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			existing = parsed as Record<string, unknown>;
		}
	} catch {
		// missing or malformed — start from an empty layer
	}
	existing.enabled = enabled;
	mkdirSync(dir, { recursive: true });
	writeFileSync(file, `${JSON.stringify(existing, null, 2)}\n`, "utf8");
}

/**
 * Install the advisor extension onto `pi`. Exported so tests can inject a
 * controller factory (spy); the default export uses the real graph builder.
 */
export function installAdvisor(pi: ExtensionAPI, deps: { buildGraph: AdvisorGraphFactory }): void {
	// --- renderer (always registered; harmless when no advisor cards exist) ---
	pi.registerMessageRenderer(
		ADVISOR_CUSTOM_TYPE,
		(message, _options, theme) => {
			const severity = readSeverity(message.details);
			const content = typeof message.content === "string" ? message.content : "";
			return new Text(formatAdvisorCard(content, severity, theme), 0, 0);
		},
	);

	// --- advisor state (re-evaluated each session_start) ---
	let config: AdvisorConfig = { ...DEFAULT_CONFIG, ...loadConfig({ cwd: process.cwd(), agentDir: getAgentDir() }) };
	let graph: AdvisorGraph | null = null;
	let active = false;

	/** Dormancy guard: foreign child sessions + headless `-p` stay dormant. */
	function canActivate(ctx: ExtensionContext): boolean {
		return ctx.hasUI === true || process.env[FORCE_ENV] === "1";
	}

	async function activate(ctx: ExtensionContext): Promise<void> {
		if (graph) return;
		graph = deps.buildGraph({ config, ctx, pi });
		active = true;
		await graph.controller.enable();
	}

	async function deactivate(): Promise<void> {
		active = false;
		const g = graph;
		graph = null;
		if (g) await g.controller.disable();
	}

	// --- session lifecycle ---

	pi.on("session_start", async (_event, ctx) => {
		// Reload config for this project (cwd may differ across /resume, /fork).
		config = { ...DEFAULT_CONFIG, ...loadConfig({ cwd: ctx.cwd, agentDir: getAgentDir() }) };
		if (config.enabled && canActivate(ctx)) {
			await activate(ctx);
		}
	});

	// A new user prompt re-engages: clear any stale autoResumeSuppressed flag.
	pi.on("agent_start", () => {
		if (active) graph?.controller.noteUserPrompt();
	});

	// turn_end: best-effort user-abort detection (see module header) then the
	// observe→review→deliver cycle. Abort is checked FIRST so the flag is set
	// before the backlog drain's delivery decision for the same turn.
	pi.on("turn_end", (event, ctx) => {
		if (!active) return;
		if (isAbortedAssistant(event)) graph?.controller.noteUserAbort();
		void graph?.controller.handleTurnEnd({ signal: ctx.signal });
	});

	pi.on("session_tree", () => {
		if (active) void graph?.controller.handleSessionTree();
	});

	pi.on("session_compact", () => {
		if (active) void graph?.controller.handleSessionCompact();
	});

	pi.on("session_shutdown", () => {
		// `disable()` disposes the runner, bumps the backlog epoch, and clears
		// status + advisor state — the documented teardown for a session end.
		void deactivate();
	});

	// --- /advisor command ---

	pi.registerCommand(ADVISOR_CUSTOM_TYPE, {
		description: "Control the advisor watcher: `on` | `off` | `status` (bare = status).",
		handler: async (args, ctx) => {
			const sub = (args ?? "").trim().toLowerCase();
			if (sub === "on") {
				if (!canActivate(ctx)) {
					ctx.ui.notify(
						"advisor inactive: no UI in this mode. Set PI_ADVISOR_FORCE=1 to force-enable (e.g. headless `pi -p`).",
						"warning",
					);
					return;
				}
				config = { ...config, enabled: true };
				persistEnabled(ctx.cwd, true);
				await activate(ctx);
				ctx.ui.notify("advisor enabled.", "info");
				return;
			}
			if (sub === "off") {
				config = { ...config, enabled: false };
				persistEnabled(ctx.cwd, false);
				await deactivate();
				ctx.ui.notify("advisor disabled.", "info");
				return;
			}
			// `status` or bare `/advisor`: report enabled, model, backlog.
			const st = graph ? graph.controller.status() : { enabled: config.enabled, backlog: 0, model: config.model };
			const modelLine = st.model ? `model: ${st.model}` : "model: (host default)";
			ctx.ui.notify(
				`advisor ${st.enabled ? "enabled" : "disabled"} · ${modelLine} · ${st.backlog} turn(s) behind`,
				"info",
			);
		},
	});
}

/** Read the severity a tool/route attached to an advisor card's `details`. */
function readSeverity(details: unknown): Severity {
	if (details && typeof details === "object" && typeof (details as { severity?: unknown }).severity === "string") {
		const s = (details as { severity: string }).severity;
		if (s === "nit" || s === "concern" || s === "blocker") return s;
	}
	return "concern";
}

/**
 * User-abort heuristic: true when `turn_end` carries an assistant message whose
 * `stopReason` is `"aborted"` (pi's agent loop sets this on Esc). Structurally
 * narrowed so it typechecks against the real `TurnEndEvent` without importing
 * the full `AgentMessage` union.
 */
function isAbortedAssistant(event: { message?: { role?: string; stopReason?: string } }): boolean {
	const m = event.message;
	return m?.role === "assistant" && m?.stopReason === "aborted";
}

/**
 * pi extension entry. Typechecks against the real `ExtensionAPI`; wires the
 * real object graph via {@link defaultBuildGraph}.
 */
export default function advisorExtension(pi: ExtensionAPI): void {
	installAdvisor(pi, { buildGraph: defaultBuildGraph });
}

// Re-exports for tests / consumers that want to assemble a custom graph.
export { defaultBuildGraph };
export type { ExtensionCommandContext };
