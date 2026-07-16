/**
 * Continue Button — resume work without retyping "continue".
 *
 *   /continue       Send a continue nudge to the agent
 *   Ctrl+Shift+C    Same, one key
 *
 * If the agent is mid-stream the nudge is queued as a follow-up (delivered
 * after it finishes), so hitting it twice never interleaves turns.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const CONTINUE_TEXT = "Continue where you left off. Pick up the previous task and keep going.";

export default function (pi: ExtensionAPI) {
	const go = (ctx: any) => {
		// Idle → fires a fresh turn immediately. Streaming → queue as follow-up so
		// we never throw (sendUserMessage requires deliverAs while streaming).
		if (ctx?.isIdle?.() === false) {
			pi.sendUserMessage(CONTINUE_TEXT, { deliverAs: "followUp" });
			ctx.ui?.notify?.("Continue queued (delivers after current work)", "info");
		} else {
			pi.sendUserMessage(CONTINUE_TEXT);
		}
	};

	pi.registerCommand("continue", {
		description: "Resume the previous task without retyping a prompt",
		handler: async (_args, ctx) => go(ctx),
	});

	pi.registerShortcut("ctrl+shift+c", {
		description: "Continue the previous task",
		handler: async (ctx) => go(ctx),
	});
}
