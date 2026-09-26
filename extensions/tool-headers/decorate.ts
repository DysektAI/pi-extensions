/**
 * Runtime half of tool-headers: rewrites a built-in renderer's call component in place.
 * Shared with read-full-header so `read` gets the same header when that extension owns it.
 */
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { getCapabilities, hyperlink } from "@earendil-works/pi-tui";

import { collapseCommand, isVscodeTerminal, PATH_TOOLS, rewriteCallText, shortenPath, toolHeaderLabel } from "./pure.ts";

interface TextHolder {
	text: string;
	setText(text: string): void;
}

function isTextHolder(value: unknown): value is TextHolder {
	const candidate = value as Partial<TextHolder> | null;
	return typeof candidate?.text === "string" && typeof candidate.setText === "function";
}

/** The call line lives in a Text (read/bash/write/ls/grep/find) or a container's first Text (edit). */
function findCallText(component: unknown): TextHolder | undefined {
	if (isTextHolder(component)) return component;
	const first = (component as { children?: unknown[] } | null)?.children?.[0];
	return isTextHolder(first) ? first : undefined;
}

function absolutePath(raw: string, cwd: string): string {
	const expanded = raw === "~" || raw.startsWith("~/") ? `${homedir()}${raw.slice(1)}` : raw;
	return isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
}

function withLink(styled: string, raw: string, cwd: string): string {
	return getCapabilities().hyperlinks ? hyperlink(styled, pathToFileURL(absolutePath(raw, cwd)).href) : styled;
}

/** What Pi's built-in renderToolPath emits for a non-empty path. */
function builtinPath(raw: string, theme: Theme, cwd: string): string {
	return withLink(theme.fg("accent", shortenPath(raw, homedir())), raw, cwd);
}

/**
 * Paths use the markdown link colour. Under VS Code, emit the full absolute path as
 * underlined plain text so its own link detector opens the file in-window.
 */
function linkedPath(raw: string, theme: Theme, cwd: string): string {
	if (isVscodeTerminal()) return theme.fg("mdLink", theme.underline(absolutePath(raw, cwd)));
	return withLink(theme.fg("mdLink", shortenPath(raw, homedir())), raw, cwd);
}

function pathArg(name: string, args: Record<string, unknown> | undefined): string | undefined {
	const raw = args?.file_path ?? args?.path;
	if (typeof raw === "string" && raw) return raw;
	return name === "ls" && (raw === undefined || raw === "") ? "." : undefined;
}

/** Rewrite a file/search tool call component to the `[Name Tool]` layout. */
export function decorateToolCall<T>(
	name: string,
	component: T,
	args: Record<string, unknown> | undefined,
	theme: Theme,
	cwd: string,
): T {
	const holder = findCallText(component);
	if (!holder) return component;
	const raw = PATH_TOOLS.has(name) ? pathArg(name, args) : undefined;
	const rewritten = rewriteCallText(holder.text, {
		prefix: `${theme.fg("toolTitle", theme.bold(name))} `,
		header: theme.fg("toolTitle", theme.bold(toolHeaderLabel(name))),
		swaps: raw ? [[builtinPath(raw, theme, cwd), linkedPath(raw, theme, cwd)]] : [],
	});
	if (rewritten !== undefined) holder.setText(rewritten);
	return component;
}

/** Shell calls: header (plus timeout) on line one, `$ command` collapsed to one line beneath. */
export function decorateShellCall<T>(
	name: string,
	prompt: string,
	component: T,
	args: { command?: unknown; timeout?: unknown } | undefined,
	theme: Theme,
): T {
	const holder = findCallText(component);
	if (!holder) return component;
	const command = args?.command;
	let display: string;
	if (typeof command === "string" && command) display = collapseCommand(command);
	else if (command == null || command === "") display = theme.fg("toolOutput", "...");
	else display = theme.fg("error", "[invalid arg]");
	const timeout = typeof args?.timeout === "number" ? theme.fg("muted", ` (timeout ${args.timeout}s)`) : "";
	const header = theme.fg("toolTitle", theme.bold(toolHeaderLabel(name))) + timeout;
	holder.setText(`${header}\n${theme.fg("toolTitle", `${prompt} ${display}`)}`);
	return component;
}
