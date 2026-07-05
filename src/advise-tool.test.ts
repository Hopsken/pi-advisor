// Tests for the `advise` custom tool (PLAN §4/§11, issue #07).
//
// The tool is the advisor model's only output channel. Its handler runs the
// emission guard and routes accepted advice; suppression is invisible to the
// model (content-free / budget still return "Recorded.") so the model cannot
// learn to rephrase its way past the guard. Only `duplicate` is surfaced, as
// "Duplicate advice ignored.", so the model knows not to repeat itself.
//
// We call the tool's `execute` directly with a fake guard (stubbed `accept`)
// and a spy route. The tool object must satisfy pi's real `ToolDefinition`
// type — that typecheck is the primary gate for case 6; the runtime assertions
// here cover behavior.

import { describe, expect, mock, test } from "bun:test";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { createAdviseTool, type AdviseGuard } from "./advise-tool.ts";
import type { Severity } from "./types.ts";

// pi's ToolDefinition.execute takes an ExtensionContext the advisor tool never
// inspects; a cast empty object is assignable because ExtensionContext is
// structurally assignable to {}.
const CTX = {} as ExtensionContext;

/** Drive the tool's execute and pull the first text part out of the result. */
async function run(
	tool: ReturnType<typeof createAdviseTool>,
	args: { note: string; severity: Severity },
): Promise<string> {
	const res = await tool.execute("call-1", args, undefined, undefined, CTX);
	const first = res.content[0];
	return first && first.type === "text" ? first.text : "";
}

/** Build a fake guard whose `accept` returns a scripted decision and records calls. */
function fakeGuard(decision: ReturnType<AdviseGuard["accept"]>): {
	guard: AdviseGuard;
	spy: ReturnType<typeof mock<(note: string, severity: Severity) => unknown>>;
} {
	const spy = mock((_note: string, _severity: Severity) => decision);
	return { guard: { accept: spy }, spy };
}

describe("createAdviseTool / advise.execute", () => {
	// Spec case 1: allowed → route called with (note, severity), returns "Recorded.".
	test("allowed note is routed and acknowledged as Recorded.", async () => {
		const { guard } = fakeGuard({ allowed: true });
		const route = mock((_note: string, _severity: Severity) => {});
		const tool = createAdviseTool({ guard, route });

		const text = await run(tool, { note: "Add retry back-off", severity: "concern" });

		expect(text).toBe("Recorded.");
		expect(route).toHaveBeenCalledTimes(1);
		expect(route.mock.calls[0]).toEqual(["Add retry back-off", "concern"]);
	});

	// Spec case 2: duplicate → "Duplicate advice ignored.", route NOT called.
	test("duplicate is surfaced to the model and not routed", async () => {
		const { guard, spy } = fakeGuard({ allowed: false, reason: "duplicate" });
		const route = mock(() => {});
		const tool = createAdviseTool({ guard, route });

		const text = await run(tool, { note: "Add retry back-off", severity: "nit" });

		expect(text).toBe("Duplicate advice ignored.");
		expect(spy).toHaveBeenCalledTimes(1);
		expect(route).not.toHaveBeenCalled();
	});

	// Spec case 3: budget / content-free → "Recorded.", route NOT called
	// (suppression invisible — the model can't tell its note was dropped).
	test("budget suppression is invisible: Recorded. and no route call", async () => {
		const { guard } = fakeGuard({ allowed: false, reason: "budget" });
		const route = mock(() => {});
		const tool = createAdviseTool({ guard, route });

		const text = await run(tool, { note: "Real concern", severity: "blocker" });

		expect(text).toBe("Recorded.");
		expect(route).not.toHaveBeenCalled();
	});

	test("content-free suppression is invisible: Recorded. and no route call", async () => {
		const { guard } = fakeGuard({ allowed: false, reason: "content-free" });
		const route = mock(() => {});
		const tool = createAdviseTool({ guard, route });

		const text = await run(tool, { note: "stop", severity: "nit" });

		expect(text).toBe("Recorded.");
		expect(route).not.toHaveBeenCalled();
	});

	// Spec case 4: invalid severity or empty note → model-visible tool error
	// (pi turns a thrown execute into an isError result), guard/route untouched.
	test("invalid severity value throws before guard/route are touched", async () => {
		const { guard, spy } = fakeGuard({ allowed: true });
		const route = mock(() => {});
		const tool = createAdviseTool({ guard, route });

		await expect(
			run(tool, { note: "hi", severity: "bogus" as unknown as Severity }),
		).rejects.toThrow();
		expect(spy).not.toHaveBeenCalled();
		expect(route).not.toHaveBeenCalled();
	});

	test("empty note throws before guard/route are touched", async () => {
		const { guard, spy } = fakeGuard({ allowed: true });
		const route = mock(() => {});
		const tool = createAdviseTool({ guard, route });

		await expect(
			run(tool, { note: "   ", severity: "concern" }),
		).rejects.toThrow();
		expect(spy).not.toHaveBeenCalled();
		expect(route).not.toHaveBeenCalled();
	});

	// Spec case 5: route rejection → still "Recorded.", onError spy called.
	test("route rejection is swallowed: Recorded. returned, onError invoked", async () => {
		const { guard } = fakeGuard({ allowed: true });
		const route = mock(() => {
			throw new Error("channel down");
		});
		const onError = mock((_err: unknown, _note: string, _severity: Severity) => {});
		const tool = createAdviseTool({ guard, route, onError });

		const text = await run(tool, { note: "Add retry back-off", severity: "blocker" });

		expect(text).toBe("Recorded.");
		expect(onError).toHaveBeenCalledTimes(1);
		const [err, note, severity] = onError.mock.calls[0];
		expect(err).toBeInstanceOf(Error);
		expect(note).toBe("Add retry back-off");
		expect(severity).toBe("blocker");
	});

	// Spec case 6: schema sanity — name + required fields match customTools expectations.
	// (The real gate is that the object typechecks as ToolDefinition; see typecheck.)
	test("tool name is 'advise' and params require note + severity", () => {
		const { guard } = fakeGuard({ allowed: true });
		const tool = createAdviseTool({ guard, route: () => {} });

		expect(tool.name).toBe("advise");
		expect(tool.label).toBe("Advise");
		expect(typeof tool.description).toBe("string");
		expect(tool.description.length).toBeGreaterThan(0);
		const required = (tool.parameters as { required?: string[] }).required ?? [];
		expect(required).toContain("note");
		expect(required).toContain("severity");
	});
});
