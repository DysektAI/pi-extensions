/**
 * pool-guard: request feedback for ai-agent-kit key pools.
 *
 * When a pooled provider rejects a request (401/402/403/429, or quota/auth error
 * text), the pool's current key is benched so the next request — including Pi's
 * automatic retry — gets another key. The upstream `Retry-After` travels with that
 * bench (`--until`), so a quota that resets in hours is not re-probed every
 * cooldown. A key retried from exhausted.txt that succeeds is promoted back. All
 * key handling stays in `<agentDir>/bin/pool.py`; this extension never reads key
 * files. Inert when no pool wrapper is configured.
 *
 * Pi advertises a provider whose credential is a command without executing it
 * (docs/pi/UPSTREAM_NOTES.md F07 in ai-agent-kit), so an empty pool is still
 * selectable and still restorable. When a session sits on a pooled provider with
 * no usable key, the session is moved to the first usable candidate — Pi's own
 * default model first, then the session scope — and moved back is left to the
 * user, who is told once per outage.
 *
 * Reports run synchronously (a few tens of ms) so Pi's retry re-resolves the
 * credential after the bench is written.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { resolveAgentDir } from "../_shared/agent-dir.ts";
import {
	createGuard,
	discoverPools,
	parsePoolStatus,
	pickFallback,
	type FallbackCandidate,
	type Outcome,
	type PoolSnapshot,
} from "./pure.ts";

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
		report(pool: string, outcome: Outcome, reason: string, fingerprint?: string, untilSec?: number) {
			const args = [
				engine, pool, "--report", outcome,
				...(reason ? ["--reason", reason] : []),
				...(fingerprint ? ["--key", `key#${fingerprint}`] : []),
				...(untilSec ? ["--until", String(Math.ceil(untilSec))] : []),
			];
			const result = spawnSync(python, args, { encoding: "utf8", timeout: 10000, windowsHide: true });
			if ((result.error || result.status !== 0) && !warned) {
				warned = true;
				console.warn(`[pool-guard] Could not update the ${pool} pool (set POOL_PYTHON if python3 is not on PATH).`);
			}
		},
		current(pool: string) {
			try {
				const state = JSON.parse(readFileSync(join(agentDir, `${pool}-pool`, "state.json"), "utf8"));
				const fingerprint = typeof state?.current === "string" ? state.current : undefined;
				return { fingerprint, trial: state?.current_from === "exhausted" };
			} catch {
				return { trial: false };
			}
		},
		now: () => Date.now(),
	});

	/** `pool.py <pool> --status`, memoised per reachability sweep. */
	let statusCache = new Map<string, PoolSnapshot | undefined>();
	const poolStatus = (pool: string): PoolSnapshot | undefined => {
		if (statusCache.has(pool)) return statusCache.get(pool);
		const result = spawnSync(python, [engine, pool, "--status"], {
			encoding: "utf8",
			timeout: 10000,
			windowsHide: true,
		});
		const snapshot = result.status === 0 ? parsePoolStatus(result.stdout) : undefined;
		statusCache.set(pool, snapshot);
		return snapshot;
	};
	// A pool that refilled must be able to warn again next time it drains.
	const forgetPool = (pool: string) => statusCache.delete(pool);

	const candidatesFor = (ctx: ExtensionContext): FallbackCandidate[] => {
		const out: FallbackCandidate[] = [];
		const add = (provider?: string, id?: string) => {
			if (!provider || !id) return;
			if (out.some((c) => c.provider === provider && c.id === id)) return;
			out.push({ provider, id });
		};
		let settings: { defaultProvider?: string; defaultModel?: string } | undefined;
		try {
			settings = pi.getSettings();
		} catch {
			settings = undefined;
		}
		add(settings?.defaultProvider, settings?.defaultModel);
		for (const scoped of ctx.scopedModels ?? []) add(scoped.model.provider, scoped.model.id);
		for (const model of ctx.modelRegistry.getAvailable()) add(model.provider, model.id);
		return out;
	};

	const switchedFrom = new Set<string>();
	/**
	 * Move the session off a pooled provider that cannot serve a request right now.
	 * Runs after a bench, so the freshly written state is what gets read.
	 */
	const avoidUnusablePool = async (ctx: ExtensionContext, provider: string | undefined) => {
		const pool = provider ? pools.get(provider) : undefined;
		if (!pool || switchedFrom.has(pool)) return;
		forgetPool(pool);
		const snapshot = poolStatus(pool);
		if (!snapshot) return; // unknown: never move a session on a guess
		if (snapshot.usable) return;
		const target = pickFallback(provider, candidatesFor(ctx), pools, poolStatus);
		if (!target) return;
		const model = ctx.modelRegistry.find(target.provider, target.id);
		if (!model) return;
		switchedFrom.add(pool);
		if (!(await pi.setModel(model))) {
			switchedFrom.delete(pool);
			return;
		}
		const back = snapshot.nextRetryAt
			? ` (keys retry after ${new Date(snapshot.nextRetryAt).toISOString()})`
			: "";
		ctx.ui.notify(
			`${provider} pool has no usable keys${back}; switched to ${target.provider}/${target.id}.`,
			"warning",
		);
	};

	// Pi resolves the pool credential just before this event, so state.json names the key in use.
	pi.on("before_provider_request", (_event, ctx) => {
		guard.onRequest(ctx.model?.provider);
	});
	pi.on("after_provider_response", (event, ctx) => {
		guard.onResponse(ctx.model?.provider, event.status, event.headers);
	});
	// after_provider_response carries no request model, so a virtual model that routes
	// to a pooled provider is only attributed here: assistant messages record the
	// physical provider the router picked.
	pi.on("message_end", (event, ctx) => {
		const message = event.message as { role?: string; provider?: string; errorMessage?: string };
		if (message.role !== "assistant") return;
		if (message.errorMessage) {
			const provider = message.provider ?? ctx.model?.provider;
			guard.onAssistantError(provider, message.errorMessage);
			void avoidUnusablePool(ctx, provider).catch(() => {});
			return;
		}
		const pool = message.provider ? pools.get(message.provider) : undefined;
		if (pool) forgetPool(pool);
	});
	// A resumed session can already be pinned to a provider whose pool ran dry.
	pi.on("session_start", (_event, ctx) => {
		void avoidUnusablePool(ctx, ctx.model?.provider).catch(() => {});
	});
}
