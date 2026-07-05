// Smoke test for the pi-advisor extension. Issue #12 — final v1 issue.
//
// Boots a REAL `createAgentSession` from `@earendil-works/pi-coding-agent`
// in-process with the advisor extension loaded via
// `DefaultResourceLoader({ additionalExtensionPaths: [<repo src/index.ts>] })`,
// then asserts the three acceptance criteria from issues/12-smoke-readme.md:
//
//   1. the extension loads with no diagnostics/errors;
//   2. the `/advisor` command is registered;
//   3. with `enabled:false` (default) and no UI (print-mode binding), nothing
//      observes — no advisor child session is created, observed via the absence
//      of side effects: zero faux model calls and zero `advisor` custom
//      messages in the session manager.
//
// The default run is fully OFFLINE: a faux provider satisfies
// `createAgentSession`'s `model`/`modelRegistry` params, and no main turn is
// driven (the assertions are on construction-time state + the absence of
// advisor activity). Any live-LLM path is gated behind `PI_ADVISOR_E2E_LIVE=1`
// and skipped by default.
//
// The boot pattern (hermetic global isolation + faux registry + loader +
// `bindExtensions({})` firing `session_start`) mirrors
// `~/tries/pi-subagents/test/helpers/print-mode-runner.ts` and the real-pi-mono
// e2e in `~/tries/pi-subagents/test/agent-runner-e2e.test.ts`.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import {
	type AgentSession,
	type CreateAgentSessionResult,
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";

/** Path to the advisor extension entrypoint (repo `src/index.ts`). */
const EXTENSION_PATH = fileURLToPath(new URL("../src/index.ts", import.meta.url));

/** Env var that overrides the dormancy guard for headless `pi -p`. */
const FORCE_ENV = "PI_ADVISOR_FORCE";
/** Env var that opts into the live-LLM smoke path. */
const LIVE_ENV = "PI_ADVISOR_E2E_LIVE";

/** Built-in tools pi enables by default (the advisor never adds to these). */
const BUILTIN_TOOLS = ["read", "bash", "edit", "write"];

// ---------------------------------------------------------------------------
// Hermetic environment helpers
// ---------------------------------------------------------------------------

interface EnvSnapshot {
	cwd: string;
	agentDir: string | undefined;
	home: string | undefined;
	force: string | undefined;
}

let snapshot: EnvSnapshot;
let tempCwd: string;
let tempHome: string;
let faux: ReturnType<typeof registerFauxProvider> | undefined;

beforeEach(() => {
	snapshot = {
		cwd: process.cwd(),
		agentDir: process.env.PI_CODING_AGENT_DIR,
		home: process.env.HOME,
		force: process.env[FORCE_ENV],
	};
	delete process.env[FORCE_ENV];
	// Fresh temp project dir + isolated agent dir so the dev's real
	// `~/.pi/agent/advisor.json` (global config layer) can't bleed in.
	tempCwd = mkdtempSync(join(tmpdir(), "pi-advisor-smoke-cwd-"));
	tempHome = mkdtempSync(join(tmpdir(), "pi-advisor-smoke-home-"));
	process.env.PI_CODING_AGENT_DIR = tempHome;
	process.env.HOME = tempHome;
	process.chdir(tempCwd);
});

afterEach(() => {
	faux?.unregister();
	faux = undefined;
	process.chdir(snapshot.cwd);
	if (snapshot.agentDir == null) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = snapshot.agentDir;
	if (snapshot.home == null) delete process.env.HOME;
	else process.env.HOME = snapshot.home;
	if (snapshot.force == null) delete process.env[FORCE_ENV];
	else process.env[FORCE_ENV] = snapshot.force;
	rmSync(tempCwd, { recursive: true, force: true });
	rmSync(tempHome, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Boot helper
// ---------------------------------------------------------------------------

interface BootResult {
	/** The live pi session. */
	session: AgentSession;
	/** Extensions load result — `errors` is the "no diagnostics" signal. */
	extensionsResult: CreateAgentSessionResult["extensionsResult"];
	/** In-memory session manager — read `getBranch()` for custom messages. */
	sessionManager: SessionManager;
	/** Faux model call count (0 = no advisor review ever ran). */
	modelCalls: () => number;
	/** Tear down: emit session_shutdown, dispose, unregister faux. */
	dispose: () => Promise<void>;
}

/**
 * Boot a real pi session with the advisor extension loaded. Print-mode binding
 * (no `uiContext`) ⇒ `ctx.hasUI === false`, so the dormancy guard blocks
 * activation unless `PI_ADVISOR_FORCE=1` is set. `projectConfig` writes a
 * project-layer `.pi/advisor.json` before boot so individual tests can pin
 * `enabled` without touching the global layer.
 */
async function bootSession(opts: { projectConfig?: Record<string, unknown> } = {}): Promise<BootResult> {
	if (opts.projectConfig) {
		mkdirSync(join(tempCwd, ".pi"), { recursive: true });
		writeFileSync(
			join(tempCwd, ".pi", "advisor.json"),
			`${JSON.stringify(opts.projectConfig, null, 2)}\n`,
			"utf8",
		);
	}

	faux = registerFauxProvider({
		provider: "faux",
		models: [{ id: "faux-1", contextWindow: 200_000 }],
	});
	// Queue benign replies so an *unexpected* advisor activation fails cleanly
	// instead of hanging on an empty response queue.
	faux.setResponses([fauxAssistantMessage("advisor ok")]);
	const model = faux.getModel();

	// Structural faux registry (matches pi-subagents' e2e suites): `ok: true`
	// on getApiKeyAndHeaders is mandatory — createAgentSession's injected
	// streamFn throws Error(auth.error) otherwise.
	const modelRegistry = {
		find: () => model,
		getAll: () => [model],
		getAvailable: () => [model],
		hasConfiguredAuth: () => true,
		isUsingOAuth: () => false,
		getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "faux", headers: {} }),
		registerProvider: () => {},
		unregisterProvider: () => {},
	} as unknown as Parameters<typeof createAgentSession>[0] extends { modelRegistry?: infer R }
		? R
		: never;

	const agentDir = getAgentDir();
	const sessionManager = SessionManager.inMemory(tempCwd);

	const loader = new DefaultResourceLoader({
		cwd: tempCwd,
		agentDir,
		additionalExtensionPaths: [EXTENSION_PATH],
		systemPromptOverride: () => "You are a smoke-test orchestrator.",
		appendSystemPromptOverride: () => [],
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});
	await loader.reload();

	const { session, extensionsResult } = await createAgentSession({
		cwd: tempCwd,
		agentDir,
		model,
		modelRegistry,
		resourceLoader: loader,
		sessionManager,
		settingsManager: SettingsManager.inMemory({
			compaction: { enabled: false },
			retry: { enabled: false },
		}),
	});

	// Binding fires `session_start` so the extension initializes, reads config,
	// and (if enabled + guard passes) activates. No `uiContext` ⇒ hasUI=false.
	await session.bindExtensions({});

	const modelCalls = () => faux?.state.callCount ?? 0;

	const dispose = async () => {
		try {
			await session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" });
		} catch {
			/* ignore */
		}
		try {
			session.dispose?.();
		} catch {
			/* ignore */
		}
	};

	return { session, extensionsResult, sessionManager, modelCalls, dispose };
}

/** Advisor custom messages that landed in the session manager's branch. */
function advisorMessages(sessionManager: SessionManager): unknown[] {
	return sessionManager
		.getBranch()
		.filter(
			(e) =>
				(e as { type?: string; customType?: string }).type === "custom_message" &&
				(e as { customType?: string }).customType === "advisor",
		);
}

/** Let any async backlog drain / advisor activation settle before asserting. */
async function settle(): Promise<void> {
	// Two microtask rounds + a short macrotask: the backlog drain is single-
	// flight async; if activation happened, the advisor's first review prompts
	// the faux model within this window. If the guard blocked, nothing fires.
	for (let i = 0; i < 4; i++) await Promise.resolve();
	await new Promise((r) => setTimeout(r, 25));
}

// ---------------------------------------------------------------------------
// Offline smoke (default)
// ---------------------------------------------------------------------------

describe("pi-advisor smoke — offline (default)", () => {
	test("1. extension loads with no diagnostics/errors; built-ins available", async () => {
		const boot = await bootSession();
		try {
			// `extensionsResult.errors` is the loader's authoritative error list —
			// an entry here means the extension module failed to import or its
			// factory threw. Empty = clean load.
			expect(boot.extensionsResult.errors).toEqual([]);
			expect(boot.extensionsResult.extensions.length).toBeGreaterThanOrEqual(1);
			// The session constructed and exposed its default built-in tool set.
			const tools = boot.session.getActiveToolNames();
			for (const b of BUILTIN_TOOLS) expect(tools).toContain(b);
		} finally {
			await boot.dispose();
		}
	}, 30_000);

	test("2. `/advisor` command is registered", async () => {
		const boot = await bootSession();
		try {
			const cmd = boot.session.extensionRunner.getCommand("advisor");
			expect(cmd).toBeDefined();
			expect(typeof cmd?.handler).toBe("function");
			expect(typeof cmd?.description).toBe("string");
			expect(cmd?.description).toMatch(/advisor/i);
		} finally {
			await boot.dispose();
		}
	}, 30_000);

	test("3. enabled:false + no UI → nothing observes (no advisor session, no model calls, no advisor messages)", async () => {
		// Default config (no file) ⇒ enabled:false. Print-mode binding ⇒
		// hasUI:false. The dormancy guard plus the off switch both keep the
		// advisor dormant: no child session, no review, no delivery.
		const boot = await bootSession();
		try {
			await settle();
			expect(boot.modelCalls()).toBe(0);
			expect(advisorMessages(boot.sessionManager).length).toBe(0);
			// The advisor's `advise` tool is registered only in the CHILD session,
			// never the main one — so its absence here is a sanity check, not the
			// primary signal (the primary signal is zero model calls).
			expect(boot.session.getActiveToolNames()).not.toContain("advise");
		} finally {
			await boot.dispose();
		}
	}, 30_000);

	test("4. dormancy guard: enabled:true + no UI + no PI_ADVISOR_FORCE → still nothing observes", async () => {
		// Project config turns the master switch ON, but print mode has no UI
		// and the force env is unset — so the guard blocks activation. This
		// proves the guard in a REAL session (unit tests cover it with fakes).
		const boot = await bootSession({ projectConfig: { enabled: true } });
		try {
			await settle();
			expect(boot.modelCalls()).toBe(0);
			expect(advisorMessages(boot.sessionManager).length).toBe(0);
		} finally {
			await boot.dispose();
		}
	}, 30_000);

	test("5. dormancy guard override: enabled:true + PI_ADVISOR_FORCE=1 → advisor activates (model called)", async () => {
		// The force env overrides the guard. With enabled:true the advisor
		// activates on session_start, seeds the backlog, and the drain prompts
		// the faux model — proving the activation path actually fires end-to-end
		// (and that test 4's zero-call result is due to the guard, not a wiring
		// bug). This is still OFFLINE (faux model, no network).
		process.env[FORCE_ENV] = "1";
		const boot = await bootSession({ projectConfig: { enabled: true } });
		try {
			await settle();
			expect(boot.modelCalls()).toBeGreaterThan(0);
		} finally {
			await boot.dispose();
		}
	}, 30_000);
});

// ---------------------------------------------------------------------------
// Live-LLM smoke (opt-in, skipped by default)
// ---------------------------------------------------------------------------

describe("pi-advisor smoke — live (PI_ADVISOR_E2E_LIVE=1)", () => {
	// Skipped unless the env var is set. Live mode needs real auth/network and
	// is non-deterministic; the default offline suite above is the CI gate.
	test.skipIf(!process.env[LIVE_ENV] || /^(0|false|no)$/i.test(process.env[LIVE_ENV] ?? ""))(
		"extension loads + `/advisor` registered against a real auth-backed registry",
		async () => {
			// Live boot: no faux provider, no modelRegistry pin — let
			// createAgentSession build the real, auth-backed registry and resolve
			// the model from the local `pi` settings default. We only assert
			// construction-time state (extension load + command registration); no
			// turn is driven, so this is network-light (auth lookup only).
			const agentDir = getAgentDir();
			const loader = new DefaultResourceLoader({
				cwd: tempCwd,
				agentDir,
				additionalExtensionPaths: [EXTENSION_PATH],
				systemPromptOverride: () => "You are a smoke-test orchestrator.",
				appendSystemPromptOverride: () => [],
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: true,
			});
			await loader.reload();
			const { session } = await createAgentSession({
				cwd: tempCwd,
				agentDir,
				resourceLoader: loader,
				sessionManager: SessionManager.inMemory(tempCwd),
			});
			try {
				await session.bindExtensions({});
				expect(session.extensionRunner.getCommand("advisor")).toBeDefined();
			} finally {
				try {
					await session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" });
				} catch {
					/* ignore */
				}
				try {
					session.dispose?.();
				} catch {
					/* ignore */
				}
			}
		},
		60_000,
	);
});
