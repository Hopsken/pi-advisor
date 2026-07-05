// Tests for the pure advisor-card formatter. PLAN §12, issue #11.
//
// The formatter is a pure function over (note, severity, theme). We inject a
// fake theme that tags styled text as `[color]text[/]` so assertions can pin
// the severity → color/label mapping and the body rendering without the real
// TUI. No pi imports, no network.

import { describe, expect, test } from "bun:test";

import {
	formatAdvisorCard,
	SEVERITY_COLOR,
	SEVERITY_LABEL,
	type AdvisorCardTheme,
} from "./advisor-card.ts";
import type { Severity } from "../types.ts";

/** Fake theme: wraps text in `[color]…[/]` tags so color usage is observable. */
function tagTheme(): AdvisorCardTheme {
	return {
		fg(color: string, text: string): string {
			return `[${color}]${text}[/]`;
		},
	};
}

/** Strip the tag wrappers, returning only the raw text, for presence checks. */
function raw(styled: string): string {
	return styled.replace(/\[[a-z]+\]/g, "").replace(/\[\/\]/g, "");
}

describe("formatAdvisorCard", () => {
	test("nit → dim color and NIT label", () => {
		const out = formatAdvisorCard("trim trailing whitespace", "nit", tagTheme());
		expect(out).toContain("[dim]");
		expect(out).not.toContain("[warning]");
		expect(out).not.toContain("[error]");
		expect(raw(out)).toContain(SEVERITY_LABEL.nit);
		expect(raw(out)).toContain("advisor");
	});

	test("concern → warning color and CONCERN label", () => {
		const out = formatAdvisorCard("missing retry back-off", "concern", tagTheme());
		expect(out).toContain("[warning]");
		expect(out).not.toContain("[error]");
		expect(raw(out)).toContain(SEVERITY_LABEL.concern);
	});

	test("blocker → error color and BLOCKER label", () => {
		const out = formatAdvisorCard("data loss risk", "blocker", tagTheme());
		expect(out).toContain("[error]");
		expect(raw(out)).toContain(SEVERITY_LABEL.blocker);
	});

	test("note text is present in the body", () => {
		const out = formatAdvisorCard("Add a transaction around the two writes", "concern", tagTheme());
		expect(raw(out)).toContain("Add a transaction around the two writes");
	});

	test("multi-line notes render one body line per input line", () => {
		const note = "first line of advice\nsecond line of advice\nthird line";
		const out = formatAdvisorCard(note, "blocker", tagTheme());
		const r = raw(out);
		expect(r).toContain("first line of advice");
		expect(r).toContain("second line of advice");
		expect(r).toContain("third line");
		// Each body line is prefixed by the colored bar; count `│` occurrences.
		const barCount = (out.match(/│/g) ?? []).length;
		expect(barCount).toBe(3);
	});

	test("SEVERITY_COLOR / SEVERITY_LABEL tables are exhaustive and stable", () => {
		const severities: Severity[] = ["nit", "concern", "blocker"];
		expect(SEVERITY_COLOR.nit).toBe("dim");
		expect(SEVERITY_COLOR.concern).toBe("warning");
		expect(SEVERITY_COLOR.blocker).toBe("error");
		expect(SEVERITY_LABEL.nit).toBe("NIT");
		expect(SEVERITY_LABEL.concern).toBe("CONCERN");
		expect(SEVERITY_LABEL.blocker).toBe("BLOCKER");
		// Every severity has a mapping — guards against a future Severity
		// extension leaving a hole in the Record.
		for (const s of severities) {
			expect(typeof SEVERITY_COLOR[s]).toBe("string");
			expect(typeof SEVERITY_LABEL[s]).toBe("string");
		}
	});
});
