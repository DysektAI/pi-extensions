/**
 * Portable Pi config: the model choices `/config` manages, as JSON that can be
 * copied on one machine and imported on another (Windows <-> WSL).
 *
 * Only model ids, priorities, thinking levels and registered extension settings
 * travel. Settings keys come from an allowlist, so API keys, auth and pool
 * files can never be exported.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { getConfigSetting, listConfigSettings } from "../_shared/config-settings.ts";
import { configDir, readModelRolesFile, writeModelRolesFile, type RolesFile } from "../_shared/model-roles.ts";

export const PORTABLE_VERSION = 1;

const ROLE_FILE_KEYS = ["roles", "subagentModels", "agentModels", "subagentOptions"] as const;

const SETTING_CHECKS = {
	defaultProvider: isString,
	defaultModel: isString,
	defaultThinkingLevel: isString,
	enabledModels: isStringArray,
	modelThinkingLevels: isStringRecord,
} as const;

type SettingKey = keyof typeof SETTING_CHECKS;

export interface PortableConfig {
	piConfig: number;
	modelRoles: RolesFile;
	settings: Partial<Record<SettingKey, unknown>>;
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
		settings: pickKeys(settings, Object.keys(SETTING_CHECKS)),
		extensionSettings,
	};
}

export function exportPortableConfig(): string {
	return JSON.stringify(buildPortableConfig(), null, 2);
}

function settingErrors(settings: Record<string, unknown>): string[] {
	return Object.entries(settings)
		.filter(([key, value]) => !(key in SETTING_CHECKS) || !SETTING_CHECKS[key as SettingKey](value))
		.map(([key]) => `settings.${key}`);
}

/** Parse pasted text; throws with every invalid field named. */
export function parsePortableConfig(text: string): PortableConfig {
	const parsed: unknown = JSON.parse(text);
	if (!isRecord(parsed) || parsed.piConfig !== PORTABLE_VERSION) {
		throw new Error(`Not a Pi config export (expected "piConfig": ${PORTABLE_VERSION}).`);
	}
	const { modelRoles = {}, settings = {}, extensionSettings = {} } = parsed;
	const errors = [
		...(isRecord(modelRoles) ? [] : ["modelRoles"]),
		...(isRecord(settings) ? settingErrors(settings) : ["settings"]),
		...(isStringRecord(extensionSettings) ? [] : ["extensionSettings"]),
	];
	if (errors.length > 0) throw new Error(`Invalid Pi config export: ${errors.join(", ")}`);
	return {
		piConfig: PORTABLE_VERSION,
		modelRoles: pickKeys(modelRoles as Record<string, unknown>, ROLE_FILE_KEYS) as RolesFile,
		settings: settings as PortableConfig["settings"],
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

/**
 * Apply an export: replaces the model-roles keys it carries, sets the settings
 * keys it carries, and leaves everything else (keys, auth, other settings) alone.
 * Returns extension settings that are not registered here or have unknown values.
 */
export function importPortableConfig(text: string): { skipped: string[] } {
	const config = parsePortableConfig(text);
	const settings = readSettings();
	writeModelRolesFile({ ...readModelRolesFile(), ...config.modelRoles });
	writeSettings({ ...settings, ...config.settings });
	return { skipped: applyExtensionSettings(config.extensionSettings) };
}
