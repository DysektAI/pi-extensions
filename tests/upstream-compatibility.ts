import assert from "node:assert/strict";
import {
	mkdtempSync,
	mkdirSync,
	existsSync,
	writeFileSync,
	readdirSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import {
	getCurrentTools,
	normalizeContext,
	AssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import {
	ModelRuntime,
	ModelRegistry,
	createAgentSession,
	DefaultResourceLoader,
	SettingsManager,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import {
	withOpenCodeCompat,
	formatOpenCodeSessionId,
} from "../extensions/opencode-compat/compat.js";
import { registerPoolKey } from "../extensions/_shared/provider-key.js";
const root = process.env.PI_UPSTREAM_ROOT;
if (!root)
	throw new Error(
		"Set PI_UPSTREAM_ROOT to a built, unmodified upstream Pi checkout",
	);
const load = (path: string) => import(pathToFileURL(join(root, path)).href);
const { AuthStorage } = await load(
	"packages/coding-agent/dist/core/auth-storage.js",
);
const { loadExtensions } = await load(
	"packages/coding-agent/dist/core/extensions/loader.js",
);
const temp = mkdtempSync(join(tmpdir(), "pi-upstream-compat-"));
process.env.PI_CODING_AGENT_DIR = temp;
process.env.PI_OFFLINE = "1";
process.env.PI_OPENCODE_COMPAT = "1";
process.on("exit", () => rmSync(temp, { recursive: true, force: true }));
const model = {
	id: "test",
	name: "Test",
	provider: "opencode",
	api: "openai-completions",
	baseUrl: "https://example.invalid/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 4096,
	maxTokens: 128,
};
const context = normalizeContext({
	messages: [{ role: "user", content: "hello", timestamp: 0 }],
});
function completed() {
	const message = {
		role: "assistant",
		content: [{ type: "text", text: "ok" }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		stopReason: "stop",
		timestamp: 0,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
	const stream = new AssistantMessageEventStream();
	stream.push({ type: "done", reason: "stop", message });
	stream.end(message);
	return stream;
}
test("compatibility covers both stream APIs and tool removals without mutating input", async () => {
	const removed = normalizeContext({
		messages: [
			{
				role: "system",
				content: "system",
				toolsAdded: [
					{
						name: "bash",
						description: "bash",
						parameters: { type: "object", properties: {} },
					},
				],
				timestamp: 0,
			},
			{ role: "system", content: "", toolsRemoved: ["bash"], timestamp: 1 },
			{ role: "user", content: "summarize", timestamp: 2 },
		],
	});
	const before = JSON.stringify(removed);
	for (const method of ["stream", "streamSimple"] as const) {
		let capture: any;
		const fn = (_model: any, ctx: any, options: any) => {
			capture = { ctx, options };
			return completed();
		};
		await withOpenCodeCompat({ stream: fn, streamSimple: fn })
			[method](model as any, removed, { sessionId: "conversation-1" })
			.result();
		assert.deepEqual(
			getCurrentTools(capture.ctx.messages).map((t) => t.name),
			["bash", "read"],
		);
		assert.match(
			capture.options.headers["x-opencode-session"],
			/^ses_[0-9a-f]{26}$/,
		);
		assert.match(capture.options.headers["User-Agent"], /^opencode\//);
	}
	assert.equal(JSON.stringify(removed), before);
	assert.equal(
		formatOpenCodeSessionId("conversation-1"),
		formatOpenCodeSessionId("conversation-1"),
	);
});
test("native provider and custom models survive repeated credential rotation", async () => {
	const modelsPath = join(temp, "models.json");
	writeFileSync(
		modelsPath,
		JSON.stringify({
			providers: {
				opencode: {
					models: [{ ...model, id: "custom-test" }],
					baseUrl: model.baseUrl,
				},
			},
		}),
	);
	const registry = new ModelRegistry(
		await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsPath,
			allowModelNetwork: false,
		}),
	);
	const original = registry.getProvider("opencode")!;
	let capture: any;
	const fn = (_model: any, ctx: any, options: any) => {
		capture = { ctx, options };
		return completed();
	};
	registry.registerProvider({
		...original,
		...withOpenCodeCompat({ stream: fn, streamSimple: fn }),
	});
	const pi = {
		registerProvider: (...args: any[]) =>
			registry.registerProvider(...(args as [any])),
	};
	for (const key of ["test-key-1", "test-key-2", "test-key-1"]) {
		registerPoolKey(pi as any, "opencode", key, {
			modelRegistry: registry,
		} as any);
		assert.ok(registry.find("opencode", "custom-test"));
		const auth = await registry.getProviderAuth("opencode");
		assert.equal(auth?.auth.apiKey, key);
		const result = await registry
			.streamSimple(registry.find("opencode", "custom-test")!, context, {
				sessionId: "rotation",
			})
			.result();
		assert.equal(result.stopReason, "stop");
		assert.equal(capture.options.apiKey, key);
		assert.equal(getCurrentTools(capture.ctx.messages).length, 2);
	}
});
test("real upstream adapter sends compat headers/tools and receives a streamed answer", async () => {
	const registry = new ModelRegistry(
		await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsPath: null,
			allowModelNetwork: false,
		}),
	);
	const original = registry.getProvider("opencode")!;
	registry.registerProvider({ ...original, ...withOpenCodeCompat(original) });
	registerPoolKey(
		{ registerProvider: (p: any) => registry.registerProvider(p) } as any,
		"opencode",
		"fake-test-key",
		{ modelRegistry: registry } as any,
	);
	const previous = globalThis.fetch;
	let captured: any;
	globalThis.fetch = async (input: any, init: any) => {
		const request = input instanceof Request ? input : new Request(input, init);
		captured = { headers: request.headers, body: await request.json() };
		const chunk = {
			id: "chatcmpl-test",
			object: "chat.completion.chunk",
			created: 0,
			model: "test",
			choices: [
				{ index: 0, delta: { content: "upstream works" }, finish_reason: null },
			],
		};
		const end = {
			...chunk,
			choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
		};
		return new Response(
			`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(end)}\n\ndata: [DONE]\n\n`,
			{ headers: { "content-type": "text/event-stream" } },
		);
	};
	try {
		const result = await registry
			.streamSimple(model as any, context, { sessionId: "real-adapter" })
			.result();
		assert.equal(result.stopReason, "stop", result.errorMessage);
		assert.equal((result.content[0] as any).text, "upstream works");
		assert.equal(captured.headers.get("authorization"), "Bearer fake-test-key");
		assert.match(captured.headers.get("user-agent"), /^opencode\//);
		assert.match(
			captured.headers.get("x-opencode-session"),
			/^ses_[0-9a-f]{26}$/,
		);
		assert.deepEqual(
			captured.body.tools.map((t: any) => t.function.name),
			["bash", "read"],
		);
	} finally {
		globalThis.fetch = previous;
	}
});
test("all extension entrypoints load through the actual upstream extension loader", async () => {
	const dir = resolve("extensions");
	const paths = readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
		entry.isFile() && entry.name.endsWith(".ts")
			? [join(dir, entry.name)]
			: entry.isDirectory() && !entry.name.startsWith("_")
				? [join(dir, entry.name, "index.ts")]
				: [],
	);
	const entrypoints = paths.filter(existsSync);
	const result = await loadExtensions(entrypoints, resolve("."));
	assert.deepEqual(result.errors, []);
	assert.equal(result.extensions.length, entrypoints.length);
	console.log(`Loaded ${entrypoints.length} extensions on stock upstream`);
});

test("real credential-pool events preserve compatibility in either extension load order", async () => {
	mkdirSync(join(temp, "credential-pool"), { recursive: true });
	writeFileSync(
		join(temp, "credential-pool", "pools.json"),
		JSON.stringify({
			pools: {
				opencode: {
					keys: [{ value: "fake-pool-1" }, { value: "fake-pool-2" }],
				},
			},
		}),
	);
	const paths = [
		resolve("extensions/credential-pool/index.ts"),
		resolve("extensions/opencode-compat/index.ts"),
	];
	for (const order of [paths, [...paths].reverse()]) {
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsPath: null,
			allowModelNetwork: false,
		});
		const registry = new ModelRegistry(runtime);
		const result = await loadExtensions(order, resolve("."));
		assert.deepEqual(result.errors, []);
		for (const { name, config } of result.runtime.pendingProviderRegistrations)
			registry.registerProvider(name, config);
		result.runtime.registerProvider = (id: any, config: any) =>
			registry.registerProvider(id, config);
		result.runtime.registerNativeProvider = (p: any) =>
			registry.registerProvider(p);
		const ctx: any = {
			model: { provider: "opencode" },
			modelRegistry: registry,
			ui: { notify() {}, setStatus() {} },
		};
		const emit = async (type: string, event: any) => {
			for (const extension of result.extensions)
				for (const handler of extension.handlers.get(type) ?? [])
					await handler({ type, ...event }, ctx);
		};
		await emit("session_start", {});
		assert.equal(
			(await registry.getProviderAuth("opencode"))?.auth.apiKey,
			"fake-pool-1",
		);
		await emit("after_provider_response", {
			status: 429,
			headers: { "retry-after": "1" },
		});
		assert.equal(
			(await registry.getProviderAuth("opencode"))?.auth.apiKey,
			"fake-pool-2",
		);
		let captured: any;
		const previous = globalThis.fetch;
		globalThis.fetch = async (input: any, init: any) => {
			const req = input instanceof Request ? input : new Request(input, init);
			captured = { headers: req.headers, body: await req.json() };
			return new Response(
				'data: {"id":"test","object":"chat.completion.chunk","created":0,"model":"test","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
				{ headers: { "content-type": "text/event-stream" } },
			);
		};
		try {
			const response = await registry
				.streamSimple(model as any, context, { sessionId: "pool" })
				.result();
			assert.equal(response.stopReason, "stop", response.errorMessage);
			assert.equal(captured.headers.get("authorization"), "Bearer fake-pool-2");
			assert.match(captured.headers.get("user-agent"), /^opencode\//);
			assert.equal(captured.body.tools.length, 2);
			await emit("after_provider_response", { status: 401, headers: {} });
			const pool = result.extensions.find((e: any) =>
				e.path.includes("credential-pool"),
			);
			await pool.commands.get("pool-reset").handler("", ctx);
			assert.equal(
				(await registry.getProviderAuth("opencode"))?.auth.apiKey,
				"fake-pool-1",
			);
			const again = await registry
				.streamSimple(model as any, context, { sessionId: "pool" })
				.result();
			assert.equal(again.stopReason, "stop");
			assert.equal(captured.body.tools.length, 2);
		} finally {
			globalThis.fetch = previous;
		}
	}
	rmSync(join(temp, "credential-pool"), { recursive: true });
});
test("actual SDK compaction retains compatibility and session attribution", async () => {
	const runtime = await ModelRuntime.create({
		credentials: AuthStorage.inMemory(),
		modelsPath: null,
		allowModelNetwork: false,
	});
	const registry = new ModelRegistry(runtime);
	registry.registerProvider({
		...registry.getProvider("opencode")!,
		...withOpenCodeCompat(registry.getProvider("opencode")!),
	});
	registerPoolKey(
		{ registerProvider: (p: any) => registry.registerProvider(p) } as any,
		"opencode",
		"fake-summary-key",
		{ modelRegistry: registry } as any,
	);
	const settingsManager = SettingsManager.inMemory({});
	const resourceLoader = new DefaultResourceLoader({
		cwd: temp,
		agentDir: temp,
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
	});
	await resourceLoader.reload();
	const { session } = await createAgentSession({
		cwd: temp,
		agentDir: temp,
		model: model as any,
		modelRuntime: runtime,
		settingsManager,
		sessionManager: SessionManager.inMemory(temp),
		resourceLoader,
	});
	const { generateSummaryWithUsage } = await load(
		"packages/coding-agent/dist/core/compaction/compaction.js",
	);
	const previous = globalThis.fetch;
	let captured: any;
	globalThis.fetch = async (input: any, init: any) => {
		const req = input instanceof Request ? input : new Request(input, init);
		captured = { headers: req.headers, body: await req.json() };
		return new Response(
			'data: {"id":"summary","object":"chat.completion.chunk","created":0,"model":"test","choices":[{"index":0,"delta":{"content":"Summary from upstream"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
			{ headers: { "content-type": "text/event-stream" } },
		);
	};
	try {
		const result = await generateSummaryWithUsage(
			[{ role: "user", content: "summarize this", timestamp: 0 }],
			model,
			100,
			"fake-summary-key",
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			session.agent.streamFunction,
			undefined,
			undefined,
			undefined,
			"summary-session",
		);
		assert.equal(result.text, "Summary from upstream");
		assert.equal(captured.body.tools.length, 2);
		assert.match(captured.headers.get("user-agent"), /^opencode\//);
		assert.match(
			captured.headers.get("x-opencode-session"),
			/^ses_[0-9a-f]{26}$/,
		);
	} finally {
		globalThis.fetch = previous;
		session.dispose();
	}
});
test("Zen and Go compatibility reaches every upstream wire adapter", async () => {
	const registry = new ModelRegistry(
		await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsPath: null,
			allowModelNetwork: false,
		}),
	);
	const previous = globalThis.fetch;
	globalThis.fetch = async () => {
		throw new Error("Unexpected network dispatch");
	};
	try {
		for (const id of ["opencode", "opencode-go"]) {
			const original = registry.getProvider(id)!;
			registry.registerProvider({
				...original,
				...withOpenCodeCompat(original),
			});
			const apis = [...new Set(original.getModels().map((m) => m.api))];
			for (const api of apis) {
				const candidate = original.getModels().find((m) => m.api === api)!;
				let payload: any;
				const reply = await registry
					.getProvider(id)!
					.streamSimple(candidate, context, {
						apiKey: "fake-adapter-key",
						sessionId: "adapters",
						onPayload: (p) => {
							payload = p;
							throw new Error("Captured payload before network");
						},
					})
					.result();
				assert.ok(payload, `${id}/${api}: ${reply.errorMessage}`);
				const tools = payload.tools ?? payload.config?.tools;
				const names = tools?.flatMap(
					(t: any) =>
						t.functionDeclarations?.map((f: any) => f.name) ?? [
							t.function?.name ?? t.name,
						],
				);
				assert.deepEqual(names, ["bash", "read"], `${id}/${api}`);
			}
			console.log(`${id}: ${apis.join(", ")}`);
		}
	} finally {
		globalThis.fetch = previous;
	}
});

test("valid caller headers, explicit suppressions, and sufficient tools remain intact", () => {
	const tools = [
		{
			name: "read",
			description: "real read",
			parameters: { type: "object", properties: {} },
		},
		{
			name: "edit",
			description: "real edit",
			parameters: { type: "object", properties: {} },
		},
	];
	const ctx = normalizeContext({
		messages: [
			{ role: "system", content: "original", toolsAdded: tools, timestamp: 0 },
		],
	});
	let captured: any;
	const fn = (_model: any, context: any, options: any) => {
		captured = { context, options };
		return completed();
	};
	const wrapped = withOpenCodeCompat({ stream: fn, streamSimple: fn });
	for (const headers of [
		{
			"USER-AGENT": "opencode/1.18.31 custom",
			"X-OpenCode-Session": "ses_abcdef123456abcdefghijklmn",
		},
		{ "USER-AGENT": null, "X-OpenCode-Session": null },
	]) {
		wrapped.streamSimple(model as any, ctx, { headers, sessionId: "ignored" });
		assert.equal(captured.context, ctx);
		assert.deepEqual(captured.options.headers, headers);
	}
});

test("compatibility is opt-in so upstream behavior is the default", async () => {
	const previous = process.env.PI_OPENCODE_COMPAT;
	delete process.env.PI_OPENCODE_COMPAT;
	try {
		const result = await loadExtensions(
			[resolve("extensions/opencode-compat/index.ts")],
			resolve("."),
		);
		assert.deepEqual(result.errors, []);
		assert.equal(result.extensions[0].handlers.size, 0);
		assert.equal(result.runtime.pendingNativeProviderRegistrations.length, 0);
	} finally {
		process.env.PI_OPENCODE_COMPAT = previous;
	}
});
