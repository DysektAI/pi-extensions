/**
 * Thinking label: prefix each visible thinking run with a bold `[Thinking]` header,
 * so the normalized reasoning channel is unambiguous at a glance.
 *
 * Uses the public Markdown transformer API; hidden thinking ("Thinking...") is
 * untouched because Pi only runs transformers on visible thinking markdown.
 */
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { labelThinking } from "./pure.ts";

export default function thinkingLabel(pi: ExtensionAPI): void {
	let theme: (() => Theme) | undefined;

	pi.on("session_start", (_event, ctx) => {
		if (ctx.hasUI) theme = () => ctx.ui.theme;
	});

	pi.registerMarkdownTransformer((markdown, context) => {
		if (context.messageType !== "assistant-thinking" || !theme) return markdown;
		const current = theme();
		return labelThinking(markdown, (text) => current.fg("thinkingText", text));
	});
}
