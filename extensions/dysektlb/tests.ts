import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { dysektlbProvider, extractModels, resolveBaseUrl, toPiModel, usesResponsesApi } from "./provider.ts";

const model = { id: "codex-example", owned_by: "dysekt-lb", metadata: { prefer_websockets: true } };
const DEFAULT = "https://api.dysektai.com/v1";

test("model conversion selects Responses affinity only for owned WebSocket models", () => {
	assert.equal(usesResponsesApi(model), true);
	const responses = toPiModel(model);
	assert.equal(responses.api, "openai-responses");
	assert.equal(responses.compat.sessionAffinityFormat, "openai");
	assert.equal(responses.compat.supportsLongCacheRetention, true);
	for (const stateless of [
		{ ...model, owned_by: "kiro" },
		{ ...model, owned_by: "provider-key" },
		{ ...model, metadata: {} },
		{ ...model, metadata: { prefer_websockets: false } },
	]) {
		assert.equal(usesResponsesApi(stateless), false);
		const converted = toPiModel(stateless);
		assert.equal(converted.api, "openai-completions");
		assert.equal(converted.compat.sessionAffinityFormat, undefined);
		assert.equal(converted.compat.supportsReasoningEffort, true);
	}
});

test("existing prices and capabilities survive conversion", () => {
	const converted = toPiModel({
		id: "deepseek/deepseek-v4.1-flash",
		metadata: { input_modalities: ["text", "image"], context_window: 1000000, max_output_tokens: 32000,
			pricing: { inputCostPerToken: 0.000002, output: 7 } },
		capabilities: { supports_reasoning: true },
	});
	assert.deepEqual(converted.input, ["text", "image"]);
	assert.equal(converted.contextWindow, 1000000);
	assert.equal(converted.maxTokens, 32000);
	assert.equal(converted.cost.input, 2);
	assert.equal(converted.cost.output, 7);
	assert.equal(converted.thinkingLevelMap?.max, "max");
});

test("pricing units follow the selected key rather than the numeric magnitude", () => {
	for (const rate of [0.001, 0.1, 2]) {
		const perToken = toPiModel({ id: "priced", pricing: { inputCostPerToken: rate, outputCostPerToken: String(rate) } });
		assert.equal(perToken.cost.input, rate * 1000000);
		assert.equal(perToken.cost.output, rate * 1000000);
	}
	const perMillion = toPiModel({ id: "cheap", pricing: {
		inputCostPerMillion: 0.0005, output_cost_per_million: "0.0007", cacheReadCostPerMillion: 0.0002,
		cache_write_cost_per_million: 0.0003,
	} });
	assert.deepEqual(perMillion.cost, { input: 0.0005, output: 0.0007, cacheRead: 0.0002, cacheWrite: 0.0003 });
	const priority = toPiModel({ id: "priority", pricing: { input: 0, inputCostPerToken: 1, output: "invalid", outputCostPerToken: 0.001 } });
	assert.equal(priority.cost.input, 0);
	assert.equal(priority.cost.output, 1000);
});

test("backend Kiro metadata reference pricing maps all per-million rates", () => {
	const backendPricing = { input_per_1m: 5, output_per_1m: 25, cached_input_per_1m: 0.5,
		cache_write_per_1m: 6.25, currency: "USD", source: "Anthropic public reference rates" };
	const catalog = extractModels({ data: [{ id: "claude-opus-4.8", owned_by: "dysekt-lb",
		metadata: { pricing: backendPricing } }] });
	assert.equal(catalog.length, 1);
	assert.deepEqual(toPiModel(catalog[0]).cost, { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 });
	const priority = toPiModel({ id: "pricing-priority", pricing: { ...backendPricing, input: 0, output: 3, cacheRead: 0.2, cacheWrite: 0.3 } });
	assert.deepEqual(priority.cost, { input: 0, output: 3, cacheRead: 0.2, cacheWrite: 0.3 });
});

test("advertised levels and model overrides enable reasoning when boolean flags are absent", () => {
	const advertised = toPiModel({ id: "kiro/example", metadata: { supported_reasoning_levels: [{ effort: "high" }] } });
	assert.equal(advertised.reasoning, true);
	assert.equal(advertised.thinkingLevelMap?.high, "high");
	for (const id of ["deepseek/deepseek-v4.1-flash", "fw/ds-v4.1-flash", "zoyi/gpt-6-sol"]) {
		assert.equal(toPiModel({ id }).reasoning, true);
		assert.equal(toPiModel({ id }).thinkingLevelMap?.max, "max");
	}
	for (const flags of [{ supports_reasoning: false }, { supportsReasoning: false }, { capabilities: { supports_reasoning: false }, supports_reasoning: true }]) {
		assert.equal(toPiModel({ id: "deepseek/deepseek-v4.1-flash", ...flags }).reasoning, false);
	}
	assert.equal(toPiModel({ id: "plain" }).reasoning, false);
	assert.equal(toPiModel({ id: "plain", supports_reasoning: true }).reasoning, true);
});

test("malformed catalog entries cannot reach model conversion", () => {
	for (const invalid of [null, {}, { id: " " }, { id: 4 }, { id: "a", metadata: { input_modalities: {} } },
		{ id: "a", metadata: { supported_reasoning_levels: [null] } }, { id: "a", capabilities: { input_modalities: "image" } }]) {
		assert.deepEqual(extractModels([model, invalid]), []);
		assert.deepEqual(extractModels({ data: [invalid] }), []);
	}
	assert.deepEqual(extractModels({ data: [model] }), [model]);
	assert.deepEqual(extractModels([model]), [model]);
});

test("URL configuration and provider lifecycle use real files and mocked HTTP", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "dysektlb-test-"));
	const modelsPath = join(dir, "models.json");
	const cachePath = join(dir, ".cache", "dysektlb-models.json");
	const env = { url: process.env.DYSEKTLB_BASE_URL, key: process.env.DYSEKTLB_API_KEY };
	const originalWarn = console.warn;
	const originalFetch = globalThis.fetch;
	const warnings: string[] = [];
	let configs: any[] = [];
	const pi = { registerProvider(name: string, config: unknown) { assert.equal(name, "dysektlb"); configs.push(config); } };
	const run = () => dysektlbProvider(pi as Parameters<typeof dysektlbProvider>[0], dir);
	console.warn = (value) => warnings.push(String(value));
	delete process.env.DYSEKTLB_BASE_URL;
	process.env.DYSEKTLB_API_KEY = "test-env-key";
	try {
		await t.test("missing or absent configuration silently uses default", async () => {
			assert.equal(resolveBaseUrl(dir), DEFAULT);
			for (const config of ["{}", "null", '{"providers":{}}', '{"providers":{"dysektlb":{"baseUrl":" "}}}']) {
				await writeFile(modelsPath, config);
				assert.equal(resolveBaseUrl(dir), DEFAULT);
			}
			assert.deepEqual(warnings, []);
		});
		await t.test("config URL trims trailing slashes and blank environment", async () => {
			await writeFile(modelsPath, JSON.stringify({ providers: { dysektlb: { baseUrl: "  http://localhost:2455/v1///  " } } }));
			for (const value of ["", "   "]) {
				process.env.DYSEKTLB_BASE_URL = value;
				assert.equal(resolveBaseUrl(dir), "http://localhost:2455/v1");
			}
		});
		await t.test("environment wins without reading malformed config", async () => {
			await writeFile(modelsPath, "invalid JSON");
			process.env.DYSEKTLB_BASE_URL = "  https://override.example/v1///  ";
			assert.equal(resolveBaseUrl(dir), "https://override.example/v1");
			assert.deepEqual(warnings, []);
			delete process.env.DYSEKTLB_BASE_URL;
		});
		await t.test("malformed and unreadable config warn without contents", async () => {
			await writeFile(modelsPath, '{"apiKey":"SECRET-CANARY", broken}');
			assert.equal(resolveBaseUrl(dir), DEFAULT);
			assert.equal(warnings.length, 1);
			assert.match(warnings[0], /models.json/);
			assert.doesNotMatch(warnings[0], /SECRET-CANARY/);
			await rm(modelsPath);
			await mkdir(modelsPath);
			assert.equal(resolveBaseUrl(dir), DEFAULT);
			assert.equal(warnings.length, 2);
			await rm(modelsPath, { recursive: true });
		});
		await writeFile(join(dir, "auth.json"), JSON.stringify({ dysektlb: { type: "api_key", key: "test-auth-key" } }));
		await writeFile(modelsPath, JSON.stringify({ providers: { dysektlb: { baseUrl: "https://configured.example/v1/" } } }));
		globalThis.fetch = async (url, options) => {
			assert.equal(url, "https://configured.example/v1/models");
			assert.equal((options?.headers as Record<string, string>).Authorization, "Bearer test-auth-key");
			return new Response(JSON.stringify({ data: [model] }));
		};
		await t.test("registration uses configured URL, same auth and private fresh cache", async () => {
			await run();
			assert.equal(configs[0].baseUrl, "https://configured.example/v1");
			assert.equal(configs[0].apiKey, "test-auth-key");
			assert.equal(configs[0].models[0].api, "openai-responses");
			assert.deepEqual(JSON.parse(await readFile(cachePath, "utf8")), [model]);
			if (process.platform !== "win32") {
				assert.equal((await stat(cachePath)).mode & 0o777, 0o600);
				assert.equal((await stat(join(dir, ".cache"))).mode & 0o777, 0o700);
			}
		});
		await t.test("existing cache permissions tighten and content refreshes", async () => {
			await writeFile(cachePath, '[{"id":"old"}]');
			if (process.platform !== "win32") await chmod(cachePath, 0o644);
			await run();
			assert.deepEqual(JSON.parse(await readFile(cachePath, "utf8")), [model]);
			if (process.platform !== "win32") assert.equal((await stat(cachePath)).mode & 0o777, 0o600);
		});
		await t.test("Windows cache writes avoid descriptor chmod", async (windowsTest) => {
			const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
			const probe = await open(cachePath, "r");
			const prototype = Object.getPrototypeOf(probe);
			await probe.close();
			const mock = windowsTest.mock.method(prototype, "chmod", async () => { throw new Error("Windows reopen fails"); });
			try {
				Object.defineProperty(process, "platform", { ...platform, value: "win32" });
				await rm(cachePath);
				await run();
				assert.deepEqual(JSON.parse(await readFile(cachePath, "utf8")), [model]);
				await writeFile(cachePath, '[{"id":"old-with-longer-content-than-normal"}]');
				await run();
				assert.deepEqual(JSON.parse(await readFile(cachePath, "utf8")), [model]);
			} finally { Object.defineProperty(process, "platform", platform); mock.mock.restore(); }
		});
		for (const status of [401, 403]) {
			await t.test(`HTTP ${status} does not use cached models`, async () => {
				configs = [];
				globalThis.fetch = async () => new Response("denied", { status });
				await run();
				assert.deepEqual(configs, []);
				assert.match(warnings.at(-1)!, /Authentication failed/);
			});
		}
		await t.test("malformed response preserves valid cache and registers it", async () => {
			configs = [];
			globalThis.fetch = async () => new Response("[null]");
			await run();
			assert.deepEqual(JSON.parse(await readFile(cachePath, "utf8")), [model]);
			assert.equal(configs[0].models[0].id, model.id);
		});
		await t.test("network outage uses valid cache", async () => {
			configs = [];
			globalThis.fetch = async () => { throw new TypeError("offline"); };
			await run();
			assert.equal(configs[0].models[0].id, model.id);
		});
		await t.test("malformed cache during outage skips registration", async () => {
			configs = [];
			await writeFile(cachePath, "[null]");
			await run();
			assert.deepEqual(configs, []);
		});
		await t.test("missing credentials never fetch", async () => {
			configs = [];
			await rm(join(dir, "auth.json"));
			delete process.env.DYSEKTLB_API_KEY;
			let fetchCalls = 0;
			globalThis.fetch = async () => { fetchCalls++; return new Response(JSON.stringify({ data: [model] })); };
			await run();
			assert.equal(fetchCalls, 0);
			assert.deepEqual(configs, []);
		});
	} finally {
		console.warn = originalWarn;
		globalThis.fetch = originalFetch;
		for (const [name, value] of [["DYSEKTLB_BASE_URL", env.url], ["DYSEKTLB_API_KEY", env.key]]) {
			if (value === undefined) delete process.env[name!]; else process.env[name!] = value;
		}
		await rm(dir, { recursive: true, force: true });
	}
});
