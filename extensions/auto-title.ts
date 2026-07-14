/**
 * Auto Title Extension
 *
 * Names sessions so they're easy to find in /resume and `pi -r`, and keeps the
 * name broad — describing the whole session's purpose, not the latest turn.
 *
 * Behavior:
 *   - Titles after a couple of user turns, then RE-TITLES on a widening cadence
 *     (2, 4, 8, 16… user turns) so the name broadens early then settles,
 *     instead of freezing on the opening ask OR churning every few turns.
 *     Re-titles are sticky: a reworded/near-identical title is skipped silently
 *     so the session list doesn't flood with "Session titled: …" notifications.
 *   - Samples user AND assistant messages across the whole timeline, so titles
 *     reflect every phase of a multi-task session, not just the first or last.
 *   - Never overrides a name you set by hand (/name or /title <name>); that
 *     marks the session manual and stops auto-updates.
 *   - Cheap model first (gemini-flash-lite), active model as backstop.
 *
 * Commands:
 *   /title            Show the current session name
 *   /title <name>     Set the name manually (stops auto-titling this session)
 *   /title auto       Re-enable + regenerate a broad name from the whole session
 *   /title debug      Show active model + last generation error
 *   /titles on|off    Enable/disable automatic titling (default: on)
 *   Ctrl+Shift+T      One-key: regenerate a broad title from the whole session
 */

import { complete } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { resolveRoleCandidates } from "./_shared/model-roles.ts";

// Title helper models come from the central "title" role (configure via /config).
// ctx.model is added last as a guaranteed-authed backstop.

const TITLE_TIMEOUT_MS = 15_000;
const MAX_TITLE_TOKENS = 40;
const MAX_TITLE_CHARS = 70;
const MAX_SAMPLED_USERS = 6; // user messages fed to the model, spread across time
const MAX_SAMPLED_ASSISTANTS = 4; // assistant messages spread across time (what was done)

// Last error seen during generation, surfaced via `/title debug`.
let lastError = "";
// Model that actually produced the last title (or "fallback" if all failed).
let lastModelUsed = "";

const textOf = (msg: any): string => {
	const content = msg?.content;
	return typeof content === "string"
		? content
		: Array.isArray(content)
			? content
					.filter((c: any) => c?.type === "text")
					.map((c: any) => c.text)
					.join("\n")
			: "";
};

/** Pick k items spread evenly across arr (always includes first + last). */
function evenSample<T>(arr: T[], k: number): T[] {
	if (arr.length <= k) return arr;
	const out: T[] = [];
	for (let i = 0; i < k; i++) {
		out.push(arr[Math.round((i * (arr.length - 1)) / (k - 1))]);
	}
	return out.filter((v, i) => i === 0 || v !== out[i - 1]);
}

/**
 * Build a breadth-first snippet: user AND assistant messages each sampled
 * evenly across the whole conversation, then replayed in chronological order.
 * Sampling both roles across time (not just the opening assistant reply) is
 * what lets a multi-phase session title capture every phase, not just phase 1.
 */
function buildSnippet(messages: any[]): { firstUser: string; snippet: string } {
	const users = messages.filter((m) => m?.role === "user" && textOf(m).trim());
	const assistants = messages.filter(
		(m) => m?.role === "assistant" && textOf(m).trim(),
	);
	const firstUser = users.length ? textOf(users[0]).trim() : "";
	if (!users.length) return { firstUser, snippet: "" };

	const picked = new Set<any>([
		...evenSample(users, MAX_SAMPLED_USERS),
		...evenSample(assistants, MAX_SAMPLED_ASSISTANTS),
	]);

	const lines: string[] = [];
	for (const m of messages) {
		if (!picked.has(m)) continue;
		const cap = m.role === "user" ? 500 : 300;
		const role = m.role === "user" ? "User" : "Assistant";
		lines.push(`${role}: ${textOf(m).slice(0, cap).trim()}`);
	}
	return { firstUser, snippet: lines.join("\n\n") };
}

/** Normalize for comparison: lowercase, strip non-alphanumerics, collapse space. */
function normTitle(s: string): string {
	return (s || "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.trim();
}

/**
 * True when `next` is essentially the current title reworded — identical after
 * normalization, or one is a subset of the other (e.g. "Fix Auto-Title" vs
 * "Fix Auto-Title Bug"). Used to suppress churny re-title notifications while
 * still allowing a genuinely broader/different title through.
 */
function nearlySame(next: string, current: string | undefined | null): boolean {
	if (!current) return false;
	const a = normTitle(next);
	const b = normTitle(current);
	if (!a || !b) return false;
	if (a === b) return true;
	return a.length > 3 && b.length > 3 && (a.includes(b) || b.includes(a));
}

/** Strip quotes/markdown/trailing punctuation a model might add, clamp length. */
function cleanTitle(raw: string): string {
	let t = raw.trim().split("\n")[0].trim();
	t = t.replace(/^["'`*#\s]+|["'`*\s]+$/g, "");
	t = t.replace(/^(title|session)\s*[:-]\s*/i, "");
	if (t.length > MAX_TITLE_CHARS)
		t = `${t.slice(0, MAX_TITLE_CHARS - 1).trimEnd()}…`;
	return t;
}

/** Last-resort title when no model is reachable: first line of the prompt. */
function fallbackTitle(firstUser: string): string {
	const line = firstUser.split("\n").find((l) => l.trim()) ?? firstUser;
	return cleanTitle(line);
}

async function generateTitle(ctx: any, messages: any[]): Promise<string> {
	const { firstUser, snippet } = buildSnippet(messages);
	if (!snippet.trim()) return "";

	// Cheap configured models first, then the active model as a guaranteed-authed
	// backstop. De-dupe so we don't retry the same model.
	const candidates: any[] = [];
	const seen = new Set<string>();
	const add = (m: any) => {
		if (!m) return;
		const key = `${m.provider}/${m.id}`;
		if (seen.has(key)) return;
		seen.add(key);
		candidates.push(m);
	};
	for (const { provider, id } of resolveRoleCandidates("title")) add(ctx.modelRegistry.find(provider, id));
	add(ctx.model);

	if (candidates.length === 0) {
		lastError = "no models available (ctx.model unset, no fallbacks resolved)";
		return fallbackTitle(firstUser);
	}

	for (const model of candidates) {
		const label = `${model.provider}/${model.id}`;
		try {
			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
			if (!auth.ok || !auth.apiKey) {
				lastError = `${label}: ${auth.ok ? "no api key" : auth.error}`;
				continue;
			}

			const response = await complete(
				model,
				{
					messages: [
						{
							role: "user",
							content: [
								{
									type: "text",
									text:
										`You are titling a developer work session. ` +
										`Read the whole transcript and write one short, broad title (max ${MAX_TITLE_CHARS} chars) naming the main focus of the work. ` +
										`Prefer a SINGLE clear theme. Only if the session is genuinely split between two equally major efforts, name both. ` +
										`Don't over-specify and don't title it after just one step. ` +
										`No quotes, no preamble, Title Case. Output only the title.\n\n${snippet}`,
								},
							],
							timestamp: Date.now(),
						},
					],
				},
				{
					apiKey: auth.apiKey,
					headers: (auth as any).headers,
					maxTokens: MAX_TITLE_TOKENS,
					signal: AbortSignal.timeout(TITLE_TIMEOUT_MS),
				},
			);

			const text = response.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join(" ");
			const title = cleanTitle(text);
			if (title) {
				lastError = "";
				lastModelUsed = label;
				return title;
			}
			lastError = `${label}: empty response`;
		} catch (e) {
			lastError = `${label}: ${(e as Error)?.message ?? String(e)}`;
		}
	}

	// All model calls failed — fall back to the first prompt line.
	lastModelUsed = "fallback (first prompt line)";
	return fallbackTitle(firstUser);
}

export default function (pi: ExtensionAPI) {
	let enabled = true;
	let manual = false; // user set the name by hand → stop auto-updates
	let lastAutoTitle = ""; // the name WE last set (distinguishes ours vs manual)
	let lastUserCount = 0; // user-turn count at last (re)title
	let titling = false; // guard against overlapping generations

	const persist = () =>
		pi.appendEntry("title-config", {
			enabled,
			manual,
			lastAutoTitle,
			lastUserCount,
		});

	// Register the on/off toggle into the shared /config registry (config-center
	// owns the command + UI). /titles still works independently. Inline helper so
	// load order/bundling never matters; registry lives on globalThis.
	const titleReg = globalThis as any;
	titleReg.__piConfigSettings ??= new Map();
	titleReg.__piConfigSettings.set("titles", {
		id: "titles",
		label: "Auto session titles",
		values: ["on", "off"],
		get: () => (enabled ? "on" : "off"),
		set: (v: string) => {
			enabled = v === "on";
			persist();
		},
	});

	const sessionMessages = (ctx: any): any[] =>
		ctx.sessionManager
			.getEntries()
			.filter((e: any) => e.type === "message")
			.map((e: any) => e.message);

	const userCountOf = (messages: any[]): number =>
		messages.filter((m) => m?.role === "user").length;

	pi.on("session_start", (_event, ctx) => {
		enabled = true;
		manual = false;
		lastAutoTitle = "";
		lastUserCount = 0;
		for (const entry of ctx.sessionManager.getEntries()) {
			if (
				entry.type === "custom" &&
				(entry as any).customType === "title-config"
			) {
				const d = (entry as any).data ?? {};
				if (typeof d.enabled === "boolean") enabled = d.enabled;
				if (typeof d.manual === "boolean") manual = d.manual;
				if (typeof d.lastAutoTitle === "string")
					lastAutoTitle = d.lastAutoTitle;
				if (typeof d.lastUserCount === "number")
					lastUserCount = d.lastUserCount;
			}
		}
		// A name we didn't set (e.g. /name, or titled before this version) is
		// treated as manual so we never clobber it. Use /title auto to opt in.
		const current = pi.getSessionName();
		if (current && current !== lastAutoTitle) manual = true;
	});

	// Core (re)titling routine. Re-titles on a widening cadence (geometric
	// doubling: 1, 2, 4, 8, 16…) so the title broadens quickly early on, then
	// settles as the session grows long instead of churning every few turns.
	// `force` (/title auto, Ctrl+Shift+T) ignores the cadence.
	const runTitle = async (ctx: any, force = false) => {
		if (titling) return;
		const messages = sessionMessages(ctx);
		const userCount = userCountOf(messages);
		const haveName = Boolean(pi.getSessionName());
		// ponytail: pure doubling. gaps widen forever; long sessions stop re-titling.
		// First auto-title waits for the 2nd user turn: a title built from a single
		// opening message is the "too specific" one the user complained about.
		const nextDue = lastUserCount * 2;
		const firstReady = haveName || userCount >= 2;
		const due =
			firstReady && (!haveName || userCount >= Math.max(nextDue, lastUserCount + 1));
		if (!force && !due) return;

		titling = true;
		try {
			const title = await generateTitle(ctx, messages);
			const current = pi.getSessionName();
			// Sticky: skip the rename + notification when the new title is just a
			// reword of the current one (punctuation/case/subset). This kills the
			// churn where every turn re-emits a near-identical "Session titled:".
			if (title && !nearlySame(title, current)) {
				pi.setSessionName(title);
				ctx.ui.notify(`Session titled: ${title}`, "info");
			}
			// Advance the cadence whenever we got *any* title back (even a sticky
			// no-op or fallback), so we widen the gap instead of retrying next turn.
			if (title) {
				lastAutoTitle = title;
				lastUserCount = userCount;
				manual = false;
				persist();
			} else {
				// Generation produced nothing (no snippet yet). Back off one rung so a
				// dry start doesn't hammer a title attempt on every single turn.
				lastUserCount = userCount;
			}
		} catch {
			// Context went stale (session switch/reload) — retry on a later turn.
		} finally {
			titling = false;
		}
	};

	pi.on("agent_end", (_event, ctx) => {
		if (!enabled || manual) return;
		void runTitle(ctx);
	});

	pi.registerCommand("title", {
		description:
			"Show/set session title (usage: /title [new name | auto | debug])",
		getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
			const opts: AutocompleteItem[] = [
				{
					value: "auto",
					label: "auto",
					description: "Regenerate a broad title from the whole session",
				},
				{
					value: "debug",
					label: "debug",
					description: "Show active model + last generation error",
				},
			];
			const filtered = opts.filter((o) =>
				o.value.startsWith(prefix.trim().toLowerCase()),
			);
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			const arg = args.trim();
			if (!arg) {
				const current = pi.getSessionName();
				ctx.ui.notify(
					current ? `Session: ${current}` : "No session title set",
					"info",
				);
				return;
			}
			if (arg.toLowerCase() === "debug") {
				const active = ctx.model
					? `${ctx.model.provider}/${ctx.model.id}`
					: "(none)";
				const flashLite = ctx.modelRegistry.find(
					"google-aistudio",
					"gemini-flash-lite-latest",
				);
				ctx.ui.notify(
					`titled by: ${lastModelUsed || "(not yet run)"} | flash-lite resolves: ${flashLite ? "yes" : "NO (add to models.json)"} | active model: ${active} | manual: ${manual} | users@lastTitle: ${lastUserCount} | last error: ${lastError || "none"}`,
					"info",
				);
				return;
			}
			if (arg.toLowerCase() === "auto") {
				manual = false;
				await runTitle(ctx, true);
				if (!pi.getSessionName())
					ctx.ui.notify("Could not generate a title", "warning");
				return;
			}
			pi.setSessionName(arg);
			manual = true;
			lastAutoTitle = "";
			persist();
			ctx.ui.notify(`Session titled: ${arg}`, "info");
		},
	});

	pi.registerCommand("titles", {
		description: "Toggle automatic session titling (usage: /titles on|off)",
		getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
			const opts: AutocompleteItem[] = [
				{ value: "on", label: "on", description: "Enable automatic titling" },
				{
					value: "off",
					label: "off",
					description: "Disable automatic titling",
				},
			];
			const filtered = opts.filter((o) =>
				o.value.startsWith(prefix.trim().toLowerCase()),
			);
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			if (arg === "on" || arg === "off") {
				enabled = arg === "on";
				persist();
				ctx.ui.notify(
					`Automatic titles ${enabled ? "enabled" : "disabled"}`,
					"info",
				);
			} else {
				ctx.ui.notify(
					`Automatic titles are ${enabled ? "on" : "off"}. Use /titles on|off.`,
					"info",
				);
			}
		},
	});

	// One-key re-title: regenerate a broad name from the whole session without
	// typing /title auto. Re-enables auto-titling if it was turned off manually.
	pi.registerShortcut("ctrl+shift+t", {
		description: "Auto-generate session title from the whole conversation",
		handler: async (ctx) => {
			manual = false;
			await runTitle(ctx, true);
			if (!pi.getSessionName())
				ctx.ui.notify("Could not generate a title", "warning");
		},
	});
}
