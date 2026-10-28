/**
 * Pi's agent-directory resolution without importing the SDK at runtime
 * (the SDK needs Node 22+ APIs such as fs.globSync; unit tests run on Node 20).
 *
 * Mirrors stock v1.4.0 `getAgentDir()` (packages/coding-agent/src/config.ts):
 * a non-empty PI_CODING_AGENT_DIR wins, with `~`, `~/` (and `~\` on Windows)
 * expanded against the home directory; otherwise `~/.pi/agent`.
 */
import { homedir } from "node:os";
import { join } from "node:path";

export function resolveAgentDir(env: NodeJS.ProcessEnv = process.env): string {
	const configured = env.PI_CODING_AGENT_DIR;
	if (!configured) return join(homedir(), ".pi", "agent");
	if (configured === "~") return homedir();
	if (configured.startsWith("~/") || (process.platform === "win32" && configured.startsWith("~\\"))) {
		return join(homedir(), configured.slice(2));
	}
	return configured;
}
