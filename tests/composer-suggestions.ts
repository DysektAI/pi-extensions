import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import configure from "../extensions/composer-suggestions.ts";
import { getConfigSetting } from "../extensions/_shared/config-settings.ts";

test("composer suggestions use bounded exchange text and insert only into an empty editor", async () => {
	const folder = mkdtempSync(join(tmpdir(), "pi-composer-test-"));
	const previousDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = folder;
	const events = new Map<string, (event: object, ctx: ExtensionContext) => void>();
	let accept: ((ctx: ExtensionContext) => void) | undefined;
	const pi = {
		on: (event: string, handler: NonNullable<ReturnType<typeof events.get>>) => events.set(event, handler),
		registerShortcut: (_key: string, { handler }: { handler: typeof accept }) => { accept = handler; },
	} as unknown as ExtensionAPI;
	let editor = "";
	let widget: unknown;
	let output = JSON.stringify("Run the focused tests.");
	let pause: Promise<void> | undefined;
	const calls: unknown[] = [];
	const ctx = {
		mode: "tui",
		hasUI: true,
		model: {},
		ui: {
			getEditorText: () => editor,
			setEditorText: (text: string) => { editor = text; },
			setWidget: (_id: string, content: unknown) => { widget = content; },
		},
		sessionManager: {
			getBranch: () => [
				{ type: "message", message: { role: "user", content: "Earlier unrelated instruction" } },
				{ type: "message", message: { role: "user", content: "Fix it " + "x".repeat(1200) } },
				{ type: "message", message: { role: "toolResult", content: [{ type: "text", text: "private tool output" }] } },
				{ type: "message", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Fixed the bug." }] } },
			],
		},
		modelRegistry: {
			complete: async (_model: unknown, context: unknown) => {
				calls.push(context);
				await pause;
				return { stopReason: "stop", content: [{ type: "text", text: output }] };
			},
		},
	} as unknown as ExtensionContext;
	const settle = async () => {
		events.get("agent_settled")!({ aborted: false }, ctx);
		await setImmediate();
	};
	try {
		configure(pi);
		assert.ok(accept);
		await settle();
		assert.equal(calls.length, 0);
		getConfigSetting("composer-suggestions")!.set("on");
		await settle();
		assert.equal(calls.length, 1);
		const sent = JSON.stringify(calls[0]);
		assert.match(sent, /Fix it /);
		assert.match(sent, /Fixed the bug/);
		assert.doesNotMatch(sent, /private tool output|Earlier unrelated instruction|x{1000}/);
		assert.ok(widget);
		assert.equal(editor, "");
		editor = "My own draft";
		accept(ctx);
		assert.equal(editor, "My own draft");
		editor = "";
		accept(ctx);
		assert.equal(editor, "Run the focused tests.");
		assert.equal(widget, undefined);
		editor = "";
		output = JSON.stringify("/exit");
		await settle();
		assert.equal(widget, undefined);
		accept(ctx);
		assert.equal(editor, "");
		output = JSON.stringify("Run the focused tests.");
		await settle();
		assert.ok(widget);
		events.get("session_before_tree")!({}, ctx);
		assert.equal(widget, undefined);
		let release!: () => void;
		pause = new Promise<void>((resolve) => { release = resolve; });
		await settle();
		events.get("session_before_tree")!({}, ctx);
		release();
		await setImmediate();
		assert.equal(widget, undefined);
	} finally {
		events.get("session_shutdown")?.({}, ctx);
		if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousDir;
		rmSync(folder, { recursive: true, force: true });
	}
});
