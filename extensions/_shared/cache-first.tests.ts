/**
 * Run with: npx tsx --test extensions/_shared/cache-first.tests.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { type CacheFirstCatalog, registerCacheFirst } from "./cache-first.ts";

function catalog(overrides: Partial<CacheFirstCatalog<string>>) {
	const registered: string[][] = [];
	const saved: string[][] = [];
	const coldErrors: unknown[] = [];
	const options: CacheFirstCatalog<string> = {
		loadCache: async () => undefined,
		fetchFresh: async () => ["fresh"],
		saveCache: async (models) => { saved.push(models); },
		register: (models) => { registered.push(models); },
		onColdFailure: (error) => { coldErrors.push(error); },
		...overrides,
	};
	return { options, registered, saved, coldErrors };
}

describe("registerCacheFirst", () => {
	it("registers a cached catalog without waiting for the network", { timeout: 2000 }, async () => {
		const { options, registered } = catalog({
			loadCache: async () => ["cached"],
			fetchFresh: () => new Promise<string[]>(() => {}),
		});
		const result = await registerCacheFirst(options);
		assert.deepEqual(registered, [["cached"]]);
		assert.ok(result.refresh instanceof Promise);
	});

	it("replaces the cached catalog when the refresh differs", async () => {
		const { options, registered, saved } = catalog({ loadCache: async () => ["cached"] });
		await (await registerCacheFirst(options)).refresh;
		assert.deepEqual(registered, [["cached"], ["fresh"]]);
		assert.deepEqual(saved, [["fresh"]]);
	});

	it("does not re-register an unchanged catalog", async () => {
		const { options, registered, saved } = catalog({ loadCache: async () => ["fresh"] });
		await (await registerCacheFirst(options)).refresh;
		assert.deepEqual(registered, [["fresh"]]);
		assert.deepEqual(saved, [["fresh"]]);
	});

	it("keeps the cache and reports background failures, including an inactive API", async () => {
		const failures: unknown[] = [];
		const offline = catalog({
			loadCache: async () => ["cached"],
			fetchFresh: async () => { throw new Error("offline"); },
			onRefreshFailure: (error) => { failures.push(error); throw new Error("API no longer active"); },
		});
		await (await registerCacheFirst(offline.options)).refresh;
		assert.deepEqual(offline.registered, [["cached"]]);
		assert.deepEqual(offline.saved, []);
		assert.equal((failures[0] as Error).message, "offline");

		let calls = 0;
		const reloaded = catalog({
			loadCache: async () => ["cached"],
			register: () => { if (calls++ > 0) throw new Error("API no longer active"); },
		});
		await assert.doesNotReject(async () => (await registerCacheFirst(reloaded.options)).refresh);
	});

	it("blocks on a cold cache and falls back on failure", async () => {
		const fetched = catalog({});
		assert.deepEqual(await registerCacheFirst(fetched.options), {});
		assert.deepEqual(fetched.registered, [["fresh"]]);
		assert.deepEqual(fetched.saved, [["fresh"]]);

		const cold = catalog({ fetchFresh: async () => { throw new Error("offline"); } });
		await registerCacheFirst(cold.options);
		assert.deepEqual(cold.registered, []);
		assert.equal((cold.coldErrors[0] as Error).message, "offline");
	});
});
