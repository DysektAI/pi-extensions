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
import {
	createGuard,
	DEDUPE_MS,
	discoverPools,
	outcomeForStatus,
	parsePoolStatus,
	pickFallback,
	reasonForError,
	retryAfterSeconds,
} from "./pure.ts";

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

describe("upstream retry window", () => {
	it("reads retry-after headers in milliseconds, seconds, and HTTP-date form", () => {
		assert.equal(retryAfterSeconds({ "retry-after-ms": "1500" }), 1.5);
		assert.equal(retryAfterSeconds({ "Retry-After": "21437" }), 21437);
		assert.equal(retryAfterSeconds({ "retry-after": "-5" }), undefined);
		const upcoming = new Date(Date.now() + 60_000).toUTCString();
		const seconds = retryAfterSeconds({ "retry-after": upcoming });
		assert.ok(seconds !== undefined && seconds > 0 && seconds <= 60);
	});

	it("falls back to the delay Pi declined to wait for", () => {
		const text =
			"Server requested 21437s retry delay (max: 60s). 429 Free usage limit reached. subscribe to OpenCode Go";
		assert.equal(retryAfterSeconds(undefined, text), 21437);
		assert.equal(retryAfterSeconds(undefined, "429 rate limit reached"), undefined);
		assert.equal(retryAfterSeconds({}, undefined), undefined);
	});
});

describe("pool status", () => {
	it("parses usable and the retry time an engine reports", () => {
		assert.deepEqual(
			parsePoolStatus('{"provider":"opencode","counts":{"active":0},"usable":false,"next_retry_at":1793470091.5}'),
			{ usable: false, nextRetryAt: 1_793_470_091_500 },
		);
		assert.deepEqual(parsePoolStatus('{"counts":{"active":2}}'), { usable: true, nextRetryAt: undefined });
		assert.equal(parsePoolStatus("not json"), undefined);
		assert.equal(parsePoolStatus('{"counts":{}}'), undefined);
	});

	it("prefers the first candidate whose pool is usable", () => {
		const pools = new Map([
			["opencode", "opencode"],
			["groq", "groq"],
		]);
		const snapshots = new Map<string, { usable: boolean }>([
			["opencode", { usable: false }],
			["groq", { usable: true }],
		]);
		const status = (pool: string) => snapshots.get(pool) as never;
		const candidates = [
			{ provider: "opencode", id: "beam-free" },
			{ provider: "morph", id: "morph-dsv41flash" },
			{ provider: "groq", id: "llama" },
		];
		assert.deepEqual(pickFallback("opencode", candidates, pools, status), {
			provider: "morph",
			id: "morph-dsv41flash",
		});
		assert.deepEqual(pickFallback("other", candidates, pools, status), {
			provider: "morph",
			id: "morph-dsv41flash",
		});
		// An unknown pool state is never treated as usable.
		assert.equal(pickFallback("opencode", [candidates[0]], pools, () => undefined), undefined);
	});
});

describe("createGuard", () => {
	function harness(current = { fingerprint: "aaaa1111", trial: false }) {
		const calls: string[] = [];
		let clock = 0;
		const state = { ...current };
		const guard = createGuard(new Map([["deepseek", "deepseek"]]), {
			report: (pool, outcome, reason, fp, until) =>
				calls.push(`${pool}:${outcome}:${reason}:${fp ?? "-"}${until === undefined ? "" : `:${until}`}`),
			current: () => ({ ...state }),
			now: () => clock,
		});
		return { guard, calls, state, advance: (ms: number) => (clock += ms) };
	}

	it("benches once per failure window and ignores unpooled providers", () => {
		const { guard, calls, advance } = harness();
		guard.onRequest("deepseek");
		guard.onResponse("deepseek", 429);
		guard.onAssistantError("deepseek", "rate limit reached");
		guard.onResponse("openai", 429);
		advance(DEDUPE_MS);
		guard.onResponse("deepseek", 401);
		assert.deepEqual(calls, ["deepseek:exhausted:http 429:aaaa1111", "deepseek:exhausted:http 401 auth:aaaa1111"]);
	});

	it("benches with the upstream retry window", () => {
		const fromHeader = harness();
		fromHeader.guard.onRequest("deepseek");
		fromHeader.guard.onResponse("deepseek", 429, { "Retry-After": "21437" });
		assert.deepEqual(fromHeader.calls, ["deepseek:exhausted:http 429:aaaa1111:21437"]);
		const fromText = harness();
		fromText.guard.onAssistantError(
			"deepseek",
			"Server requested 20239s retry delay (max: 60s). 429 Free usage limit reached",
		);
		assert.deepEqual(fromText.calls, ["deepseek:exhausted:quota error:-:20239"]);
		// A status without any retry signal keeps the engine's own cooldown.
		const bare = harness();
		bare.guard.onRequest("deepseek");
		bare.guard.onResponse("deepseek", 429);
		assert.deepEqual(bare.calls, ["deepseek:exhausted:http 429:aaaa1111"]);
	});

	it("reports the key that was in use when the request started", () => {
		const { guard, calls, state } = harness();
		guard.onRequest("deepseek");
		state.fingerprint = "bbbb2222"; // another process rotated meanwhile
		guard.onResponse("deepseek", 429);
		assert.deepEqual(calls, ["deepseek:exhausted:http 429:aaaa1111"]);
	});

	it("promotes only a key under trial on success", () => {
		const idle = harness();
		idle.guard.onRequest("deepseek");
		idle.guard.onResponse("deepseek", 200);
		assert.deepEqual(idle.calls, []);
		const trial = harness({ fingerprint: "cccc3333", trial: true });
		trial.guard.onRequest("deepseek");
		trial.guard.onResponse("deepseek", 200);
		assert.deepEqual(trial.calls, ["deepseek:ok::cccc3333"]);
	});

	it("benches on classified error text without a decisive status", () => {
		const { guard, calls } = harness();
		guard.onResponse("deepseek", 400);
		guard.onAssistantError("deepseek", "RESOURCE_EXHAUSTED");
		guard.onAssistantError("deepseek", "");
		assert.deepEqual(calls, ["deepseek:exhausted:quota error:-"]);
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
			// Fake engine: answer --status, log every other call's arguments.
			await writeFile(
				join(dir, "bin", "pool.py"),
				[
					"import sys, pathlib",
					"if '--status' in sys.argv:",
					"    print('{\"counts\": {\"active\": 1}, \"usable\": true}')",
					"else:",
					"    pathlib.Path(sys.argv[0]).with_name('calls.log').open('a').write(' '.join(sys.argv[1:]) + '\\n')",
					"",
				].join("\n"),
			);
			await writeFile(join(dir, "deepseek-pool", "state.json"), JSON.stringify({ current: "dddd4444", current_from: "exhausted" }));
			const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
			poolGuard({ on: (name: string, fn: (e: unknown, c: unknown) => void) => handlers.set(name, fn) } as never);
			const ctx = { model: { provider: "deepseek" } };
			handlers.get("before_provider_request")!({ payload: {} }, ctx);
			handlers.get("after_provider_response")!({ status: 429, headers: { "Retry-After": "21437" } }, ctx);
			handlers.get("after_provider_response")!({ status: 200, headers: {} }, ctx);
			// A virtual model routed to the pooled provider: attribute by the message.
			await new Promise((r) => setTimeout(r, DEDUPE_MS + 50));
			handlers.get("message_end")!(
				{
					message: {
						role: "assistant",
						provider: "deepseek",
						errorMessage: "Server requested 20239s retry delay (max: 60s). 429 Free usage limit reached",
					},
				},
				{
					model: { provider: "my-router" },
					modelRegistry: { getAvailable: () => [] },
					scopedModels: [],
					ui: { notify: () => {} },
				},
			);
			const log = await readFile(join(dir, "bin", "calls.log"), "utf8");
			assert.deepEqual(log.trim().split(/\r?\n/), [
				"deepseek --report exhausted --reason http 429 --key key#dddd4444 --until 21437",
				"deepseek --report ok --key key#dddd4444",
				"deepseek --report exhausted --reason quota error --key key#dddd4444 --until 20239",
			]);
		} finally {
			if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previous;
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("moves a session off a pool with no usable key, once per outage", { timeout: 20000 }, async () => {
		const dir = await mkdtemp(join(tmpdir(), "pool-guard-switch-"));
		const previous = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = dir;
		try {
			await mkdir(join(dir, "bin"));
			await mkdir(join(dir, "opencode-pool"));
			await writeFile(
				join(dir, "models.json"),
				JSON.stringify({ providers: { opencode: { apiKey: "!bash $HOME/.pi/agent/opencode-pool/oc-pool" } } }),
			);
			await writeFile(
				join(dir, "bin", "pool.py"),
				[
					"import sys",
					"if '--status' in sys.argv:",
					"    print('{\"counts\": {\"active\": 0}, \"usable\": false, \"next_retry_at\": 1793470091.5}')",
					"",
				].join("\n"),
			);
			const picks: string[] = [];
			const notices: string[] = [];
			const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
			poolGuard({
				on: (name: string, fn: (e: unknown, c: unknown) => unknown) => handlers.set(name, fn),
				getSettings: () => ({ defaultProvider: "morph", defaultModel: "morph-dsv41flash" }),
				setModel: async (model: { provider: string; id: string }) => {
					picks.push(`${model.provider}/${model.id}`);
					return true;
				},
			} as never);
			const ctx = {
				model: { provider: "opencode", id: "beam-free" },
				modelRegistry: {
					find: (provider: string, id: string) => ({ provider, id }),
					getAvailable: () => [{ provider: "opencode", id: "beam-free" }],
				},
				scopedModels: [],
				ui: { notify: (message: string) => notices.push(message) },
			};
			await handlers.get("session_start")!({}, ctx);
			for (let i = 0; i < 60 && picks.length === 0; i++) await new Promise((r) => setTimeout(r, 100));
			assert.deepEqual(picks, ["morph/morph-dsv41flash"]);
			// A second start must not re-switch (or re-warn) for the same outage.
			await handlers.get("session_start")!({}, ctx);
			for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 100));
			assert.deepEqual(picks, ["morph/morph-dsv41flash"]);
			assert.equal(notices.length, 1);
			assert.match(notices[0]!, /opencode pool has no usable keys/);
			assert.match(notices[0]!, /switched to morph\/morph-dsv41flash/);
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
