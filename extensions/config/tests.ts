/**
 * Config Extension Tests
 *
 * Covers the /config model-role pickers: the TUI path reuses core's
 * ModelSelectorComponent (searchable/scrollable, same as /model) via the
 * roleModelRuntime adapter, non-TUI keeps the legacy static list, and
 * `/config <role> auto` resets without opening a picker.
 *
 * State is redirected with PI_CODING_AGENT_DIR so the real
 * ~/.pi/agent/model-roles.json is never touched.
 *
 * Run with:
 *   npx tsx --test extensions/config/tests.ts
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import configExtension, { agentListRow, parsePriority, roleModelRuntime, sharedListRow } from "./index.ts";
import { getSubagentModels, setSubagentModels } from "../_shared/subagent-models.ts";
import { getRoleValue, setRoleValue } from "../_shared/model-roles.ts";
// The TUI picker test constructs core's real ModelSelectorComponent, which
// needs @earendil-works/pi-coding-agent resolvable (at pi runtime it always
// is; for tests, symlink pi-fork's workspace into node_modules — gitignored).
// Every other test runs unconditionally.
let hasCoreComponent = false;
try {
	const core = (await import("@earendil-works/pi-coding-agent")) as Record<string, unknown>;
	hasCoreComponent = typeof core.ModelSelectorComponent === "function";
} catch {
	hasCoreComponent = false;
}

const MODELS = [
	{ provider: "opencode", id: "mimo-v2.6-flash-free", name: "MiMo Flash Free" },
	{ provider: "opencode", id: "muse-spark-1.3-contributor-free", name: "Muse Spark 1.3 Free" },
];

function makeRegistry(models = MODELS) {
	return {
		getAvailable: () => [...models],
		find: (provider: string, id: string) => models.find((m) => m.provider === provider && m.id === id),
		getError: () => undefined,
		refresh: async () => ({ aborted: false, errors: new Map() }),
		calls: { refresh: 0 },
	};
}

function makeCtx(over: Record<string, any> = {}) {
	const notifications: string[] = [];
	const selectCalls: any[] = [];
	const customCalls: any[] = [];
	const registry = makeRegistry();
	const ctx: any = {
		mode: "tui",
		hasUI: true,
		cwd: "/tmp",
		model: undefined,
		scopedModels: [],
		modelRegistry: registry,
		ui: {
			notify: (msg: any) => {
				notifications.push(String(msg));
			},
			select: async (...args: any[]) => {
				selectCalls.push(args);
				return undefined;
			},
			custom: async (...args: any[]) => {
				customCalls.push(args);
				return undefined;
			},
		},
		...over,
	};
	return { ctx, notifications, selectCalls, customCalls, registry };
}

function getHandler() {
	const commands = new Map<string, any>();
	configExtension({ registerCommand: (name: string, def: any) => commands.set(name, def) } as any);
	const cmd = commands.get("config");
	assert.ok(cmd, "registers a config command");
	return cmd.handler as (args: string, ctx: any) => Promise<void>;
}

let agentDir: string;
let prevAgentDir: string | undefined;

beforeEach(() => {
	prevAgentDir = process.env.PI_CODING_AGENT_DIR;
	agentDir = mkdtempSync(join(tmpdir(), "config-tests-"));
	process.env.PI_CODING_AGENT_DIR = agentDir;
});

afterEach(() => {
	if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
	rmSync(agentDir, { recursive: true, force: true });
});

describe("roleModelRuntime adapter", () => {
	it("maps the extension registry onto the ModelSelector surface", async () => {
		const { ctx, registry } = makeCtx();
		const runtime = roleModelRuntime(ctx);
		assert.deepEqual((runtime as any).getAvailableSnapshot(), MODELS);
		assert.equal((runtime as any).getModel("opencode", "mimo-v2.6-flash-free"), MODELS[0]);
		assert.equal((runtime as any).getModel("nope", "missing"), undefined);
		assert.equal((runtime as any).getError(), undefined);
		const res = await (runtime as any).refresh({ signal: new AbortController().signal });
		assert.equal(res.aborted, false);
		assert.ok(registry);
	});
});

describe("/config <role> auto", () => {
	it("resets without opening any picker", async () => {
		const handler = getHandler();
		setRoleValue("title", "opencode/mimo-v2.6-flash-free");
		const { ctx, notifications, selectCalls, customCalls } = makeCtx();
		await handler("title auto", ctx);
		assert.equal(getRoleValue("title"), "auto");
		assert.deepEqual(selectCalls, []);
		assert.deepEqual(customCalls, []);
		assert.ok(notifications.some((n) => n.includes("auto")));
	});
});

describe("TUI role picker", () => {
	it("builds a real ModelSelectorComponent via ui.custom", async () => {
		if (!hasCoreComponent) {
			console.log("  skip: @earendil-works/pi-coding-agent not resolvable here");
			return;
		}
		// The component styles via pi's global theme singleton (initialized by pi
		// at startup); initialize it headlessly for the test.
		const { initTheme } = (await import("@earendil-works/pi-coding-agent")) as Record<string, any>;
		initTheme();
		const handler = getHandler();
		const { ctx, customCalls } = makeCtx();
		// Don't block on the picker: resolve cancellation immediately.
		ctx.ui.custom = async (factory: any) => {
			customCalls.push(factory);
			const stubTui = { requestRender: () => {} };
			const component = await factory(stubTui, {}, {}, () => {});
			assert.ok(component && typeof component.handleInput === "function");
			assert.ok(typeof component.dispose === "function");
			component.dispose();
			return undefined;
		};
		await handler("title", ctx);
		assert.equal(customCalls.length, 1);
		// Cancelled picker leaves the role untouched.
		assert.equal(getRoleValue("title"), "auto");
	});

	it("selecting a model persists the role", async () => {
		if (!hasCoreComponent) {
			console.log("  skip: @earendil-works/pi-coding-agent not resolvable here");
			return;
		}
		const { initTheme } = (await import("@earendil-works/pi-coding-agent")) as Record<string, any>;
		initTheme();
		const handler = getHandler();
		const { ctx } = makeCtx();
		ctx.ui.custom = async (factory: any) => {
			const stubTui = { requestRender: () => {} };
			// Simulate the user picking the second model, then closing.
			const component = await factory(stubTui, {}, {}, (key: string | undefined) => {
				picked = key;
			});
			let picked: string | undefined;
			// Drive the component like /model does: arrow down then Enter
			// (raw terminal sequences: \x1b[B = down, \r = enter).
			component.handleInput("\x1b[B");
			component.handleInput("\r");
			component.dispose();
			return picked;
		};
		await handler("title", ctx);
		assert.equal(getRoleValue("title"), "opencode/muse-spark-1.3-contributor-free");
	});
});

describe("non-TUI role picker", () => {
	it("falls back to the legacy static list", async () => {
		const handler = getHandler();
		const picked = "opencode/mimo-v2.6-flash-free";
		const { ctx, notifications, selectCalls, customCalls } = makeCtx({
			mode: "rpc", // UI-capable but no custom components → legacy list
			hasUI: true,
			ui: undefined,
		});
		ctx.ui = {
			notify: (msg: any) => {
				notifications.push(String(msg));
			},
			select: async (title: string, options: string[]) => {
				selectCalls.push([title, options]);
				if (selectCalls.length === 1) {
					// Model step.
					assert.ok(options[0]?.startsWith("Auto"));
					assert.ok(options.some((o) => o.includes("mimo-v2.6-flash-free")));
					return options.find((o) => o.includes("mimo-v2.6-flash-free"));
				}
				// Thinking step: keep whatever the model step preserved.
				assert.ok(options.some((o) => o.includes("Model default")));
				return undefined;
			},
			custom: async () => {
				throw new Error("custom must not be used outside the TUI");
			},
		};
		await handler("title", ctx);
		assert.equal(selectCalls.length, 2); // model step, then thinking step
		assert.equal(customCalls.length, 0);
		assert.equal(getRoleValue("title"), picked);
	});
});

describe("/config subagents list editor", () => {
	function scriptedUi(ctx: any, script: Array<(title: string, options: string[]) => string | undefined>, inputs: string[] = []) {
		const titles: string[] = [];
		ctx.ui.select = async (title: string, options: string[]) => {
			titles.push(title);
			const step = script.shift();
			return step ? step(title, options) : undefined;
		};
		ctx.ui.input = async () => inputs.shift();
		ctx.ui.confirm = async () => true;
		ctx.mode = "rpc"; // legacy static model list, driven by select
		ctx.modelRegistry = makeRegistry(
			MODELS.map((m) => ({ ...m, reasoning: true, thinkingLevelMap: { xhigh: "xhigh", max: "max" } })) as any,
		);
		return titles;
	}
	const pick = (needle: string) => (_t: string, o: string[]) => o.find((x) => x.includes(needle));

	it("adds models in order with reasoning and an explicit priority", async () => {
		const handler = getHandler();
		const { ctx } = makeCtx();
		scriptedUi(
			ctx,
			[
				pick("+ Add model"),
				pick("muse-spark-1.3"),
				pick("xhigh"),
				pick("+ Add model"),
				pick("mimo-v2.6"),
				pick("high"),
				pick("Done"),
			],
			["1"], // second model jumps to priority 1
		);
		await handler("subagents", ctx);
		assert.deepEqual(getSubagentModels(), [
			"opencode/mimo-v2.6-flash-free:high",
			"opencode/muse-spark-1.3-contributor-free:xhigh",
		]);
	});

	it("sets a priority number for an existing entry", async () => {
		setSubagentModels(["a/one", "b/two", "c/three"]);
		const handler = getHandler();
		const { ctx } = makeCtx();
		scriptedUi(ctx, [pick("c/three"), pick("Set priority"), pick("Done")], ["1"]);
		await handler("subagents", ctx);
		assert.deepEqual(getSubagentModels(), ["c/three", "a/one", "b/two"]);
	});

	it("edits a per-agent list discovered from agent files", async () => {
		mkdirSync(join(agentDir, "agents"), { recursive: true });
		writeFileSync(join(agentDir, "agents", "plan.md"), "---\nname: plan\ndescription: d\n---\nbody\n");
		setSubagentModels(["a/one"]);
		const handler = getHandler();
		const { ctx } = makeCtx();
		scriptedUi(ctx, [pick("+ Add model"), pick("mimo-v2.6"), pick("Model default"), pick("Done")]);
		await handler("plan", ctx);
		assert.deepEqual(getSubagentModels("plan"), ["opencode/mimo-v2.6-flash-free"]);
		assert.deepEqual(getSubagentModels(), ["a/one"]);
		assert.ok(agentListRow("plan").includes("then Subagent models"));
	});

	it("parsePriority accepts only whole numbers in range", () => {
		assert.equal(parsePriority("3", 5), 3);
		assert.equal(parsePriority(" 1 ", 5), 1);
		assert.equal(parsePriority("0", 5), undefined);
		assert.equal(parsePriority("6", 5), undefined);
		assert.equal(parsePriority("2.5", 5), undefined);
		assert.equal(parsePriority("", 5), undefined);
	});

	it("shows an explicit 'none' row when nothing is configured", () => {
		assert.ok(sharedListRow().includes("none"));
	});
});
