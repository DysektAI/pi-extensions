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

/**
 * Upstream retry window in seconds, from response headers or provider error text.
 *
 * Headers win: `retry-after-ms`, then `retry-after` as seconds or an HTTP date. Pi
 * refuses to sleep past its own cap and reports the value it declined to wait for
 * ("Server requested 21437s retry delay (max: 60s)"), which is the fallback for a
 * provider whose reply reaches us only as error text.
 */
export function retryAfterSeconds(headers: Record<string, string> | undefined, errorText?: string): number | undefined {
	const lower = new Map<string, string>();
	for (const [name, value] of Object.entries(headers ?? {})) lower.set(name.toLowerCase(), value);
	const millis = Number.parseFloat(lower.get("retry-after-ms") ?? "");
	if (Number.isFinite(millis) && millis > 0) return millis / 1000;
	const raw = lower.get("retry-after");
	if (raw) {
		const seconds = Number.parseFloat(raw);
		if (Number.isFinite(seconds) && seconds > 0) return seconds;
		const date = Date.parse(raw);
		if (!Number.isNaN(date)) {
			const until = (date - Date.now()) / 1000;
			if (until > 0) return until;
		}
	}
	const declined = /server requested (\d+)s retry delay/i.exec(errorText ?? "");
	return declined ? Number(declined[1]) : undefined;
}

/** Pool state as reported by `pool.py <pool> --status`. */
export interface PoolSnapshot {
	/** Whether the engine would hand out a key right now. */
	usable: boolean;
	/** Epoch ms after which a benched key becomes retryable, when known. */
	nextRetryAt?: number;
}

/** Parse `--status` JSON. Unknown fields, older engines, and junk yield undefined. */
export function parsePoolStatus(raw: string): PoolSnapshot | undefined {
	let data: unknown;
	try {
		data = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (!data || typeof data !== "object") return undefined;
	const status = data as { usable?: unknown; counts?: { active?: unknown }; next_retry_at?: unknown };
	const retryAt = typeof status.next_retry_at === "number" ? status.next_retry_at * 1000 : undefined;
	if (typeof status.usable === "boolean") return { usable: status.usable, nextRetryAt: retryAt };
	// Engines before --until report counts only; an active key is still decisive.
	const active = typeof status.counts?.active === "number" ? status.counts.active : undefined;
	return active === undefined ? undefined : { usable: active > 0, nextRetryAt: retryAt };
}

export interface FallbackCandidate {
	provider: string;
	id: string;
}

/**
 * First candidate that is not the current provider and whose pool, when the
 * provider is pooled, has a usable key. Candidate order is the caller's
 * preference; an unpooled provider needs no pool check.
 */
export function pickFallback(
	currentProvider: string | undefined,
	candidates: readonly FallbackCandidate[],
	pools: Map<string, string>,
	status: (pool: string) => PoolSnapshot | undefined,
	cache = new Map<string, PoolSnapshot | undefined>(),
): FallbackCandidate | undefined {
	for (const candidate of candidates) {
		if (candidate.provider === currentProvider) continue;
		const pool = pools.get(candidate.provider);
		if (pool) {
			if (!cache.has(pool)) cache.set(pool, status(pool));
			if (!cache.get(pool)?.usable) continue;
		}
		return candidate;
	}
	return undefined;
}

export interface PoolCurrent {
	/** Fingerprint of the pool's current key (`state.json` "current"). */
	fingerprint?: string;
	/** Whether that key is under trial from exhausted.txt. */
	trial: boolean;
}

export interface GuardDeps {
	/** Run `pool.py <pool> --report <outcome> [--reason] [--key key#<fp>] [--until <s>]`. */
	report(pool: string, outcome: Outcome, reason: string, fingerprint?: string, untilSec?: number): void;
	/** Read the pool's current key fingerprint (never key text). */
	current(pool: string): PoolCurrent;
	now(): number;
}

/** Window in which one failure per pool is reported (pi retries re-pick keys). */
export const DEDUPE_MS = 3000;

export function createGuard(pools: Map<string, string>, deps: GuardDeps) {
	const lastBench = new Map<string, number>();
	// Key in use when the latest request to each pool started, so a late report
	// cannot bench a different key that was picked in the meantime.
	const inFlight = new Map<string, PoolCurrent>();
	const bench = (pool: string, reason: string, untilSec?: number) => {
		const at = deps.now();
		if (at - (lastBench.get(pool) ?? -Infinity) < DEDUPE_MS) return;
		lastBench.set(pool, at);
		deps.report(pool, "exhausted", reason, inFlight.get(pool)?.fingerprint, untilSec);
	};
	return {
		onRequest(provider: string | undefined): void {
			const pool = provider ? pools.get(provider) : undefined;
			if (pool) inFlight.set(pool, deps.current(pool));
		},
		onResponse(provider: string | undefined, status: number, headers?: Record<string, string>): void {
			const pool = provider ? pools.get(provider) : undefined;
			if (!pool) return;
			const result = outcomeForStatus(status);
			if (!result) return;
			if (result.outcome === "ok") {
				const used = inFlight.get(pool) ?? deps.current(pool);
				if (used.trial) deps.report(pool, "ok", "", used.fingerprint);
				return;
			}
			bench(pool, result.reason, retryAfterSeconds(headers));
		},
		onAssistantError(provider: string | undefined, errorText: string): void {
			const pool = provider ? pools.get(provider) : undefined;
			if (!pool || !errorText) return;
			const reason = reasonForError(errorText);
			if (reason) bench(pool, reason, retryAfterSeconds(undefined, errorText));
		},
	};
}
