/**
 * pool-guard tests: discovery, status/error classification, dedupe, and the
 * extension wiring against a fake pool engine (python3, no network).
 *
 * Run with: npx tsx --test extensions/pool-guard/tests.ts
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import poolGuard from "./index.ts";
import { createGuard, DEDUPE_MS, discoverPools, outcomeForStatus, reasonForError } from "./pure.ts";

const models = {
	providers: {
		deepseek: { apiKey: "!bash $HOME/.pi/agent/deepseek-pool/ds-pool" },
		zai: { apiKey: '!bash "C:\\Users\\me\\.pi\\agent\\zai-pool\\zai-pool"' },
		openai: { apiKey: "$OPENAI_API_KEY" },
		other: { apiKey: "!cat $HOME/.pi/agent/other-key" },
		legacy: { apiKey: "!bash $HOME/.pi/agent/groq-pool/rotate-keys.sh" },
	},
};

describe("discoverPools", () => {
	it("maps only pool wrapper commands whose pool directory exists", () => {
		const exists = (p: string) => !p.replace(/\\/g, "/").endsWith("/groq-pool");
		const pools = discoverPools(models, "/agent", exists);
		assert.deepEqual([...pools], [["deepseek", "deepseek"], ["zai", "zai"]]);
	});

	it("is inert without the pool engine", () => {
		assert.equal(discoverPools(models, "/agent", (p) => !p.replace(/\\/g, "/").endsWith("bin/pool.py")).size, 0);
	});
});

describe("classification", () => {
	it("maps statuses to outcomes", () => {
		assert.deepEqual(outcomeForStatus(429), { outcome: "exhausted", reason: "http 429" });
		assert.deepEqual(outcomeForStatus(402), { outcome: "exhausted", reason: "http 402" });
		assert.deepEqual(outcomeForStatus(401), { outcome: "exhausted", reason: "http 401 auth" });
		assert.deepEqual(outcomeForStatus(200), { outcome: "ok", reason: "" });
		assert.equal(outcomeForStatus(500), undefined);
		assert.equal(outcomeForStatus(400), undefined);
	});

	it("recognizes quota and auth error text", () => {
		assert.equal(reasonForError("code 1310: Weekly/Monthly Limit Exhausted"), "quota error");
		assert.equal(reasonForError("API key not valid. Please pass a valid API key."), "auth error");
		assert.equal(reasonForError("context length exceeded"), undefined);
	});
});

describe("createGuard", () => {
	function harness(trial = false) {
		const calls: string[] = [];
		let clock = 0;
		const guard = createGuard(new Map([["deepseek", "deepseek"]]), {
			report: (pool, outcome, reason) => calls.push(`${pool}:${outcome}:${reason}`),
			currentIsTrial: () => trial,
			now: () => clock,
		});
		return { guard, calls, advance: (ms: number) => (clock += ms) };
	}

	it("benches once per failure window and ignores unpooled providers", () => {
		const { guard, calls, advance } = harness();
		guard.onResponse("deepseek", 429);
		guard.onAssistantError("deepseek", "rate limit reached");
		guard.onResponse("openai", 429);
		advance(DEDUPE_MS);
		guard.onResponse("deepseek", 401);
		assert.deepEqual(calls, ["deepseek:exhausted:http 429", "deepseek:exhausted:http 401 auth"]);
	});

	it("promotes only a key under trial on success", () => {
		const idle = harness(false);
		idle.guard.onResponse("deepseek", 200);
		assert.deepEqual(idle.calls, []);
		const trial = harness(true);
		trial.guard.onResponse("deepseek", 200);
		assert.deepEqual(trial.calls, ["deepseek:ok:"]);
	});

	it("benches on classified error text without a decisive status", () => {
		const { guard, calls } = harness();
		guard.onResponse("deepseek", 400);
		guard.onAssistantError("deepseek", "RESOURCE_EXHAUSTED");
		guard.onAssistantError("deepseek", "");
		assert.deepEqual(calls, ["deepseek:exhausted:quota error"]);
	});
});

const python = spawnSync("python3", ["--version"]).status === 0;

describe("extension wiring", { skip: python ? false : "python3 not available" }, () => {
	it("reports through the pool engine and stays silent about key text", { timeout: 20000 }, async () => {
		const dir = await mkdtemp(join(tmpdir(), "pool-guard-"));
		const previous = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = dir;
		try {
			await mkdir(join(dir, "bin"));
			await mkdir(join(dir, "deepseek-pool"));
			await writeFile(join(dir, "models.json"), JSON.stringify(models));
			// Fake engine: append its arguments to a log file.
			await writeFile(
				join(dir, "bin", "pool.py"),
				"import sys, pathlib\npathlib.Path(sys.argv[0]).with_name('calls.log').open('a').write(' '.join(sys.argv[1:]) + '\\n')\n",
			);
			await writeFile(join(dir, "deepseek-pool", "state.json"), JSON.stringify({ current_from: "exhausted" }));
			const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
			poolGuard({ on: (name: string, fn: (e: unknown, c: unknown) => void) => handlers.set(name, fn) } as never);
			const ctx = { model: { provider: "deepseek" } };
			handlers.get("after_provider_response")!({ status: 429 }, ctx);
			handlers.get("after_provider_response")!({ status: 200 }, ctx);
			// A virtual model routed to the pooled provider: attribute by the message.
			await new Promise((r) => setTimeout(r, DEDUPE_MS + 50));
			handlers.get("message_end")!(
				{ message: { role: "assistant", provider: "deepseek", errorMessage: "429 rate limit reached" } },
				{ model: { provider: "my-router" } },
			);
			const log = await readFile(join(dir, "bin", "calls.log"), "utf8");
			assert.deepEqual(log.trim().split(/\r?\n/), ["deepseek --report exhausted --reason http 429", "deepseek --report ok", "deepseek --report exhausted --reason quota error"]);
		} finally {
			if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previous;
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("registers nothing without pool wrappers", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pool-guard-"));
		const previous = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = dir;
		try {
			await writeFile(join(dir, "models.json"), JSON.stringify({ providers: {} }));
			const names: string[] = [];
			poolGuard({ on: (name: string) => names.push(name) } as never);
			assert.deepEqual(names, []);
		} finally {
			if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previous;
			await rm(dir, { recursive: true, force: true });
		}
	});
});
