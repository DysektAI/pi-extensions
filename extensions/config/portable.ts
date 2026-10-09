/**
 * Portable Pi config: the model choices `/config` manages, as JSON that can be
 * copied on one machine and imported on another (Windows <-> WSL).
 *
 * Only model ids, priorities, thinking levels and registered extension settings
 * travel. Settings keys come from an allowlist, so API keys, auth and pool
 * files can never be exported.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { getConfigSetting, listConfigSettings } from "../_shared/config-settings.ts";
import { configDir, readModelRolesFile, rolesConfigPath, writeModelRolesFile, type RolesFile } from "../_shared/model-roles.ts";

export const PORTABLE_VERSION = 1;

type Check = (value: unknown) => boolean;

const ROLE_CHECKS: Record<string, Check> = {
	roles: isStringRecord,
	subagentModels: isStringArray,
	agentModels: (value) => isRecord(value) && Object.values(value).every(isStringArray),
	subagentOptions: (value) => isRecord(value) && Object.entries(value).every(isTimeoutOption),
};

const ROLE_FILE_KEYS = Object.keys(ROLE_CHECKS);

const SETTING_CHECKS: Record<string, Check> = {
	defaultProvider: isString,
	defaultModel: isString,
	defaultThinkingLevel: isString,
	enabledModels: isStringArray,
	modelThinkingLevels: isStringRecord,
};

const SETTING_KEYS = Object.keys(SETTING_CHECKS);

export interface PortableConfig {
	piConfig: number;
	modelRoles: RolesFile;
	settings: Record<string, unknown>;
	extensionSettings: Record<string, string>;
}

function isString(value: unknown): boolean {
	return typeof value === "string";
}

function isStringArray(value: unknown): boolean {
	return Array.isArray(value) && value.every(isString);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): boolean {
	return isRecord(value) && Object.values(value).every(isString);
}

function isTimeoutOption([key, value]: [string, unknown]): boolean {
	return key === "failFastTimeoutSec" && typeof value === "number" && Number.isFinite(value);
}

function settingsPath(): string {
	return join(configDir(), "settings.json");
}

function readSettings(): Record<string, unknown> {
	const path = settingsPath();
	if (!existsSync(path)) return {};
	const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
	if (!isRecord(parsed)) throw new Error(`${path} is not a JSON object`);
	return parsed;
}

function writeSettings(next: Record<string, unknown>): void {
	const path = settingsPath();
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
	renameSync(tmp, path);
}

function pickKeys<T extends Record<string, unknown>>(source: T, keys: readonly string[]): Partial<T> {
	const out: Record<string, unknown> = {};
	for (const key of keys) if (source[key] !== undefined) out[key] = source[key];
	return out as Partial<T>;
}

export function buildPortableConfig(): PortableConfig {
	const settings = readSettings();
	const extensionSettings: Record<string, string> = {};
	for (const setting of listConfigSettings()) extensionSettings[setting.id] = setting.get();
	return {
		piConfig: PORTABLE_VERSION,
		modelRoles: pickKeys(readModelRolesFile() as Record<string, unknown>, ROLE_FILE_KEYS) as RolesFile,
		settings: pickKeys(settings, SETTING_KEYS),
		extensionSettings,
	};
}

export function exportPortableConfig(): string {
	return JSON.stringify(buildPortableConfig(), null, 2);
}

function fieldErrors(section: string, value: unknown, checks: Record<string, Check>): string[] {
	if (!isRecord(value)) return [section];
	return Object.entries(value)
		.filter(([key, field]) => !Object.hasOwn(checks, key) || !checks[key](field))
		.map(([key]) => `${section}.${key}`);
}

/** Parse pasted text; throws with every invalid field named. */
export function parsePortableConfig(text: string): PortableConfig {
	const parsed: unknown = JSON.parse(text);
	if (!isRecord(parsed) || parsed.piConfig !== PORTABLE_VERSION) {
		throw new Error(`Not a Pi config export (expected "piConfig": ${PORTABLE_VERSION}).`);
	}
	const { modelRoles = {}, settings = {}, extensionSettings = {} } = parsed;
	const errors = [
		...fieldErrors("modelRoles", modelRoles, ROLE_CHECKS),
		...fieldErrors("settings", settings, SETTING_CHECKS),
		...(isStringRecord(extensionSettings) ? [] : ["extensionSettings"]),
	];
	if (errors.length > 0) throw new Error(`Invalid Pi config export: ${errors.join(", ")}`);
	return {
		piConfig: PORTABLE_VERSION,
		modelRoles: modelRoles as RolesFile,
		settings: settings as Record<string, unknown>,
		extensionSettings: extensionSettings as Record<string, string>,
	};
}

function applyExtensionSettings(values: Record<string, string>): string[] {
	const skipped: string[] = [];
	for (const [id, value] of Object.entries(values)) {
		const setting = getConfigSetting(id);
		if (setting?.values.includes(value)) setting.set(value);
		else skipped.push(id);
	}
	return skipped;
}

function withoutKeys(source: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
	return Object.fromEntries(Object.entries(source).filter(([key]) => !keys.includes(key)));
}

function readRaw(path: string): string | undefined {
	return existsSync(path) ? readFileSync(path, "utf-8") : undefined;
}

function restoreRaw(path: string, raw: string | undefined): void {
	if (raw === undefined) rmSync(path, { force: true });
	else writeFileSync(path, raw);
}

function writeBoth(roles: RolesFile, settings: Record<string, unknown>): void {
	const previousRoles = readRaw(rolesConfigPath());
	writeModelRolesFile(roles);
	try {
		writeSettings(settings);
	} catch (error) {
		rollBackRoles(previousRoles, error);
	}
}

function rollBackRoles(previousRoles: string | undefined, error: unknown): never {
	try {
		restoreRaw(rolesConfigPath(), previousRoles);
	} catch {
		throw new Error(`${(error as Error).message}; model-roles.json was imported but settings.json was not`);
	}
	throw error;
}

/**
 * Apply an export as a snapshot: the portable keys become exactly what the
 * export carries (absent ones are cleared); everything else (keys, auth, other
 * settings) stays. Both files change or neither does.
 * Returns extension settings that are not registered here or have unknown values.
 */
export function importPortableConfig(text: string): { skipped: string[] } {
	const config = parsePortableConfig(text);
	const settings = readSettings();
	const roles = withoutKeys(readModelRolesFile() as Record<string, unknown>, ROLE_FILE_KEYS);
	writeBoth({ ...roles, ...config.modelRoles }, { ...withoutKeys(settings, SETTING_KEYS), ...config.settings });
	return { skipped: applyExtensionSettings(config.extensionSettings) };
}
