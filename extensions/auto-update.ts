/**
 * Auto-Update Extensions — apply pi package updates automatically on startup.
 *
 * OFF by default. Pi packages run with full system access, so silently pulling
 * third-party extension code is a supply-chain risk. Opt in explicitly:
 *
 *   ~/.pi/agent/settings.json  →  { "autoUpdateExtensions": true }
 *
 * Commands:
 *   /auto-update         Run `pi update --extensions` now
 *   /auto-update on|off  Toggle the startup behavior (persists to settings.json)
 *
 * Updates only take effect after the NEXT restart (already-loaded extension
 * code stays in memory for this session).
 */

import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const SETTINGS_PATH = join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "settings.json");

function readSettings(): Record<string, any> {
	try {
		return JSON.parse(readFileSync(SETTINGS_PATH, "utf8"));
	} catch {
		return {};
	}
}

function setEnabled(on: boolean): boolean {
	try {
		const s = readSettings();
		s.autoUpdateExtensions = on;
		// ponytail: re-serialize whole file. Fine for a settings blob this size.
		writeFileSync(SETTINGS_PATH, `${JSON.stringify(s, null, 2)}\n`);
		return true;
	} catch {
		return false;
	}
}

async function runUpdate(pi: ExtensionAPI, ctx: any, signal?: AbortSignal) {
	try {
		const res = await pi.exec("pi", ["update", "--extensions"], { signal, timeout: 120_000 });
		const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
		const changed = /updat|install|pull|→/i.test(out) && !/already up.?to.?date|nothing to update/i.test(out);
		ctx?.ui?.notify?.(
			changed ? "Extensions updated — restart pi to load the new code" : "Extensions already up to date",
			changed ? "info" : "info",
		);
	} catch (e) {
		ctx?.ui?.notify?.(`Auto-update failed: ${(e as Error)?.message ?? e}`, "warning");
	}
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (event: any, ctx: any) => {
		// Startup only — not every /new, /resume, or /reload.
		if (event?.reason !== "startup") return;
		if (readSettings().autoUpdateExtensions !== true) return;
		// Background: don't block the editor on npm/git.
		void runUpdate(pi, ctx, ctx?.signal);
	});

	pi.registerCommand("auto-update", {
		description: "Run/toggle automatic extension updates (usage: /auto-update [on|off])",
		getArgumentCompletions: (prefix: string) => {
			const opts = [
				{ value: "on", label: "on", description: "Enable auto-update on startup" },
				{ value: "off", label: "off", description: "Disable auto-update on startup" },
			];
			const f = opts.filter((o) => o.value.startsWith(prefix.trim().toLowerCase()));
			return f.length ? f : null;
		},
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			if (arg === "on" || arg === "off") {
				const ok = setEnabled(arg === "on");
				ctx.ui.notify(
					ok
						? `Auto-update ${arg === "on" ? "enabled" : "disabled"} (takes effect next startup)`
						: "Could not write settings.json",
					ok ? "info" : "warning",
				);
				return;
			}
			ctx.ui.notify("Running pi update --extensions…", "info");
			await runUpdate(pi, ctx, ctx?.signal);
		},
	});
}
