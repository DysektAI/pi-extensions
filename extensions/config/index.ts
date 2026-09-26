/**
 * /config — central interactive Pi config menu.
 *
 * Owns:
 *   /config                 open menu (registered extension settings, subagent
 *                           model lists, helper model roles). The menu loops
 *                           until cancelled, so several things can be set in
 *                           one visit.
 *   /config <setting>       show or set a registered setting (e.g. recaps on|off)
 *   /config subagents       edit the shared ordered "Subagent models" list
 *   /config <agent>         edit one agent's own ordered list (plan, scout, ...)
 *   /config <role>          pick a helper-role model (recap, title, judge) with
 *                           the same searchable list as /model, then its
 *                           thinking level
 *   /config <role> auto     reset a helper role back to defaults
 *   /config <role> thinking jump straight to the thinking step
 *
 * Subagent models are an ordered list (1 = tried first, then 2, 3, ... up to
 * MAX_SUBAGENT_MODELS). Each entry carries its own reasoning level. A per-agent
 * list, when set, is tried before the shared list. Nothing is hardcoded: with
 * no models configured, subagents refuse to run and point back here.
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
	registerConfigSetting,
	type ConfigSetting,
} from "../_shared/config-settings.ts";
import {
	getRoleDisplay,
	getRoleValue,
	parseModelKey,
	parseRoleKey,
	ROLE_SPECS,
	ROLE_THINKING_LEVELS,
	scopeModels,
	setRoleModel,
	setRoleThinking,
	setRoleValue,
	type RoleThinking,
} from "../_shared/model-roles.ts";
import {
	FAIL_FAST_TIMEOUT_CHOICES,
	formatEntry,
	formatModelList,
	getFailFastTimeoutSec,
	getSubagentModels,
	insertModel,
	listUserAgentNames,
	MAX_SUBAGENT_MODELS,
	migrateLegacySubagentRoles,
	modelBase,
	moveModel,
	removeModel,
	setFailFastTimeoutSec,
	setModelThinking,
	setSubagentModels,
} from "../_shared/subagent-models.ts";

const AUTO_LABEL = "Auto (use defaults)";

/** A single helper role spec (recap, title, judge). */
type RoleSpec = (typeof ROLE_SPECS)[number];

type ModelIdentity = { provider: string; id: string };

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
 * Thinking levels a model supports, resolved lazily from pi-ai (like the selector
 * above) so this module loads without the pi runtime, e.g. under unit tests.
 */
async function supportedThinkingLevels(model: unknown): Promise<string[] | undefined> {
	try {
		const mod = (await import("@earendil-works/pi-ai")) as unknown as {
			getSupportedThinkingLevels?: (model: unknown) => readonly string[];
		};
		return mod.getSupportedThinkingLevels ? [...mod.getSupportedThinkingLevels(model)] : undefined;
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

/** Announce a helper role's current stored value. */
export function applyRoleValue(spec: RoleSpec, ctx: any): void {
	const display = getRoleValue(spec.role) === "auto" ? "auto" : getRoleDisplay(spec.role);
	ctx.ui.notify(`${spec.label} set to ${display}`, "info");
}

function capitalize(s: string): string {
	return s ? s[0]!.toUpperCase() + s.slice(1) : s;
}

/** Menu row for the shared list. */
export function sharedListRow(): string {
	const list = getSubagentModels();
	return `Subagent models: ${list.length ? formatModelList(list) : "none — subagents disabled until you add one"}`;
}

/** Menu row for one agent's own list. */
export function agentListRow(agent: string): string {
	const own = getSubagentModels(agent);
	return `${capitalize(agent)} models: ${own.length ? `${formatModelList(own, 2)} → then Subagent models` : "uses Subagent models"}`;
}

/** Parse a 1-based priority typed by the user; undefined when blank/invalid. */
export function parsePriority(input: string | undefined, max: number): number | undefined {
	const trimmed = input?.trim();
	if (!trimmed) return undefined;
	if (!/^\d+$/.test(trimmed)) return undefined;
	const n = Number.parseInt(trimmed, 10);
	return n >= 1 && n <= max ? n : undefined;
}

function registerFailFastSetting(): void {
	registerConfigSetting({
		id: "subagent-timeout",
		label: "Subagent fail-fast timeout",
		values: FAIL_FAST_TIMEOUT_CHOICES.map((s) => `${s}s`),
		get: () => `${getFailFastTimeoutSec()}s`,
		set: (v) => {
			const sec = Number.parseInt(v, 10);
			if (Number.isFinite(sec) && sec > 0) setFailFastTimeoutSec(sec);
		},
	});
}

export default function (pi: ExtensionAPI) {
	// Ensure registry Map exists early so personal extensions that register during
	// their own load (before or after this file) always share one store.
	const g = globalThis as typeof globalThis & { __piConfigSettings?: Map<string, unknown> };
	if (!(g.__piConfigSettings instanceof Map)) g.__piConfigSettings = new Map();
	registerFailFastSetting();
	try {
		migrateLegacySubagentRoles();
	} catch {
		/* never break load */
	}

	// -------------------------------------------------------------------------
	// Generic pickers (model identity, then reasoning level)
	// -------------------------------------------------------------------------

	/** Model step. Returns the picked identity, or null on Esc. */
	async function pickModel(title: string, currentKey: string | undefined, ctx: any): Promise<ModelIdentity | null> {
		if (ctx.mode !== "tui") return pickModelLegacy(title, currentKey, ctx, false) as Promise<ModelIdentity | null>;
		const Selector = await loadModelSelector();
		if (!Selector) return pickModelLegacy(title, currentKey, ctx, false) as Promise<ModelIdentity | null>;
		ctx.ui.notify(`${title} — type to filter, ↑↓ to move, Enter to select, Esc to cancel.`, "info");
		const ref = parseRoleKey(currentKey);
		const currentModel = ref ? ctx.modelRegistry.find(ref.provider, ref.id) : undefined;
		const selected: string | undefined = await ctx.ui.custom((tui: any, _theme: any, _kb: any, done: any) => {
			return new Selector(
				tui,
				currentModel,
				roleModelRuntime(ctx),
				[...(ctx.scopedModels ?? [])],
				(model: any) => done(`${model.provider}/${model.id}`),
				() => done(undefined),
			);
		});
		if (selected === undefined) return null;
		const picked = parseModelKey(selected);
		return picked ? { provider: picked.provider, id: picked.id } : null;
	}

	/** Static-list fallback outside the TUI. `withAuto` adds the reset row (helper roles only). */
	async function pickModelLegacy(
		title: string,
		currentKey: string | undefined,
		ctx: any,
		withAuto: boolean,
	): Promise<ModelIdentity | "auto" | null> {
		const available = scopeModels(ctx.modelRegistry.getAvailable());
		const currentBase = parseRoleKey(currentKey);
		const current = currentBase ? `${currentBase.provider}/${currentBase.id}` : undefined;
		const options: string[] = withAuto ? [AUTO_LABEL] : [];
		const keys: (ModelIdentity | "auto")[] = withAuto ? ["auto"] : [];
		const providerWidth = available.reduce((w: number, m: any) => Math.max(w, m.provider.length), 0);
		for (const m of available) {
			const key = `${m.provider}/${m.id}`;
			const marker = key === current ? " ✓" : "";
			options.push(`${`[${m.provider}]`.padEnd(providerWidth + 2)} ${m.id}${marker}`);
			keys.push({ provider: m.provider, id: m.id });
		}
		const choice = await ctx.ui.select(title, options);
		if (choice === undefined) return null;
		const index = options.indexOf(choice);
		return index < 0 ? null : (keys[index] ?? null);
	}

	/**
	 * Reasoning step for a model, limited to levels it supports. Returns the
	 * level, undefined for "model default", or null on Esc.
	 */
	async function pickThinking(
		title: string,
		model: ModelIdentity,
		current: RoleThinking | undefined,
		ctx: any,
	): Promise<RoleThinking | undefined | null> {
		const found = ctx.modelRegistry.find(model.provider, model.id);
		const supported: string[] = (found && (await supportedThinkingLevels(found))) || [...ROLE_THINKING_LEVELS];
		const options = ["Model default (unset)", ...supported];
		const currentIdx = current ? supported.indexOf(current) + 1 : 0;
		const rows = options.map((o, i) => `${i === currentIdx ? "✓ " : "  "}${o}`);
		const choice = await ctx.ui.select(`${title} reasoning (${model.provider}/${model.id})`, rows);
		if (choice === undefined) return null;
		const index = rows.indexOf(choice);
		if (index < 0) return null;
		return index === 0 ? undefined : (options[index] as RoleThinking);
	}

	// -------------------------------------------------------------------------
	// Helper roles (recap / title / judge) — single model each
	// -------------------------------------------------------------------------

	async function pickModelForRole(spec: RoleSpec, ctx: any): Promise<ModelIdentity | "auto" | null> {
		const current = getRoleValue(spec.role);
		const title = `${spec.label}  (current: ${getRoleDisplay(spec.role)})`;
		if (ctx.mode !== "tui") return pickModelLegacy(title, current, ctx, true);
		return pickModel(`Pick ${spec.label} (current: ${getRoleDisplay(spec.role)})`, current, ctx);
	}

	async function pickThinkingForRole(spec: RoleSpec, ctx: any): Promise<void> {
		if (!ctx.hasUI) return;
		const ref = parseRoleKey(getRoleValue(spec.role));
		if (!ref) {
			ctx.ui.notify(`${spec.label} has no model set — pick a model first.`, "warning");
			return;
		}
		const level = await pickThinking(spec.label, ref, ref.thinking, ctx);
		if (level === null) return;
		setRoleThinking(spec.role, level);
	}

	async function configureRole(spec: RoleSpec, ctx: any): Promise<void> {
		const picked = await pickModelForRole(spec, ctx);
		if (picked === null) return;
		if (picked === "auto") {
			setRoleValue(spec.role, undefined);
		} else {
			setRoleModel(spec.role, picked.provider, picked.id);
			await pickThinkingForRole(spec, ctx);
		}
		applyRoleValue(spec, ctx);
	}

	// -------------------------------------------------------------------------
	// Ordered subagent model lists
	// -------------------------------------------------------------------------

	function scopeLabel(agent: string | undefined): string {
		return agent === undefined ? "Subagent models" : `${capitalize(agent)} models`;
	}

	function save(list: string[], agent: string | undefined, ctx: any, what: string): void {
		const stored = setSubagentModels(list, agent);
		ctx.ui.notify(`${scopeLabel(agent)} ${what}: ${stored.length ? formatModelList(stored, 5) : "none"}`, "info");
	}

	/** Pick a model + reasoning and insert it at a chosen priority. */
	async function addModel(agent: string | undefined, ctx: any): Promise<void> {
		const list = getSubagentModels(agent);
		if (list.length >= MAX_SUBAGENT_MODELS) {
			ctx.ui.notify(`${scopeLabel(agent)} already has the maximum of ${MAX_SUBAGENT_MODELS} models.`, "warning");
			return;
		}
		const model = await pickModel(`Add to ${scopeLabel(agent)} (becomes #${list.length + 1})`, undefined, ctx);
		if (!model) return;
		const thinking = await pickThinking(scopeLabel(agent), model, undefined, ctx);
		if (thinking === null) return;
		const key = `${model.provider}/${model.id}${thinking ? `:${thinking}` : ""}`;
		const base = `${model.provider}/${model.id}`;
		const without = list.filter((k) => modelBase(k) !== base);
		let priority = without.length + 1;
		if (without.length > 0) {
			const typed = await ctx.ui.input(
				`Priority for ${base} (1 = tried first, ${without.length + 1} = last)`,
				`${without.length + 1}`,
			);
			if (typed === undefined) return;
			priority = parsePriority(typed, without.length + 1) ?? without.length + 1;
		}
		save(insertModel(list, key, priority), agent, ctx, "updated");
	}

	/** Actions for one entry at 1-based `position`. */
	async function editEntry(agent: string | undefined, position: number, ctx: any): Promise<void> {
		const list = getSubagentModels(agent);
		const key = list[position - 1];
		const ref = parseRoleKey(key);
		if (!key || !ref) return;
		const actions = [
			`Set priority number (now ${position} of ${list.length})`,
			"Move up",
			"Move down",
			`Change reasoning (now ${ref.thinking ?? "default"})`,
			"Replace model",
			"Remove",
		];
		const choice = await ctx.ui.select(`#${position} ${formatEntry(key)}`, actions);
		if (choice === undefined) return;
		switch (actions.indexOf(choice)) {
			case 0: {
				const typed = await ctx.ui.input(`New priority for ${formatEntry(key)} (1-${list.length})`, `${position}`);
				const to = parsePriority(typed, list.length);
				if (to === undefined) {
					if (typed !== undefined) ctx.ui.notify(`Enter a whole number from 1 to ${list.length}.`, "warning");
					return;
				}
				save(moveModel(list, position, to), agent, ctx, "reordered");
				return;
			}
			case 1:
				if (position > 1) save(moveModel(list, position, position - 1), agent, ctx, "reordered");
				return;
			case 2:
				if (position < list.length) save(moveModel(list, position, position + 1), agent, ctx, "reordered");
				return;
			case 3: {
				const level = await pickThinking(scopeLabel(agent), ref, ref.thinking, ctx);
				if (level === null) return;
				save(setModelThinking(list, position, level), agent, ctx, "updated");
				return;
			}
			case 4: {
				const model = await pickModel(`Replace #${position} ${formatEntry(key)}`, key, ctx);
				if (!model) return;
				const level = await pickThinking(scopeLabel(agent), model, ref.thinking, ctx);
				if (level === null) return;
				const next = removeModel(list, position);
				save(insertModel(next, `${model.provider}/${model.id}${level ? `:${level}` : ""}`, position), agent, ctx, "updated");
				return;
			}
			case 5:
				save(removeModel(list, position), agent, ctx, "updated");
				return;
		}
	}

	/**
	 * List editor: numbered rows in priority order, then actions. Loops until
	 * Done/Esc so several models can be added and reordered in one visit.
	 */
	async function editModelList(agent: string | undefined, ctx: any): Promise<void> {
		for (;;) {
			const list = getSubagentModels(agent);
			const rows = list.map((k, i) => `${String(i + 1).padStart(3)}. ${formatEntry(k)}`);
			const ADD = "+ Add model";
			const CLEAR = agent === undefined ? "Clear all" : "Clear (use Subagent models only)";
			const DONE = "Done";
			const options = [...rows, ADD, ...(list.length ? [CLEAR] : []), DONE];
			const title =
				agent === undefined
					? `Subagent models — tried in order: 1 first, then 2, 3, … (${list.length}/${MAX_SUBAGENT_MODELS})`
					: `${scopeLabel(agent)} — tried first, then Subagent models (${formatModelList(getSubagentModels(), 2)})`;
			const choice = await ctx.ui.select(title, options);
			if (choice === undefined || choice === DONE) return;
			const index = options.indexOf(choice);
			if (index < 0) continue;
			if (index < rows.length) {
				await editEntry(agent, index + 1, ctx);
			} else if (choice === ADD) {
				await addModel(agent, ctx);
			} else if (choice === CLEAR) {
				const ok = ctx.ui.confirm
					? await ctx.ui.confirm(`${CLEAR}?`, `Remove all ${list.length} models from ${scopeLabel(agent)}.`)
					: true;
				if (ok) save([], agent, ctx, "cleared");
			}
		}
	}

	// -------------------------------------------------------------------------
	// Menu + status
	// -------------------------------------------------------------------------

	type MenuItem =
		| { kind: "setting"; setting: ConfigSetting }
		| { kind: "list"; agent: string | undefined }
		| { kind: "role"; spec: RoleSpec };

	function menuItems(): { label: string; item: MenuItem }[] {
		const items: { label: string; item: MenuItem }[] = [];
		for (const setting of listConfigSettings()) {
			items.push({ label: `${setting.label}: ${setting.get()}`, item: { kind: "setting", setting } });
		}
		items.push({ label: sharedListRow(), item: { kind: "list", agent: undefined } });
		for (const agent of listUserAgentNames()) {
			items.push({ label: agentListRow(agent), item: { kind: "list", agent } });
		}
		for (const spec of ROLE_SPECS) {
			items.push({ label: `${spec.label}: ${getRoleDisplay(spec.role)}`, item: { kind: "role", spec } });
		}
		return items;
	}

	async function openConfigMenu(ctx: any): Promise<void> {
		for (;;) {
			const items = menuItems();
			const options = items.map((i) => i.label);
			const choice = await ctx.ui.select("Pi config", options);
			if (choice === undefined) return;
			const entry = items[options.indexOf(choice)];
			if (!entry) continue;
			const { item } = entry;
			if (item.kind === "setting") {
				const s = item.setting;
				let next: string | undefined;
				if (s.values.length > 2) {
					// Multi-value: pick directly instead of cycling through every option.
					const current = s.get();
					const rows = s.values.map((v) => `${v === current ? "✓ " : "  "}${v}`);
					const picked = await ctx.ui.select(s.label, rows);
					if (picked === undefined) continue;
					next = s.values[rows.indexOf(picked)];
					if (next === undefined) continue;
					s.set(next);
				} else {
					next = cycleConfigSetting(s);
				}
				ctx.ui.notify(`${s.label} = ${next}`, "info");
			} else if (item.kind === "list") {
				await editModelList(item.agent, ctx);
			} else {
				await configureRole(item.spec, ctx);
			}
		}
	}

	function formatStatus(): string {
		const lines = listConfigSettings().map((s) => `  ${s.label}: ${s.get()}`);
		const shared = getSubagentModels();
		lines.push(`  Subagent models:${shared.length ? "" : " none"}`);
		shared.forEach((k, i) => lines.push(`    ${i + 1}. ${formatEntry(k)}`));
		for (const agent of listUserAgentNames()) lines.push(`  ${agentListRow(agent)}`);
		for (const s of ROLE_SPECS) lines.push(`  ${s.label}: ${getRoleDisplay(s.role)}`);
		return lines.join("\n");
	}

	function applySetting(setting: ConfigSetting, val: string | undefined, ctx: any): void {
		if (!val) {
			ctx.ui.notify(`${setting.label} is ${setting.get()}. Use /config ${setting.id} ${setting.values.join("|")}`, "info");
			return;
		}
		const normalized = val.toLowerCase();
		const match = setting.values.find((v) => v.toLowerCase() === normalized);
		if (!match) {
			ctx.ui.notify(`Usage: /config ${setting.id} ${setting.values.join("|")}`, "error");
			return;
		}
		setting.set(match);
		ctx.ui.notify(`${setting.label} = ${match}`, "info");
	}

	pi.registerCommand("config", {
		description:
			"Open Pi config. Or: /config <setting> [value], /config subagents, /config <agent>, /config <role> [auto|thinking]",
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const key = parts[0]?.toLowerCase();
			const val = parts[1]?.toLowerCase();

			if (!key) {
				if (ctx.hasUI) await openConfigMenu(ctx);
				else ctx.ui.notify(formatStatus(), "info");
				return;
			}

			const setting = getConfigSetting(key);
			if (setting) {
				applySetting(setting, val, ctx);
				return;
			}

			// Ordered subagent lists: shared, or one agent's own.
			const agentName = listUserAgentNames().find((n) => n.toLowerCase() === key);
			if (key === "subagents" || key === "subagent" || agentName) {
				const agent = agentName && key !== "subagents" && key !== "subagent" ? agentName : undefined;
				if (ctx.hasUI) await editModelList(agent, ctx);
				else ctx.ui.notify(agent ? agentListRow(agent) : sharedListRow(), "info");
				return;
			}

			const spec = ROLE_SPECS.find((s) => s.role.toLowerCase() === key);
			if (spec) {
				if (val === "auto") {
					setRoleValue(spec.role, undefined);
					applyRoleValue(spec, ctx);
					return;
				}
				if (!ctx.hasUI) {
					ctx.ui.notify(`${spec.label}: ${getRoleDisplay(spec.role)}`, "info");
					return;
				}
				if (val === "thinking") {
					await pickThinkingForRole(spec, ctx);
					applyRoleValue(spec, ctx);
				} else {
					await configureRole(spec, ctx);
				}
				return;
			}

			const settingIds = listConfigSettings().map((s) => s.id).join(", ");
			const agents = listUserAgentNames().join(", ");
			const roleNames = ROLE_SPECS.map((s) => s.role).join(", ");
			ctx.ui.notify(
				`Usage: /config (menu), /config <${settingIds || "setting"}> [value], /config subagents, /config <${agents || "agent"}>, or /config <${roleNames}>`,
				"info",
			);
		},
	});
}
