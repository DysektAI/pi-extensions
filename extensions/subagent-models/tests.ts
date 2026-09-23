/**
 * subagent-models Extension Tests
 *
 * Covers the /config subagent chain (primary + ordered fallbacks) and the
 * agents/*.md frontmatter sync. Pure logic + temp-dir I/O only.
 *
 * Run with:
 *   npx tsx --test extensions/subagent-models/tests.ts
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	applyChainToFrontmatter,
	applySubagentChainToAgents,
	resolveSubagentChain,
} from "../_shared/model-roles.ts";

const CHAIN = [
	"opencode/muse-spark-1.3-contributor-free",
	"opencode/mimo-v2.6-flash-free",
	"tokenrouter/deepseek/deepseek-v4.1-flash",
];

const AGENT = `---
name: implement
description: Implementation agent
tools: read, bash
model: tokenrouter/moonshotai/kimi-k3
fallbackModels: dysektlb/fw/kimi-k3
---

You are an implementer.
`;

describe("resolveSubagentChain", () => {
	it("returns a non-empty chain of provider/id strings", () => {
		const chain = resolveSubagentChain();
		assert.ok(chain.length >= 1);
		for (const key of chain) {
			assert.match(key, /^[^/]+\/.+/);
		}
	});

	it("has no duplicates", () => {
		const chain = resolveSubagentChain();
		assert.equal(new Set(chain).size, chain.length);
	});
});

describe("applyChainToFrontmatter", () => {
	it("replaces expensive pins with the chain", () => {
		const { content, changed } = applyChainToFrontmatter(AGENT, CHAIN);
		assert.equal(changed, true);
		assert.ok(content.includes(`model: ${CHAIN[0]}`));
		assert.ok(content.includes(`fallbackModels: ${CHAIN.slice(1).join(", ")}`));
		assert.ok(!content.includes("kimi-k3"));
		assert.ok(content.includes("Managed by /config"));
	});

	it("is idempotent", () => {
		const once = applyChainToFrontmatter(AGENT, CHAIN).content;
		const twice = applyChainToFrontmatter(once, CHAIN);
		assert.equal(twice.changed, false);
		assert.equal(twice.content, once);
	});

	it("adds model lines when missing", () => {
		const bare = `---\nname: scout\ndescription: Fast recon\ntools: read\n---\n\nBody.\n`;
		const { content, changed } = applyChainToFrontmatter(bare, CHAIN);
		assert.equal(changed, true);
		assert.ok(content.includes(`model: ${CHAIN[0]}`));
		assert.ok(content.includes("fallbackModels:"));
	});

	it("removes fallbackModels when the chain has no fallbacks", () => {
		const { content, changed } = applyChainToFrontmatter(AGENT, [CHAIN[0]!]);
		assert.equal(changed, true);
		assert.ok(content.includes(`model: ${CHAIN[0]}`));
		assert.ok(!content.includes("fallbackModels:"));
	});

	it("leaves non-agent files untouched", () => {
		for (const bad of ["no frontmatter here", "---\nno name key\n---\nbody"]) {
			const res = applyChainToFrontmatter(bad, CHAIN);
			assert.equal(res.changed, false);
			assert.equal(res.content, bad);
		}
	});

	it("leaves body text alone", () => {
		const { content } = applyChainToFrontmatter(AGENT, CHAIN);
		assert.ok(content.endsWith("You are an implementer.\n"));
	});
});

describe("applySubagentChainToAgents", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "subagent-models-"));
		writeFileSync(join(dir, "implement.md"), AGENT);
		writeFileSync(join(dir, "notes.txt"), "not an agent");
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("rewrites pins in dir and reports updated files", () => {
		const chain = resolveSubagentChain();
		const { updated, skipped } = applySubagentChainToAgents(dir);
		assert.deepEqual(updated, ["implement.md"]);
		assert.deepEqual(skipped, []);
		const after = readFileSync(join(dir, "implement.md"), "utf-8");
		assert.ok(after.includes(`model: ${chain[0]}`));
	});

	it("is a no-op on second run", () => {
		applySubagentChainToAgents(dir);
		const second = applySubagentChainToAgents(dir);
		assert.deepEqual(second.updated, []);
	});

	it("handles a missing dir without throwing", () => {
		const res = applySubagentChainToAgents(join(dir, "does-not-exist"));
		assert.deepEqual(res.updated, []);
	});
});
