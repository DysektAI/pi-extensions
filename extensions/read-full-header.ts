/**
 * read-full-header — always render the read tool's "[Read Tool]" + path block,
 * even when collapsed. Disables pi's compact one-liner for its own docs,
 * SKILL.md, and AGENTS.md/CLAUDE.md.
 *
 * Built-in renderCall only uses the compact form when context.expanded is
 * false, so we delegate to it with expanded forced true. This touches the
 * header only — collapsed reads still hide the file body (driven separately
 * by options.expanded in renderResult).
 */
import { createReadToolDefinition, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	const builtin = createReadToolDefinition(process.cwd());
	pi.registerTool({
		...builtin,
		renderCall(args, theme, context) {
			return builtin.renderCall!(args, theme, { ...context, expanded: true });
		},
	});
}
