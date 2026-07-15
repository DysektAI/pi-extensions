/**
 * Cross-extension config settings registry.
 *
 * Other extensions can register toggles that appear in `/config` without each
 * extension owning the command. Storage is on globalThis so a single registry
 * is shared even if multiple package copies load (prefer one install path).
 *
 * Example:
 *
 *   import { registerConfigSetting } from "./config-settings.ts";
 *   registerConfigSetting({
 *     id: "recaps",
 *     label: "Session recaps",
 *     values: ["on", "off"],
 *     get: () => enabled ? "on" : "off",
 *     set: (v) => { enabled = v === "on"; },
 *   });
 */

export interface ConfigSetting {
	/** Stable id (also used by `/config <id>` shortcuts when values are on|off). */
	id: string;
	/** Label shown in the `/config` menu. */
	label: string;
	/** Allowed values (cycle/toggle uses these). */
	values: string[];
	get: () => string;
	set: (value: string) => void;
}

const REGISTRY_KEY = "__piConfigSettings";

type Registry = Map<string, ConfigSetting>;

function registry(): Registry {
	const g = globalThis as typeof globalThis & { [REGISTRY_KEY]?: Registry };
	if (!(g[REGISTRY_KEY] instanceof Map)) {
		g[REGISTRY_KEY] = new Map();
	}
	return g[REGISTRY_KEY]!;
}

/** Register (or replace) a setting. Returns an unregister function. */
export function registerConfigSetting(setting: ConfigSetting): () => void {
	const map = registry();
	map.set(setting.id, setting);
	return () => {
		const current = map.get(setting.id);
		if (current === setting) map.delete(setting.id);
	};
}

export function getConfigSetting(id: string): ConfigSetting | undefined {
	return registry().get(id);
}

/** Sorted by label for stable menus. */
export function listConfigSettings(): ConfigSetting[] {
	return [...registry().values()].sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * Toggle/cycle a setting to the next value that differs from the current one
 * (for two-value toggles this flips on↔off).
 */
export function cycleConfigSetting(setting: ConfigSetting): string {
	const current = setting.get();
	const next = setting.values.find((v) => v !== current) ?? setting.values[0] ?? current;
	setting.set(next);
	return next;
}
