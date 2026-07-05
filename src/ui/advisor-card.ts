// Advisor card renderer — pure formatting helper for the `advisor` custom
// message renderer. PLAN §2.4 / §12, issue #11.
//
// The pi extension entry registers `pi.registerMessageRenderer("advisor", …)`
// as a thin wrapper that pulls the severity out of `message.details` and hands
// (note, severity, theme) to this pure function. Keeping the formatting here —
// away from the `ExtensionAPI`/`Component` types — makes the label/color
// mapping and multi-line rendering unit-testable without spinning up pi's TUI.
//
// Severity → color mapping (PLAN §12, issue #11 spec):
//   nit      → "dim"      (gray, nice-to-have)
//   concern  → "warning"  (yellow, should fix)
//   blocker  → "error"    (red, must fix)
//
// The theme seam is intentionally narrow (`fg` only) and typed against `string`
// colors so a fake theme is injectable in tests; pi's real `Theme` satisfies it
// bivariantly (`fg` is a method, so the narrower `ThemeColor` union is
// compatible with the wider `string` parameter here).

import type { Severity } from "../types.ts";

/**
 * Narrow theme seam used by {@link formatAdvisorCard}. Pi's `Theme` satisfies
 * this structurally (its `fg` method is bivariantly compatible with the
 * wider `string` color parameter).
 */
export interface AdvisorCardTheme {
	/** Apply a named theme color to `text`, returning styled text. */
 fg(color: string, text: string): string;
}

/** Severity → color key used for the card border + label. */
export const SEVERITY_COLOR: Record<Severity, string> = {
	nit: "dim",
	concern: "warning",
	blocker: "error",
};

/** Severity → short uppercase label shown in the card header. */
export const SEVERITY_LABEL: Record<Severity, string> = {
	nit: "NIT",
	concern: "CONCERN",
	blocker: "BLOCKER",
};

/** Fixed header prefix so the advisor card is visually distinct from tool rows. */
const ADVISOR_HEADER = "advisor";

/**
 * Render an advisor note as a severity-colored card string.
 *
 * Layout (every line's border + label colored by severity):
 * ```
 * ╭─ advisor · LABEL
 * │ <note line 1>
 * │ <note line 2>
 * ╰─
 * ```
 * Multi-line notes render one `│`-prefixed body line per input line, so
 * nothing is truncated or reflowed. Pure function of its inputs — no clocks,
 * no randomness, no I/O — so output is deterministic for prompt-cache-friendly
 * rendering and for snapshot-style assertions.
 */
export function formatAdvisorCard(note: string, severity: Severity, theme: AdvisorCardTheme): string {
	const color = SEVERITY_COLOR[severity];
	const label = SEVERITY_LABEL[severity];
	const bar = (text: string): string => theme.fg(color, text);

	const lines: string[] = [];
	lines.push(bar(`╭─ ${ADVISOR_HEADER} · ${label}`));
	for (const line of note.split("\n")) {
		lines.push(`${bar("│")} ${line}`);
	}
	lines.push(bar("╰─"));
	return lines.join("\n");
}
