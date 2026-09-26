/**
 * Tool headers: render every built-in tool call as a bold `[Name Tool]` header on
 * its own line with the arguments beneath, collapse multi-line shell commands into
 * one title line, and colour file paths as links (VS Code: plain absolute paths so
 * its own link detector opens them in-window).
 *
 * Each active built-in is re-registered under the same name, delegating execution
 * and result rendering to Pi's own definition; only the call line is rewritten.
 * Registration happens at session_start and only for tools that are already active,
 * so the active tool set never changes. Tools another extension already overrides
 * (e.g. read-full-header's `read`) are left to that extension.
 */
import {
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createPowerShellToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	type ExtensionAPI,
	SettingsManager,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import { decorateShellCall, decorateToolCall } from "./decorate.ts";
import { HEADER_TOOLS } from "./pure.ts";

type AnyTool = ToolDefinition<any, any, any>;

function shellOptions(cwd: string): { commandPrefix?: string; shellPath?: string } {
	try {
		const settings = SettingsManager.create(cwd);
		return { commandPrefix: settings.getShellCommandPrefix(), shellPath: settings.getShellPath() };
	} catch {
		return {};
	}
}

function readOptions(cwd: string): { autoResizeImages?: boolean } {
	try {
		return { autoResizeImages: SettingsManager.create(cwd).getImageAutoResize() };
	} catch {
		return {};
	}
}

function builtinDefinition(name: string, cwd: string): AnyTool | undefined {
	switch (name) {
		case "bash":
			return createBashToolDefinition(cwd, shellOptions(cwd)) as AnyTool;
		case "powershell":
			return createPowerShellToolDefinition(cwd) as AnyTool;
		case "read":
			// Normally owned by read-full-header (skipped as already overridden); this is the fallback.
			return createReadToolDefinition(cwd, readOptions(cwd)) as AnyTool;
		case "edit":
			return createEditToolDefinition(cwd) as AnyTool;
		case "write":
			return createWriteToolDefinition(cwd) as AnyTool;
		case "grep":
			return createGrepToolDefinition(cwd) as AnyTool;
		case "find":
			return createFindToolDefinition(cwd) as AnyTool;
		case "ls":
			return createLsToolDefinition(cwd) as AnyTool;
		default:
			return undefined;
	}
}

function withHeader(name: string, builtin: AnyTool): AnyTool {
	const renderCall = builtin.renderCall;
	if (!renderCall) return builtin;
	const prompt = name === "powershell" ? "PS>" : "$";
	const renderResult = builtin.renderResult;
	return {
		...builtin,
		renderCall(args, theme, context) {
			const component = renderCall(args, theme, context);
			return name === "bash" || name === "powershell"
				? decorateShellCall(name, prompt, component, args as { command?: unknown; timeout?: unknown }, theme)
				: decorateToolCall(name, component, args as Record<string, unknown>, theme, context.cwd);
		},
		...(renderResult && name === "edit"
			? {
					renderResult(result, options, theme, context) {
						const component = renderResult(result, options, theme, context);
						// Edit's result renderer rebuilds the shared call component (settled
						// error, final diff) with the plain built-in header; re-apply ours.
						const callComponent = (context.state as { callComponent?: unknown } | undefined)?.callComponent;
						if (callComponent) {
							decorateToolCall(name, callComponent, context.args as Record<string, unknown>, theme, context.cwd);
						}
						return component;
					},
				}
			: {}),
	};
}

export default function toolHeaders(pi: ExtensionAPI): void {
	const registered = new Set<string>();

	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		const active = new Set(pi.getActiveTools());
		const overridden = new Set(
			pi
				.getAllTools()
				.filter((tool) => tool.sourceInfo?.source !== "builtin")
				.map((tool) => tool.name),
		);
		for (const name of HEADER_TOOLS) {
			if (registered.has(name) || !active.has(name) || overridden.has(name)) continue;
			const builtin = builtinDefinition(name, ctx.cwd);
			if (!builtin) continue;
			pi.registerTool(withHeader(name, builtin));
			registered.add(name);
		}
	});
}
