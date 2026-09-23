/**
 * /config — central interactive Pi config menu.
 *
 * Owns:
 *   /config                 open menu (registered extension settings + model roles)
 *   /config <setting>       show or set a registered setting (e.g. recaps on|off)
 *   /config <role>          pick a model with the same searchable/scrollable
 *                           list as /model (recap, title, judge, subagent,
 *                           subagentfallback1..3)
 *   /config <role> auto     reset a role straight back to defaults
 *
 * Subagent roles are special: after picking one, the resolved chain
 * (primary + ordered fallbacks) is immediately written into
 * ~/.pi/agent/agents/*.md so core subagents use it — see subagent-models.
 *
 * Extension authors register settings via `_shared/config-settings.ts` so this
 * menu stays the single place for user-facing configuration.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ModelSelectorComponent } from "@earendil-works/pi-coding-agent";
import {
	cycleConfigSetting,
	getConfigSetting,
	listConfigSettings,
	type ConfigSetting,
} from "../_shared/config-settings.ts";
import {
	applySubagentChainToAgents,
	getRoleValue,
	parseModelKey,
	ROLE_SPECS,
	scopeModels,
	setRoleValue,
} from "../_shared/model-roles.ts";

const AUTO_LABEL = "Auto (use defaults)";

/** A single role spec (recap, title, judge, subagent, subagentFallback1..3). */
type RoleSpec = (typeof ROLE_SPECS)[number];

/**
 * Lazily resolve core's ModelSelectorComponent (the /model picker). Lazy so
 * /config keeps working even if the component ever moves — callers fall back
 * to the static list when it can't be loaded.
 */
async function loadModelSelector(): Promise<typeof ModelSelectorComponent | undefined> {
	try {
		const mod = (await import("@earendil-works/pi-coding-agent")) as unknown as {
			ModelSelectorComponent?: typeof ModelSelectorComponent;
		};
		return mod.ModelSelectorComponent;
	} catch {
		return undefined;
	}
}
/**
 * Adapter letting core's /model picker run off the extension-facing
 * ModelRegistry. Same searchable, scrollable list as /model with zero
 * duplicated UI code — background catalog refresh included.
 */
export function roleModelRuntime(ctx: any): ConstructorParameters<typeof ModelSelectorComponent>[2] {
	return {
		getAvailableSnapshot: () => ctx.modelRegistry.getAvailable(),
		getModel: (provider: string, id: string) => ctx.modelRegistry.find(provider, id),
		getError: () => ctx.modelRegistry.getError(),
		refresh: (opts: any) => ctx.modelRegistry.refresh(opts),
	} as unknown as ConstructorParameters<typeof ModelSelectorComponent>[2];
}

/** Persist a role value; re-syncs agent pins for the subagent family. */
export function applyRoleValue(spec: RoleSpec, value: string | undefined, ctx: any): void {
	setRoleValue(spec.role, value);
	let suffix = "";
	if (spec.role === "subagent" || spec.role.startsWith("subagentFallback")) {
		const { updated, chain } = applySubagentChainToAgents();
		suffix = ` — subagent chain now ${chain.join(" → ")} (applied to ${updated.length} agent${updated.length === 1 ? "" : "s"})`;
	}
	ctx.ui.notify(`${spec.label} set to ${value ?? "auto"}${suffix}`, "info");
}

export default function (pi: ExtensionAPI) {
	// Ensure registry Map exists early so personal extensions that register during
	// their own load (before or after this file) always share one store.
	const g = globalThis as typeof globalThis & { __piConfigSettings?: Map<string, unknown> };
	if (!(g.__piConfigSettings instanceof Map)) g.__piConfigSettings = new Map();

	async function pickModelForRole(roleIndex: number, ctx: any): Promise<void> {
		const spec = ROLE_SPECS[roleIndex];
		if (!spec) return;
		const current = getRoleValue(spec.role);

		// Outside the TUI there are no custom components — keep the static list.
		if (ctx.mode !== "tui") {
			await pickModelForRoleLegacy(spec, current, ctx);
			return;
		}

		// Same component as /model: type-to-filter, ↑↓ scrolls a windowed list.
		// Reset to defaults with `/config <role> auto` (the list itself picks models).
		ctx.ui.notify(
			`Pick ${spec.label} (current: ${current}) — type to filter, ↑↓ to move, Enter to select, Esc to cancel.`,
			"info",
		);
		const ref = parseModelKey(current);
		const currentModel = ref ? ctx.modelRegistry.find(ref.provider, ref.id) : undefined;
		const Selector = await loadModelSelector();
		if (!Selector) {
			await pickModelForRoleLegacy(spec, current, ctx);
			return;
		}
		const selected = await ctx.ui.custom<string | undefined>((tui: any, _theme: any, _kb: any, done: any) => {
			const selector = new Selector(
				tui,
				currentModel,
				roleModelRuntime(ctx),
				[...ctx.scopedModels],
				(model: any) => done(`${model.provider}/${model.id}`),
				() => done(undefined),
			);
			return selector;
		});
		if (selected === undefined) return;
		applyRoleValue(spec, selected, ctx);
	}

	async function pickModelForRoleLegacy(spec: RoleSpec, current: string, ctx: any): Promise<void> {
		// Same model list as /model (settings.json enabledModels), from authed models.
		const available = scopeModels(ctx.modelRegistry.getAvailable());
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
		applyRoleValue(spec, keys[index], ctx);
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
			"Open Pi config (extension settings + model roles). Or: /config <setting> [value], /config <role> [auto]",
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
			// Ids may be dotted (personal extensions), e.g. /config devin.enabled on
			const setting = getConfigSetting(key);
			if (setting) {
				applySetting(setting, val, ctx);
				return;
			}

			// Model role shortcut: /config recap|title|judge|subagent|subagentfallback1..3
			// `/config <role> auto` resets straight back to defaults (the picker itself only picks models).
			const roleIndex = ROLE_SPECS.findIndex((s) => s.role.toLowerCase() === key);
			if (roleIndex >= 0) {
				const spec = ROLE_SPECS[roleIndex]!;
				if (val === "auto") {
					applyRoleValue(spec, undefined, ctx);
				return;
			}
				if (ctx.hasUI) {
					await pickModelForRole(roleIndex, ctx);
				} else {
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
