import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { resolveAgentDir } from "./_shared/agent-dir.ts";
import { registerConfigSetting } from "./_shared/config-settings.ts";

const SETTING = "composer-suggestions";
const ACCEPT_KEY = "alt+j";
const INSTRUCTIONS = `Predict one short message the user might type next. Write from the user's perspective and in their language. Use only the supplied exchange as context. If there's no clear follow-up, output null. Otherwise output only a JSON string containing one plain-text request of at most 160 characters. Never suggest a shell command, slash command, or disclosure of credentials.`;

type MessageContent = string | readonly { type: string; text?: string }[];

function text(content: MessageContent): string {
	return typeof content === "string" ? content : content
		.filter((part) => part.type === "text")
		.map((part) => part.text ?? "")
		.join("\n");
}

function recentExchange(ctx: ExtensionContext): string | undefined {
	const entries = ctx.sessionManager.getBranch();
	let reply: string | undefined;
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry.type !== "message") continue;
		const msg = entry.message;
		if (msg.role === "assistant" && reply === undefined) {
			if (msg.stopReason !== "stop") return;
			reply = text(msg.content).trim().slice(0, 1600);
		}
		if (msg.role === "user") {
			const request = text(msg.content).trim().slice(0, 1000);
			return request && reply ? JSON.stringify({ request, reply }) : undefined;
		}
	}
}

function parseDraft(output: string): string | undefined {
	try {
		const parsed: unknown = JSON.parse(output);
		if (typeof parsed !== "string" || /[\p{Cc}\p{Bidi_Control}]/u.test(parsed)) return;
		const draft = parsed.trim();
		if (draft.length > 160 || !draft || /^[!/]/.test(draft)) return;
		return draft;
	} catch {
		return undefined;
	}
}

export default function (pi: ExtensionAPI) {
	const enabledFile = join(resolveAgentDir(), `${SETTING}.enabled`);
	let draft: string | undefined;
	let pending: AbortController | undefined;
	let activeUI: ExtensionContext["ui"] | undefined;

	function clear() {
		pending?.abort();
		pending = undefined;
		if (draft) activeUI?.setWidget(SETTING, undefined);
		draft = undefined;
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

	pi.on("agent_start", clear);
	pi.on("input", clear);
	pi.on("model_select", clear);
	pi.on("session_before_tree", clear);
	pi.on("session_shutdown", () => {
		clear();
		unregister();
	});

	async function suggest(ctx: ExtensionContext, exchange: string) {
		const model = ctx.model;
		if (!model) return;
		const request = new AbortController();
		pending = request;
		const signal = AbortSignal.any([request.signal, AbortSignal.timeout(12_000)]);
		try {
			const reply = await ctx.modelRegistry.complete(model, {
				systemPrompt: INSTRUCTIONS,
				messages: [{ role: "user", content: exchange, timestamp: Date.now() }],
			}, { maxTokens: 128, signal });
			if (signal.aborted || pending !== request || reply.stopReason !== "stop" || ctx.ui.getEditorText()) return;
			draft = parseDraft(text(reply.content));
			if (!draft) return;
			const suggestion = draft;
			activeUI = ctx.ui;
			ctx.ui.setWidget(SETTING, (_tui, theme) => ({
				render: (width) => [theme.fg("dim", truncateToWidth(`Alt+J to insert · ${suggestion}`, width))],
				invalidate() {},
			}));
		} catch {
			// A suggestion failure leaves the main session usable.
		} finally {
			if (pending === request) pending = undefined;
		}
	}

	pi.on("agent_settled", (event, ctx) => {
		if (event.aborted || ctx.mode !== "tui" || !ctx.hasUI || ctx.ui.getEditorText() || !existsSync(enabledFile)) return;
		const exchange = recentExchange(ctx);
		if (exchange) void suggest(ctx, exchange);
	});

	pi.registerShortcut(ACCEPT_KEY, {
		description: "Insert the suggested next request into the empty composer",
		handler: (ctx) => {
			if (!draft || ctx.ui.getEditorText()) return;
			ctx.ui.setEditorText(draft);
			clear();
		},
	});
}
