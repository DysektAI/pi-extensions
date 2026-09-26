import { type ExtensionAPI, type ExtensionContext, SettingsManager } from "@earendil-works/pi-coding-agent";

import { compactionThreshold, shouldResumeAfterCompaction } from "./_shared/compaction-threshold.ts";

/**
 * Pi's built-in threshold check runs after agent_end, at contextWindow - reserveTokens.
 * A long tool-calling run can cross a model's practical limit before that, and very
 * large windows defer compaction far past a sane budget. This compacts at turn_end
 * (after tool results are recorded, before the next request) once context exceeds:
 *   - `compaction.maxContextTokens` (global/project settings; per-model values in
 *     `compaction.modelOverrides["provider/id"].maxContextTokens`), and/or
 *   - built-in limits for models that degrade early (GPT-5.6 family).
 */

const IMPLEMENTATION_HANDOFF_INSTRUCTIONS = `Create a self-contained implementation handoff for a fresh agent with no access to this conversation.
Treat the latest agreement as authoritative. Preserve the exact requirements, decisions, constraints, relevant file paths and APIs, current repository state, unresolved risks, and verification steps needed to implement it.
Remove brainstorming, rejected alternatives, repetition, and conversational history. Resolve pronouns and vague references. The handoff must be immediately actionable, but do not perform the implementation in the summary.`;

export default function contextManagement(pi: ExtensionAPI): void {
	let compactionPending = false;
	let settings: { global: unknown; project: unknown } = { global: undefined, project: undefined };

	pi.on("session_start", (_event, ctx) => {
		try {
			const manager = SettingsManager.create(ctx.cwd);
			settings = { global: manager.getGlobalSettings(), project: manager.getProjectSettings() };
		} catch {
			settings = { global: undefined, project: undefined };
		}
	});

	function thresholdFor(ctx: ExtensionContext): number | undefined {
		return compactionThreshold(ctx.model, settings.global, settings.project);
	}

	pi.on("turn_end", (event, ctx) => {
		if (compactionPending) return;

		const threshold = thresholdFor(ctx);
		if (threshold === undefined) return;

		const usage = ctx.getContextUsage();
		if (usage?.tokens == null || usage.tokens < threshold) return;

		compactionPending = true;
		const shouldResume = shouldResumeAfterCompaction({
			toolResults: event.toolResults.length,
			pendingMessages: ctx.hasPendingMessages(),
			idle: ctx.isIdle(),
		});
		if (ctx.hasUI) {
			ctx.ui.notify(
				`Proactive compaction at ${Math.round(usage.tokens / 1000)}K tokens ` +
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
							customType: "proactive-compaction",
							content: "Proactive context compaction completed. Continue the interrupted task and any queued messages.",
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
