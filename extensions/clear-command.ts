/**
 * /clear — alias for /new with a full TUI redraw.
 *
 * Lives in a Pi package so it can be installed / updated / removed via
 * `pi install|update|remove` instead of dumping into ~/.pi/agent/extensions/.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	// Register /clear as an alias for /new
	// Both /clear and /new appear in autocomplete and do the same thing
	pi.registerCommand("clear", {
		description:
			"(new) Start a new session with empty context; previous session stays on disk (resumable with /resume)",
		handler: async (_args, ctx) => {
			// Read ctx.mode before newSession() — ctx is stale afterward.
			const isTui = ctx.mode === "tui";
			// newSession() only schedules an incremental render, which leaves short
			// prior transcripts on screen and never clears scrollback. Force pi's own
			// full redraw from inside withSession (the post-replacement ctx is fresh;
			// the outer ctx is stale once newSession resolves). requestRender(true)
			// emits ESC[2J ESC[H ESC[3J (viewport + scrollback) and resets the
			// differential renderer, so we don't hand-roll escapes or race the paint.
			await ctx.newSession({
				withSession: isTui
					? async (sessionCtx) => {
							await sessionCtx.ui.custom<void>((tui, _theme, _keybindings, done) => {
								tui.requestRender(true);
								done(undefined);
								return { render: () => [], invalidate: () => {} };
							});
						}
					: undefined,
			});
		},
	});
}
