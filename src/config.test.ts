import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_CONFIG, SEVERITY_RANK, type AdvisorConfig, type AutoResume, type Severity } from "./types.ts";
import { loadConfig, mergeConfig, parseConfig } from "./config.ts";

function withTempDirs(fn: (cwd: string, agentDir: string) => void) {
	const root = mkdtempSync(join(tmpdir(), "pi-advisor-cfg-"));
	const cwd = join(root, "project");
	const agentDir = join(root, "agent");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	try {
		fn(cwd, agentDir);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

function writeJson(dir: string, rel: string, content: string): string {
	const file = join(dir, rel);
	mkdirSync(join(dir, rel.split("/").slice(0, -1).join("/")), { recursive: true });
	writeFileSync(file, content, "utf8");
	return file;
}

describe("types", () => {
	test("SEVERITY_RANK orders nit < concern < blocker", () => {
		const ascending: Severity[] = ["nit", "concern", "blocker"];
		expect(SEVERITY_RANK.nit).toBeLessThan(SEVERITY_RANK.concern);
		expect(SEVERITY_RANK.concern).toBeLessThan(SEVERITY_RANK.blocker);
		// ranks are distinct and cover exactly the three severities
		expect(new Set(ascending.map((s) => SEVERITY_RANK[s])).size).toBe(3);
	});

	test("DEFAULT_CONFIG matches PLAN §12 table", () => {
		const expected: AdvisorConfig = {
			enabled: false,
			model: undefined,
			thinkingLevel: "medium",
			autoResume: "concern",
			immuneTurns: 2,
			syncBacklog: 10,
			catchupTimeoutMs: 45000,
			skills: true,
			contextFiles: true,
		};
		expect({ ...DEFAULT_CONFIG, model: DEFAULT_CONFIG.model }).toEqual({
			...expected,
			model: expected.model,
		});
	});
});

describe("parseConfig", () => {
	test("accepts a fully valid object", () => {
		const parsed = parseConfig({
			enabled: true,
			model: "claude-sonnet-5",
			thinkingLevel: "high",
			autoResume: "all",
			immuneTurns: 3,
			syncBacklog: "off",
			catchupTimeoutMs: 60000,
			skills: false,
			contextFiles: false,
		});
		expect(parsed).toEqual({
			enabled: true,
			model: "claude-sonnet-5",
			thinkingLevel: "high",
			autoResume: "all",
			immuneTurns: 3,
			syncBacklog: "off",
			catchupTimeoutMs: 60000,
			skills: false,
			contextFiles: false,
		});
	});

	test("drops unknown keys", () => {
		const parsed = parseConfig({ enabled: true, color: "red", extra: { nested: true } });
		expect(parsed).toEqual({ enabled: true });
		expect("color" in parsed).toBe(false);
		expect("extra" in parsed).toBe(false);
	});

	test("drops wrong-typed and out-of-range values, keeps valid ones", () => {
		const parsed = parseConfig({
			enabled: "yes",
			model: 42,
			thinkingLevel: "turbo",
			autoResume: "sometimes",
			immuneTurns: -1,
			syncBacklog: "ten",
			catchupTimeoutMs: "fast",
			skills: "true",
			contextFiles: null,
		});
		expect(parsed).toEqual({});
	});

	test("accepts syncBacklog 'off' and numbers >= 1, rejects 0 and negatives", () => {
		expect(parseConfig({ syncBacklog: "off" })).toEqual({ syncBacklog: "off" });
		expect(parseConfig({ syncBacklog: 1 })).toEqual({ syncBacklog: 1 });
		expect(parseConfig({ syncBacklog: 25 })).toEqual({ syncBacklog: 25 });
		expect(parseConfig({ syncBacklog: 0 })).toEqual({});
		expect(parseConfig({ syncBacklog: -3 })).toEqual({});
	});

	test("rejects non-number and non-integer immuneTurns", () => {
		expect(parseConfig({ immuneTurns: "2" })).toEqual({});
		expect(parseConfig({ immuneTurns: 2.5 })).toEqual({});
		expect(parseConfig({ immuneTurns: 0 })).toEqual({ immuneTurns: 0 });
		expect(parseConfig({ immuneTurns: 5 })).toEqual({ immuneTurns: 5 });
	});

	test("validates autoResume and thinkingLevel enums", () => {
		const valid: AutoResume[] = ["off", "blocker", "concern", "all"];
		for (const v of valid) {
			expect(parseConfig({ autoResume: v })).toEqual({ autoResume: v });
		}
		expect(parseConfig({ autoResume: "sometimes" })).toEqual({});
		for (const v of ["off", "minimal", "low", "medium", "high", "xhigh"] as const) {
			expect(parseConfig({ thinkingLevel: v })).toEqual({ thinkingLevel: v });
		}
		expect(parseConfig({ thinkingLevel: "turbo" })).toEqual({});
	});

	test("treats non-object raw as empty", () => {
		expect(parseConfig(null)).toEqual({});
		expect(parseConfig(undefined)).toEqual({});
		expect(parseConfig("enabled:true")).toEqual({});
		expect(parseConfig([true])).toEqual({});
	});
});

describe("mergeConfig", () => {
	test("no layers yields exact DEFAULT_CONFIG", () => {
		expect(mergeConfig()).toEqual(DEFAULT_CONFIG);
	});

	test("later layers win over earlier and defaults", () => {
		const merged = mergeConfig(
			{ enabled: true, immuneTurns: 5 },
			{ immuneTurns: 1 },
		);
		expect(merged.enabled).toBe(true);
		expect(merged.immuneTurns).toBe(1);
	});

	test("undefined values in a layer do not clobber earlier or default values", () => {
		const merged = mergeConfig({ model: "claude" }, { model: undefined });
		expect(merged.model).toBe("claude");
	});
});

describe("loadConfig", () => {
	test("no config files -> exact DEFAULT_CONFIG", () => {
		withTempDirs((cwd, agentDir) => {
			expect(loadConfig({ cwd, agentDir })).toEqual(DEFAULT_CONFIG);
		});
	});

	test("global file only -> merged over defaults", () => {
		withTempDirs((cwd, agentDir) => {
			writeJson(agentDir, "advisor.json", JSON.stringify({ enabled: true, model: "claude-sonnet-5" }));
			const cfg = loadConfig({ cwd, agentDir });
			expect(cfg.enabled).toBe(true);
			expect(cfg.model).toBe("claude-sonnet-5");
			// untouched keys keep defaults
			expect(cfg.autoResume).toBe(DEFAULT_CONFIG.autoResume);
			expect(cfg.immuneTurns).toBe(DEFAULT_CONFIG.immuneTurns);
		});
	});

	test("project overrides global on the same key; unrelated keys survive from both", () => {
		withTempDirs((cwd, agentDir) => {
			writeJson(agentDir, "advisor.json", JSON.stringify({ enabled: true, model: "global-model", immuneTurns: 7 }));
			writeJson(cwd, ".pi/advisor.json", JSON.stringify({ model: "project-model", skills: false }));
			const cfg = loadConfig({ cwd, agentDir });
			expect(cfg.enabled).toBe(true); // from global
			expect(cfg.immuneTurns).toBe(7); // from global
			expect(cfg.model).toBe("project-model"); // project overrides global
			expect(cfg.skills).toBe(false); // from project
		});
	});

	test("invalid values in files are dropped, defaults kept", () => {
		withTempDirs((cwd, agentDir) => {
			writeJson(agentDir, "advisor.json", JSON.stringify({
				autoResume: "sometimes",
				syncBacklog: "ten",
				immuneTurns: -1,
				enabled: true,
			}));
			const cfg = loadConfig({ cwd, agentDir });
			expect(cfg.autoResume).toBe(DEFAULT_CONFIG.autoResume);
			expect(cfg.syncBacklog).toBe(DEFAULT_CONFIG.syncBacklog);
			expect(cfg.immuneTurns).toBe(DEFAULT_CONFIG.immuneTurns);
			expect(cfg.enabled).toBe(true); // valid value survives
		});
	});

	test("malformed JSON file -> ignored, no throw, defaults returned", () => {
		withTempDirs((cwd, agentDir) => {
			writeJson(agentDir, "advisor.json", "{ not valid json,,, ");
			writeJson(cwd, ".pi/advisor.json", "{ also broken: ");
			expect(() => loadConfig({ cwd, agentDir })).not.toThrow();
			expect(loadConfig({ cwd, agentDir })).toEqual(DEFAULT_CONFIG);
		});
	});

	test("unknown keys in files are ignored", () => {
		withTempDirs((cwd, agentDir) => {
			writeJson(agentDir, "advisor.json", JSON.stringify({ enabled: true, color: "red", deep: { x: 1 } }));
			const cfg = loadConfig({ cwd, agentDir });
			expect(cfg.enabled).toBe(true);
			expect(cfg).toEqual({ ...DEFAULT_CONFIG, enabled: true });
		});
	});
});
