/**
 * Path links: inline code in messages that names an existing file (`src/a.ts`,
 * `/abs/file:42`, `~/x`, `C:\dir\file`) renders in the link colour, underlined, as
 * an OSC 8 file:// hyperlink. In the VS Code integrated terminal it stays plain
 * styled text so VS Code's own detector opens the file in-window (OSC 8 file links
 * go to the host OS there and fail under Remote-WSL/SSH).
 *
 * Uses the public Markdown transformer API; spans that are not existing files keep
 * normal inline-code styling.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { getCapabilities, hyperlink } from "@earendil-works/pi-tui";

import { isVscodeTerminal } from "../tool-headers/pure.ts";
import { barePath, ExistsCache, escapeMarkdown, linkifyInlineCode, looksLikePath } from "./pure.ts";

function absolutePath(raw: string, cwd: string): string {
	const expanded = raw === "~" || raw.startsWith("~/") || raw.startsWith("~\\") ? `${homedir()}${raw.slice(1)}` : raw;
	return isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
}

export default function pathLinks(pi: ExtensionAPI): void {
	let theme: (() => Theme) | undefined;
	let cwd = process.cwd();
	const cache = new ExistsCache(existsSync);

	pi.on("session_start", (_event, ctx) => {
		cwd = ctx.cwd;
		if (ctx.hasUI) theme = () => ctx.ui.theme;
	});

	pi.registerMarkdownTransformer((markdown, context) => {
		// User messages render with preserved backslash escapes, so the escaping a
		// link needs would show up literally (`my\_file.ts`); leave them untouched.
		if (!theme || context.messageType === "user") return markdown;
		const current = theme();
		const vscode = isVscodeTerminal();
		const hyperlinks = !vscode && getCapabilities().hyperlinks;
		return linkifyInlineCode(markdown, (code) => {
			const bare = barePath(code);
			if (!looksLikePath(bare)) return undefined;
			const absolute = absolutePath(bare, cwd);
			if (!cache.has(absolute)) return undefined;
			const styled = current.fg("mdLink", current.underline(escapeMarkdown(code)));
			return hyperlinks ? hyperlink(styled, pathToFileURL(absolute).href) : styled;
		});
	});
}
