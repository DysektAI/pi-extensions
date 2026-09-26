/**
 * Run with: npx tsx --test extensions/path-links/tests.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { barePath, ExistsCache, escapeMarkdown, linkifyInlineCode, looksLikePath } from "./pure.ts";

const mark = (code: string) => (code.includes("/") || code.endsWith(".ts") ? `<${code}>` : undefined);

describe("linkifyInlineCode", () => {
	it("replaces recognized inline code spans", () => {
		assert.equal(linkifyInlineCode("see `src/a.ts` and `ls -la`", mark), "see <src/a.ts> and `ls -la`");
	});

	it("skips fenced code blocks, including tilde fences and longer closers", () => {
		const md = "```\n`src/a.ts`\n```\n~~~~\n`src/b.ts`\n~~~~~\n`src/c.ts`";
		assert.equal(linkifyInlineCode(md, mark), "```\n`src/a.ts`\n```\n~~~~\n`src/b.ts`\n~~~~~\n<src/c.ts>");
	});

	it("skips indented code and double-backtick spans", () => {
		assert.equal(linkifyInlineCode("    `src/a.ts`", mark), "    `src/a.ts`");
		assert.equal(linkifyInlineCode("``src/a.ts``", mark), "``src/a.ts``");
	});

	it("returns markdown without backticks unchanged", () => {
		assert.equal(linkifyInlineCode("plain text", mark), "plain text");
	});
});

describe("path heuristics", () => {
	it("strips line/column locators but not Windows drives", () => {
		assert.equal(barePath("src/a.ts:42"), "src/a.ts");
		assert.equal(barePath("src/a.ts:4:7"), "src/a.ts");
		assert.equal(barePath("src/a.ts:1-5"), "src/a.ts");
		assert.equal(barePath("src/a.ts#L9"), "src/a.ts");
		assert.equal(barePath("C:"), "C:");
	});

	it("recognizes path-like spans and rejects commands/identifiers", () => {
		for (const p of ["/etc/hosts", "~/x", "./a", "a/b", "C:\\x\\y", "\\\\srv\\share", "package.json"]) {
			assert.equal(looksLikePath(p), true, p);
		}
		for (const p of ["ls -la", "foo()", "useState", ""]) assert.equal(looksLikePath(p), false, p);
	});

	it("escapes markdown metacharacters", () => {
		assert.equal(escapeMarkdown("my_file*[x].ts"), "my\\_file\\*\\[x\\].ts");
	});
});

describe("ExistsCache", () => {
	it("caches positives and expires negatives", () => {
		let now = 0;
		const calls: string[] = [];
		let present = false;
		const cache = new ExistsCache(
			(p) => {
				calls.push(p);
				return present;
			},
			1000,
			() => now,
		);
		assert.equal(cache.has("a"), false);
		assert.equal(cache.has("a"), false);
		assert.equal(calls.length, 1);
		present = true;
		now = 1500;
		assert.equal(cache.has("a"), true);
		present = false;
		assert.equal(cache.has("a"), true);
		assert.equal(calls.length, 2);
	});
});
