/**
 * Notes / Ideas Box — jot thoughts without leaving pi or interrupting work.
 *
 *   /note <text>    Append a timestamped line to your notes inbox
 *   /notes          Show the inbox
 *   /notes clear    Empty it
 *
 * Notes live in ONE global file (~/.pi/agent/NOTES.md) so it's a single inbox
 * across every session/project, not scattered per-session.
 *
 * ponytail: a flat append-only markdown file. No DB, no overlay UI — add a
 * TUI panel only if a file genuinely stops being enough.
 */

import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const NOTES_PATH = join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "NOTES.md");

const stamp = () => new Date().toISOString().slice(0, 16).replace("T", " ");

export default function (pi: ExtensionAPI) {
	pi.registerCommand("note", {
		description: "Jot a quick note/idea to your inbox (usage: /note <text>)",
		handler: async (args, ctx) => {
			const text = args.trim();
			if (!text) {
				ctx.ui.notify("Usage: /note <text>", "warning");
				return;
			}
			try {
				appendFileSync(NOTES_PATH, `- [${stamp()}] ${text}\n`);
				ctx.ui.notify("Noted", "info");
			} catch (e) {
				ctx.ui.notify(`Could not write note: ${(e as Error)?.message ?? e}`, "warning");
			}
		},
	});

	pi.registerCommand("notes", {
		description: "Show your notes inbox (usage: /notes [clear])",
		getArgumentCompletions: (prefix: string) => {
			const opts = [{ value: "clear", label: "clear", description: "Empty the notes inbox" }];
			const f = opts.filter((o) => o.value.startsWith(prefix.trim().toLowerCase()));
			return f.length ? f : null;
		},
		handler: async (args, ctx) => {
			if (args.trim().toLowerCase() === "clear") {
				try {
					writeFileSync(NOTES_PATH, "");
					ctx.ui.notify("Notes cleared", "info");
				} catch (e) {
					ctx.ui.notify(`Could not clear: ${(e as Error)?.message ?? e}`, "warning");
				}
				return;
			}
			let body = "";
			try {
				body = readFileSync(NOTES_PATH, "utf8").trim();
			} catch {
				body = "";
			}
			ctx.ui.notify(body || "No notes yet. Add one with /note <text>", "info");
		},
	});
}
