/**
 * Shared model-role configuration.
 *
 * A "role" is a named slot for a helper model used by extensions, separate from
 * the main chat model you pick with /model. Roles let cheap/background work
 * (session recaps, auto titles, the goal judge, subagents) target whichever
 * model you prefer, without hardcoding provider/model IDs in each extension.
 *
 * Configuration lives in ~/.pi/agent/model-roles.json:
 *
 *   {
 *     "roles": {
 *       "recap":    "google-aistudio/gemini-flash-lite-latest",
 *       "title":    "google-aistudio/gemini-flash-lite-latest",
 *       "judge":    "anthropic/claude-opus-4-5",
 *       "subagent": "anthropic/claude-sonnet-4-5"
 *     }
 *   }
 *
 * Each value is a single "provider/id" string, or "auto" / unset to fall back
 * to the role's built-in default candidates and ultimately ctx.model.
 *
 * Edit it interactively with /config (no file editing needed). This module is
 * the single source of truth that both the extensions and the /config command
 * read and write.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type ModelRole = "recap" | "title" | "judge" | "subagent";

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
	{
		role: "subagent",
		label: "Subagent model",
		description: "Default model for scout / implement / review agents",
		defaults: [
			{ provider: "anthropic", id: "claude-sonnet-4-5" },
			{ provider: "openai", id: "gpt-4o-mini" },
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

interface RolesFile {
	roles?: Partial<Record<ModelRole, string>>;
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

/** Parse a "provider/id" string into a ModelRef. Returns undefined for "auto"/empty/malformed. */
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
 * Resolve the ordered list of candidate ModelRefs for a role: the configured
 * model first (if any), then the role's defaults. Callers append ctx.model as
 * the guaranteed-authed final backstop and de-duplicate.
 */
export function resolveRoleCandidates(role: ModelRole): ModelRef[] {
	const spec = ROLE_SPECS.find((s) => s.role === role);
	const defaults = spec ? spec.defaults : [];
	const configured = parseModelKey(getRoleValue(role));
	if (!configured) return [...defaults];
	// Configured model wins; keep defaults as additional fallbacks.
	const out = [configured];
	for (const d of defaults) {
		if (d.provider !== configured.provider || d.id !== configured.id) out.push(d);
	}
	return out;
}

/** Persist a role's value. Pass "auto" (or undefined) to clear it back to defaults. */
export function setRoleValue(role: ModelRole, value: string | undefined): void {
	const path = rolesConfigPath();
	const current = readRolesFile();
	const roles: Partial<Record<ModelRole, string>> = { ...current.roles };
	if (!value || value.trim().toLowerCase() === AUTO) {
		delete roles[role];
	} else {
		roles[role] = value.trim();
	}
	const next: RolesFile = { ...current, roles };
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`);
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
