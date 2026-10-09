import assert from "node:assert/strict";
import { chmod, mkdtemp, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { extractModels, morphProvider, toPiModel } from "./provider.ts";

const known = { id: "morph-kimik3" };

test("catalog validation rejects malformed entries in live and cached shapes", () => {
	for (const entries of [[null], [{ id: "" }], [{ id: "  " }], [{ id: 3 }], [known, null], [{ ...known, name: {} }]]) {
		assert.deepEqual(extractModels(entries), []);
		assert.deepEqual(extractModels({ data: entries }), []);
	}
	assert.deepEqual(extractModels([known]), [known]);
	assert.deepEqual(extractModels({ data: [known] }), [known]);
	assert.deepEqual(extractModels({ data: "bad" }), []);
});

test("only known chat models register, with priced usage and Kimi image input", () => {
	for (const id of ["unknown-paid", "toString", "__proto__", "auto", "morph-v3-fast", "morph-v3-large", "morph-compactor", "morph-warp-grep-v2.1"]) {
		assert.equal(toPiModel({ id }), undefined);
	}
	for (const id of ["morph-kimik3", "morph-kimik3-fast"]) {
		const model = toPiModel({ id });
		assert.deepEqual(model?.input, ["text", "image"]);
		assert.ok(model!.cost.input > 0);
		assert.ok(model!.cost.output > 0);
		assert.equal(model?.compat.maxTokensField, "max_tokens");
	}
});

// Real cache/auth files; only HTTP is mocked. No live credentials or requests.
test("provider discovery, credential rejection and outage fallback", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "morph-test-"));
	const cache = join(dir, ".cache", "morph-models.json");
	const originalFetch = globalThis.fetch;
	const originalWarn = console.warn;
	const originalKey = process.env.MORPH_API_KEY;
	let registrations: any[] = [];
	const warnings: string[] = [];
	const pi = {
		registerProvider: (name: string, config: unknown) => registrations.push({ name, config }),
		unregisterProvider: (name: string) => { registrations = registrations.filter((r) => r.name !== name); },
	};
	const start = () => morphProvider(pi as Parameters<typeof morphProvider>[0], dir);
	const run = async () => {
		const result = await start();
		await result.refresh;
		return result;
	};
	console.warn = (message) => warnings.push(String(message));
	process.env.MORPH_API_KEY = "test-env-key";
	try {
		await writeFile(join(dir, "auth.json"), JSON.stringify({ morph: { type: "api_key", key: "test-auth-key" } }));
		await t.test("live catalog uses auth key and filters unknown and specialized models", async () => {
			globalThis.fetch = async (_url, options) => {
				assert.equal((options?.headers as Record<string, string>).Authorization, "Bearer test-auth-key");
				return new Response(JSON.stringify({ data: [known, { id: "unknown-paid" }, { id: "morph-v3-fast" }] }));
			};
			await run();
			assert.equal(registrations[0].name, "morph");
			assert.equal(registrations[0].config.apiKey, "test-auth-key");
			assert.deepEqual(registrations[0].config.models.map((m: any) => m.id), [known.id]);
		});
		await t.test("fresh cache and directory are private without changing catalog contents", async () => {
			assert.deepEqual(JSON.parse(await readFile(cache, "utf8")), [known, { id: "unknown-paid" }, { id: "morph-v3-fast" }]);
			if (process.platform !== "win32") {
				assert.equal((await stat(cache)).mode & 0o777, 0o600);
				assert.equal((await stat(join(dir, ".cache"))).mode & 0o777, 0o700);
			}
		});
		await t.test("existing readable cache is tightened and refreshed", async () => {
			await writeFile(cache, JSON.stringify([{ id: "old-model" }]));
			if (process.platform !== "win32") {
				await chmod(cache, 0o644);
				assert.equal((await stat(cache)).mode & 0o777, 0o644);
			}
			globalThis.fetch = async () => new Response(JSON.stringify({ data: [known] }));
			await run();
			assert.deepEqual(JSON.parse(await readFile(cache, "utf8")), [known]);
			if (process.platform !== "win32") assert.equal((await stat(cache)).mode & 0o777, 0o600);
		});
		await t.test("Windows cache branch creates and replaces content without POSIX chmod", async (windowsTest) => {
			const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
			const probe = await open(cache, "r");
			const handlePrototype = Object.getPrototypeOf(probe);
			await probe.close();
			const chmodMock = windowsTest.mock.method(handlePrototype, "chmod", async () => {
				throw Object.assign(new Error("Windows writable-handle reopen fails"), { code: "EBUSY" });
			});
			try {
				Object.defineProperty(process, "platform", { ...platform, value: "win32" });
				await rm(cache);
				await run();
				assert.deepEqual(JSON.parse(await readFile(cache, "utf8")), [known]);
				await writeFile(cache, JSON.stringify([{ id: "old-model-with-longer-content" }]));
				await run();
				assert.deepEqual(JSON.parse(await readFile(cache, "utf8")), [known]);
			} finally {
				Object.defineProperty(process, "platform", platform);
				chmodMock.mock.restore();
			}
		});
		for (const status of [401, 403]) {
			await t.test(`HTTP ${status} withdraws cached models once the refresh is rejected`, { timeout: 2000 }, async () => {
				registrations = [];
				await writeFile(cache, JSON.stringify([known]));
				let release!: () => void;
				const gate = new Promise<void>((resolve) => { release = resolve; });
				globalThis.fetch = async () => { await gate; return new Response("rejected", { status }); };
				const { refresh } = await start();
				assert.equal(registrations.length, 1, "the cached catalog registers without waiting for the network");
				release();
				await refresh;
				assert.deepEqual(registrations, []);
				assert.match(warnings.at(-1)!, /Authentication failed/);
			});
			await t.test(`HTTP ${status} without a cache registers no curated models`, async () => {
				registrations = [];
				await rm(cache);
				globalThis.fetch = async () => new Response("rejected", { status });
				await run();
				assert.deepEqual(registrations, []);
				assert.match(warnings.at(-1)!, /Authentication failed/);
				await writeFile(cache, JSON.stringify([known]));
			});
		}
		await t.test("outage uses validated cache", async () => {
			registrations = [];
			globalThis.fetch = async () => { throw new TypeError("offline"); };
			await run();
			assert.deepEqual(registrations[0].config.models.map((m: any) => m.id), [known.id]);
			assert.match(warnings.at(-1)!, /Catalog refresh failed \(offline\); keeping cached models/);
		});
		await t.test("malformed live payload does not overwrite valid cache", async () => {
			registrations = [];
			globalThis.fetch = async () => new Response(JSON.stringify({ data: [null] }));
			await run();
			assert.deepEqual(JSON.parse(await readFile(cache, "utf8")), [known]);
			assert.equal(registrations[0].config.models[0].id, known.id);
		});
		await t.test("malformed live and cached catalogs use curated fallback", async () => {
			registrations = [];
			await writeFile(cache, "[null]");
			await run();
			assert.equal(registrations[0].config.models.length, 5);
			assert.ok(registrations[0].config.models.every((m: any) => m.cost.input > 0));
		});
		for (const unsupported of [[{ id: "unknown-paid" }], [{ id: "morph-v3-fast" }, { id: "morph-compactor" }]]) {
			await t.test("live unsupported-only catalog does not advertise absent models", async () => {
				registrations = [];
				globalThis.fetch = async () => new Response(JSON.stringify({ data: unsupported }));
				await run();
				assert.deepEqual(registrations, []);
			});
			await t.test("cached unsupported-only catalog during outage does not advertise absent models", async () => {
				registrations = [];
				globalThis.fetch = async () => { throw new TypeError("offline"); };
				await run();
				assert.deepEqual(registrations, []);
			});
			await t.test("rejected credentials cannot enable curated models with unsupported cache", async () => {
				registrations = [];
				globalThis.fetch = async () => new Response("denied", { status: 401 });
				await run();
				assert.deepEqual(registrations, []);
			});
		}
		for (const payload of [[], { data: [] }]) {
			await t.test("valid empty live and cached catalogs are authoritative", async () => {
				registrations = [];
				globalThis.fetch = async () => new Response(JSON.stringify(payload));
				await run();
				assert.deepEqual(registrations, []);
				assert.deepEqual(JSON.parse(await readFile(cache, "utf8")), []);
				globalThis.fetch = async () => { throw new TypeError("offline"); };
				await run();
				assert.deepEqual(registrations, []);
			});
		}
		await t.test("malformed payload shape without a valid cache uses curated fallback", async () => {
			registrations = [];
			await rm(cache);
			globalThis.fetch = async () => new Response(JSON.stringify({ data: "invalid" }));
			await run();
			assert.equal(registrations[0].config.models.length, 5);
		});
		await t.test("no credentials skips discovery", async () => {
			registrations = [];
			delete process.env.MORPH_API_KEY;
			await rm(join(dir, "auth.json"));
			let calls = 0;
			globalThis.fetch = async () => { calls++; return new Response("[]"); };
			await run();
			assert.equal(calls, 0);
			assert.deepEqual(registrations, []);
		});
	} finally {
		globalThis.fetch = originalFetch;
		console.warn = originalWarn;
		if (originalKey === undefined) delete process.env.MORPH_API_KEY;
		else process.env.MORPH_API_KEY = originalKey;
		await rm(dir, { recursive: true, force: true });
	}
});
