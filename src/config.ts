// Config subsystem for pi-advisor. PLAN §12.
//
// Two-layer file config: global `<agentDir>/advisor.json` and project
// `<cwd>/.pi/advisor.json` (project overrides global). Files are read
// tolerantly: unknown keys ignored, wrong-typed/out-of-range/invalid-enum
// values dropped (fall back to default via merge), missing or malformed JSON
// files treated as an empty layer. `loadConfig` never throws.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
	DEFAULT_CONFIG,
	type AdvisorConfig,
	type AutoResume,
	type SyncBacklog,
	type ThinkingLevel,
} from "./types.ts";

const AUTO_RESUME_VALUES: readonly AutoResume[] = ["off", "blocker", "concern", "all"];
const THINKING_LEVEL_VALUES: readonly ThinkingLevel[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
];

function isBoolean(v: unknown): v is boolean {
	return typeof v === "boolean";
}

function isString(v: unknown): v is string {
	return typeof v === "string";
}

function isNonNegativeInteger(v: unknown): v is number {
	return typeof v === "number" && Number.isInteger(v) && v >= 0;
}

function isPositiveInteger(v: unknown): v is number {
	return typeof v === "number" && Number.isInteger(v) && v >= 1;
}

function isPositiveFinite(v: unknown): v is number {
	return typeof v === "number" && Number.isFinite(v) && v > 0;
}

function isOneOf<T extends string>(v: unknown, allowed: readonly T[]): v is T {
	return typeof v === "string" && (allowed as readonly string[]).includes(v);
}

/**
 * Tolerantly parse a raw (e.g. `JSON.parse`'d) value into a `Partial<AdvisorConfig>`.
 * Only valid keys appear in the result; everything else is dropped so that
 * `mergeConfig` reinstates the default for it. Never throws.
 */
export function parseConfig(raw: unknown): Partial<AdvisorConfig> {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		return {};
	}
	const src = raw as Record<string, unknown>;
	const out: Partial<AdvisorConfig> = {};

	if (isBoolean(src.enabled)) out.enabled = src.enabled;
	if (isString(src.model)) out.model = src.model;
	if (isOneOf(src.thinkingLevel, THINKING_LEVEL_VALUES)) out.thinkingLevel = src.thinkingLevel;
	if (isOneOf(src.autoResume, AUTO_RESUME_VALUES)) out.autoResume = src.autoResume;
	if (isNonNegativeInteger(src.immuneTurns)) out.immuneTurns = src.immuneTurns;
	if (src.syncBacklog === "off") {
		out.syncBacklog = "off" as SyncBacklog;
	} else if (isPositiveInteger(src.syncBacklog)) {
		out.syncBacklog = src.syncBacklog;
	}
	if (isPositiveFinite(src.catchupTimeoutMs)) out.catchupTimeoutMs = src.catchupTimeoutMs;
	if (isBoolean(src.skills)) out.skills = src.skills;
	if (isBoolean(src.contextFiles)) out.contextFiles = src.contextFiles;

	return out;
}

/**
 * Merge config layers over `DEFAULT_CONFIG`; later layers win. A layer value of
 * `undefined` is treated as "not specified in this layer" and does not clobber
 * earlier layers or the default.
 */
export function mergeConfig(...layers: Partial<AdvisorConfig>[]): AdvisorConfig {
	const result: AdvisorConfig = { ...DEFAULT_CONFIG };
	for (const layer of layers) {
		for (const key of Object.keys(layer) as (keyof AdvisorConfig)[]) {
			const v = layer[key];
			if (v !== undefined) {
				(result as Record<keyof AdvisorConfig, unknown>)[key] = v;
			}
		}
	}
	return result;
}

/** Read one JSON config file tolerantly; missing/malformed -> empty layer. */
function readLayer(file: string): Partial<AdvisorConfig> {
	try {
		const text = readFileSync(file, "utf8");
		return parseConfig(JSON.parse(text));
	} catch {
		return {};
	}
}

/**
 * Load advisor config: global `<agentDir>/advisor.json`, then project
 * `<cwd>/.pi/advisor.json` (project overrides global). Missing/invalid files
 * are ignored. Never throws.
 */
export function loadConfig({ cwd, agentDir }: { cwd: string; agentDir: string }): AdvisorConfig {
	const globalLayer = readLayer(join(agentDir, "advisor.json"));
	const projectLayer = readLayer(join(cwd, ".pi", "advisor.json"));
	return mergeConfig(globalLayer, projectLayer);
}
