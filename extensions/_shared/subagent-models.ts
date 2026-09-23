/**
 * Subagent model chains — the ONLY source of models for the subagent tool.
 *
 * Stored in ~/.pi/agent/model-roles.json next to the helper roles:
 *
 *   "subagentModels": ["opencode/muse-spark-1.3-contributor-free:xhigh", "opencode/mimo-v2.6-flash-free:high"],
 *   "agentModels":    { "plan": ["tokenrouter/z-ai/glm-5.3:max"] }
 *
 * - `subagentModels` is an ordered list: index 0 is priority 1, the model every
 *   subagent tries first; later entries are fallbacks tried in order.
 * - `agentModels[<agent>]` is an optional ordered list for one agent (plan,
 *   scout, ...). When set, that agent tries its own list first, then the shared
 *   `subagentModels` list (duplicates skipped).
 * - There are no built-in defaults. An empty chain is an error surfaced to the
 *   user ("configure models in /config"), never a silent pick.
 *
 * Each entry is "provider/id" with an optional ":level" reasoning suffix — the
 * same vocabulary as `pi --model`.
 *
 * Model health (fail-fast circuit breaker) also lives here so the subagent tool
 * can skip models that failed moments ago instead of re-waiting on them for
 * every spawn.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	configDir,
	formatModelKey,
	formatRoleKey,
	parseRoleKey,
	readModelRolesFile,
	type RoleThinking,
	userAgentsDir,
	writeModelRolesFile,
} from "./model-roles.ts";

/** Upper bound on entries per list. */
export const MAX_SUBAGENT_MODELS = 100;

/** Allowed fail-fast timeouts (seconds) for the /config cycle setting. */
export const FAIL_FAST_TIMEOUT_CHOICES = [10, 15, 20, 30, 45, 60, 90, 120] as const;
export const DEFAULT_FAIL_FAST_TIMEOUT_SEC = 30;

// ---------------------------------------------------------------------------
// List normalisation + persistence
// ---------------------------------------------------------------------------

/** Model identity without the reasoning suffix ("provider/id"). */
export function modelBase(key: string): string | undefined {
	const ref = parseRoleKey(key);
	return ref ? formatModelKey(ref) : undefined;
}

/** Drop malformed entries and duplicates (by model identity), cap length. */
export function normalizeModelList(list: unknown): string[] {
	if (!Array.isArray(list)) return [];
	const out: string[] = [];
	const seen = new Set<string>();
	for (const raw of list) {
		if (typeof raw !== "string") continue;
		const ref = parseRoleKey(raw);
		if (!ref) continue;
		const base = formatModelKey(ref);
		if (seen.has(base)) continue;
		seen.add(base);
		out.push(formatRoleKey(ref));
		if (out.length >= MAX_SUBAGENT_MODELS) break;
	}
	return out;
}

/** Ordered list for `agent`, or the shared list when agent is undefined. */
export function getSubagentModels(agent?: string): string[] {
	const file = readModelRolesFile();
	if (agent === undefined) return normalizeModelList(file.subagentModels);
	return normalizeModelList(file.agentModels?.[agent]);
}

/** Replace the list for `agent` (or the shared list). Returns the stored list. */
export function setSubagentModels(list: string[], agent?: string): string[] {
	const file = readModelRolesFile();
	const normalized = normalizeModelList(list);
	if (agent === undefined) {
		file.subagentModels = normalized;
	} else {
		const agentModels = { ...(file.agentModels ?? {}) };
		if (normalized.length > 0) agentModels[agent] = normalized;
		else delete agentModels[agent];
		file.agentModels = agentModels;
		if (Object.keys(agentModels).length === 0) delete file.agentModels;
	}
	writeModelRolesFile(file);
	return normalized;
}

/**
 * Pure: insert `key` at 1-based `priority` (default: last). If the same model
 * (ignoring reasoning level) is already present it is moved/replaced instead
 * of duplicated.
 */
export function insertModel(list: string[], key: string, priority?: number): string[] {
	const ref = parseRoleKey(key);
	if (!ref) return [...list];
	const base = formatModelKey(ref);
	const rest = list.filter((k) => modelBase(k) !== base);
	const index = clampIndex(priority === undefined ? rest.length + 1 : priority, rest.length + 1);
	rest.splice(index, 0, formatRoleKey(ref));
	return rest.slice(0, MAX_SUBAGENT_MODELS);
}

/** Pure: move the entry at 1-based `from` to 1-based `to`. */
export function moveModel(list: string[], from: number, to: number): string[] {
	if (from < 1 || from > list.length) return [...list];
	const out = [...list];
	const [item] = out.splice(from - 1, 1);
	out.splice(clampIndex(to, out.length + 1), 0, item!);
	return out;
}

/** Pure: remove the entry at 1-based `position`. */
export function removeModel(list: string[], position: number): string[] {
	if (position < 1 || position > list.length) return [...list];
	return list.filter((_, i) => i !== position - 1);
}

/** Pure: set (or clear) the reasoning level of the entry at 1-based `position`. */
export function setModelThinking(list: string[], position: number, thinking: RoleThinking | undefined): string[] {
	const ref = parseRoleKey(list[position - 1]);
	if (!ref) return [...list];
	const out = [...list];
	out[position - 1] = formatRoleKey({ provider: ref.provider, id: ref.id, thinking });
	return out;
}

/** 1-based priority → 0-based splice index within [0, size-1]. */
function clampIndex(priority: number, size: number): number {
	const p = Number.isFinite(priority) ? Math.trunc(priority) : size;
	return Math.min(Math.max(p, 1), size) - 1;
}

/** "1. provider/id (level) → 2. ..." one-line summary, truncated after `max`. */
export function formatModelList(list: string[], max = 3): string {
	if (list.length === 0) return "none";
	const shown = list.slice(0, max).map((k, i) => `${i + 1}. ${formatEntry(k)}`);
	const more = list.length > max ? ` (+${list.length - max} more)` : "";
	return `${shown.join(" → ")}${more}`;
}

/** "provider/id (level|default)". */
export function formatEntry(key: string): string {
	const ref = parseRoleKey(key);
	if (!ref) return key;
	return `${formatModelKey(ref)} (${ref.thinking ?? "default"})`;
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * The full ordered chain for `agentName`: its own list first (if any), then the
 * shared list, de-duplicated by model identity (first occurrence wins, so an
 * agent-specific reasoning level beats the shared one). Empty = unconfigured.
 */
export function resolveAgentModelChain(agentName: string): string[] {
	const file = readModelRolesFile();
	const own = normalizeModelList(file.agentModels?.[agentName]);
	const shared = normalizeModelList(file.subagentModels);
	return normalizeModelList([...own, ...shared]);
}

export function getFailFastTimeoutSec(): number {
	const v = readModelRolesFile().subagentOptions?.failFastTimeoutSec;
	return typeof v === "number" && v > 0 ? v : DEFAULT_FAIL_FAST_TIMEOUT_SEC;
}

export function setFailFastTimeoutSec(sec: number): void {
	const file = readModelRolesFile();
	file.subagentOptions = { ...(file.subagentOptions ?? {}), failFastTimeoutSec: sec };
	writeModelRolesFile(file);
}

/** Names of user agent definitions (~/.pi/agent/agents/*.md with a name:). */
export function listUserAgentNames(dir: string = userAgentsDir()): string[] {
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return [];
	}
	const names: string[] = [];
	for (const entry of entries.sort()) {
		if (!entry.endsWith(".md")) continue;
		try {
			const content = readFileSync(join(dir, entry), "utf-8");
			const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content)?.[1];
			const name = fm && /^name\s*:\s*(.+)$/m.exec(fm)?.[1]?.trim();
			if (name && !names.includes(name)) names.push(name);
		} catch {
			/* unreadable file — skip */
		}
	}
	return names;
}

// ---------------------------------------------------------------------------
// Migration from the old single-select roles + frontmatter pins
// ---------------------------------------------------------------------------

const LEGACY_ROLE_KEYS = ["subagent", "subagentFallback1", "subagentFallback2", "subagentFallback3"] as const;

/**
 * One-time: fold legacy roles.subagent / subagentFallback1..3 into
 * subagentModels (when that list is not already set) and drop the legacy keys.
 * Returns true when the file changed.
 */
export function migrateLegacySubagentRoles(): boolean {
	const file = readModelRolesFile();
	const roles = { ...(file.roles ?? {}) };
	const legacy = LEGACY_ROLE_KEYS.map((k) => roles[k]).filter((v): v is string => typeof v === "string");
	const hasLegacyKeys = LEGACY_ROLE_KEYS.some((k) => k in roles);
	if (!hasLegacyKeys) return false;
	if (!Array.isArray(file.subagentModels) || file.subagentModels.length === 0) {
		file.subagentModels = normalizeModelList(legacy);
	}
	for (const k of LEGACY_ROLE_KEYS) delete roles[k];
	file.roles = roles;
	writeModelRolesFile(file);
	return true;
}

const MANAGED_NOTE_RE = /^# Managed by \/config Subagent model.*$/;
const MODEL_PIN_RE = /^(model|fallbackModels)\s*:/;

/**
 * Pure: remove `model:` / `fallbackModels:` (and the old managed-by note) from
 * an agent file's frontmatter. The subagent tool ignores them, so leaving them
 * in place would only mislead whoever reads the file.
 */
export function stripModelPins(content: string): { content: string; changed: boolean } {
	const lines = content.split("\n");
	if (lines[0]?.trim() !== "---") return { content, changed: false };
	const end = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
	if (end < 0) return { content, changed: false };
	const head = lines.slice(1, end);
	const kept = head.filter((l) => !MODEL_PIN_RE.test(l) && !MANAGED_NOTE_RE.test(l));
	if (kept.length === head.length) return { content, changed: false };
	return { content: [lines[0]!, ...kept, ...lines.slice(end)].join("\n"), changed: true };
}

/** Strip model pins from every user agent file. Never throws. */
export function stripModelPinsFromAgents(dir: string = userAgentsDir()): string[] {
	const updated: string[] = [];
	let entries: string[] = [];
	try {
		entries = readdirSync(dir);
	} catch {
		return updated;
	}
	for (const entry of entries) {
		if (!entry.endsWith(".md")) continue;
		const file = join(dir, entry);
		try {
			const { content, changed } = stripModelPins(readFileSync(file, "utf-8"));
			if (changed) {
				writeFileSync(file, content);
				updated.push(entry);
			}
		} catch {
			/* skip */
		}
	}
	return updated;
}

// ---------------------------------------------------------------------------
// Model health — cross-process circuit breaker for fail-fast fallback
// ---------------------------------------------------------------------------

export interface ModelHealthEntry {
	/** Epoch ms of the most recent failure. */
	failedAt: number;
	/** Consecutive failures (reset on success). */
	failures: number;
	reason?: string;
}

export type ModelHealth = Record<string, ModelHealthEntry>;

export function healthFilePath(): string {
	return join(configDir(), ".cache", "subagent-model-health.json");
}

export function readModelHealth(): ModelHealth {
	const path = healthFilePath();
	if (!existsSync(path)) return {};
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8"));
		return parsed && typeof parsed === "object" ? (parsed as ModelHealth) : {};
	} catch {
		return {};
	}
}

function writeModelHealth(health: ModelHealth): void {
	try {
		const path = healthFilePath();
		mkdirSync(dirname(path), { recursive: true });
		const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
		writeFileSync(tmp, `${JSON.stringify(health, null, 2)}\n`);
		renameSync(tmp, path);
	} catch {
		/* health is advisory; never break a spawn over it */
	}
}

/** Cooldown after `failures` consecutive failures: 1m, 2m, 4m, ... capped at 15m. */
export function cooldownMs(failures: number): number {
	const n = Math.max(1, failures);
	return Math.min(15 * 60_000, 60_000 * 2 ** (n - 1));
}

export function isCoolingDown(entry: ModelHealthEntry | undefined, now = Date.now()): boolean {
	return !!entry && now - entry.failedAt < cooldownMs(entry.failures);
}

/**
 * Pure: reorder a chain so models not in cooldown keep their priority order at
 * the front, and models in cooldown go to the back (soonest-to-recover first).
 * Nothing is dropped — if every model is cooling down they are all still tried.
 */
export function orderByHealth(chain: string[], health: ModelHealth, now = Date.now()): string[] {
	const healthy: string[] = [];
	const cooling: { key: string; readyAt: number }[] = [];
	for (const key of chain) {
		const entry = health[modelBase(key) ?? key];
		if (isCoolingDown(entry, now)) cooling.push({ key, readyAt: entry!.failedAt + cooldownMs(entry!.failures) });
		else healthy.push(key);
	}
	cooling.sort((a, b) => a.readyAt - b.readyAt);
	return [...healthy, ...cooling.map((c) => c.key)];
}

export function markModelFailure(key: string, reason: string, now = Date.now()): void {
	const base = modelBase(key) ?? key;
	const health = readModelHealth();
	const prev = health[base];
	health[base] = { failedAt: now, failures: (prev?.failures ?? 0) + 1, reason: reason.slice(0, 300) };
	writeModelHealth(health);
}

export function markModelSuccess(key: string): void {
	const base = modelBase(key) ?? key;
	const health = readModelHealth();
	if (!(base in health)) return;
	delete health[base];
	writeModelHealth(health);
}
