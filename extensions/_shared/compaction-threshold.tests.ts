/**
 * Run with: npx tsx --test extensions/_shared/compaction-threshold.tests.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { compactionThreshold, shouldResumeAfterCompaction } from "./compaction-threshold.ts";

const model = { provider: "tokenrouter", id: "some-model" };
const gpt = { provider: "freemodel", id: "gpt-5.6-sol" };

describe("compactionThreshold", () => {
	it("returns undefined without a model or any configuration", () => {
		assert.equal(compactionThreshold(undefined, {}, {}), undefined);
		assert.equal(compactionThreshold(model, {}, {}), undefined);
	});

	it("uses compaction.maxContextTokens", () => {
		assert.equal(compactionThreshold(model, { compaction: { maxContextTokens: 400000 } }, {}), 400000);
	});

	it("prefers per-model overrides, then project over global", () => {
		const global = {
			compaction: { maxContextTokens: 400000, modelOverrides: { "tokenrouter/some-model": { maxContextTokens: 150000 } } },
		};
		assert.equal(compactionThreshold(model, global, {}), 150000);
		assert.equal(compactionThreshold(model, global, { compaction: { maxContextTokens: 90000 } }), 150000);
		assert.equal(compactionThreshold(model, { compaction: { maxContextTokens: 400000 } }, { compaction: { maxContextTokens: 90000 } }), 90000);
	});

	it("keeps built-in model limits and takes the lower of built-in and configured", () => {
		assert.equal(compactionThreshold(gpt, {}, {}), 200000);
		assert.equal(compactionThreshold(gpt, { compaction: { maxContextTokens: 400000 } }, {}), 200000);
		assert.equal(compactionThreshold(gpt, { compaction: { maxContextTokens: 100000 } }, {}), 100000);
	});

	it("ignores invalid values", () => {
		assert.equal(compactionThreshold(model, { compaction: { maxContextTokens: -1 } }, {}), undefined);
		assert.equal(compactionThreshold(model, { compaction: { maxContextTokens: "big" } }, {}), undefined);
		assert.equal(compactionThreshold(model, { compaction: "x" }, {}), undefined);
	});
});

describe("shouldResumeAfterCompaction", () => {
	it("resumes after tool results or with queued messages", () => {
		assert.equal(shouldResumeAfterCompaction({ toolResults: 2, pendingMessages: false, idle: false }), true);
		assert.equal(shouldResumeAfterCompaction({ toolResults: 0, pendingMessages: true, idle: false }), true);
	});

	it("does not resume a finished text-only run or an idle agent", () => {
		assert.equal(shouldResumeAfterCompaction({ toolResults: 0, pendingMessages: false, idle: false }), false);
		assert.equal(shouldResumeAfterCompaction({ toolResults: 2, pendingMessages: true, idle: true }), false);
	});
});
