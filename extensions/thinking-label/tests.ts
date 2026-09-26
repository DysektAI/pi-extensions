/**
 * Run with: npx tsx --test extensions/thinking-label/tests.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { LABEL_CLOSE, LABEL_OPEN, labelThinking } from "./pure.ts";

const plain = (text: string) => text;

describe("labelThinking", () => {
	it("puts the label on its own line above the thinking text", () => {
		assert.equal(labelThinking("Reasoning.", plain), `${LABEL_OPEN}[Thinking]${LABEL_CLOSE}\nReasoning.`);
	});

	it("uses the combined italic-off/bold SGR so chalk cannot re-open italic", () => {
		const out = labelThinking("x", plain);
		assert.ok(out.startsWith("\x1b[23;1m"));
		assert.ok(!out.includes("\x1b[23m"));
	});

	it("separates indented code with a blank line so it stays a code block", () => {
		assert.ok(labelThinking("    code", plain).includes(`${LABEL_CLOSE}\n\n    code`));
		assert.ok(labelThinking("\tcode", plain).includes(`${LABEL_CLOSE}\n\n\tcode`));
	});

	it("applies the colour function to the label text only", () => {
		const out = labelThinking("body", (text) => `<${text}>`);
		assert.ok(out.includes("<[Thinking]>"));
		assert.ok(out.endsWith("\nbody"));
	});

	it("leaves empty thinking alone", () => {
		assert.equal(labelThinking("  ", plain), "  ");
	});
});
