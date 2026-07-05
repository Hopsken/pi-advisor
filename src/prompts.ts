// Advisor system prompt assembly. PLAN §2.1–2.2, issue #08.
//
// `buildAdvisorSystemPrompt` emits the advisor's bespoke reviewer prompt and,
// when the config asks for skills/context-file injection, the reframing
// preamble that tells the advisor how to treat the `<project_context>` and
// skills sections pi appends after this string. The actual AGENTS.md and
// skill bodies are appended downstream by pi's own `buildSystemPrompt` — this
// module only emits the preamble, never the content (PLAN §1/§2.2).
//
// The prompt bodies live as sibling .md files under `./prompts/` so they stay
// editable as plain markdown. They are loaded synchronously with `node:fs`
// rather than bun text imports (`import x from "./f.md" with { type: "text" }`):
// the project tsconfig sets `module: "ES2022"`, and import attributes only
// typecheck under `esnext` / `node18+` / `preserve`. `readFileSync` keeps the
// .md files as the source of truth while staying synchronous and tsc-clean,
// and avoids touching tsconfig (out of scope for this issue).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { AdvisorConfig } from "./types.ts";

const here = dirname(fileURLToPath(import.meta.url));

/** Bespoke reviewer prompt. Ported from oh-my-pi's advisor `system.md`. */
const ADVISOR_SYSTEM_PROMPT = readFileSync(join(here, "prompts/advisor-system.md"), "utf8");

/** Reframing preamble for pi-appended `<project_context>` / skills sections.
 *  Ported from oh-my-pi's advisor `context-files.md`, generalized and stripped
 *  of Handlebars placeholders (pi appends the real bodies itself). */
const CONTEXT_REFRAME_PREAMBLE = readFileSync(join(here, "prompts/context-reframe.md"), "utf8");

/**
 * Build the advisor sub-session's system prompt.
 *
 * Concatenates the bespoke reviewer prompt with the context-reframe preamble
 * when either `config.skills` or `config.contextFiles` is set — pi will
 * append the matching `<project_context>` / skills bodies after this string,
 * so the preamble is only meaningful when at least one of those injections is
 * enabled. When both are disabled, the preamble is omitted: there is nothing
 * to reframe, and emitting the section would be misleading.
 */
export function buildAdvisorSystemPrompt(config: AdvisorConfig): string {
	const base = ADVISOR_SYSTEM_PROMPT.trimEnd();
	if (config.skills || config.contextFiles) {
		return `${base}\n\n${CONTEXT_REFRAME_PREAMBLE.trimEnd()}\n`;
	}
	return `${base}\n`;
}
