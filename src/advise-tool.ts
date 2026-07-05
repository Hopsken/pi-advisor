// `advise` custom tool — the advisor model's only output channel.
// PLAN §4/§11, issue #07. Blueprint: oh-my-pi `advise-tool.ts`.
//
// The tool object is built against pi's real `ToolDefinition` type (imported
// from `@earendil-works/pi-coding-agent`, schema in TypeBox via the `typebox`
// package pi already depends on). The handler runs the emission guard and
// routes accepted advice; suppression is invisible to the model so it cannot
// learn to rephrase its way past the guard:
//   - allowed        → await route(note, severity); reply "Recorded."
//   - duplicate      → reply "Duplicate advice ignored." (no route) — the one
//                      surfaced suppression, so the model knows not to repeat.
//   - content-free /  → reply "Recorded." (no route) — silent drop.
//     budget
//   - invalid input  → throw → pi wraps as a model-visible isError result so
//                      the model can correct the call shape.
//   - route throws   → swallow, reply "Recorded.", surface via onError so the
//                      model never sees a scary transport error.

import type { ToolDefinition, ExtensionContext, AgentToolResult } from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import type { GuardDecision } from "./emission-guard.ts";
import type { Severity } from "./types.ts";

/** Description ported/adapted from the oh-my-pi `advise-tool.md` blueprint. */
const ADVISE_DESCRIPTION = [
	"Send one concrete, terse piece of advice to the agent you are watching.",
	"- Emit at most one `advise` call per update; prefer silence when nothing matters.",
	"- Use it to head off likely-wrong or materially wasteful work, not to narrate progress.",
	"- `severity` weighs how strongly the agent should consider the note:",
	"  `nit` = nice-to-have polish; `concern` = should fix; `blocker` = must fix before continuing.",
	"- Never repeat advice you have already given at the same or higher severity.",
].join("\n");

/** TypeBox parameter schema for the `advise` tool. Both fields are required. */
const adviseSchema = Type.Object({
	note: Type.String({
		description:
			"One concrete, actionable piece of advice for the agent you are watching. Terse and specific.",
	}),
	severity: Type.Union([Type.Literal("nit"), Type.Literal("concern"), Type.Literal("blocker")], {
		description:
			"How strongly to weigh this advice: nit (nice-to-have), concern (should fix), or blocker (must fix before continuing). Pick the lowest grade that fits.",
	}),
});

/** Structured details attached to every advise result (logs / UI rendering). */
export interface AdviseToolDetails {
	note: string;
	severity: Severity;
}

/**
 * Structural interface for the guard dependency. The real `EmissionGuard`
 * satisfies this (it has a matching `accept`), but tests can substitute a
 * stub without having to fake EmissionGuard's private dedupe state. We accept
 * the wider type rather than `EmissionGuard` precisely so a fake guard is
 * injectable — the only behavior the tool relies on is `accept`'s decision.
 */
export interface AdviseGuard {
	accept(note: string, severity: Severity): GuardDecision;
}

/** Dependencies injected into {@link createAdviseTool}. */
export interface AdviseToolDeps {
	/** Per-session emission guard (dedupe / content-free / per-update budget). */
	guard: AdviseGuard;
	/** Delivery sink for an accepted note. Called only when the guard allows. */
	route: (note: string, severity: Severity) => void | Promise<void>;
	/** Optional sink for route errors, so a transport failure is observable
	 *  without leaking a scary error back to the advisor model. */
	onError?: (error: unknown, note: string, severity: Severity) => void;
}

const SEVERITIES: ReadonlySet<string> = new Set(["nit", "concern", "blocker"]);

/** Build a single `Recorded.` / `Duplicate advice ignored.` text result. */
function textResult(text: string, note: string, severity: Severity): AgentToolResult<AdviseToolDetails> {
	return {
		content: [{ type: "text", text }],
		details: { note, severity },
	};
}

/**
 * Build the `advise` custom tool. The returned object satisfies pi's
 * `ToolDefinition` and can be passed straight to `createAgentSession({
 * customTools: [tool] })`.
 */
export function createAdviseTool(deps: AdviseToolDeps): ToolDefinition<typeof adviseSchema, AdviseToolDetails> {
	return defineTool({
		name: "advise",
		label: "Advise",
		description: ADVISE_DESCRIPTION,
		parameters: adviseSchema,
		executionMode: "sequential",
		async execute(
			_toolCallId: string,
			params: { note: string; severity: Severity },
			_signal: AbortSignal | undefined,
			_onUpdate: ((partial: AgentToolResult<AdviseToolDetails>) => void) | undefined,
			_ctx: ExtensionContext,
		): Promise<AgentToolResult<AdviseToolDetails>> {
			const { note, severity } = params;

			// Invalid call shape: throw so pi surfaces a model-visible isError
			// result and the model can correct itself. Guard/route stay untouched.
			if (typeof note !== "string" || note.trim() === "") {
				throw new Error("advise: `note` must be a non-empty string.");
			}
			if (!SEVERITIES.has(severity)) {
				throw new Error(
					`advise: \`severity\` must be one of nit|concern|blocker, got ${JSON.stringify(severity)}.`,
				);
			}

			const decision = deps.guard.accept(note, severity);

			if (decision.allowed) {
				try {
					await deps.route(note, severity);
				} catch (error) {
					// Never leak a transport error to the model; surface via onError.
					deps.onError?.(error, note, severity);
				}
				return textResult("Recorded.", note, severity);
			}

			// The only suppression surfaced to the model: a verbatim repeat.
			if (decision.reason === "duplicate") {
				return textResult("Duplicate advice ignored.", note, severity);
			}

			// content-free or budget: invisible suppression.
			return textResult("Recorded.", note, severity);
		},
	});
}
