/**
 * Shared model-role configuration.
 *
 * A "role" is a named slot for a helper model used by extensions, separate from
 * the main chat model you pick with /model. Roles let cheap/background work
 * (session recaps, auto titles, the goal judge) target whichever
 * model you prefer, without hardcoding provider/model IDs in each extension.
 *
 * Configuration lives in ~/.pi/agent/model-roles.json:
 *
 *   {
 *     "roles": {
 *       "recap":    "google-aistudio/gemini-flash-lite-latest",
 *       "title":    "google-aistudio/gemini-flash-lite-latest",
 *       "judge":    "anthropic/claude-opus-4-5"
 *     },
 *     "subagentModels": ["provider/id:level", ...],      // priority order
 *     "agentModels": { "plan": ["provider/id:level"] }  // optional per agent
 *   }
 *
 * Subagent model lists live in ./subagent-models.ts and have NO built-in
 * defaults: subagents only ever run on models the user put in /config.
 *
 * Each value is a single "provider/id" string, or "auto" / unset to fall back
 * to the role's built-in default candidates and ultimately ctx.model.
 *
 * Edit it interactively with /config (no file editing needed). This module is
 * the single source of truth that both the extensions and the /config command
 * read and write.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type ModelRole = "recap" | "title" | "judge";

/** A provider/id pair, e.g. { provider: "google-aistudio", id: "gemini-flash-lite-latest" }. */
export interface ModelRef {
	provider: string;
	id: string;
}

export interface RoleSpec {
	role: ModelRole;
	/** Short label shown in the /config menu. */
	label: string;
	/** One-line description of what the role drives. */
	description: string;
	/**
	 * Ordered fallback candidates tried when the role is unset/"auto" or when the
	 * configured model is unavailable. ctx.model is always the final backstop and
	 * is appended by callers, not here.
	 */
	defaults: ModelRef[];
}

/** Canonical role definitions. The /config menu is generated from this list. */
export const ROLE_SPECS: RoleSpec[] = [
	{
		role: "recap",
		label: "Recap model",
		description: "Generates the one-line session recap footer",
		defaults: [
			{ provider: "google-aistudio", id: "gemini-flash-lite-latest" },
			{ provider: "google-aistudio", id: "gemini-2.5-flash-lite" },
		],
	},
	{
		role: "title",
		label: "Title model",
		description: "Names sessions for /resume and the session selector",
		defaults: [
			{ provider: "google-aistudio", id: "gemini-flash-lite-latest" },
			{ provider: "google-aistudio", id: "gemini-2.5-flash-lite" },
		],
	},
	{
		role: "judge",
		label: "Goal judge model",
		description: "Evaluates work quality in the goal loop (stronger model)",
		defaults: [
			{ provider: "anthropic", id: "claude-opus-4-5" },
			{ provider: "anthropic", id: "claude-sonnet-4-5" },
			{ provider: "openai", id: "gpt-4o" },
		],
	},
];

const AUTO = "auto";

function agentDir(): string {
	return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

export function rolesConfigPath(): string {
	return join(agentDir(), "model-roles.json");
}

/** Full model-roles.json shape (roles + subagent model lists). */
export interface RolesFile {
	/** Role values; may still contain legacy subagent* keys until migrated. */
	roles?: Partial<Record<ModelRole, string>> & Record<string, string | undefined>;
	/** Ordered subagent model chain (index 0 = priority 1). */
	subagentModels?: string[];
	/** Optional per-agent ordered chains, tried before subagentModels. */
	agentModels?: Record<string, string[]>;
	/** Fail-fast tuning for subagent spawns. */
	subagentOptions?: { failFastTimeoutSec?: number };
}

/** Read the whole model-roles.json (empty object when missing/corrupt). */
export function readModelRolesFile(): RolesFile {
	return readRolesFile();
}

/** Atomically replace model-roles.json with `next`. */
export function writeModelRolesFile(next: RolesFile): void {
	const path = rolesConfigPath();
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
	renameSync(tmp, path);
}

function readRolesFile(): RolesFile {
	const path = rolesConfigPath();
	if (!existsSync(path)) return {};
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as RolesFile;
		return parsed && typeof parsed === "object" ? parsed : {};
	} catch {
		// Corrupt/unreadable config should never break extensions; treat as empty.
		return {};
	}
}

/** Valid thinking/reasoning levels for a `:level` role suffix (same vocabulary as pi CLI --model/--thinking). */
export const ROLE_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type RoleThinking = (typeof ROLE_THINKING_LEVELS)[number];

/** A parsed role value: model identity plus an optional thinking-level override. */
export interface RoleRef extends ModelRef {
	thinking?: RoleThinking;
}

export function isRoleThinking(value: string | undefined): value is RoleThinking {
	return !!value && (ROLE_THINKING_LEVELS as readonly string[]).includes(value);
}

/**
 * Parse a role value ("provider/id" or "provider/id:level") into a RoleRef.
 * The `:level` suffix is only split off when it is a valid thinking level —
 * model ids that legitimately contain colons (e.g. openrouter "...:free")
 * are left intact. Returns undefined for "auto"/empty/malformed.
 */
export function parseRoleKey(value: string | undefined): RoleRef | undefined {
	const base = parseModelKey(value);
	if (!base) return undefined;
	const colon = base.id.lastIndexOf(":");
	if (colon > 0) {
		const suffix = base.id.slice(colon + 1);
		if (isRoleThinking(suffix)) {
			return { provider: base.provider, id: base.id.slice(0, colon), thinking: suffix };
		}
	}
	return base;
}

/** Format a RoleRef back to its stored string form. */
export function formatRoleKey(ref: RoleRef): string {
	return ref.thinking ? `${ref.provider}/${ref.id}:${ref.thinking}` : `${ref.provider}/${ref.id}`;
}

/** Menu display for a role: "auto", or "provider/id (level|default)". */
export function getRoleDisplay(role: ModelRole): string {
	const ref = parseRoleKey(getRoleValue(role));
	if (!ref) return AUTO;
	return `${formatModelKey(ref)} (${ref.thinking ?? "default"})`;
}

/** The configured thinking level for a role (undefined = model default). */
export function resolveRoleThinking(role: ModelRole): RoleThinking | undefined {
	return parseRoleKey(getRoleValue(role))?.thinking;
}

/**
 * Request options applying a role's thinking level to pi-ai complete/stream
 * calls (OpenAI-family providers honor `reasoningEffort`). Returns {} when
 * the role has no level set or is "off" — omission means provider default.
 */
export function roleThinkingOption(role: ModelRole): { reasoningEffort: RoleThinking } | Record<string, never> {
	const thinking = resolveRoleThinking(role);
	if (!thinking || thinking === "off") return {};
	return { reasoningEffort: thinking };
}

/**
 * Parse a "provider/id" string into a ModelRef. Returns undefined for "auto"/empty/malformed.
 * NOTE: role values may carry a `:level` thinking suffix — use parseRoleKey
 * for those; this intentionally keeps any suffix inside `id`.
 */
export function parseModelKey(value: string | undefined): ModelRef | undefined {
	if (!value) return undefined;
	const trimmed = value.trim();
	if (!trimmed || trimmed.toLowerCase() === AUTO) return undefined;
	const slash = trimmed.indexOf("/");
	if (slash <= 0 || slash === trimmed.length - 1) return undefined;
	// Provider is everything before the first slash; id keeps any remaining slashes
	// (some model ids contain "/", e.g. "accounts/fireworks/models/...").
	return { provider: trimmed.slice(0, slash), id: trimmed.slice(slash + 1) };
}

export function formatModelKey(ref: ModelRef): string {
	return `${ref.provider}/${ref.id}`;
}

/** Get the raw configured value for a role ("auto" when unset). */
export function getRoleValue(role: ModelRole): string {
	return readRolesFile().roles?.[role] ?? AUTO;
}

/**
 * Set a role's model identity, preserving any configured thinking level.
 * Use pick-then-thinking flow in UI callers to revalidate the level.
 */
export function setRoleModel(role: ModelRole, provider: string, id: string): void {
	const prev = parseRoleKey(getRoleValue(role));
	setRoleValue(role, prev?.thinking ? `${provider}/${id}:${prev.thinking}` : `${provider}/${id}`);
}

/**
 * Set (or clear with undefined) a role's thinking level. No-op when the role
 * has no model set — there is nothing to attach the level to.
 */
export function setRoleThinking(role: ModelRole, thinking: RoleThinking | undefined): void {
	const ref = parseRoleKey(getRoleValue(role));
	if (!ref) return;
	setRoleValue(role, thinking ? `${formatModelKey(ref)}:${thinking}` : formatModelKey(ref));
}
/**
 * Ordered candidate ModelRefs for a role: the configured model first (if any),
 * then the role's defaults. Callers append ctx.model as the
 * guaranteed-authed final backstop and de-duplicate.
 */
export function resolveRoleCandidates(role: ModelRole): ModelRef[] {
	const spec = ROLE_SPECS.find((s) => s.role === role);
	const defaults = spec ? spec.defaults : [];
	// Strip any `:level` thinking suffix — candidates are model identity only;
	// the level travels separately via resolveRoleThinking.
	const parsed = parseRoleKey(getRoleValue(role));
	const configured = parsed ? { provider: parsed.provider, id: parsed.id } : undefined;
	if (!configured) return [...defaults];
	// Configured model wins; keep defaults as additional fallbacks.
	const out = [configured];
	for (const d of defaults) {
		if (d.provider !== configured.provider || d.id !== configured.id) out.push(d);
	}
	return out;
}

/** Persist a role's value. Pass "auto" (or undefined) to clear it back to defaults. Clearing also drops any `:level` thinking suffix (it lives in the same string). */
export function setRoleValue(role: ModelRole, value: string | undefined): void {
	const current = readRolesFile();
	const roles: Partial<Record<ModelRole, string>> = { ...current.roles };
	if (!value || value.trim().toLowerCase() === AUTO) {
		delete roles[role];
	} else {
		roles[role] = value.trim();
	}
	writeModelRolesFile({ ...current, roles });
}

// ---------------------------------------------------------------------------
// Model scoping — mirror pi's /model picker, which scopes to settings.json
// "enabledModels" patterns (exact ids or globs), falling back to all models.
// ---------------------------------------------------------------------------

function settingsPath(): string {
	return join(agentDir(), "settings.json");
}

/** Read enabledModels patterns from settings.json (undefined when unset/unreadable). */
export function getEnabledModelPatterns(): string[] | undefined {
	const path = settingsPath();
	if (!existsSync(path)) return undefined;
	try {
		const data = JSON.parse(readFileSync(path, "utf-8")) as { enabledModels?: unknown };
		const patterns = data.enabledModels;
		if (Array.isArray(patterns) && patterns.every((p) => typeof p === "string")) {
			return patterns as string[];
		}
		return undefined;
	} catch {
		return undefined;
	}
}

/** Translate a glob pattern (supporting * and ?) into an anchored, case-insensitive RegExp. */
function globToRegExp(glob: string): RegExp {
	const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
	return new RegExp(`^${escaped}$`, "i");
}

/** A minimal model shape: anything with provider + id (e.g. registry Model). */
export interface ModelLike {
	provider: string;
	id: string;
}

/**
 * Scope a list of models to the configured enabledModels patterns, mirroring pi's
 * /model picker. Patterns match against "provider/id" or the bare id, support *
 * and ? globs, and ignore any trailing ":thinkingLevel" suffix. When no patterns
 * are configured (or none match), the full list is returned unchanged — exactly
 * like pi falling back to all available models.
 */
export function scopeModels<T extends ModelLike>(models: T[], patterns?: string[]): T[] {
	const pats = patterns ?? getEnabledModelPatterns();
	if (!pats || pats.length === 0) return models;

	const out: T[] = [];
	const seen = new Set<string>();
	const addMatch = (m: T) => {
		const key = `${m.provider}/${m.id}`;
		if (seen.has(key)) return;
		seen.add(key);
		out.push(m);
	};

	for (const raw of pats) {
		// Strip an optional ":thinkingLevel" suffix (e.g. "provider/*:high").
		const colon = raw.lastIndexOf(":");
		const pattern = colon > 0 && !raw.slice(colon + 1).includes("/") ? raw.slice(0, colon) : raw;
		if (pattern.includes("*") || pattern.includes("?")) {
			const re = globToRegExp(pattern);
			for (const m of models) {
				if (re.test(`${m.provider}/${m.id}`) || re.test(m.id)) addMatch(m);
			}
		} else {
			const lower = pattern.toLowerCase();
			for (const m of models) {
				if (`${m.provider}/${m.id}`.toLowerCase() === lower || m.id.toLowerCase() === lower) addMatch(m);
			}
		}
	}

	// If patterns matched nothing (e.g. stale config), don't strand the user with
	// an empty picker — fall back to the full list like pi does.
	return out.length > 0 ? out : models;
}

/** Default user agents dir: ~/.pi/agent/agents (overridable via PI_CODING_AGENT_DIR). */
export function userAgentsDir(): string {
	return join(agentDir(), "agents");
}

/** Agent config dir (~/.pi/agent or PI_CODING_AGENT_DIR). */
export function configDir(): string {
	return agentDir();
}
