// Delta compression: serialize a slice of main-session entries into the compact
// transcript fed to the advisor. PLAN §9, issue #04.
//
// The advisor needs to understand what the main agent is doing, what it changed,
// and what constraints it operates under — without swallowing every byte of
// tool output (which would bloat the resident session and kill prompt-cache
// locality). So we keep user/assistant prose and thinking verbatim, collapse
// each tool call + result onto one line (`→ name({args}) ⇒ ok · N lines`),
// drop tool-result bodies, but make an exception for edit-style tools whose
// unified diff (or, for `write`, the content arg) is retained verbatim.
// Re-injected primary-context blocks (plan-mode rules, the approved plan) are
// deduped to `(unchanged — still in effect)` on their second identical
// occurrence. The advisor's own injected cards (`customType === "advisor"`) are
// skipped — defense in depth, since the controller also filters (PLAN §4 回路闸).
//
// Style reference: oh-my-pi `session/session-history-format.ts:230-358` (read
// for style, not copied — our input is pi v0.80.3 session entries, and the spec
// mandates `→ toolName({truncated args JSON})` rather than the blueprint's
// `primaryArg` pick).
//
// Determinism is load-bearing (prompt-cache friendliness): this is a pure
// function of its input — no clocks, no randomness, no input mutation.
//
// ── Input typing ────────────────────────────────────────────────────────────
// The interfaces below are narrow local shapes structurally compatible with pi
// v0.80.3 session entries, so unit tests can build fixtures without the real
// `SessionManager`. Mapping to the real shapes:
//
//   pi `SessionEntry` (session-manager.ts:140)        → here
//   ───────────────────────────────────────────────────────
//   SessionMessageEntry  { type:"message",            → CompressMessageEntry
//                          message: AgentMessage }       (message narrowed to
//                                                             CompressMessage; in
//                                                             practice pi only
//                                                             stores user/assistant/
//                                                             toolResult here —
//                                                             agent-session.ts:556)
//   CustomMessageEntry   { type:"custom_message",     → CompressCustomMessageEntry
//                           customType, content, … }     (how sendCustomMessage
//                                                             persists advisor
//                                                             cards and re-injected
//                                                             context)
//   CompactionEntry      { type:"compaction", summary }→ CompressCompactionEntry
//   BranchSummaryEntry   { type:"branch_summary", … }  → CompressBranchSummaryEntry
//   ThinkingLevelChangeEntry, ModelChangeEntry,        → CompressOtherEntry
//     CustomEntry, LabelEntry, SessionInfoEntry          (no transcript prose;
//                                                          skipped silently)
//
// The controller (issue #10) passes `getBranch()` entries; because pi types
// `SessionMessageEntry.message` as the broad `AgentMessage`, a structural cast
// (`entries as unknown as readonly SessionEntryLike[]`) or a pre-filter is the
// controller's responsibility — compress itself only reads the fields below.

/** Max length of the JSON args blob inside `→ toolName({…})`. ~120 per spec. */
const ARGS_MAX = 120;

/** customType of the advisor's own injected advice cards (skipped). */
const ADVISOR_CUSTOM_TYPE = "advisor";

/**
 * Hidden custom messages that re-inject the primary agent's operative
 * *constraints* — plan mode's rules and the approved plan it implements. A
 * reviewer must read these verbatim (truncating them hides load-bearing
 * exceptions), but a byte-identical re-injection collapses to a marker so the
 * advisor doesn't re-read ~1k tokens every turn. Mirrors oh-my-pi
 * `session-history-format.ts` `PRIMARY_CONTEXT_CUSTOM_TYPES`.
 */
export const PRIMARY_CONTEXT_CUSTOM_TYPES: ReadonlySet<string> = new Set([
	"plan-mode-context",
	"plan-mode-reference",
]);

/** Tools whose effect (diff/content) is retained verbatim instead of dropped. */
const EDIT_TOOLS: ReadonlySet<string> = new Set(["edit", "write", "apply_patch"]);

// --- content blocks ---------------------------------------------------------

export interface CompressTextContent {
	type: "text";
	text: string;
}
export interface CompressImageContent {
	type: "image";
	data: string;
	mimeType: string;
}
export interface CompressThinkingContent {
	type: "thinking";
	thinking: string;
	redacted?: boolean;
}
export interface CompressToolCall {
	type: "toolCall";
	id: string;
	name: string;
	arguments: Record<string, unknown>;
}

// --- messages (narrow subset of pi `AgentMessage` that compress renders) ----

export interface CompressUserMessage {
	role: "user";
	content: string | readonly (CompressTextContent | CompressImageContent)[];
	timestamp?: number;
}
export interface CompressAssistantMessage {
	role: "assistant";
	content: readonly (CompressTextContent | CompressThinkingContent | CompressToolCall)[];
	timestamp?: number;
}
/** Structured details on a tool result; `diff` is kept for edit-style tools. */
export type CompressToolResultDetails = { diff?: string; [k: string]: unknown };

export interface CompressToolResultMessage {
	role: "toolResult";
	toolCallId: string;
	toolName: string;
	content: readonly (CompressTextContent | CompressImageContent)[];
	/** `details.diff` (unified diff) is kept for edit-style tools. */
	details?: CompressToolResultDetails | undefined;
	isError: boolean;
	timestamp?: number;
}
export interface CompressCustomMessage {
	role: "custom";
	customType: string;
	content: string | readonly (CompressTextContent | CompressImageContent)[];
	display?: boolean;
	details?: unknown;
	timestamp?: number;
}
export type CompressMessage =
	| CompressUserMessage
	| CompressAssistantMessage
	| CompressToolResultMessage
	| CompressCustomMessage;

// --- entries (narrow subset of pi `SessionEntry`) ---------------------------

export interface CompressEntryBase {
	id: string;
	parentId: string | null;
	timestamp: string;
}

export interface CompressMessageEntry extends CompressEntryBase {
	type: "message";
	message: CompressMessage;
}

export interface CompressCustomMessageEntry extends CompressEntryBase {
	type: "custom_message";
	customType: string;
	content: string | readonly (CompressTextContent | CompressImageContent)[];
	display: boolean;
	details?: unknown;
}

export interface CompressCompactionEntry extends CompressEntryBase {
	type: "compaction";
	summary: string;
}

export interface CompressBranchSummaryEntry extends CompressEntryBase {
	type: "branch_summary";
	fromId: string;
	summary: string;
}

/**
 * Entry kinds with no transcript prose (thinking-level/model changes, pure
 * extension state, labels, session metadata). `type` is a closed literal union
 * so `switch (entry.type)` narrows the discriminated union correctly.
 */
export type CompressOtherEntryType =
	| "thinking_level_change"
	| "model_change"
	| "custom"
	| "label"
	| "session_info";

export interface CompressOtherEntry extends CompressEntryBase {
	type: CompressOtherEntryType;
}

/** Structural input type for {@link compressEntries}. */
export type SessionEntryLike =
	| CompressMessageEntry
	| CompressCustomMessageEntry
	| CompressCompactionEntry
	| CompressBranchSummaryEntry
	| CompressOtherEntry;

export interface CompressOptions {
	/** Render assistant `thinking` blocks (default: true — the advisor wants them). */
	includeThinking?: boolean;
}

// --- pure helpers -----------------------------------------------------------

/** Join the text blocks of a string-or-blocks content field; images → `[image]`. */
function contentToText(
	content: string | readonly (CompressTextContent | CompressImageContent)[],
): string {
	if (typeof content === "string") return content;
	const parts: string[] = [];
	for (const block of content) {
		if (block.type === "text") parts.push(block.text);
		else parts.push("[image]");
	}
	return parts.join("\n");
}

/** Collapse whitespace runs and truncate to `max` chars with an ellipsis. */
function oneLine(text: string, max = ARGS_MAX): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function lineCount(text: string): number {
	if (!text) return 0;
	return text.split("\n").length;
}

/** JSON-serialize tool args and truncate to {@link ARGS_MAX} chars with `…`. */
function truncateArgs(args: Record<string, unknown> | undefined): string {
	if (!args || typeof args !== "object") return "{}";
	let json: string;
	try {
		json = JSON.stringify(args);
	} catch {
		return "{}";
	}
	if (json.length <= ARGS_MAX) return json;
	return `${json.slice(0, ARGS_MAX - 1)}…`;
}

/** One-liner for a tool call + (optional) result: `→ name({args}) ⇒ status`. */
function toolCallLine(
	name: string,
	args: Record<string, unknown> | undefined,
	result: CompressToolResultMessage | undefined,
): string {
	const head = `→ ${name}(${truncateArgs(args)})`;
	if (!result) return `${head} ⇒ pending`;
	const text = contentToText(result.content);
	if (result.isError) {
		const firstLine = oneLine(text.split("\n", 1)[0] ?? "");
		return firstLine ? `${head} ⇒ error: ${firstLine}` : `${head} ⇒ error`;
	}
	const n = lineCount(text);
	return `${head} ⇒ ok · ${n} ${n === 1 ? "line" : "lines"}`;
}

/**
 * Wrap a body in a backtick fence tall enough to outlast the longest backtick
 * run inside it, so a diff/content that touches markdown can't break the fence.
 */
function fenceBlock(info: string, body: string): string {
	const longest = body.match(/`+/g)?.reduce((m, run) => Math.max(m, run.length), 0) ?? 0;
	const fence = "`".repeat(Math.max(3, longest + 1));
	return `${fence}${info}\n${body}\n${fence}`;
}

/** For edit-style tools, append the unified diff (or, for `write`, the content). */
function appendEditExpansion(
	lines: string[],
	name: string,
	args: Record<string, unknown> | undefined,
	result: CompressToolResultMessage | undefined,
): void {
	if (!EDIT_TOOLS.has(name)) return;
	const diff = (result?.details as { diff?: unknown } | undefined)?.diff;
	if (typeof diff === "string" && diff.trim()) {
		lines.push(fenceBlock("diff", diff));
		return;
	}
	// `write` carries no diff in its result details; keep the written content arg.
	if (name === "write") {
		const content = args?.content;
		if (typeof content === "string" && content.trim()) {
			lines.push(fenceBlock("", content));
		}
	}
}

/** True for entries carrying the advisor's own injected card (either shape). */
function isAdvisorInjection(entry: SessionEntryLike): boolean {
	if (entry.type === "custom_message") return entry.customType === ADVISOR_CUSTOM_TYPE;
	if (entry.type === "message") {
		const m = entry.message;
		return m.role === "custom" && m.customType === ADVISOR_CUSTOM_TYPE;
	}
	return false;
}

// --- main serializer --------------------------------------------------------

/**
 * Compress a slice of main-session entries into a compact, deterministic
 * transcript string for the advisor. Pure function of `entries` — same input
 * always yields the same output (prompt-cache friendly). See module header for
 * the rendering rules and the input-shape mapping.
 */
export function compressEntries(
	entries: readonly SessionEntryLike[],
	opts?: CompressOptions,
): string {
	const includeThinking = opts?.includeThinking ?? true;

	// Index tool results by toolCallId so each toolCall line can cite its
	// outcome without echoing the body. Orphan results (truncated history) get
	// their own line below.
	const resultsByCallId = new Map<string, CompressToolResultMessage>();
	for (const e of entries) {
		if (e.type === "message" && e.message.role === "toolResult") {
			resultsByCallId.set(e.message.toolCallId, e.message);
		}
	}
	const consumed = new Set<string>();
	const seenContext = new Map<string, string>(); // customType → last content text

	const lines: string[] = [];
	let lastHeader: string | undefined;
	const header = (h: string): void => {
		if (lastHeader !== h) {
			lines.push(h);
			lastHeader = h;
		}
	};
	const blank = (): void => {
		lines.push("");
	};

	/** Render a custom/context message (primary-context dedup or one-liner). */
	const emitCustom = (
		customType: string,
		content: string | readonly (CompressTextContent | CompressImageContent)[],
	): void => {
		const text = contentToText(content).trim();
		if (PRIMARY_CONTEXT_CUSTOM_TYPES.has(customType)) {
			if (!text) return;
			if (seenContext.get(customType) === text) {
				header(`[context:${customType}]`);
				lines.push("(unchanged — still in effect)");
				blank();
				return;
			}
			seenContext.set(customType, text);
			header(`[context:${customType}]`);
			lines.push(text);
			blank();
			return;
		}
		if (!text) return;
		lines.push(`[${customType}] ${oneLine(text)}`);
		blank();
	};

	for (const entry of entries) {
		// Defense in depth (PLAN §4 回路闸): never echo the advisor's own cards.
		if (isAdvisorInjection(entry)) continue;
		// Each entry re-headers; within an assistant message, consecutive
		// same-header blocks still collapse (see `header`).
		lastHeader = undefined;

		if (entry.type === "message") {
			const msg = entry.message;
			if (msg.role === "user") {
				const text = contentToText(msg.content);
				if (!text.trim()) continue;
				header("[user]");
				lines.push(text);
				blank();
			} else if (msg.role === "assistant") {
				for (const block of msg.content) {
					if (block.type === "text") {
						if (!block.text.trim()) continue;
						header("[agent]");
						lines.push(block.text);
						blank();
					} else if (block.type === "thinking" && includeThinking) {
						if (!block.thinking.trim()) continue;
						header("[thinking]");
						lines.push(block.thinking);
						blank();
					} else if (block.type === "toolCall") {
						const result = resultsByCallId.get(block.id);
						if (result) consumed.add(block.id);
						lines.push(toolCallLine(block.name, block.arguments, result));
						appendEditExpansion(lines, block.name, block.arguments, result);
						blank();
						// Re-label any text that follows the call within this message.
						lastHeader = undefined;
					}
					// image / redactedThinking: no readable text — elided.
				}
			} else if (msg.role === "toolResult") {
				if (consumed.has(msg.toolCallId)) continue;
				lines.push(toolCallLine(msg.toolName, undefined, msg));
				appendEditExpansion(lines, msg.toolName, undefined, msg);
				blank();
			} else if (msg.role === "custom") {
				emitCustom(msg.customType, msg.content);
			}
		} else if (entry.type === "custom_message") {
			emitCustom(entry.customType, entry.content);
		} else if (entry.type === "compaction") {
			lines.push(`[compaction] ${oneLine(entry.summary)}`);
			blank();
		} else if (entry.type === "branch_summary") {
			lines.push(`[branch] from ${entry.fromId}: ${oneLine(entry.summary)}`);
			blank();
		}
		// CompressOtherEntry: no transcript prose — skip silently.
	}

	return `${lines.join("\n").trim()}\n`;
}
