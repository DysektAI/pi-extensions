/**
 * Run with: npx tsx --test extensions/tool-headers/tests.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { collapseCommand, isVscodeTerminal, rewriteCallText, shortenPath, toolHeaderLabel } from "./pure.ts";

describe("toolHeaderLabel", () => {
	it("capitalizes built-in names and keeps PowerShell casing", () => {
		assert.equal(toolHeaderLabel("bash"), "[Bash Tool]");
		assert.equal(toolHeaderLabel("powershell"), "[PowerShell Tool]");
		assert.equal(toolHeaderLabel("read"), "[Read Tool]");
		assert.equal(toolHeaderLabel("ls"), "[Ls Tool]");
	});
});

describe("collapseCommand", () => {
	it("turns heredocs and multi-line chains into one title line", () => {
		assert.equal(collapseCommand("cat <<'EOF'\n  a\n\tb\nEOF"), "cat <<'EOF' a b EOF");
		assert.equal(collapseCommand("  ls  \n"), "ls");
	});
});

describe("rewriteCallText", () => {
	const prefix = "<b>read</b> ";
	const header = "<b>[Read Tool]</b>";

	it("moves the arguments under the header", () => {
		assert.equal(rewriteCallText("<b>read</b> ~/a.ts:1-5", { prefix, header }), "<b>[Read Tool]</b>\n~/a.ts:1-5");
	});

	it("keeps everything after the first line (write/edit previews)", () => {
		const out = rewriteCallText("<b>read</b> a.ts\n\nbody line", { prefix, header });
		assert.equal(out, "<b>[Read Tool]</b>\na.ts\n\nbody line");
	});

	it("applies swaps to the first line only", () => {
		const out = rewriteCallText("<b>read</b> P\nP", { prefix, header, swaps: [["P", "Q"]] });
		assert.equal(out, "<b>[Read Tool]</b>\nQ\nP");
	});

	it("returns undefined for renderer variants it does not recognize", () => {
		assert.equal(rewriteCallText("read docs (compact)", { prefix, header }), undefined);
	});
});

describe("shortenPath / isVscodeTerminal", () => {
	it("replaces the home prefix with ~", () => {
		assert.equal(shortenPath("/home/u/x", "/home/u"), "~/x");
		assert.equal(shortenPath("/tmp/x", "/home/u"), "/tmp/x");
	});

	it("detects the VS Code integrated terminal", () => {
		assert.equal(isVscodeTerminal({ TERM_PROGRAM: "vscode" }), true);
		assert.equal(isVscodeTerminal({ TERM_PROGRAM: "WezTerm" }), false);
		assert.equal(isVscodeTerminal({}), false);
	});
});
