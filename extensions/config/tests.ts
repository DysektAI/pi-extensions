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
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import configExtension, { agentListRow, exportConfig, parsePriority, roleModelRuntime, sharedListRow } from "./index.ts";
import { getSubagentModels, setSubagentModels } from "../_shared/subagent-models.ts";
import { getRoleValue, readModelRolesFile, setRoleValue } from "../_shared/model-roles.ts";
import { registerConfigSetting } from "../_shared/config-settings.ts";
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

const shortcuts = new Map<string, any>();

function getHandler() {
	shortcuts.clear();
	const commands = new Map<string, any>();
	configExtension({
		registerCommand: (name: string, def: any) => commands.set(name, def),
		registerShortcut: (key: string, def: any) => shortcuts.set(key, def),
	} as any);
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

describe("/config export and import", () => {
	const settingsFile = () => join(agentDir, "settings.json");
	const readJson = (path: string) => JSON.parse(readFileSync(path, "utf-8"));
	let toggle = "on";
	let unregister: () => void = () => {};

	beforeEach(() => {
		toggle = "on";
		unregister = registerConfigSetting({
			id: "portable-test",
			label: "Portable test",
			values: ["on", "off"],
			get: () => toggle,
			set: (v: string) => { toggle = v; },
		} as any);
	});

	afterEach(() => unregister());

	async function exported(): Promise<string> {
		let copied = "";
		await exportConfig(makeCtx().ctx, async (text) => { copied = text; });
		return copied;
	}

	it("exports model choices and never secrets", async () => {
		setSubagentModels(["opencode/mimo-v2.6-flash-free:high"]);
		writeFileSync(settingsFile(), JSON.stringify({
			defaultModel: "mimo",
			enabledModels: ["opencode/*"],
			modelThinkingLevels: { "opencode/mimo": "high" },
			apiKey: "sk-secret",
			providers: { x: { apiKey: "sk-secret" } },
		}));
		const text = await exported();
		assert.ok(!text.includes("sk-secret"));
		const data = JSON.parse(text);
		assert.deepEqual(data.modelRoles.subagentModels, ["opencode/mimo-v2.6-flash-free:high"]);
		assert.deepEqual(data.settings.enabledModels, ["opencode/*"]);
		assert.equal(data.extensionSettings["portable-test"], "on");
	});

	it("is registered as /config export and the alt+e shortcut", async () => {
		const handler = getHandler();
		assert.ok(shortcuts.get("alt+e"));
		const { ctx, notifications } = makeCtx();
		await handler("export", ctx);
		assert.ok(notifications.some((n) => /Pi config copied|"piConfig": 1/.test(n)), notifications.join("\n"));
	});

	it("imports into another machine, keeping its keys and other settings", async () => {
		setSubagentModels(["opencode/mimo-v2.6-flash-free:high"]);
		writeFileSync(settingsFile(), JSON.stringify({ enabledModels: ["opencode/*"], defaultThinkingLevel: "high" }));
		toggle = "off";
		const text = await exported();

		setSubagentModels([]);
		toggle = "on";
		writeFileSync(settingsFile(), JSON.stringify({ apiKey: "local-key", theme: "dark" }));
		let reloaded = 0;
		const { ctx } = makeCtx({ reload: async () => { reloaded++; } });
		ctx.ui.editor = async () => text;
		await getHandler()("import", ctx);

		assert.deepEqual(getSubagentModels(), ["opencode/mimo-v2.6-flash-free:high"]);
		assert.deepEqual(readJson(settingsFile()), {
			apiKey: "local-key",
			theme: "dark",
			enabledModels: ["opencode/*"],
			defaultThinkingLevel: "high",
		});
		assert.equal(toggle, "off");
		assert.equal(reloaded, 1);
	});

	it("rejects invalid pastes without changing anything", async () => {
		setSubagentModels(["opencode/mimo-v2.6-flash-free:high"]);
		writeFileSync(settingsFile(), JSON.stringify({ theme: "dark" }));
		const before = JSON.stringify(readModelRolesFile());
		const pastes = [
			"not json",
			JSON.stringify({ modelRoles: {} }),
			JSON.stringify({ piConfig: 1, settings: { apiKey: "sk-secret" } }),
			JSON.stringify({ piConfig: 1, settings: { enabledModels: "opencode/*" } }),
			JSON.stringify({ piConfig: 1, modelRoles: { subagentModels: 42 } }),
			JSON.stringify({ piConfig: 1, modelRoles: { agentModels: { plan: "a/b" } } }),
			JSON.stringify({ piConfig: 1, modelRoles: { subagentOptions: { failFastTimeoutSec: "9" } } }),
			JSON.stringify({ piConfig: 1, modelRoles: { secrets: {} } }),
			JSON.stringify({ piConfig: 1, modelRoles: { subagentModels: ["garbage"] } }),
			JSON.stringify({ piConfig: 1, modelRoles: { agentModels: { plan: ["garbage"] } } }),
			JSON.stringify({ piConfig: 1, modelRoles: { roles: { recap: "garbage" } } }),
		];
		for (const paste of pastes) {
			const { ctx, notifications } = makeCtx({ reload: async () => assert.fail("must not reload") });
			ctx.ui.editor = async () => paste;
			await getHandler()("import", ctx);
			assert.ok(notifications.some((n) => n.startsWith("Import failed")), paste);
		}
		assert.equal(JSON.stringify(readModelRolesFile()), before);
		assert.deepEqual(readJson(settingsFile()), { theme: "dark" });

		const valid = await exported();
		setSubagentModels([]);
		writeFileSync(settingsFile(), "{corrupt");
		const { ctx, notifications } = makeCtx({ reload: async () => assert.fail("must not reload") });
		ctx.ui.editor = async () => valid;
		await getHandler()("import", ctx);
		assert.ok(notifications.some((n) => n.startsWith("Import failed")));
		assert.deepEqual(getSubagentModels(), []);
	});

	it("replaces portable choices as a snapshot, clearing ones the export lacks", async () => {
		setSubagentModels(["opencode/mimo-v2.6-flash-free:high"]);
		writeFileSync(settingsFile(), JSON.stringify({ enabledModels: ["opencode/*"] }));
		const text = await exported();

		writeFileSync(join(agentDir, "model-roles.json"), JSON.stringify({ agentModels: { plan: ["x/y"] }, custom: 1 }));
		writeFileSync(settingsFile(), JSON.stringify({ defaultModel: "local", theme: "dark" }));
		const { ctx } = makeCtx({ reload: async () => {} });
		ctx.ui.editor = async () => text;
		await getHandler()("import", ctx);

		const roles = readModelRolesFile() as any;
		assert.equal(roles.custom, 1);
		assert.equal(roles.agentModels, undefined);
		assert.deepEqual(roles.subagentModels, ["opencode/mimo-v2.6-flash-free:high"]);
		assert.deepEqual(readJson(settingsFile()), { theme: "dark", enabledModels: ["opencode/*"] });
	});

	it("restores model roles when settings.json cannot be written", async () => {
		setSubagentModels(["opencode/mimo-v2.6-flash-free:high"]);
		const text = await exported();
		setSubagentModels([]);
		const rolesBefore = readFileSync(join(agentDir, "model-roles.json"), "utf-8");
		writeFileSync(settingsFile(), JSON.stringify({ theme: "dark" }));
		mkdirSync(`${settingsFile()}.${process.pid}.tmp`);
		const { ctx, notifications } = makeCtx({ reload: async () => assert.fail("must not reload") });
		ctx.ui.editor = async () => text;
		await getHandler()("import", ctx);
		rmSync(`${settingsFile()}.${process.pid}.tmp`, { recursive: true });

		assert.ok(notifications.some((n) => n.startsWith("Import failed")));
		assert.equal(readFileSync(join(agentDir, "model-roles.json"), "utf-8"), rolesBefore);
		assert.deepEqual(readJson(settingsFile()), { theme: "dark" });
	});

	it("rolls back files and settings when an extension setter throws", async () => {
		const unregisterBad = registerConfigSetting({
			id: "portable-bad",
			label: "Portable zz broken",
			values: ["on", "off"],
			get: () => "on",
			set: (v: string) => { if (v === "off") throw new Error("setter broke"); },
		} as any);
		try {
			setSubagentModels(["opencode/mimo-v2.6-flash-free:high"]);
			const text = (await exported()).replace(/": "on"/g, '": "off"');
			setSubagentModels([]);
			const rolesBefore = readFileSync(join(agentDir, "model-roles.json"), "utf-8");
			writeFileSync(settingsFile(), JSON.stringify({ theme: "dark" }));
			const { ctx, notifications } = makeCtx({ reload: async () => assert.fail("must not reload") });
			ctx.ui.editor = async () => text;
			await getHandler()("import", ctx);

			assert.ok(notifications.some((n) => n.includes("setter broke")));
			assert.equal(readFileSync(join(agentDir, "model-roles.json"), "utf-8"), rolesBefore);
			assert.deepEqual(readJson(settingsFile()), { theme: "dark" });
			assert.equal(toggle, "on");
		} finally {
			unregisterBad();
		}
	});

	it("keeps the settings.json file mode", async (t) => {
		if (process.platform === "win32") return t.skip("POSIX modes only");
		const text = await exported();
		writeFileSync(settingsFile(), JSON.stringify({ theme: "dark" }));
		chmodSync(settingsFile(), 0o600);
		const { ctx } = makeCtx({ reload: async () => {} });
		ctx.ui.editor = async () => text;
		await getHandler()("import", ctx);
		assert.equal(statSync(settingsFile()).mode & 0o777, 0o600);
	});

	it("exports only registered settings whose value is one of their choices", async () => {
		toggle = "sk-secret";
		const data = JSON.parse(await exported());
		assert.equal(data.extensionSettings["portable-test"], undefined);
	});

	it("reports an unreadable settings file instead of throwing from the hotkey", async () => {
		writeFileSync(settingsFile(), "{corrupt");
		const { ctx, notifications } = makeCtx();
		await shortcuts.get("alt+e").handler(ctx);
		assert.ok(notifications.some((n) => n.startsWith("Export failed")));
	});
});
