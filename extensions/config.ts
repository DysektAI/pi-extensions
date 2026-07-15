/**
 * /config — central interactive Pi config menu.
 *
 * Owns:
 *   /config                 open menu (registered extension settings + model roles)
 *   /config <setting>       show or set a registered setting (e.g. recaps on|off)
 *   /config <role>          jump to a model-role picker (recap, title, judge, subagent)
 *
 * Extension authors register settings via `_shared/config-settings.ts` so this
 * menu stays the single place for user-facing configuration.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	cycleConfigSetting,
	getConfigSetting,
	listConfigSettings,
	type ConfigSetting,
} from "./_shared/config-settings.ts";
import {
	getRoleValue,
	ROLE_SPECS,
	scopeModels,
	setRoleValue,
} from "./_shared/model-roles.ts";

const AUTO_LABEL = "Auto (use defaults)";

export default function (pi: ExtensionAPI) {
	async function pickModelForRole(roleIndex: number, ctx: any): Promise<void> {
		const spec = ROLE_SPECS[roleIndex];
		if (!spec) return;
		// Same model list as /model (settings.json enabledModels), from authed models.
		const available = scopeModels(ctx.modelRegistry.getAvailable());
		const current = getRoleValue(spec.role);
		const options: string[] = [AUTO_LABEL];
		const keys: (string | undefined)[] = [undefined];
		const providerWidth = available.reduce(
			(w: number, m: any) => Math.max(w, m.provider.length),
			0,
		);
		for (const m of available) {
			const key = `${m.provider}/${m.id}`;
			const marker = key === current ? " ✓" : "";
			const provider = `[${m.provider}]`.padEnd(providerWidth + 2);
			options.push(`${provider} ${m.id}${marker}`);
			keys.push(key);
		}
		const title = `${spec.label}  (current: ${current})`;
		const choice = await ctx.ui.select(title, options);
		if (choice === undefined) return;
		const index = options.indexOf(choice);
		if (index < 0) return;
		setRoleValue(spec.role, keys[index]);
		ctx.ui.notify(`${spec.label} set to ${keys[index] ?? "auto"}`, "info");
	}

	async function openConfigMenu(ctx: any): Promise<void> {
		const settings = listConfigSettings();
		const settingRows = settings.map((s) => `${s.label}: ${s.get()}`);
		const roleRows = ROLE_SPECS.map((s) => `${s.label}: ${getRoleValue(s.role)}`);
		const options = [...settingRows, ...roleRows];
		if (options.length === 0) {
			ctx.ui.notify("No config settings or model roles registered.", "info");
			return;
		}
		const choice = await ctx.ui.select("Pi config", options);
		if (choice === undefined) return;
		const index = options.indexOf(choice);
		if (index < 0) return;
		if (index < settingRows.length) {
			const setting = settings[index];
			const next = cycleConfigSetting(setting);
			ctx.ui.notify(`${setting.label} = ${next}`, "info");
			return;
		}
		await pickModelForRole(index - settingRows.length, ctx);
	}

	function formatStatus(): string {
		const settings = listConfigSettings();
		const settingLines = settings.map((s) => `  ${s.label}: ${s.get()}`);
		const roleLines = ROLE_SPECS.map((s) => `  ${s.label}: ${getRoleValue(s.role)}`);
		return [...settingLines, ...roleLines].join("\n") || "  (empty)";
	}

	function applySetting(setting: ConfigSetting, val: string | undefined, ctx: any): void {
		if (!val) {
			ctx.ui.notify(
				`${setting.label} is ${setting.get()}. Use /config ${setting.id} ${setting.values.join("|")}`,
				"info",
			);
			return;
		}
		const normalized = val.toLowerCase();
		if (!setting.values.map((v) => v.toLowerCase()).includes(normalized)) {
			ctx.ui.notify(
				`Usage: /config ${setting.id} ${setting.values.join("|")}`,
				"error",
			);
			return;
		}
		// Prefer the casing from the setting's declared values.
		const match =
			setting.values.find((v) => v.toLowerCase() === normalized) ?? normalized;
		setting.set(match);
		ctx.ui.notify(`${setting.label} = ${match}`, "info");
	}

	pi.registerCommand("config", {
		description:
			"Open Pi config (extension settings + model roles). Or: /config <setting> [value], /config <role>",
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const key = parts[0]?.toLowerCase();
			const val = parts[1]?.toLowerCase();

			if (!key) {
				if (ctx.hasUI) {
					await openConfigMenu(ctx);
				} else {
					ctx.ui.notify(formatStatus(), "info");
				}
				return;
			}

			// Registered setting shortcut: /config recaps [on|off]
			const setting = getConfigSetting(key);
			if (setting) {
				applySetting(setting, val, ctx);
				return;
			}

			// Model role shortcut: /config recap|title|judge|subagent
			const roleIndex = ROLE_SPECS.findIndex((s) => s.role === key);
			if (roleIndex >= 0) {
				if (ctx.hasUI) {
					await pickModelForRole(roleIndex, ctx);
				} else {
					const spec = ROLE_SPECS[roleIndex];
					ctx.ui.notify(`${spec.label}: ${getRoleValue(spec.role)}`, "info");
				}
				return;
			}

			const settingIds = listConfigSettings()
				.map((s) => s.id)
				.join(", ");
			const roleNames = ROLE_SPECS.map((s) => s.role).join(", ");
			ctx.ui.notify(
				`Usage: /config (menu), /config <${settingIds || "setting"}> [value], or /config <${roleNames}>`,
				"info",
			);
		},
	});
}
