/**
 * kit-status.ts
 *
 * Shows the ai-agent-kit sync status at session start, at near-zero token
 * cost. Runs `<python> <repo>/shared/scripts/kit_status.py --notice`, which
 * prints one line per drift issue — or nothing when the install is in sync or
 * its status is unknown — then surfaces any output as a Pi notification. The
 * notice is UI-only; nothing is injected into the model context.
 *
 * kit_status.py repo discovery, in order:
 *   1. $AI_AGENT_KIT_REPO
 *   2. the `repo` field of the newest install-history.jsonl entry (the state
 *      dir every kit sync appends to)
 *   3. ~/ai-agent-kit
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const KIT_STATUS_TIMEOUT_MS = 10_000;

function kitStateDir(): string {
	const override = process.env.AI_AGENT_KIT_STATE_DIR;
	if (override) return override;
	if (process.platform === "win32") {
		return join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "ai-agent-kit");
	}
	return join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "ai-agent-kit");
}

/** Newest recorded `repo` from install-history.jsonl, if any. */
function repoFromInstallHistory(): string | undefined {
	try {
		const text = readFileSync(join(kitStateDir(), "install-history.jsonl"), "utf8");
		for (const line of text.trim().split("\n").reverse()) {
			try {
				const record = JSON.parse(line) as { repo?: unknown };
				if (typeof record.repo === "string" && record.repo) return record.repo;
			} catch {
				// skip malformed lines
			}
		}
	} catch {
		// no history yet
	}
	return undefined;
}

function resolveKitStatusScript(): string | undefined {
	const candidates = [
		process.env.AI_AGENT_KIT_REPO,
		repoFromInstallHistory(),
		join(homedir(), "ai-agent-kit"),
	].filter((p): p is string => Boolean(p));
	for (const repo of candidates) {
		const script = join(repo, "shared", "scripts", "kit_status.py");
		if (existsSync(script)) return script;
	}
	return undefined;
}

/** Interpreters to try in order; the py launcher skips the Windows Store `python` stub. */
const PYTHON_CANDIDATES: ReadonlyArray<readonly [string, ...string[]]> =
	process.platform === "win32" ? [["py", "-3"], ["python"]] : [["python3"], ["python"]];

/** Output of kit_status --notice ("" on failure or timeout), or undefined when the interpreter could not start. */
function runWith(command: readonly [string, ...string[]], script: string): Promise<string | undefined> {
	return new Promise((resolve) => {
		const [file, ...prefix] = command;
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(file, [...prefix, script, "--notice"], { stdio: ["ignore", "pipe", "ignore"] });
		} catch {
			return resolve(undefined);
		}
		let out = "";
		let settled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const finish = (value: string | undefined) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(value);
		};
		timer = setTimeout(() => {
			child.kill();
			finish("");
		}, KIT_STATUS_TIMEOUT_MS);
		child.stdout?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => {
			out += chunk;
		});
		// Spawn failure (e.g. ENOENT): undefined lets the caller try the next interpreter.
		child.on("error", () => finish(undefined));
		child.on("close", (code) => finish(code === 0 ? out.trim() : ""));
	});
}

async function runKitStatus(): Promise<string> {
	const script = resolveKitStatusScript();
	if (!script) return "";
	for (const command of PYTHON_CANDIDATES) {
		const result = await runWith(command, script);
		if (result !== undefined) return result;
	}
	return "";
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (event, ctx) => {
		if (event.reason !== "startup" && event.reason !== "resume") return;
		// Headless sessions must not consume the one-time pending notice.
		if (!ctx.hasUI) return;
		const notice = await runKitStatus();
		if (notice) ctx.ui.notify(notice, "warning");
	});
}
