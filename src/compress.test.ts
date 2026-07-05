// Tests for delta compression (transcript serializer). PLAN §9, issue #04.
//
// `compressEntries` turns a slice of main-session entries into the compact
// transcript fed to the advisor. It is a pure function of its input
// (prompt-cache friendliness hinges on determinism). These eight fixture-driven
// cases map 1:1 onto the issue spec; assertions are contains / not-contains /
// counts (no brittle full-string snapshots, per spec).
//
// Fixture shapes are narrow local interfaces (`SessionEntryLike` and friends
// defined in `compress.ts`) that are structurally compatible with pi v0.80.3
// session entries — see the mapping table documented in `compress.ts`. Tests
// build fixtures inline without the real session manager.

import { describe, expect, test } from "bun:test";

import {
	compressEntries,
	type SessionEntryLike,
	type CompressMessage,
	type CompressToolResultMessage,
	type CompressToolResultDetails,
} from "./compress.ts";

// --- fixture builders -------------------------------------------------------

function msgEntry(id: string, message: CompressMessage): SessionEntryLike {
	return { type: "message", id, parentId: null, timestamp: "2026-01-01T00:00:00Z", message };
}

function userMsg(text: string): CompressMessage {
	return { role: "user", content: text, timestamp: 1_000 };
}

function assistantMsg(
	content: CompressExtractAssistantContent,
): CompressMessage {
	return { role: "assistant", content, timestamp: 1_001 };
}
type CompressExtractAssistantContent = Exclude<CompressMessage, { role: "toolResult" | "user" | "custom" }>["content"];

function textBlock(text: string) {
	return { type: "text" as const, text };
}
function thinkingBlock(text: string) {
	return { type: "thinking" as const, thinking: text };
}
function toolCall(id: string, name: string, args: Record<string, unknown>) {
	return { type: "toolCall" as const, id, name, arguments: args };
}

function toolResult(
	toolCallId: string,
	toolName: string,
	body: string,
	opts: { isError?: boolean; details?: CompressToolResultDetails } = {},
): CompressToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text: body }],
		isError: opts.isError ?? false,
		details: opts.details,
		timestamp: 1_002,
	};
}

function customMessageEntry(
	id: string,
	customType: string,
	content: string,
): SessionEntryLike {
	return {
		type: "custom_message",
		id,
		parentId: null,
		timestamp: "2026-01-01T00:00:00Z",
		customType,
		content,
		display: true,
	};
}

function customRoleMsg(customType: string, content: string): CompressMessage {
	return { role: "custom", customType, content, display: true, timestamp: 1_003 };
}

// --- spec cases -------------------------------------------------------------

describe("compressEntries", () => {
	// Spec case 1: user + assistant text preserved with speaker headers.
	test("user and assistant text are preserved verbatim under [user]/[agent] headers", () => {
		const out = compressEntries([
			msgEntry("e1", userMsg("Please fix the bug in auth.")),
			msgEntry("e2", assistantMsg([textBlock("I will patch the token check.")])),
		]);

		expect(out).toContain("[user]");
		expect(out).toContain("Please fix the bug in auth.");
		expect(out).toContain("[agent]");
		expect(out).toContain("I will patch the token check.");
	});

	// Spec case 2: assistant thinking block preserved under its own header.
	test("assistant thinking block is preserved under a [thinking] header", () => {
		const out = compressEntries([
			msgEntry("e1", assistantMsg([
				thinkingBlock("The root cause is a stale session cookie."),
				textBlock("Patching now."),
			])),
		]);

		expect(out).toContain("[thinking]");
		expect(out).toContain("The root cause is a stale session cookie.");
	});

	// Spec case 3: read tool call — args JSON truncated to ~120 chars, result
	// body dropped, summary line carries the line count.
	test("read tool call: args truncated, result body dropped, line-count summary present", () => {
		const bigBody = Array.from({ length: 500 }, (_, i) => `line ${i + 1}`).join("\n");
		// Embed a unique sentinel in the body to prove it is NOT echoed back.
		const sentinelLine = "UNIQUE_SENTINEL_LINE_499";
		const bodyWithSentinel = bigBody.replace("line 250", sentinelLine);

		const longArgs = {
			path: "src/big.ts",
			limit: 50,
			offset: 10,
			encoding: "utf-8",
			note: "X".repeat(150),
		};
		const out = compressEntries([
			msgEntry("e1", assistantMsg([
				toolCall("call1", "read", longArgs),
			])),
			msgEntry("e2", toolResult("call1", "read", bodyWithSentinel)),
		]);

		// One-liner shape.
		expect(out).toContain("→ read(");
		expect(out).toContain("⇒ ok · 500 lines");

		// Args present but truncated: a known prefix survives, the full
		// untruncated JSON does not, and the truncation marker appears.
		expect(out).toContain('"path":"src/big.ts"');
		expect(out).toContain("…");
		expect(out).not.toContain('"note":"' + "X".repeat(150) + '"');

		// Result body dropped.
		expect(out).not.toContain(sentinelLine);
		expect(out).not.toContain("line 499");

		// The args portion inside the read(...) call stays within the budget.
		const readLine = out.split("\n").find((l) => l.startsWith("→ read(")) ?? "";
		expect(readLine.length).toBeGreaterThan(0);
		const argsStart = readLine.indexOf("(") + 1;
		const argsEnd = readLine.indexOf(") ⇒");
		expect(argsEnd).toBeGreaterThan(argsStart);
		const argsPortion = readLine.slice(argsStart, argsEnd);
		expect(argsPortion.length).toBeLessThanOrEqual(120);
	});

	// Spec case 4: failed bash call → `⇒ error: <first line>` and no full output.
	test("failed bash tool call: error summary with first line, full output dropped", () => {
		const errBody = "Error: tests failed\nstack frame 2\nstack frame 3\nstack frame 4";
		const out = compressEntries([
			msgEntry("e1", assistantMsg([
				toolCall("call1", "bash", { command: "npm test" }),
			])),
			msgEntry("e2", toolResult("call1", "bash", errBody, { isError: true })),
		]);

		expect(out).toContain("→ bash(");
		expect(out).toContain("⇒ error: Error: tests failed");
		// Full output (later lines) must not leak.
		expect(out).not.toContain("stack frame 2");
		expect(out).not.toContain("stack frame 3");
		expect(out).not.toContain("stack frame 4");
	});

	// Spec case 5: edit tool call → unified diff text present in output.
	test("edit tool call: diff text is retained (expandEditDiffs), result body dropped", () => {
		const diff =
			"--- a/src/foo.ts\n+++ b/src/foo.ts\n@@ -1 +1 @@\n-oldValue\n+newValueMarker\n";
		const out = compressEntries([
			msgEntry("e1", assistantMsg([
				toolCall("call1", "edit", { path: "src/foo.ts", oldText: "oldValue", newText: "newValueMarker" }),
			])),
			msgEntry("e2", toolResult("call1", "edit", "Edit applied to src/foo.ts.", {
				details: { diff },
			})),
		]);

		// One-liner summary still present.
		expect(out).toContain("→ edit(");
		expect(out).toContain("⇒ ok ·");
		// Diff content survives.
		expect(out).toContain("```diff");
		expect(out).toContain("--- a/src/foo.ts");
		expect(out).toContain("+newValueMarker");
		// Tool result body is dropped (only the diff from details is kept).
		expect(out).not.toContain("Edit applied to src/foo.ts.");
	});

	// Spec case 6: duplicated primary-context block → second occurrence collapses
	// to the `(unchanged — still in effect)` marker, verbatim text appears once.
	test("repeated primary-context block collapses on its second occurrence", () => {
		const rules = "NEVER create files except the approved plan file.";
		const out = compressEntries([
			customMessageEntry("e1", "plan-mode-context", rules),
			msgEntry("e2", userMsg("Do step 1.")),
			customMessageEntry("e3", "plan-mode-context", rules),
			msgEntry("e4", assistantMsg([textBlock("done.")])),
		]);

		expect(out).toContain("(unchanged — still in effect)");
		// The marker appears exactly once (only the second occurrence collapses).
		expect(out.split("(unchanged — still in effect)").length - 1).toBe(1);
		// The verbatim rules appear exactly once (first occurrence only).
		expect(out.split(rules).length - 1).toBe(1);
	});

	// Spec case 7: entries carrying `customType:"advisor"` are skipped (both the
	// CustomMessageEntry shape and a custom-role message wrapped in a message
	// entry — defense in depth, the controller also filters).
	test("advisor self-injections are skipped regardless of entry shape", () => {
		const out = compressEntries([
			msgEntry("e1", userMsg("hello")),
			customMessageEntry("e2", "advisor", "You should stop and reconsider."),
			msgEntry("e3", assistantMsg([textBlock("hi there")])),
			// Also the wrapped-message shape.
			msgEntry("e4", customRoleMsg("advisor", "Duplicate nudge.")),
		]);

		expect(out).toContain("hello");
		expect(out).toContain("hi there");
		expect(out).not.toContain("You should stop and reconsider.");
		expect(out).not.toContain("Duplicate nudge.");
	});

	// Spec case 8: determinism — same input twice yields an identical string.
	test("deterministic: identical input produces identical output", () => {
		const entries: SessionEntryLike[] = [
			msgEntry("e1", userMsg("hello")),
			msgEntry("e2", assistantMsg([
				thinkingBlock("planning the fix."),
				toolCall("call1", "bash", { command: "npm test" }),
			])),
			msgEntry("e3", toolResult("call1", "bash", "Error: boom\nframe 2", { isError: true })),
			customMessageEntry("e4", "plan-mode-context", "Rule A."),
			customMessageEntry("e5", "plan-mode-context", "Rule A."),
			msgEntry("e6", assistantMsg([textBlock("done.")])),
		];

		const a = compressEntries(entries);
		const b = compressEntries(entries);
		expect(a).toBe(b);
		// Stable formatting: single trailing newline, no doubled blank lines.
		expect(a.endsWith("\n")).toBe(true);
		expect(a.endsWith("\n\n")).toBe(false);
	});
});
