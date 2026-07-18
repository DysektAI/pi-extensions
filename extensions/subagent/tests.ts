/**
 * Subagent Extension Tests
 *
 * Pure helper tests run without a live Pi environment.
 *
 * Run with:
 *   npx tsx --test extensions/subagent/tests.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
	type AgentConfig,
	type AgentSystemPromptMode,
	parseAgentFrontmatter,
} from "./pure.ts";

function makeConfig(frontmatter: Record<string, unknown>, body = ""): AgentConfig | null {
	return parseAgentFrontmatter(frontmatter, body, "project", "/tmp/test.md");
}

describe("parseAgentFrontmatter", () => {
	it("fills defaults when optional fields are omitted", () => {
		const config = makeConfig({ name: "scout", description: "A scout agent" });
		assert.equal(config?.systemPromptMode, "append");
		assert.equal(config?.inheritSkills, true);
	});

	it("requires name and description", () => {
		assert.equal(makeConfig({ name: "", description: "b" }), null);
		assert.equal(makeConfig({ name: "a", description: "" }), null);
		assert.equal(makeConfig({}), null);
	});

	it("parses systemPromptMode replace", () => {
		const config = makeConfig({ name: "a", description: "b", systemPromptMode: "replace" });
		assert.equal(config?.systemPromptMode, "replace");
	});

	it("parses systemPromptMode append", () => {
		const config = makeConfig({ name: "a", description: "b", systemPromptMode: "append" });
		assert.equal(config?.systemPromptMode, "append");
	});

	it("normalizes systemPromptMode case", () => {
		const config = makeConfig({ name: "a", description: "b", systemPromptMode: "REPLACE" });
		assert.equal(config?.systemPromptMode, "replace" as AgentSystemPromptMode);
	});

	it("rejects invalid systemPromptMode values", () => {
		const config = makeConfig({ name: "a", description: "b", systemPromptMode: "foo" });
		assert.equal(config?.systemPromptMode, "append");
	});

	it("parses inheritSkills boolean false", () => {
		const config = makeConfig({ name: "a", description: "b", inheritSkills: false });
		assert.equal(config?.inheritSkills, false);
	});

	it("parses inheritSkills string false", () => {
		const config = makeConfig({ name: "a", description: "b", inheritSkills: "false" });
		assert.equal(config?.inheritSkills, false);
	});

	it("parses inheritSkills boolean true", () => {
		const config = makeConfig({ name: "a", description: "b", inheritSkills: true });
		assert.equal(config?.inheritSkills, true);
	});

	it("parses inheritSkills string true", () => {
		const config = makeConfig({ name: "a", description: "b", inheritSkills: "true" });
		assert.equal(config?.inheritSkills, true);
	});

	it("parses tools and fallbackModels as comma-separated strings", () => {
		const config = makeConfig({
			name: "a",
			description: "b",
			tools: "read, edit , write",
			fallbackModels: "gpt-4, claude-3 ",
		});
		assert.deepEqual(config?.tools, ["read", "edit", "write"]);
		assert.deepEqual(config?.fallbackModels, ["gpt-4", "claude-3"]);
	});

	it("parses model string", () => {
		const config = makeConfig({ name: "a", description: "b", model: "gpt-4o" });
		assert.equal(config?.model, "gpt-4o");
	});

	it("uses the markdown body as systemPrompt", () => {
		const config = makeConfig({ name: "a", description: "b" }, "You are a tester.");
		assert.equal(config?.systemPrompt, "You are a tester.");
	});
});
