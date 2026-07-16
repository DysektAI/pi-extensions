import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * Pi's built-in threshold check runs after agent_end. A long tool-calling run can
 * therefore cross the model limit before that check gets a chance to run.
 * Trigger compaction at turn_end as well, after tool results are recorded and
 * before the next model request starts.
 */
const GPT56_THRESHOLDS: Readonly<Record<string, number>> = {
	"gpt-5.6-sol": 200_000,
	"gpt-5.6-terra": 200_000,
	"gpt-5.6-luna": 500_000,
};

const IMPLEMENTATION_HANDOFF_INSTRUCTIONS = `Create a self-contained implementation handoff for a fresh agent with no access to this conversation.
Treat the latest agreement as authoritative. Preserve the exact requirements, decisions, constraints, relevant file paths and APIs, current repository state, unresolved risks, and verification steps needed to implement it.
Remove brainstorming, rejected alternatives, repetition, and conversational history. Resolve pronouns and vague references. The handoff must be immediately actionable, but do not perform the implementation in the summary.`;

export default function contextManagement(pi: ExtensionAPI): void {
	let compactionPending = false;

	function thresholdFor(ctx: ExtensionContext): number | undefined {
		return ctx.model ? GPT56_THRESHOLDS[ctx.model.id] : undefined;
	}

	pi.on("turn_end", (_event, ctx) => {
		if (compactionPending) return;

		const threshold = thresholdFor(ctx);
		if (threshold === undefined) return;

		const usage = ctx.getContextUsage();
		if (usage?.tokens == null || usage.tokens < threshold) return;

		compactionPending = true;
		const shouldResume = !ctx.isIdle();
		if (ctx.hasUI) {
			ctx.ui.notify(
				`GPT-5.6 proactive compaction at ${Math.round(usage.tokens / 1000)}K tokens ` +
					`(limit ${Math.round(threshold / 1000)}K)`,
				"warning",
			);
		}

		ctx.compact({
			onComplete: () => {
				compactionPending = false;
				if (shouldResume) {
					pi.sendMessage(
						{
							customType: "gpt56-proactive-compaction",
							content: "Proactive context compaction completed. Continue the interrupted task.",
							display: false,
						},
						{ deliverAs: "steer", triggerTurn: true },
					);
				}
			},
			onError: (error) => {
				compactionPending = false;
				if (ctx.hasUI) ctx.ui.notify(`Proactive compaction failed: ${error.message}`, "error");
			},
		});
	});

	pi.registerCommand("clear-implement", {
		description: "Summarize the agreed solution into a fresh session and implement it",
		handler: async (args, ctx) => {
			await ctx.waitForIdle();
			const parentSession = ctx.sessionManager.getSessionFile();
			const extraInstruction = args.trim();

			if (ctx.hasUI) ctx.ui.notify("Preparing a clean implementation handoff…", "info");
			ctx.compact({
				customInstructions: IMPLEMENTATION_HANDOFF_INSTRUCTIONS,
				onComplete: (result) => {
					const implementationPrompt = [
						"Implement the agreed solution now using the handoff below.",
						"Treat settled decisions as authoritative and do not restart brainstorming unless implementation is blocked by new evidence.",
						extraInstruction
							? `Additional instruction from the user: ${extraInstruction}`
							: undefined,
						"",
						"# Implementation handoff",
						result.summary,
					]
						.filter((part): part is string => part !== undefined)
						.join("\n\n");

					void ctx
						.newSession({
							parentSession,
							withSession: async (newCtx) => {
								await newCtx.sendUserMessage(implementationPrompt);
							},
						})
						.catch((error: unknown) => {
							const message = error instanceof Error ? error.message : String(error);
							console.error(`[clear-implement] Could not start clean implementation session: ${message}`);
						});
				},
				onError: (error) => {
					if (ctx.hasUI) ctx.ui.notify(`Could not prepare implementation handoff: ${error.message}`, "error");
				},
			});
		},
	});
}
