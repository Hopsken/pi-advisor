// Tests for advisor system prompt assembly. PLAN §2.1–2.2, issue #08.
//
// Asserts externally observable properties of `buildAdvisorSystemPrompt`'s
// output only — never greps source files, never inspects private state.

import { describe, expect, test } from "bun:test";

import { DEFAULT_CONFIG, type AdvisorConfig } from "./types.ts";
import { buildAdvisorSystemPrompt } from "./prompts.ts";

describe("buildAdvisorSystemPrompt", () => {
	test("includes the severity rubric markers and the advise protocol section", () => {
		const out = buildAdvisorSystemPrompt(DEFAULT_CONFIG);
		// severity rubric — all three grades named.
		expect(out).toContain("`nit`");
		expect(out).toContain("`concern`");
		expect(out).toContain("`blocker`");
		// advise protocol section is present with its "staying silent" guidance.
		expect(out).toContain("<advise-protocol>");
		expect(out.toLowerCase()).toContain("staying silent");
	});

	test("tool names adapted to pi: has find/ls, no glob tool grant", () => {
		const out = buildAdvisorSystemPrompt(DEFAULT_CONFIG);
		expect(out).toContain("find");
		expect(out).toContain("ls");
		// the `glob` tool was rewritten to pi's `find`/`ls`; it must not appear
		// anywhere in the prompt (not just as a grant).
		expect(out).not.toContain("glob");
	});

	test("reframe preamble present by default; absent when skills and contextFiles are both false", () => {
		const on = buildAdvisorSystemPrompt(DEFAULT_CONFIG);
		expect(on).toContain("<project-context>");
		// preamble-only phrase; the base prompt never says this.
		expect(on.toLowerCase()).toContain("not tasks for you to execute");

		const off: AdvisorConfig = { ...DEFAULT_CONFIG, skills: false, contextFiles: false };
		const offOut = buildAdvisorSystemPrompt(off);
		expect(offOut).not.toContain("<project-context>");
		expect(offOut.toLowerCase()).not.toContain("not tasks for you to execute");

		// either flag alone still pulls in the preamble (skills || contextFiles).
		const skillsOnly: AdvisorConfig = { ...DEFAULT_CONFIG, skills: true, contextFiles: false };
		expect(buildAdvisorSystemPrompt(skillsOnly)).toContain("<project-context>");
		const ctxOnly: AdvisorConfig = { ...DEFAULT_CONFIG, skills: false, contextFiles: true };
		expect(buildAdvisorSystemPrompt(ctxOnly)).toContain("<project-context>");
	});

	test("no unresolved Handlebars template placeholders in output", () => {
		const out = buildAdvisorSystemPrompt(DEFAULT_CONFIG);
		expect(out).not.toContain("{{");
		expect(out).not.toContain("}}");
	});
});
