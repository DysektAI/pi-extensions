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

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import lockfile from "proper-lockfile";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const SETTINGS_PATH = join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "settings.json");

function readSettings(): Record<string, unknown> {
	let text: string;
	try {
		text = readFileSync(SETTINGS_PATH, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw error;
	}
	const settings: unknown = JSON.parse(text.replace(/^\uFEFF/, ""));
	if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
		throw new Error("Settings must be a JSON object");
	}
	return settings as Record<string, unknown>;
}

async function setEnabled(on: boolean): Promise<boolean> {
	let release: (() => Promise<void>) | undefined;
	try {
		mkdirSync(dirname(SETTINGS_PATH), { recursive: true });
		// Stock 1.4.0 FileSettingsStorage uses proper-lockfile with realpath:false
		// (src/core/settings-manager.ts:206-250). Its class is not a public export;
		// share the same settings.json.lock directory and default stale/update times.
		// Acquire BEFORE reading even when settings.json does not yet exist.
		release = await lockfile.lock(SETTINGS_PATH, {
			realpath: false, retries: { retries: 10, minTimeout: 20, maxTimeout: 100 },
		});
		const settings = readSettings();
		settings.autoUpdateExtensions = on;
		writeFileSync(SETTINGS_PATH, `${JSON.stringify(settings, null, 2)}\n`);
		return true;
	} catch {
		return false;
	} finally {
		try { await release?.(); } catch { return false; }
	}
}

async function runUpdate(pi: ExtensionAPI, ctx: any, signal?: AbortSignal) {
	try {
		const res = await pi.exec("pi", ["update", "--extensions"], { signal, timeout: 120_000 });
		// Never echo subprocess output/errors: git/npm can include credentials.
		const terminationSignal = (res as typeof res & { signal?: string | null }).signal;
		if (res.code !== 0 || res.killed || terminationSignal || signal?.aborted) {
			ctx?.ui?.notify?.("Auto-update failed — process unsuccessful or interrupted; packages may be partially updated", "warning");
			return;
		}
		const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
		const changed = /updat|install|pull|→/i.test(out) && !/already up.?to.?date|nothing to update/i.test(out);
		ctx?.ui?.notify?.(
			changed ? "Extensions updated — restart pi to load the new code" : "Extensions already up to date",
			changed ? "info" : "info",
		);
	} catch {
		ctx?.ui?.notify?.("Auto-update failed — process could not complete", "warning");
	}
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (event: any, ctx: any) => {
		// Startup only — not every /new, /resume, or /reload.
		if (event?.reason !== "startup") return;
		try {
			if (readSettings().autoUpdateExtensions !== true) return;
		} catch {
			ctx.ui.notify("Auto-update skipped — settings.json is unreadable or malformed", "warning");
			return;
		}
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
				const ok = await setEnabled(arg === "on");
				ctx.ui.notify(
					ok
						? `Auto-update ${arg === "on" ? "enabled" : "disabled"} (takes effect next startup)`
						: "Could not update settings.json — unreadable, malformed, or locked",
					ok ? "info" : "warning",
				);
				return;
			}
			ctx.ui.notify("Running pi update --extensions…", "info");
			await runUpdate(pi, ctx, ctx?.signal);
		},
	});
}
