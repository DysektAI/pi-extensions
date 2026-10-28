import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext, ProviderConfig } from "@earendil-works/pi-coding-agent";
import type { Api, Model, ModelsPublication, ModelsStoreEntry } from "@earendil-works/pi-ai";
import {
	type CatalogRefreshContext,
	createCatalogRefresh,
	parseCatalog,
	registerAgentRouter,
	toModel,
	USER_AGENT,
} from "./catalog.ts";

const baseUrl = "https://agentrouter.org/v1";
// Dependency-free metadata fixtures; the real Pi catalog is exercised by CLI smoke tests.
const upstream: Model<Api>[] = [
	{
		provider: "openai",
		id: "gpt-6.1-sol",
		name: "GPT-6.1 Sol",
		api: "openai-responses",
		baseUrl: "https://api.openai.com/v1",
		reasoning: true,
		input: ["text", "image"],
		contextWindow: 272000,
		maxTokens: 128000,
		thinkingLevelMap: {
			off: null,
			minimal: null,
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: "xhigh",
			max: "max",
		},
		cost: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
		compat: { supportsMidConvoEffort: true, supportsStrictMode: true },
	},
];
const entry = (id: string, endpoints = ["openai"]) => ({ id, supported_endpoint_types: endpoints });
const initial = toModel(entry("gpt-6.1-sol"), baseUrl, upstream)!;
const payload = { success: true, data: [entry("gpt-6.1-sol"), entry("gpt-6-astra"), entry("gpt-5.6-sol")] };

function context(overrides: Partial<CatalogRefreshContext> = {}): CatalogRefreshContext {
	return {
		allowNetwork: true,
		credential: { type: "api_key", key: "test-key" },
		signal: new AbortController().signal,
		baseUrl,
		publish: async () => true,
		...overrides,
	};
}

function fixture(status = 200, body: unknown = payload) {
	const requests: Array<{ url: string; init?: RequestInit }> = [];
	const publications: ModelsPublication[] = [];
	const refresh = createCatalogRefresh({
		baseUrl,
		initialModels: [initial],
		upstream,
		fetch: (async (url, init) => {
			requests.push({ url: String(url), init });
			return new Response(JSON.stringify(body), { status });
		}) as typeof fetch,
	});
	const ctx = context({
		publish: async (publication) => {
			publications.push(publication);
			return true;
		},
	});
	return { refresh, ctx, requests, publications };
}

test("extension registration keeps Pi's credential/endpoint/header resolution and installs automatic/manual refresh", () => {
	let registered: ProviderConfig | undefined;
	const events: string[] = [];
	const commands: string[] = [];
	registerAgentRouter(
		{
			registerProvider: (id: string, config: ProviderConfig) => {
				assert.equal(id, "agentrouter");
				registered = config;
			},
			on: (event: string) => events.push(event),
			registerCommand: (name: string) => commands.push(name),
		} as unknown as ExtensionAPI,
		baseUrl,
		upstream,
	);
	assert.ok(registered?.refreshModels);
	assert.equal(registered.apiKey, undefined);
	assert.equal(registered.baseUrl, undefined);
	assert.equal(registered.headers, undefined);
	assert.deepEqual(
		registered.models?.map((model) => model.id),
		["gpt-6.1-sol"],
	);
	assert.deepEqual(events, ["session_start"]);
	assert.deepEqual(commands, ["agentrouter-refresh"]);
});

test("model catalog validates all records, de-duplicates strictly, and accepts a genuine empty catalog", () => {
	assert.deepEqual(parseCatalog(payload), payload.data);
	assert.deepEqual(parseCatalog({ success: true, data: [] }), []);
	for (const invalid of [
		null,
		[],
		{},
		{ success: false, data: [] },
		{ data: [entry("")] },
		{ data: [entry(" padded ")] },
		{ data: [entry("a"), entry("a")] },
		{ data: [entry("valid"), { id: "bad" }] },
		{ data: [{ id: "bad", supported_endpoint_types: [3] }] },
	]) {
		assert.throws(() => parseCatalog(invalid), /Invalid AgentRouter/);
	}
});

test("GPT-6.1 Sol uses exact upstream limits/reasoning levels, but not upstream prices or gateway capabilities", () => {
	const source = upstream.find((model) => model.provider === "openai" && model.id === "gpt-6.1-sol")!;
	assert.ok(source);
	assert.equal(initial.api, "openai-responses");
	assert.equal(initial.contextWindow, source.contextWindow);
	assert.equal(initial.maxTokens, source.maxTokens);
	assert.deepEqual(initial.input, ["text", "image"]);
	assert.deepEqual(initial.thinkingLevelMap, source.thinkingLevelMap);
	assert.equal(initial.thinkingLevelMap?.max, "max");
	assert.equal(initial.thinkingLevelMap?.off, null);
	assert.equal(initial.compat, undefined);
	assert.equal(initial.promptCache, undefined);
	assert.deepEqual(initial.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
});

test("Claude uses the Anthropic endpoint when advertised; others use Chat Completions or are excluded", () => {
	const claude = toModel(entry("claude-opus-5", ["openai", "anthropic"]), baseUrl, upstream)!;
	assert.equal(claude.api, "anthropic-messages");
	assert.equal(claude.baseUrl, "https://agentrouter.org");
	assert.equal(toModel(entry("claude-opus-5", ["openai"]), baseUrl, upstream)?.api, "openai-completions");
	assert.equal(toModel(entry("deepseek-v4-flash"), baseUrl, upstream)?.api, "openai-completions");
	assert.equal(toModel(entry("image-model", ["openai-image"]), baseUrl, upstream), undefined);
	assert.equal(toModel(entry("unknown", []), baseUrl, upstream), undefined);
	const unknown = toModel(entry("new-chat-model"), baseUrl, upstream)!;
	assert.deepEqual(unknown.input, ["text"]);
	assert.equal(unknown.reasoning, false);
	assert.equal(unknown.contextWindow, 8192);
	assert.equal(unknown.maxTokens, 2048);
});

test("fetch uses Pi's resolved credential, required user agent, cancellation, and no redirects; only advertised IDs survive", async () => {
	const { refresh, ctx, requests, publications } = fixture();
	const models = await refresh(ctx);
	assert.deepEqual(
		models.map((model) => model.id),
		payload.data.map((model) => model.id),
	);
	assert.equal(requests[0].url, `${baseUrl}/models`);
	assert.deepEqual(requests[0].init?.headers, { Authorization: "Bearer test-key", "User-Agent": USER_AGENT });
	assert.equal(requests[0].init?.redirect, "error");
	assert.ok(requests[0].init?.signal);
	assert.equal(publications[0].persist?.models.length, 3);
	assert.ok(publications[0].persist?.checkedAt);
});

test("offline/cache-only initialization and an empty key perform no network requests", async () => {
	const { refresh, requests } = fixture();
	assert.deepEqual(await refresh(context({ allowNetwork: false })), [initial]);
	assert.deepEqual(await refresh(context({ credential: { type: "api_key", key: " " } })), [initial]);
	assert.deepEqual(await refresh(context({ credential: undefined })), [initial]);
	assert.equal(requests.length, 0);
});

test("forced refresh without a usable credential fails rather than reporting cached models as refreshed", async () => {
	const { refresh, requests } = fixture();
	for (const credential of [undefined, { type: "api_key" as const, key: " " }]) {
		await assert.rejects(() => refresh(context({ credential, force: true })), /needs an API key/);
	}
	assert.equal(requests.length, 0);
});

test("manual command reports missing auth even when Pi would skip its network refresh phase", async () => {
	let handler: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
	registerAgentRouter(
		{
			registerProvider: () => {},
			on: () => {},
			registerCommand: (_name: string, command: { handler: typeof handler }) => {
				handler = command.handler;
			},
		} as unknown as ExtensionAPI,
		baseUrl,
		upstream,
	);
	let refreshes = 0;
	const notices: Array<{ message: string; level: string }> = [];
	await handler!("", {
		modelRegistry: {
			getApiKeyForProvider: async () => undefined,
			refresh: async () => {
				refreshes++;
				return { errors: new Map(), aborted: false };
			},
			getAll: () => [initial],
		},
		ui: { notify: (message: string, level: string) => notices.push({ message, level }) },
	} as unknown as ExtensionCommandContext);
	assert.equal(refreshes, 0);
	assert.equal(notices.length, 1);
	assert.equal(notices[0].level, "warning");
	assert.match(notices[0].message, /needs a configured API key/);
});

test("cache restores offline including empty catalogs, and startup still checks the current key", async () => {
	const { refresh, ctx, requests } = fixture();
	const cached = toModel(entry("gpt-5.6-sol"), baseUrl, upstream)!;
	const stored: ModelsStoreEntry = { models: [cached], checkedAt: Date.now() };
	assert.deepEqual(await refresh(context({ allowNetwork: false, stored })), [cached]);
	await refresh({ ...ctx, stored });
	assert.equal(requests.length, 1);
	assert.deepEqual(await refresh(context({ allowNetwork: false, stored: { models: [] } })), []);
});

test("picker refreshes are debounced, but force and key changes always refetch", async () => {
	const { refresh, ctx, requests } = fixture();
	await refresh(ctx);
	await refresh(ctx);
	assert.equal(requests.length, 1);
	await refresh({ ...ctx, force: true });
	await refresh({ ...ctx, credential: { type: "api_key", key: "rotated-key" } });
	assert.equal(requests.length, 3);
});

test("refresh resumes after TTL and does not trust a future clock timestamp", async () => {
	let time = 1000;
	let calls = 0;
	const refresh = createCatalogRefresh({
		baseUrl,
		initialModels: [initial],
		upstream,
		now: () => time,
		fetch: (async () => {
			calls++;
			return new Response(JSON.stringify(payload));
		}) as typeof fetch,
	});
	await refresh(context());
	time += 5 * 60 * 1000;
	await refresh(context());
	time = 0;
	await refresh(context());
	assert.equal(calls, 3);
});

test("base URL overrides are honored and do not reuse a fresh catalog from another endpoint", async () => {
	const { refresh, ctx, requests } = fixture();
	await refresh(ctx);
	const alternate = "https://proxy.example/api/v1";
	const models = await refresh({ ...ctx, baseUrl: alternate, stored: { models: [initial], checkedAt: Date.now() } });
	assert.equal(requests.length, 2);
	assert.equal(requests[1].url, `${alternate}/models`);
	assert.ok(models.every((model) => model.baseUrl === alternate));
	const offline = await refresh(context({ allowNetwork: false, baseUrl: "https://another.example/v1" }));
	assert.ok(offline.every((model) => model.baseUrl === "https://another.example/v1"));
});

test("transient HTTP errors and malformed JSON/catalogs preserve the last good models and never persist failures", async () => {
	for (const [status, body] of [
		[429, {}],
		[500, {}],
		[200, { success: false, data: [] }],
		[200, { data: [{ id: "bad" }] }],
	] as const) {
		const { refresh, ctx, publications } = fixture(status, body);
		await assert.rejects(() => refresh(ctx));
		assert.deepEqual(await refresh(context({ allowNetwork: false })), [initial]);
		assert.equal(publications.length, 0);
	}
	const refresh = createCatalogRefresh({
		baseUrl,
		initialModels: [initial],
		upstream,
		fetch: (async () => new Response("not-json")) as typeof fetch,
	});
	await assert.rejects(() => refresh(context()));
	assert.deepEqual(await refresh(context({ allowNetwork: false })), [initial]);
});

test("401/403 withdraw stale models and allow recovery on the next refresh", async () => {
	for (const status of [401, 403]) {
		const { refresh, ctx, publications } = fixture(status);
		assert.deepEqual(await refresh(ctx), []);
		assert.deepEqual(publications[0].persist?.models, []);
		assert.equal(publications[0].persist?.checkedAt, undefined);
	}
	let status = 401;
	const refresh = createCatalogRefresh({
		baseUrl,
		initialModels: [initial],
		upstream,
		fetch: (async () => new Response(JSON.stringify(payload), { status })) as typeof fetch,
	});
	assert.deepEqual(await refresh(context()), []);
	status = 200;
	assert.equal((await refresh(context())).length, 3);
});

test("a valid empty accessible catalog replaces all models instead of retaining a fallback", async () => {
	const { refresh, ctx, publications } = fixture(200, { success: true, data: [] });
	assert.deepEqual(await refresh(ctx), []);
	assert.deepEqual(publications[0].persist?.models, []);
});

test("aborted or superseded publications never change the live fallback", async () => {
	const { refresh, ctx, publications } = fixture();
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(() => refresh({ ...ctx, signal: controller.signal }), /abort/i);
	assert.equal(publications.length, 0);
	assert.deepEqual(await refresh({ ...ctx, publish: async () => false }), [initial]);
	assert.deepEqual(await refresh(context({ allowNetwork: false })), [initial]);
});

test("manual command warns when the refresh leaves no AgentRouter models (rejected key or empty catalog)", async () => {
	let handler: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
	registerAgentRouter(
		{
			registerProvider: () => {},
			on: () => {},
			registerCommand: (_name: string, command: { handler: typeof handler }) => {
				handler = command.handler;
			},
		} as unknown as ExtensionAPI,
		baseUrl,
		upstream,
	);
	for (const [models, level] of [[[], "warning"], [[initial], "info"]] as const) {
		const notices: Array<{ message: string; level: string }> = [];
		await handler!("", {
			modelRegistry: {
				getApiKeyForProvider: async () => "rejected-key",
				refresh: async () => ({ errors: new Map(), aborted: false }),
				getAll: () => models,
			},
			ui: { notify: (message: string, level: string) => notices.push({ message, level }) },
		} as unknown as ExtensionCommandContext);
		assert.equal(notices.length, 1);
		assert.equal(notices[0].level, level);
		if (level === "warning") assert.match(notices[0].message, /0 models available/);
	}
});

test("startup refresh retries when a superseding registry refresh drops the network phase", async () => {
	let registered: ProviderConfig | undefined;
	let onStart: ((event: unknown, ctx: unknown) => void) | undefined;
	// Stub before registration: the catalog captures the global fetch when created.
	const original = globalThis.fetch;
	let fetches = 0;
	globalThis.fetch = (async () => {
		fetches++;
		return new Response(JSON.stringify(payload), { status: 200 });
	}) as typeof fetch;
	registerAgentRouter(
		{
			registerProvider: (_id: string, config: ProviderConfig) => {
				registered = config;
			},
			on: (_event: string, handler: typeof onStart) => {
				onStart = handler;
			},
			registerCommand: () => {},
		} as unknown as ExtensionAPI,
		baseUrl,
		upstream,
		1,
	);
	try {
		let calls = 0;
		const done = new Promise<void>((resolve) => {
			onStart!({}, {
				modelRegistry: {
					refresh: async () => {
						calls++;
						// First call: superseded (no network phase). Second: network runs.
						if (calls >= 2) await registered!.refreshModels!(context());
						if (calls >= 2) setTimeout(resolve, 5);
						return { errors: new Map(), aborted: false };
					},
				},
			});
		});
		await done;
		await new Promise((r) => setTimeout(r, 20));
		assert.equal(calls, 2);
		assert.equal(fetches, 1);
	} finally {
		globalThis.fetch = original;
	}
});

test("startup refresh stops after bounded attempts when no network result arrives (offline)", async () => {
	let onStart: ((event: unknown, ctx: unknown) => void) | undefined;
	registerAgentRouter(
		{
			registerProvider: () => {},
			on: (_event: string, handler: typeof onStart) => {
				onStart = handler;
			},
			registerCommand: () => {},
		} as unknown as ExtensionAPI,
		baseUrl,
		upstream,
		1,
	);
	let calls = 0;
	onStart!({}, { modelRegistry: { refresh: async () => (calls++, { errors: new Map(), aborted: false }) } });
	await new Promise((r) => setTimeout(r, 50));
	assert.equal(calls, 3);
});

