import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Editor } from "@earendil-works/pi-tui";
import configure from "../extensions/composer-suggestions.ts";
import { getConfigSetting } from "../extensions/_shared/config-settings.ts";

test("composer preserves grounded drafts, gates cache-uncertain refreshes and keeps editor keys local", async (t) => {
	const folder = mkdtempSync(join(tmpdir(), "pi-composer-test-"));
	const previousDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = folder;
	const events = new Map<string, (event: object, ctx: ExtensionContext) => void>();
	let refresh: () => Promise<void>;
	let editor = "";
	let focus: unknown = Object.create(Editor.prototype);
	let overlay = false;
	let render: ((width: number) => string[]) | undefined;
	let onKey: ((data: string) => { consume?: boolean } | undefined) | undefined;
	let confirmation = false;
	let confirmations = 0;
	let queued = false;
	let output = JSON.stringify("Run the parser regression test.");
	let cacheRead = 0;
	let cacheWrite = 0;
	let pause: Promise<void> | undefined;
	let now = 10_000_000;
	t.mock.method(Date, "now", () => now);
	const notices: string[] = [];
	const calls: { content: string; key: string; retries: number; signal: AbortSignal; headers?: Record<string, string> }[] = [];
	const model = { id: "gpt-test", provider: "openai", api: "openai-responses", baseUrl: "https://example.invalid" };
	const branch = [
		{ id: "unrelated", type: "message", message: { role: "user", content: "Old, unrelated request" } },
		{ id: "constraint", type: "message", message: { role: "user", content: "Saved sessions must still work." } },
		{ id: "decision", type: "message", message: { role: "user", content: "Use the existing parser." } },
		{ id: "user", type: "message", message: { role: "user", content: "Fix the parser." } },
		{ id: "tool", type: "message", message: { role: "toolResult", content: [{ type: "text", text: "private tool output" }] } },
		{ id: "assistant", type: "message", message: { role: "assistant", stopReason: "stop", content: "Fixed the parser. " + "x".repeat(3000) + " The regression test is still pending." } },
		{ id: "goal", type: "custom", customType: "goal-state", data: { status: "active", condition: "Ship the parser fix." } },
	];
	const saved: unknown[] = [];
	const pi = {
		on: (event: string, handler: NonNullable<ReturnType<typeof events.get>>) => events.set(event, handler),
		appendEntry: (customType: string, data: unknown) => saved.push({ type: "custom", customType, data }),
		registerCommand: (name: string, command: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) => {
			assert.equal(name, "suggest");
			refresh = () => command.handler("", ctx);
		},
	} as unknown as ExtensionAPI;
	const ctx = {
		mode: "tui",
		hasUI: true,
		model,
		isIdle: () => true,
		hasPendingMessages: () => queued,
		ui: {
			getEditorText: () => editor,
			setEditorText: (value: string) => { editor = value; },
			confirm: async () => { confirmations++; return confirmation; },
			notify: (notice: string) => notices.push(notice),
			onTerminalInput: (handler: typeof onKey) => { onKey = handler; return () => { onKey = undefined; }; },
			setWidget: (_id: string, factory?: (tui: object, theme: object) => { render: typeof render }) => {
				render = factory?.({
					getFocusedComponent: () => focus,
					hasOverlay: () => overlay,
					requestRender() {},
				}, { fg: (_color: string, label: string) => label }).render;
			},
		},
		sessionManager: {
			getBranch: () => branch,
			getEntries: () => [...branch, ...saved],
			getSessionId: () => "thread",
		},
		modelRegistry: {
			streamSimple: (_model: object, request: { messages: { content: string }[] }, options: {
				sessionId: string; maxRetries: number; signal: AbortSignal; headers?: Record<string, string>;
			}) => ({
				result: async () => {
					calls.push({ content: request.messages[0].content, key: options.sessionId, retries: options.maxRetries, signal: options.signal, headers: options.headers });
					await pause;
					return {
						stopReason: "stop", model: model.id, provider: model.provider,
						usage: { input: 300, cacheRead, cacheWrite },
						content: [{ type: "text", text: output }],
					};
				},
			}),
		},
	} as unknown as ExtensionContext;
	const emit = (event: string, data = {}) => events.get(event)!(data, ctx);
	const settle = async (expectedRequests: number) => {
		const before = calls.length;
		emit("agent_settled", { aborted: false });
		await setImmediate();
		assert.equal(calls.length - before, expectedRequests);
	};
	const widget = () => render?.(120).join("\n");
	try {
		configure(pi);
		emit("session_start");
		await settle(0);
		getConfigSetting("composer-suggestions")!.set("on");
		queued = true;
		await settle(0);
		queued = false;
		editor = "Preserve the text I just typed";
		await settle(1);
		assert.match(calls[0].content, /Saved sessions must still work\./);
		assert.match(calls[0].content, /Ship the parser fix\./);
		assert.match(calls[0].content, /Fixed the parser\./);
		assert.match(calls[0].content, /The regression test is still pending\./);
		assert.doesNotMatch(calls[0].content, /private tool output|Old, unrelated request/);
		assert.equal(JSON.parse(calls[0].content).reply.length, 2400);
		assert.equal(calls[0].retries, 0);
		assert.equal(calls[0].headers, undefined);
		assert.equal(widget(), "");
		assert.equal(onKey?.("\t"), undefined);
		assert.equal(editor, "Preserve the text I just typed");

		editor = "";
		assert.match(widget()!, /Run the parser regression test\./);
		overlay = true;
		assert.equal(onKey?.("\t"), undefined);
		overlay = false;
		focus = {};
		assert.equal(onKey?.("\x1b[C"), undefined);
		focus = Object.create(Editor.prototype);
		assert.deepEqual(onKey?.("\t"), { consume: true });
		assert.equal(editor, "Run the parser regression test.");
		assert.equal(calls.length, 1);
		editor = "";

		await refresh!();
		assert.equal(confirmations, 1);
		assert.equal(calls.length, 1);
		confirmation = true;
		cacheRead = 1024;
		output = JSON.stringify("Check that the fix works with older saved sessions.");
		await refresh!();
		assert.equal(confirmations, 2);
		assert.equal(calls.length, 2);
		assert.equal(calls[1].key, calls[0].key);
		assert.ok(calls[1].content.startsWith(calls[0].content));
		assert.match(calls[1].content, /Earlier suggestions to avoid: \["Run the parser regression test\."\]/);
		assert.match(widget()!, /2\/2/);

		assert.deepEqual(onKey?.("\x1b[1;3A"), { consume: true });
		assert.match(widget()!, /1\/2/);
		assert.deepEqual(onKey?.("\x1b[C"), { consume: true });
		assert.equal(editor, "Run the parser regression test.");
		assert.equal(calls.length, 2);
		editor = "";

		confirmation = false;
		output = JSON.stringify("RUN the parser regression test!");
		await refresh!();
		assert.equal(confirmations, 2);
		assert.equal(calls.length, 3);
		assert.equal(saved.length, 3);
		assert.match(notices.at(-1)!, /No distinct suggestion/);

		now += 120_000;
		await refresh!();
		assert.equal(confirmations, 3);
		assert.equal(calls.length, 3);

		emit("session_shutdown");
		configure(pi);
		emit("session_start");
		await settle(0);
		assert.match(widget()!, /older saved sessions/);
		assert.match(widget()!, /2\/2/);

		confirmation = true;
		let release!: () => void;
		pause = new Promise<void>((resolve) => { release = resolve; });
		const pending = refresh!();
		await setImmediate();
		emit("session_before_tree");
		assert.equal(calls.at(-1)?.signal.aborted, true);
		output = JSON.stringify("This stale draft must be ignored.");
		release();
		await pending;
		assert.equal(saved.length, 3);
		assert.equal(widget(), "");
		emit("session_tree");
		assert.match(widget()!, /2\/2/);

		for (const rejected of ["/exit", "!git status", "hello\nworld"]) {
			cacheRead = 0;
			cacheWrite = 0;
			output = JSON.stringify(rejected);
			await refresh!();
			assert.equal(saved.length, 3);
			assert.match(widget()!, /2\/2/);
		}

		model.provider = "morph";
		model.api = "openai-completions";
		emit("model_select");
		cacheWrite = 1024;
		output = JSON.stringify("Check parser behavior on Windows.");
		await refresh!();
		const morph = calls.at(-1)!;
		assert.notEqual(morph.key, calls[0].key);
		assert.deepEqual(morph.headers, { "x-session-id": morph.key });
		const previousConfirmations = confirmations;
		confirmation = false;
		await refresh!();
		assert.equal(confirmations, previousConfirmations);
		assert.equal(calls.at(-1)!.key, morph.key);
		assert.match(widget()!, /3\/3/);
	} finally {
		emit("session_shutdown");
		if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousDir;
		rmSync(folder, { recursive: true, force: true });
	}
});
