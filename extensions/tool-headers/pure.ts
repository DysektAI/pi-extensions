/**
 * Pure helpers for tool-headers (no pi imports, unit-testable).
 *
 * Built-in tool calls render as `name args` on one line. This extension renders
 * a bold `[Name Tool]` header on its own line with the arguments beneath.
 */

/** Built-in tools whose call line is rewritten. */
export const HEADER_TOOLS = ["bash", "powershell", "read", "edit", "write", "grep", "find", "ls"] as const;
export type HeaderTool = (typeof HEADER_TOOLS)[number];

/** Tools whose first argument is a file path (recoloured as a link). */
export const PATH_TOOLS: ReadonlySet<string> = new Set(["read", "edit", "write", "ls"]);

const LABELS: Record<string, string> = { bash: "Bash", powershell: "PowerShell", ls: "Ls" };

/** `[Bash Tool]`, `[PowerShell Tool]`, `[Read Tool]`, ... */
export function toolHeaderLabel(name: string): string {
	const label = LABELS[name] ?? name.charAt(0).toUpperCase() + name.slice(1);
	return `[${label} Tool]`;
}

/**
 * Collapse multi-line commands (heredocs, `node -e` scripts, split &&-chains) into
 * one title line. The raw command stays intact in the tool args and output.
 */
export function collapseCommand(command: string): string {
	return command.replace(/\s+/g, " ").trim();
}

export interface CallRewrite {
	/** Styled `name ` prefix the built-in renderer emits (e.g. bold toolTitle "read" + space). */
	prefix: string;
	/** Styled replacement header, e.g. bold toolTitle "[Read Tool]". */
	header: string;
	/** Exact string replacements applied to the rest of the first line only. */
	swaps?: ReadonlyArray<readonly [string, string]>;
}

/**
 * Move the built-in call line's arguments under a header line. Returns undefined when
 * the text does not start with the expected prefix (e.g. a compact renderer variant),
 * so callers leave that output untouched.
 */
export function rewriteCallText(text: string, rewrite: CallRewrite): string | undefined {
	if (!text.startsWith(rewrite.prefix)) return undefined;
	const newline = text.indexOf("\n");
	const firstLineEnd = newline === -1 ? text.length : newline;
	let rest = text.slice(rewrite.prefix.length, firstLineEnd);
	for (const [from, to] of rewrite.swaps ?? []) {
		if (from && rest.includes(from)) rest = rest.split(from).join(to);
	}
	return `${rewrite.header}\n${rest}${text.slice(firstLineEnd)}`;
}

/** VS Code routes OSC 8 file links to the host OS, which breaks under Remote-WSL/SSH. */
export function isVscodeTerminal(env: NodeJS.ProcessEnv = process.env): boolean {
	return (env.TERM_PROGRAM ?? "").toLowerCase() === "vscode";
}

/** Replace a leading home directory with `~`, matching Pi's built-in path display. */
export function shortenPath(path: string, home: string): string {
	return home && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}
