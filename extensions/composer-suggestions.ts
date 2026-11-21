import { createHash } from "node:crypto";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CustomEditor, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getKeybindings, isKeyRelease, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { resolveAgentDir } from "./_shared/agent-dir.ts";
import { registerConfigSetting } from "./_shared/config-settings.ts";
import { CUSTOM_TYPE as GOAL_ENTRY } from "./goal/pure.ts";

const SETTING = "composer-suggestions";
const INSTRUCTIONS = "Predict the next message the user might send. In their language, write one brief request for a concrete unresolved outcome. Use the supplied context as evidence. Leave the method open unless the user specified it. Avoid repeating finished work, paraphrasing earlier suggestions, or requesting secrets. Return only a JSON string of up to 160 characters, or null if there is no useful next request.";
// Evidence expires conservatively. Provider routing and eviction can still cause misses.
const CACHE_EVIDENCE_MS = 120_000;
const MAX_EXCLUSIONS = 12;

type MessageContent = string | readonly { type: string; text?: string }[];
type Reply = { id: string; context: string };
type CacheEvidence = { requestKey: string; exclusionStart: number; seenAt: number };

function text(content: MessageContent): string {
	return typeof content === "string" ? content : content
		.filter((part) => part.type === "text")
		.map((part) => part.text ?? "")
		.join("\n");
}

function excerpt(value: string, limit: number): string {
	const trimmed = value.trim();
	if (trimmed.length <= limit) return trimmed;
	const head = Math.floor(limit / 3);
	return trimmed.slice(0, head) + "\n…\n" + trimmed.slice(-(limit - head - 3));
}

function latestReply(ctx: ExtensionContext): Reply | undefined {
	let reply: { id: string; text: string } | undefined;
	let goal: string | undefined;
	const requests: string[] = [];
	const entries = ctx.sessionManager.getBranch();
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry.type === "custom" && entry.customType === GOAL_ENTRY && goal === undefined) {
			const data = entry.data as { status?: unknown; condition?: unknown; taskPlan?: unknown } | undefined;
			goal = data?.status === "active" && typeof data.condition === "string"
				? excerpt(data.condition, 500) + (typeof data.taskPlan === "string" ? "\n" + excerpt(data.taskPlan, 300) : "")
				: "";
		}
		if (entry.type !== "message") continue;
		const msg = entry.message;
		if (msg.role === "assistant" && !reply) {
			const value = excerpt(text(msg.content), 2_400);
			if (msg.stopReason !== "stop" || !value) return;
			reply = { id: entry.id, text: value };
		}
		if (msg.role === "user") {
			if (!reply) return;
			if (requests.length < 3) requests.push(excerpt(text(msg.content), requests.length ? 600 : 1_100));
		}
		if (requests.length === 3 && goal !== undefined) break;
	}
	if (!reply || !requests[0]) return;
	return { id: reply.id, context: JSON.stringify({ goal: goal || undefined, requests: requests.reverse(), reply: reply.text }) };
}

function normalize(draft: string): string {
	return draft.normalize("NFKC").toLowerCase().trim().replace(/[.!?。！？]+$/u, "").trimEnd().replace(/\s+/gu, " ");
}

function validateDraft(value: unknown): string | undefined {
	if (typeof value !== "string" || /[\p{Cc}\p{Bidi_Control}\p{Zl}\p{Zp}]/u.test(value)) return;
	const draft = value.trim();
	if (draft.length <= 160 && !/^[!/]/.test(draft) && /[^\p{P}\s]/u.test(normalize(draft))) return draft;
}

function parseDraft(output: string): string | undefined {
	try {
		return validateDraft(JSON.parse(output));
	} catch {
		return undefined;
	}
}

export default function (pi: ExtensionAPI) {
	const enabledFile = join(resolveAgentDir(), `${SETTING}.enabled`);
	let active: { reply: Reply; drafts: string[]; viewed: number } | undefined;
	let pending: AbortController | undefined;
	let cache: CacheEvidence | undefined;
	let ui: ExtensionContext["ui"] | undefined;
	let unsubscribeInput: (() => void) | undefined;
	let refreshWidget: (() => void) | undefined;

	function cancel() {
		pending?.abort();
		pending = undefined;
	}

	function clear() {
		cancel();
		active = undefined;
		cache = undefined;
		refreshWidget?.();
	}

	const unregister = registerConfigSetting({
		id: SETTING,
		label: "Composer suggestions",
		values: ["off", "on"],
		get: () => existsSync(enabledFile) ? "on" : "off",
		set: (value) => {
			if (value === "on") writeFileSync(enabledFile, "", { mode: 0o600 });
			else {
				rmSync(enabledFile, { force: true });
				clear();
			}
		},
	});

	function load(ctx: ExtensionContext, reply: Reply) {
		const drafts: string[] = [];
		let attempted = false;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== SETTING) continue;
			const data = entry.data as { replyId?: unknown; draft?: unknown } | undefined;
			if (data?.replyId !== reply.id) continue;
			attempted = true;
			const draft = validateDraft(data.draft);
			if (draft && !drafts.some((previous) => normalize(previous) === normalize(draft))) drafts.push(draft);
		}
		active = { reply, drafts, viewed: drafts.length - 1 };
		return attempted;
	}

	function syncReply(ctx: ExtensionContext) {
		const reply = latestReply(ctx);
		if (!reply) {
			clear();
		} else if (active?.reply.id !== reply.id) {
			clear();
			load(ctx, reply);
		} else if (active.reply.context !== reply.context) {
			cancel();
			cache = undefined;
			active.reply = reply;
		}
	}

	function show(ctx: ExtensionContext) {
		ui = ctx.ui;
		ui.setWidget(SETTING, (tui, theme) => {
			refreshWidget = () => tui.requestRender();
			// The 1.6 TUI runtime exposes focus even though the widget interface omits it.
			const focus = tui as typeof tui & { getFocusedComponent?(): Partial<Pick<CustomEditor, "actionHandlers">> | null };
			const composerFocused = () => {
				const actions = focus.getFocusedComponent?.()?.actionHandlers;
				// Pi wires app actions to the composer. Check structurally across Jiti module boundaries.
				return !tui.hasOverlay() && actions instanceof Map && actions.has("app.clear");
			};
			unsubscribeInput?.();
			unsubscribeInput = ctx.ui.onTerminalInput((data) => {
				if (!active || isKeyRelease(data) || !ctx.isIdle() || ctx.ui.getEditorText() || !composerFocused()) return;
				const { drafts, viewed } = active;
				const keybindings = getKeybindings();
				if (drafts[viewed] && (matchesKey(data, "alt+j") || keybindings.matches(data, "tui.input.tab")
					|| keybindings.matches(data, "tui.editor.cursorRight"))) {
					ctx.ui.setEditorText(drafts[viewed]);
					tui.requestRender();
					return { consume: true };
				}
				const direction = matchesKey(data, "alt+up") ? -1 : matchesKey(data, "alt+down") ? 1 : 0;
				if (direction && drafts.length > 1) {
					active.viewed = (viewed + direction + drafts.length) % drafts.length;
					tui.requestRender();
					return { consume: true };
				}
			});
			return {
				render: (width) => {
					if (!active || ctx.ui.getEditorText() || !composerFocused()) return [];
					const { drafts, viewed } = active;
					const draft = drafts[viewed];
					if (!draft) return [];
					const position = `${viewed + 1}/${drafts.length}`;
					const keys = drafts.length > 1 ? " · Alt+↑/↓ history" : "";
					return [
						theme.fg("dim", truncateToWidth(draft, width)),
						theme.fg("dim", truncateToWidth(`Next request ${position} · Tab/→ insert · /suggest for another${keys}`, width)),
					];
				},
				invalidate() {},
			};
		});
	}

	async function suggest(ctx: ExtensionContext, manual: boolean) {
		const state = active;
		const model = ctx.model;
		if (!state || !model || pending) return;
		const { reply } = state;
		const controller = new AbortController();
		pending = controller;
		const requestKey = createHash("sha256").update(JSON.stringify([
			ctx.sessionManager.getSessionId(), reply.id, model.provider, model.id, model.api, model.baseUrl, reply.context,
		])).digest("hex").slice(0, 32);
		const exclusionStart = Math.max(0, state.drafts.length - MAX_EXCLUSIONS);
		const warm = cache?.requestKey === requestKey && cache.exclusionStart === exclusionStart
			&& Date.now() - cache.seenAt < CACHE_EVIDENCE_MS;
		try {
			if (manual && !warm) {
				const confirmed = await ctx.ui.confirm(
					"Cache warmth unverified",
					"Generate another suggestion using limited context? It may be billed at the uncached rate.",
					{ signal: controller.signal },
				);
				if (!confirmed || controller.signal.aborted || active !== state || !ctx.isIdle()
					|| ctx.hasPendingMessages()) return;
				syncReply(ctx);
				if (controller.signal.aborted) return;
			}
			if (!manual) pi.appendEntry(SETTING, { replyId: reply.id });
			// Append each exclusion as its own message so previous cache boundaries survive.
			// When the exclusion window slides, require fresh evidence for that prompt.
			const timestamp = Date.now();
			const messages = [reply.context, ...state.drafts.slice(exclusionStart).map(
				(draft) => "Earlier suggestion to avoid: " + JSON.stringify(draft),
			)].map((content) => ({ role: "user" as const, content, timestamp }));
			const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(12_000)]);
			cache = undefined;
			const result = await ctx.modelRegistry.streamSimple(model, {
				systemPrompt: INSTRUCTIONS,
				messages,
			}, {
				maxTokens: 128,
				maxRetries: 0,
				sessionId: requestKey,
				cacheRetention: "short",
				// Pi's OpenAI-compatible defaults do not send Morph's worker-affinity header.
				headers: model.provider === "morph" ? { "x-session-id": requestKey } : undefined,
				signal,
			}).result();
			if (signal.aborted || pending !== controller || active !== state) return;
			syncReply(ctx);
			if (controller.signal.aborted) return;
			if (result.stopReason !== "stop") {
				if (manual) ctx.ui.notify("Could not generate a suggestion.", "warning");
				return;
			}
			// Reuse the SDK's normalized cache accounting across Responses, Chat Completions,
			// and providers that report explicit writes. A zero or missing count proves nothing.
			const { cacheRead, cacheWrite } = result.usage;
			cache = result.provider === model.provider && result.model === model.id
				&& cacheRead + cacheWrite > 0
				? { requestKey, exclusionStart, seenAt: Date.now() }
				: undefined;
			const draft = parseDraft(text(result.content));
			if (!draft || state.drafts.some((previous) => normalize(previous) === normalize(draft))) {
				if (manual) ctx.ui.notify("No distinct suggestion returned. Earlier suggestions are still available.", "info");
				return;
			}
			pi.appendEntry(SETTING, { replyId: reply.id, draft });
			state.drafts.push(draft);
			state.viewed = state.drafts.length - 1;
			refreshWidget?.();
		} catch {
			if (manual && !controller.signal.aborted) ctx.ui.notify("Could not generate a suggestion.", "warning");
		} finally {
			if (pending === controller) pending = undefined;
		}
	}

	function restore(ctx: ExtensionContext) {
		if (ctx.mode !== "tui" || !ctx.hasUI) return;
		if (!ui) show(ctx);
		if (!existsSync(enabledFile)) return;
		syncReply(ctx);
		refreshWidget?.();
	}

	pi.on("session_start", (_event, ctx) => {
		clear();
		restore(ctx);
	});
	pi.on("agent_start", clear);
	pi.on("input", clear);
	pi.on("model_select", () => {
		cancel();
		cache = undefined;
	});
	pi.on("session_before_tree", cancel);
	pi.on("session_tree", (_event, ctx) => {
		clear();
		restore(ctx);
	});
	pi.on("session_shutdown", () => {
		clear();
		unsubscribeInput?.();
		ui?.setWidget(SETTING, undefined);
		unregister();
	});

	pi.on("agent_settled", (event, ctx) => {
		if (event.aborted || ctx.mode !== "tui" || !ctx.hasUI || ctx.hasPendingMessages() || !existsSync(enabledFile)) return;
		const reply = latestReply(ctx);
		if (!reply || active?.reply.id === reply.id) return;
		if (!ui) show(ctx);
		if (!load(ctx, reply)) void suggest(ctx, false);
		refreshWidget?.();
	});

	pi.registerCommand("suggest", {
		description: "Generate another suggestion for the latest reply",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui" || !ctx.hasUI || !ctx.isIdle() || ctx.hasPendingMessages()
				|| !existsSync(enabledFile)) return;
			restore(ctx);
			if (active) await suggest(ctx, true);
		},
	});
}
