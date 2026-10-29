/**
 * Pure logic for pool-guard (no pi imports, unit-testable).
 *
 * pool-guard gives the ai-agent-kit key-pool engine (`<agentDir>/bin/pool.py`)
 * feedback from real requests. Providers are discovered from models.json entries
 * whose apiKey is a pool wrapper command such as
 * `!bash $HOME/.pi/agent/deepseek-pool/ds-pool`. The engine owns all key files;
 * this extension only asks it to bench or promote the pool's current key.
 */
import { join } from "node:path";

export type Outcome = "ok" | "exhausted" | "dead";

/** Error text meaning the key's quota/subscription is used up or rate limited. */
export const QUOTA_PATTERNS: readonly RegExp[] = [
	/\b1310\b/, // Z.AI weekly/monthly limit exhausted
	/limit exhausted/i,
	/\b2056\b/, // MiniMax drained window
	/insufficient_quota/i,
	/insufficient (balance|credits)/i,
	/rate[ _-]?limit/i,
	/RESOURCE_EXHAUSTED/i,
	/resource has been exhausted/i,
	/quota exceeded/i,
	/exceeded your current quota/i,
	/out of budget/i,
	/usage limit reached/i,
	/\b(Free|Go)UsageLimitError\b/,
];

/** Error text meaning the key itself was rejected. */
export const AUTH_PATTERNS: readonly RegExp[] = [
	/invalid api key/i,
	/invalid_api_key/i,
	/invalid credential/i,
	/api[ _]?key (is )?not valid/i,
	/API_KEY_INVALID/,
	/unauthorized/i,
	/authentication (failed|error)/i,
	/incorrect api key/i,
];

const POOL_COMMAND = /^!bash\s+(?:"([^"]+)"|(\S+))/;

/** Map provider id -> pool name (`<name>-pool`) for kit pool-engine wrappers. */
export function discoverPools(models: unknown, agentDir: string, exists: (path: string) => boolean): Map<string, string> {
	const pools = new Map<string, string>();
	if (!exists(join(agentDir, "bin", "pool.py"))) return pools;
	const providers = (models as { providers?: Record<string, { apiKey?: unknown }> } | undefined)?.providers ?? {};
	for (const [id, config] of Object.entries(providers)) {
		const command = typeof config?.apiKey === "string" ? config.apiKey.match(POOL_COMMAND) : null;
		const script = (command?.[1] ?? command?.[2])?.replace(/\\/g, "/");
		const dir = script?.match(/\/([a-z0-9-]+)-pool\/[^/]+$/i)?.[1];
		if (dir && exists(join(agentDir, `${dir}-pool`))) pools.set(id, dir);
	}
	return pools;
}

/** Map an HTTP status to a bench outcome, if it means anything for the key. */
export function outcomeForStatus(status: number): { outcome: Outcome; reason: string } | undefined {
	if (status === 402 || status === 429) return { outcome: "exhausted", reason: `http ${status}` };
	// Gateways also answer 401/403 for upstream trouble: bench for re-probe, not dead.
	if (status === 401 || status === 403) return { outcome: "exhausted", reason: `http ${status} auth` };
	if (status >= 200 && status < 300) return { outcome: "ok", reason: "" };
	return undefined;
}

/** Classify assistant error text that arrived without a decisive HTTP status. */
export function reasonForError(text: string): string | undefined {
	if (QUOTA_PATTERNS.some((re) => re.test(text))) return "quota error";
	if (AUTH_PATTERNS.some((re) => re.test(text))) return "auth error";
	return undefined;
}

export interface GuardDeps {
	/** Run `pool.py <pool> --report <outcome> [--reason <reason>]`. */
	report(pool: string, outcome: Outcome, reason: string): void;
	/** Whether the pool's current key is under trial from exhausted.txt. */
	currentIsTrial(pool: string): boolean;
	now(): number;
}

/** Window in which one failure per pool is reported (pi retries re-pick keys). */
export const DEDUPE_MS = 3000;

export function createGuard(pools: Map<string, string>, deps: GuardDeps) {
	const lastBench = new Map<string, number>();
	const bench = (pool: string, reason: string) => {
		const at = deps.now();
		if (at - (lastBench.get(pool) ?? -Infinity) < DEDUPE_MS) return;
		lastBench.set(pool, at);
		deps.report(pool, "exhausted", reason);
	};
	return {
		onResponse(provider: string | undefined, status: number): void {
			const pool = provider ? pools.get(provider) : undefined;
			if (!pool) return;
			const result = outcomeForStatus(status);
			if (!result) return;
			if (result.outcome === "ok") {
				if (deps.currentIsTrial(pool)) deps.report(pool, "ok", "");
				return;
			}
			bench(pool, result.reason);
		},
		onAssistantError(provider: string | undefined, errorText: string): void {
			const pool = provider ? pools.get(provider) : undefined;
			if (!pool || !errorText) return;
			const reason = reasonForError(errorText);
			if (reason) bench(pool, reason);
		},
	};
}
