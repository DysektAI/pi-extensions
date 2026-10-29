/**
 * pool-guard: request feedback for ai-agent-kit key pools.
 *
 * When a pooled provider rejects a request (401/402/403/429, or quota/auth error
 * text), the pool's current key is benched so the next request — including Pi's
 * automatic retry — gets another key. A key retried from exhausted.txt that
 * succeeds is promoted back. All key handling stays in `<agentDir>/bin/pool.py`;
 * this extension never reads key files. Inert when no pool wrapper is configured.
 *
 * Reports run synchronously (a few tens of ms) so Pi's retry re-resolves the
 * credential after the bench is written.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { resolveAgentDir } from "../_shared/agent-dir.ts";
import { createGuard, discoverPools, type Outcome } from "./pure.ts";

export default function poolGuard(pi: ExtensionAPI): void {
	const agentDir = resolveAgentDir();
	let models: unknown;
	try {
		models = JSON.parse(readFileSync(join(agentDir, "models.json"), "utf8").replace(/^\uFEFF/, ""));
	} catch {
		return;
	}
	const pools = discoverPools(models, agentDir, existsSync);
	if (pools.size === 0) return;

	const engine = join(agentDir, "bin", "pool.py");
	const python = process.env.POOL_PYTHON || "python3";
	let warned = false;
	const guard = createGuard(pools, {
		report(pool: string, outcome: Outcome, reason: string) {
			const args = [engine, pool, "--report", outcome, ...(reason ? ["--reason", reason] : [])];
			const result = spawnSync(python, args, { encoding: "utf8", timeout: 10000, windowsHide: true });
			if ((result.error || result.status !== 0) && !warned) {
				warned = true;
				console.warn(`[pool-guard] Could not update the ${pool} pool (set POOL_PYTHON if python3 is not on PATH).`);
			}
		},
		currentIsTrial(pool: string): boolean {
			try {
				const state = JSON.parse(readFileSync(join(agentDir, `${pool}-pool`, "state.json"), "utf8"));
				return state?.current_from === "exhausted";
			} catch {
				return false;
			}
		},
		now: () => Date.now(),
	});

	pi.on("after_provider_response", (event, ctx) => {
		guard.onResponse(ctx.model?.provider, event.status);
	});
	pi.on("message_end", (event, ctx) => {
		const message = event.message as { role?: string; errorMessage?: string };
		if (message.role === "assistant" && message.errorMessage) {
			guard.onAssistantError(ctx.model?.provider, message.errorMessage);
		}
	});
}
