/**
 * Session Recap Extension
 *
 * After each agent response, injects a subtle footer showing:
 *   ✻ Done in 55s  ※ recap: what was done + what's next  (disable: /config recaps off)
 *
 * Recap text uses the "recap" model role (see _shared/model-roles.ts), then falls
 * back to the active chat model. Timing-only footer if generation fails.
 *
 * Toggle via /config (owned by config.ts) or:
 *   /config recaps on|off
 */

import { complete } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { registerConfigSetting } from "./_shared/config-settings.ts";
import { resolveRoleCandidates } from "./_shared/model-roles.ts";

const RECAP_TIMEOUT_MS = 10_000;
const MAX_RECAP_TOKENS = 80;
const RECAP_DELAY_MS = 3 * 60 * 1000; // 3 minutes of inactivity before showing recap

function formatDuration(ms: number): string {
	if (ms < 1000) return "<1s";
	const s = Math.round(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	const rem = s % 60;
	return rem > 0 ? `${m}m ${rem}s` : `${m}m`;
}

function buildSnippet(messages: any[]): string {
	const lines: string[] = [];
	for (const msg of messages) {
		const role = msg?.role;
		const content = msg?.content;
		if (!role || !content) continue;

		if (role === "user") {
			const text =
				typeof content === "string"
					? content
					: Array.isArray(content)
						? content
								.filter((c: any) => c?.type === "text")
								.map((c: any) => c.text)
								.join("\n")
						: "";
			if (text.trim()) lines.push(`User: ${text.slice(0, 600).trim()}`);
		} else if (role === "assistant") {
			const parts = Array.isArray(content) ? content : [];
			const text = parts
				.filter((c: any) => c?.type === "text")
				.map((c: any) => c.text)
				.join("\n");
			const toolNames = parts
				.filter((c: any) => c?.type === "toolCall")
				.map((c: any) => String(c.name));
			if (text.trim()) lines.push(`Assistant: ${text.slice(0, 400).trim()}`);
			if (toolNames.length > 0) lines.push(`Tools used: ${toolNames.join(", ")}`);
		}
	}
	return lines.join("\n\n");
}

export default function (pi: ExtensionAPI) {
	let enabled = true;
	let hintShown = false;
	let requestStart = 0;
	let pendingTimer: ReturnType<typeof setTimeout> | null = null;
	let pendingMessages: any[] | null = null;
	let pendingElapsed = 0;

	// Expose toggle to /config (config.ts). Session preference is restored below.
	registerConfigSetting({
		id: "recaps",
		label: "Session recaps",
		values: ["on", "off"],
		get: () => (enabled ? "on" : "off"),
		set: (value) => {
			enabled = value === "on";
			pi.appendEntry("recap-config", { enabled });
		},
	});

	// Restore toggle preference from session history
	pi.on("session_start", (_event, ctx) => {
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type === "custom" && (entry as any).customType === "recap-config") {
				enabled = (entry as any).data?.enabled ?? true;
			}
		}
	});

	pi.on("agent_start", () => {
		requestStart = Date.now();
		if (pendingTimer) {
			clearTimeout(pendingTimer);
			pendingTimer = null;
			pendingMessages = null;
		}
	});

	pi.on("agent_end", (event, ctx) => {
		if (!enabled) return;
		const elapsed = requestStart > 0 ? Date.now() - requestStart : 0;

		if (pendingTimer) {
			clearTimeout(pendingTimer);
		}

		pendingMessages = event.messages;
		pendingElapsed = elapsed;

		pendingTimer = setTimeout(() => {
			pendingTimer = null;
			const messages = pendingMessages;
			pendingMessages = null;
			if (!messages) return;

			void (async () => {
				try {
					const doneStr = `✻ Done in ${formatDuration(pendingElapsed)}`;
					let recap = "";

					try {
						const snippet = buildSnippet(messages);
						if (snippet.trim()) {
							const candidates: any[] = [];
							const seen = new Set<string>();
							const add = (m: any) => {
								if (!m) return;
								const key = `${m.provider}/${m.id}`;
								if (seen.has(key)) return;
								seen.add(key);
								candidates.push(m);
							};
							for (const { provider, id } of resolveRoleCandidates("recap")) {
								add(ctx.modelRegistry.find(provider, id));
							}
							add(ctx.model);

							for (const model of candidates) {
								try {
									const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
									if (!auth.ok || !auth.apiKey) continue;

									const response = await complete(
										model,
										{
											messages: [
												{
													role: "user",
													content: [
														{
															type: "text",
															text: `Summarize in 1 sentence (max 140 chars, no preamble): what the user asked, what was done, and what's next.\n\n${snippet}`,
														},
													],
													timestamp: Date.now(),
												},
											],
										},
										{
											apiKey: auth.apiKey,
											headers: (auth as any).headers,
											maxTokens: MAX_RECAP_TOKENS,
											signal: AbortSignal.timeout(RECAP_TIMEOUT_MS),
										},
									);

									recap = response.content
										.filter((c): c is { type: "text"; text: string } => c.type === "text")
										.map((c) => c.text)
										.join(" ")
										.trim();

									if (recap) break;
								} catch {
									// Try next model
								}
							}
						}
					} catch {
						// Timing-only fallback
					}

					const hint = hintShown ? "" : " (disable: /config recaps off)";
					if (recap) hintShown = true;
					const content = recap ? `${doneStr}  ※ recap: ${recap}${hint}` : doneStr;
					pi.sendMessage({ customType: "session-recap", content, display: true });
				} catch {
					// Context went stale (session switch/reload/fork) — discard
				}
			})();
		}, RECAP_DELAY_MS);
	});

	pi.registerMessageRenderer("session-recap", (message, _options, theme) => {
		return new Text(theme.fg("dim", String(message.content ?? "")), 0, 0);
	});
}
