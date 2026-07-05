// Advisor runner — persistent advisor child session lifecycle. PLAN §1/§5/§6, issue #09.
//
// Owns the advisor sub-session: lazy creation seeded with a compressed branch
// snapshot, per-turn review prompts, reset (fresh sessionId + re-seed) on
// branch divergence or context overflow, and disposal. The single seam is the
// injected `SessionFactory`; the real factory (`createRealSessionFactory`)
// assembles a pi `createAgentSession` per the PLAN §1 code block and must
// TYPECHECK against the real pi exports — that compile is its contract test
// (no live LLM is exercised in this issue).
//
// Prior art for assembly / subscribe / abort-forwarding / finally cleanup:
// pi-subagents `src/agent-runner.ts:572-608`.

import {
	createAgentSession,
	DefaultResourceLoader,
	SessionManager,
	SettingsManager,
	type AgentSession,
	type AgentSessionEvent,
	type CreateAgentSessionOptions,
	type ModelRegistry,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import { buildAdvisorSystemPrompt } from "./prompts.ts";
import type { AdvisorConfig } from "./types.ts";

/** Read-only built-in tool allowlist for the advisor sub-session. PLAN §2.3. */
const ADVISOR_TOOLS: readonly string[] = ["read", "grep", "find", "ls"];

/**
 * Narrow seam over a pi `AgentSession` that the runner actually depends on.
 * Tests substitute this with a controllable fake handle; the real factory
 * returns an adapter over a live `AgentSession`.
 */
export interface AdvisorSessionHandle {
	prompt(text: string, opts?: { signal?: AbortSignal }): Promise<void>;
	abort(): Promise<void> | void;
	dispose(): void | Promise<void>;
}

/**
 * Creates an advisor session handle from prompt-time params. The runner builds
 * the system prompt (from config) and supplies the fixed tool allowlist plus
 * the advise custom tool; the factory wires these into a real (or fake) pi
 * session and returns the narrow handle.
 */
export type SessionFactory = (params: {
	systemPrompt: string;
	model?: string;
	tools: string[];
	adviseTool: unknown;
}) => Promise<AdvisorSessionHandle>;

// ---------------------------------------------------------------------------
// Overflow detection (PLAN §6). Pragmatic message-matching heuristic over the
// error thrown by `session.prompt()` when a provider rejects input exceeding
// its context window. Ported/trimmed from pi's `packages/ai/src/utils/overflow.ts`
// — pi's helper operates on an `AssistantMessage`; the runner sees a thrown
// `Error`, so we match against the error's message string instead. High-
// precision provider patterns are preferred over generic token-limit phrases
// to avoid false positives on rate-limit / throttling errors (excluded below).
// ---------------------------------------------------------------------------

const OVERFLOW_PATTERNS: readonly RegExp[] = [
	/prompt is too long/i, // Anthropic token overflow
	/request_too_large/i, // Anthropic request byte-size overflow (HTTP 413)
	/exceeds the context window/i, // OpenAI (Completions & Responses)
	/exceeds (?:the )?(?:model'?s )?maximum context length/i, // OpenAI-compatible / LiteLLM
	/maximum prompt length is \d+/i, // xAI (Grok)
	/reduce the length of the messages/i, // Groq
	/maximum context length is \d+ tokens/i, // OpenRouter
	/input \(\d+ tokens\) is longer than the model'?s context length/i, // Together AI
	/exceeds the available context size/i, // llama.cpp
	/greater than the context length/i, // LM Studio
	/context window exceeds limit/i, // MiniMax
	/exceeded model token limit/i, // Kimi For Coding
	/too large for model with \d+ maximum context length/i, // Mistral
	/context[_ ]length[_ ]exceeded/i, // generic
	/prompt too long/i, // Ollama
];

/** Patterns that indicate a non-overflow error (rate limiting / throttling). */
const NON_OVERFLOW_PATTERNS: readonly RegExp[] = [
	/^(Throttling error|Service unavailable):/i, // AWS Bedrock human-readable prefixes
	/rate limit/i, // generic rate limiting
	/too many requests/i, // generic HTTP 429
];

/**
 * Heuristic: does `err` look like a provider context-window overflow?
 *
 * Coerces the input to a message string (Error.message, a string, or an
 * object's `.message`), excludes known non-overflow phrases (rate limiting /
 * throttling), then tests the high-precision overflow patterns. Non-Error
 * inputs (`null`, `undefined`, numbers) return `false`. Exported for tests.
 */
export function isOverflowError(err: unknown): boolean {
	if (err === null || err === undefined) return false;
	let msg: string;
	if (typeof err === "string") {
		msg = err;
	} else if (err instanceof Error) {
		msg = err.message;
	} else if (
		typeof err === "object" &&
		typeof (err as { message?: unknown }).message === "string"
	) {
		msg = (err as { message: string }).message;
	} else {
		msg = String(err);
	}
	if (!msg) return false;
	if (NON_OVERFLOW_PATTERNS.some((p) => p.test(msg))) return false;
	return OVERFLOW_PATTERNS.some((p) => p.test(msg));
}

// ---------------------------------------------------------------------------
// AdvisorRunner
// ---------------------------------------------------------------------------

/**
 * Owns the persistent advisor child session.
 *
 * Lifecycle:
 *   - `ensureSession()` lazily creates the session (factory + seed prompt);
 *     idempotent.
 *   - `review(batch)` prompts the session; on an overflow error it `reset()`s
 *     (dispose + fresh session + re-seed) and retries the batch once on the
 *     new session. A second overflow (or any non-overflow error) propagates.
 *   - `reset()` disposes the old handle and creates + seeds a fresh one
 *     (new sessionId → cold cache once; PLAN §5 档 A / §6).
 *   - `dispose()` drops the handle; a later `review`/`ensureSession` recreates
 *     it lazily. `dispose()` is therefore NOT final — the caller controls
 *     teardown by ceasing to call `review`. This matches the lazy-creation
 *     contract and lets the AdvisorController (#10) drive lifecycle without
 *     re-instantiating the runner.
 */
export class AdvisorRunner {
	private handle: AdvisorSessionHandle | null = null;

	constructor(
		private readonly deps: {
			factory: SessionFactory;
			buildSeed: () => string;
			config: AdvisorConfig;
			adviseTool: unknown;
		},
	) {}

	/** Lazily create + seed the session if it does not already exist. */
	async ensureSession(): Promise<void> {
		if (this.handle) return;
		this.handle = await this.create();
	}

	/**
	 * Prompt the advisor with a compressed batch. On a context-window overflow
	 * the session is reset (fresh sessionId + re-seed) and the batch is retried
	 * once on the new session; a second overflow propagates. Non-overflow
	 * errors propagate without a reset. The abort signal is forwarded to the
	 * underlying prompt call.
	 */
	async review(batch: string, opts?: { signal?: AbortSignal }): Promise<void> {
		await this.ensureSession();
		const current = this.handle;
		if (!current) return; // unreachable after a successful ensureSession
		try {
			await current.prompt(batch, { signal: opts?.signal });
		} catch (err) {
			if (!isOverflowError(err)) throw err;
			await this.reset();
			const fresh = this.handle;
			if (!fresh) throw err; // reset left no handle — propagate the overflow
			await fresh.prompt(batch, { signal: opts?.signal });
		}
	}

	/**
	 * Dispose the current session and create + seed a fresh one (PLAN §5 档 A,
	 * §6 overflow reset). The new session gets a new in-memory sessionId, so the
	 * prompt cache is cold once — the accepted cost of branch/overflow recovery.
	 */
	async reset(): Promise<void> {
		const old = this.handle;
		this.handle = null;
		if (old) await Promise.resolve(old.dispose());
		this.handle = await this.create();
	}

	/** Dispose the underlying handle. A later `review` recreates the session. */
	async dispose(): Promise<void> {
		const old = this.handle;
		this.handle = null;
		if (old) await Promise.resolve(old.dispose());
	}

	/** Create + seed a fresh handle via the factory. */
	private async create(): Promise<AdvisorSessionHandle> {
		const { factory, buildSeed, config, adviseTool } = this.deps;
		const handle = await factory({
			systemPrompt: buildAdvisorSystemPrompt(config),
			model: config.model,
			tools: [...ADVISOR_TOOLS],
			adviseTool,
		});
		await handle.prompt(buildSeed());
		return handle;
	}
}

// ---------------------------------------------------------------------------
// Real factory — assembles a pi AgentSession per PLAN §1. Typecheck is the
// contract; no live LLM is run here.
// ---------------------------------------------------------------------------

/**
 * Type of the `model` option accepted by `createAgentSession`, i.e.
 * `Model<any> | undefined`. Expressed via `CreateAgentSessionOptions["model"]`
 * so this module never imports the `Model` type directly (it is not
 * re-exported by the coding-agent package).
 */
type AgentSessionModel = CreateAgentSessionOptions["model"];

/** Dependencies needed to build a real advisor session handle. */
export interface RealSessionFactoryDeps {
	cwd: string;
	agentDir: string;
	modelRegistry: ModelRegistry;
	/** Advisor config: supplies thinkingLevel and the inverted noSkills /
	 *  noContextFiles flags, plus the model name resolved via `resolveModel`. */
	config: AdvisorConfig;
	/**
	 * Resolve a fuzzy model name (from `config.model`) to a pi `Model`.
	 * Optional; when absent or returning undefined, `createAgentSession` falls
	 * back to the settings default model. Wired by the extension entry (#11)
	 * using `ctx.modelRegistry`.
	 */
	resolveModel?: (name: string | undefined) => Promise<AgentSessionModel>;
	/**
	 * Optional listener subscribed for the duration of each `prompt()` call
	 * (unsubscribed in `finally`, mirroring pi-subagents). Used to surface
	 * `message_end` usage and tool activity to the Controller (#10).
	 */
	onEvent?: (event: AgentSessionEvent) => void;
}

/**
 * Build a `SessionFactory` that assembles a real pi `AgentSession` per the
 * PLAN §1 code block: read-only built-in tool allowlist, the advise custom
 * tool, an in-memory `SessionManager` (persistent sessionId → prompt cache),
 * `SettingsManager.create`, a `DefaultResourceLoader` carrying the advisor
 * system prompt with extensions/prompt-templates/themes disabled and
 * skills/context files gated by config. Does NOT call `bindExtensions`
 * (PLAN §2.4 — structural self-recursion guard). The returned handle forwards
 * abort via the signal and cleans up its subscription in `finally`.
 */
export function createRealSessionFactory(deps: RealSessionFactoryDeps): SessionFactory {
	return async ({ systemPrompt, model, tools, adviseTool }) => {
		const settingsManager = SettingsManager.create(deps.cwd, deps.agentDir);
		const sessionManager = SessionManager.inMemory(deps.cwd);

		const resourceLoader = new DefaultResourceLoader({
			cwd: deps.cwd,
			agentDir: deps.agentDir,
			settingsManager,
			systemPrompt,
			noExtensions: true,
			noPromptTemplates: true,
			noThemes: true,
			noSkills: !deps.config.skills,
			noContextFiles: !deps.config.contextFiles,
		});
		await resourceLoader.reload();

		const sessionOpts: CreateAgentSessionOptions = {
			cwd: deps.cwd,
			agentDir: deps.agentDir,
			modelRegistry: deps.modelRegistry,
			sessionManager,
			settingsManager,
			resourceLoader,
			tools,
			customTools: [adviseTool as ToolDefinition],
		};

		if (deps.resolveModel) {
			const resolved = model ? await deps.resolveModel(model) : undefined;
			if (resolved) sessionOpts.model = resolved;
		}

		sessionOpts.thinkingLevel = deps.config.thinkingLevel;

		const { session } = await createAgentSession(sessionOpts);

		return {
			prompt: async (text, opts) => {
				const unsubscribe = deps.onEvent ? session.subscribe(deps.onEvent) : () => {};
				const cleanupAbort = forwardAbortSignal(session, opts?.signal);
				try {
					await session.prompt(text);
				} finally {
					unsubscribe();
					cleanupAbort();
				}
			},
			abort: () => session.abort(),
			dispose: () => session.dispose(),
		};
	};
}

/**
 * Wire an `AbortSignal` to `session.abort()`. Returns a cleanup function that
 * removes the listener. If the signal is already aborted, aborts immediately.
 * Mirrors pi-subagents `forwardAbortSignal`.
 */
function forwardAbortSignal(session: AgentSession, signal?: AbortSignal): () => void {
	if (!signal) return () => {};
	if (signal.aborted) {
		void session.abort();
		return () => {};
	}
	const onAbort = (): void => {
		void session.abort();
	};
	signal.addEventListener("abort", onAbort, { once: true });
	return () => signal.removeEventListener("abort", onAbort);
}
