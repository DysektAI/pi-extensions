/**
 * Run with: npx tsx --test extensions/synthetic/tests.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { extractModels, parsePrice, thinkingLevelMap, toPiModel } from "./pure.ts";

describe("synthetic catalog", () => {
	it("converts per-token price strings to per-million numbers", () => {
		assert.equal(parsePrice("$0.0000009"), 0.9);
		assert.equal(parsePrice(0.000002), 2);
		assert.equal(parsePrice(undefined), 0);
		assert.equal(parsePrice("n/a"), 0);
	});

	it("maps reasoning efforts to thinking levels", () => {
		assert.deepEqual(thinkingLevelMap(["low", "HIGH"]), {
			off: null,
			minimal: null,
			low: "low",
			medium: null,
			high: "high",
			xhigh: null,
			max: null,
		});
		assert.equal(thinkingLevelMap(["none"])?.off, "none");
		assert.equal(thinkingLevelMap([]), undefined);
	});

	it("keeps only tool-capable models and fills defaults", () => {
		assert.equal(toPiModel({ id: "x", supported_features: [] }), undefined);
		const model = toPiModel({ id: "hf:a/b", supported_features: ["tools", "reasoning"], input_modalities: ["image"] });
		assert.equal(model?.name, "hf:a/b");
		assert.equal(model?.reasoning, true);
		assert.deepEqual(model?.input, ["text", "image"]);
		assert.equal(model?.contextWindow, 128000);
		assert.equal(model?.maxTokens, 65536);
		assert.equal("thinkingLevelMap" in (model ?? {}), false);
	});

	it("extracts the data array defensively", () => {
		assert.deepEqual(extractModels({ data: [{ id: "a" }] }), [{ id: "a" }]);
		assert.deepEqual(extractModels(null), []);
		assert.deepEqual(extractModels({ data: "x" }), []);
	});
});
