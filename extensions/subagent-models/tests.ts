/**
 * subagent-models Tests
 *
 * Covers the ordered /config subagent model lists (pure list ops, persistence,
 * per-agent resolution, legacy migration), agent-file pin stripping, and the
 * fail-fast health circuit breaker. State is redirected with
 * PI_CODING_AGENT_DIR so the real ~/.pi/agent is never touched.
 *
 * Run with:
 *   npx tsx --test extensions/subagent-models/tests.ts
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readModelRolesFile, writeModelRolesFile } from "../_shared/model-roles.ts";
import {
	cooldownMs,
	getSubagentModels,
	insertModel,
	isCoolingDown,
	listUserAgentNames,
	markModelFailure,
	markModelSuccess,
	MAX_SUBAGENT_MODELS,
	migrateLegacySubagentRoles,
	moveModel,
	normalizeModelList,
	orderByHealth,
	readModelHealth,
	removeModel,
	resolveAgentModelChain,
	setModelThinking,
	setSubagentModels,
	stripModelPins,
	stripModelPinsFromAgents,
} from "../_shared/subagent-models.ts";

const A = "opencode/muse-spark-1.3-contributor-free:xhigh";
const B = "opencode/mimo-v2.6-flash-free:high";
const C = "tokenrouter/z-ai/glm-5.3:max";
const D = "morph/morph-glm53flash";

let agentDir: string;
let prevAgentDir: string | undefined;

beforeEach(() => {
	prevAgentDir = process.env.PI_CODING_AGENT_DIR;
	agentDir = mkdtempSync(join(tmpdir(), "subagent-models-"));
	process.env.PI_CODING_AGENT_DIR = agentDir;
});

afterEach(() => {
	if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
	rmSync(agentDir, { recursive: true, force: true });
});

describe("pure list ops", () => {
	it("normalizes: drops junk and duplicate model identities, keeps first", () => {
		assert.deepEqual(normalizeModelList([A, "garbage", 42, B, "opencode/muse-spark-1.3-contributor-free:low"]), [A, B]);
		assert.deepEqual(normalizeModelList("nope"), []);
	});

	it("caps at MAX_SUBAGENT_MODELS", () => {
		const many = Array.from({ length: MAX_SUBAGENT_MODELS + 20 }, (_, i) => `p/m${i}`);
		assert.equal(normalizeModelList(many).length, MAX_SUBAGENT_MODELS);
	});

	it("insertModel appends by default and inserts at a 1-based priority", () => {
		assert.deepEqual(insertModel([A, B], C), [A, B, C]);
		assert.deepEqual(insertModel([A, B], C, 1), [C, A, B]);
		assert.deepEqual(insertModel([A, B], C, 2), [A, C, B]);
		assert.deepEqual(insertModel([A, B], C, 99), [A, B, C]);
	});

	it("insertModel replaces an existing model instead of duplicating it", () => {
		assert.deepEqual(insertModel([A, B, C], "opencode/mimo-v2.6-flash-free:low", 1), [
			"opencode/mimo-v2.6-flash-free:low",
			A,
			C,
		]);
	});

	it("moveModel reorders by 1-based positions and clamps", () => {
		assert.deepEqual(moveModel([A, B, C, D], 4, 1), [D, A, B, C]);
		assert.deepEqual(moveModel([A, B, C, D], 1, 3), [B, C, A, D]);
		assert.deepEqual(moveModel([A, B, C], 2, 50), [A, C, B]);
		assert.deepEqual(moveModel([A, B], 9, 1), [A, B]);
	});

	it("removeModel and setModelThinking", () => {
		assert.deepEqual(removeModel([A, B, C], 2), [A, C]);
		assert.deepEqual(setModelThinking([A, D], 2, "low"), [A, `${D}:low`]);
		assert.deepEqual(setModelThinking([A], 1, undefined), ["opencode/muse-spark-1.3-contributor-free"]);
	});
});

describe("persistence + resolution", () => {
	it("has no built-in defaults: empty config resolves to an empty chain", () => {
		assert.deepEqual(getSubagentModels(), []);
		assert.deepEqual(resolveAgentModelChain("plan"), []);
	});

	it("stores the shared list and preserves other keys", () => {
		writeModelRolesFile({ roles: { judge: "x/y" } });
		setSubagentModels([A, B]);
		assert.deepEqual(getSubagentModels(), [A, B]);
		assert.equal(readModelRolesFile().roles?.judge, "x/y");
	});

	it("per-agent list is tried first, then the shared list, de-duplicated", () => {
		setSubagentModels([A, B, C]);
		setSubagentModels(["tokenrouter/z-ai/glm-5.3:low", D], "plan");
		assert.deepEqual(resolveAgentModelChain("plan"), ["tokenrouter/z-ai/glm-5.3:low", D, A, B]);
		assert.deepEqual(resolveAgentModelChain("scout"), [A, B, C]);
	});

	it("clearing an agent list removes its key", () => {
		setSubagentModels([D], "plan");
		setSubagentModels([], "plan");
		assert.equal(readModelRolesFile().agentModels, undefined);
	});
});

describe("migrateLegacySubagentRoles", () => {
	it("folds subagent + fallbacks into the ordered list and drops legacy keys", () => {
		writeModelRolesFile({
			roles: { judge: "x/y", subagent: A, subagentFallback1: B, subagentFallback3: C },
		});
		assert.equal(migrateLegacySubagentRoles(), true);
		const file = readModelRolesFile();
		assert.deepEqual(file.subagentModels, [A, B, C]);
		assert.deepEqual(file.roles, { judge: "x/y" });
		assert.equal(migrateLegacySubagentRoles(), false);
	});

	it("does not overwrite an existing list", () => {
		writeModelRolesFile({ roles: { subagent: A }, subagentModels: [D] });
		migrateLegacySubagentRoles();
		assert.deepEqual(readModelRolesFile().subagentModels, [D]);
	});
});

describe("agent file pins", () => {
	const AGENT = `---
name: implement
description: Implementation agent
# Managed by /config Subagent model + fallbacks — do not hand-edit
model: tokenrouter/moonshotai/kimi-k3
fallbackModels: a/b, c/d
tools: read, bash
---

model: this line is body text and must stay
`;

	it("strips model, fallbackModels and the managed note from frontmatter only", () => {
		const { content, changed } = stripModelPins(AGENT);
		assert.equal(changed, true);
		assert.ok(!content.includes("kimi-k3"));
		assert.ok(!content.includes("fallbackModels"));
		assert.ok(!content.includes("Managed by"));
		assert.ok(content.includes("tools: read, bash"));
		assert.ok(content.includes("model: this line is body text and must stay"));
		assert.equal(stripModelPins(content).changed, false);
	});

	it("strips files in the agents dir and lists agent names", () => {
		const dir = join(agentDir, "agents");
		mkdirSync(dir);
		writeFileSync(join(dir, "implement.md"), AGENT);
		writeFileSync(join(dir, "scout.md"), "---\nname: scout\ndescription: d\n---\n");
		writeFileSync(join(dir, "notes.txt"), "x");
		assert.deepEqual(stripModelPinsFromAgents(), ["implement.md"]);
		assert.ok(!readFileSync(join(dir, "implement.md"), "utf-8").includes("model:  "));
		assert.deepEqual(listUserAgentNames(), ["implement", "scout"]);
		assert.deepEqual(stripModelPinsFromAgents(join(dir, "missing")), []);
	});
});

describe("health circuit breaker", () => {
	it("cooldown grows with consecutive failures and caps at 15m", () => {
		assert.equal(cooldownMs(1), 60_000);
		assert.equal(cooldownMs(2), 120_000);
		assert.equal(cooldownMs(10), 15 * 60_000);
	});

	it("orders healthy models first (priority kept), cooling ones last, never drops", () => {
		const now = 1_000_000;
		const health = {
			"opencode/muse-spark-1.3-contributor-free": { failedAt: now - 10_000, failures: 1 },
			"opencode/mimo-v2.6-flash-free": { failedAt: now - 5_000, failures: 3 },
			"tokenrouter/z-ai/glm-5.3": { failedAt: now - 10 * 60_000, failures: 1 }, // expired
		};
		assert.deepEqual(orderByHealth([A, B, C, D], health, now), [C, D, A, B]);
		assert.ok(!isCoolingDown(health["tokenrouter/z-ai/glm-5.3"], now));
	});

	it("records failures across calls and clears on success", () => {
		markModelFailure(A, "no response within 30s");
		markModelFailure(A, "no response within 30s");
		const h = readModelHealth()["opencode/muse-spark-1.3-contributor-free"];
		assert.equal(h?.failures, 2);
		assert.ok(isCoolingDown(h));
		markModelSuccess(A);
		assert.deepEqual(readModelHealth(), {});
	});
});
