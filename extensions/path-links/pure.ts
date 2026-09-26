/**
 * Pure helpers for path-links (no pi imports, unit-testable).
 */

/** Strip a trailing `:42`, `:42:7`, `:1-5`, or `#L9` locator (but never a bare `C:` drive). */
const LOCATOR = /^(.{2,}?)((?::\d+(?:-\d+)?)|(?::\d+:\d+)|(?:#L\d+))$/;

/** Heuristic pre-filter so shell commands, calls, and identifiers never hit the filesystem. */
export function looksLikePath(bare: string): boolean {
	if (!bare || /\s/.test(bare)) return false;
	return (
		bare.startsWith("/") ||
		bare.startsWith("~") ||
		bare.startsWith("./") ||
		bare.startsWith("../") ||
		bare.startsWith(".\\") ||
		bare.startsWith("..\\") ||
		bare.includes("/") ||
		/^[a-zA-Z]:[\\/]/.test(bare) ||
		bare.startsWith("\\\\") ||
		bare.includes("\\") ||
		/^[\w.-]+\.[a-zA-Z][a-zA-Z0-9]*$/.test(bare)
	);
}

/** The path part of an inline-code span, without any line/column locator. */
export function barePath(raw: string): string {
	const match = raw.match(LOCATOR);
	return match ? match[1] : raw;
}

/** Characters that markdown would otherwise interpret inside the replaced text. */
export function escapeMarkdown(text: string): string {
	return text.replace(/[\\`*_[\]<>|~]/g, "\\$&");
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const INDENTED_CODE = /^( {4}|\t)/;
const INLINE_CODE = /(?<!`)`([^`\n]+)`(?!`)/g;

/**
 * Replace single-backtick inline code spans that `render` recognizes, outside fenced
 * and indented code blocks. `render` returns the replacement text or undefined to keep
 * the span as inline code.
 */
export function linkifyInlineCode(markdown: string, render: (code: string) => string | undefined): string {
	if (!markdown.includes("`")) return markdown;
	let fence: string | undefined;
	return markdown
		.split("\n")
		.map((line) => {
			const fenceMatch = line.match(FENCE);
			if (fenceMatch) {
				const marker = fenceMatch[1];
				if (!fence) fence = marker;
				else if (marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
				return line;
			}
			if (fence || INDENTED_CODE.test(line)) return line;
			return line.replace(INLINE_CODE, (span, code: string) => render(code) ?? span);
		})
		.join("\n");
}

/** Existence cache: positives forever (per process), negatives briefly so new files show up. */
export class ExistsCache {
	private readonly positives = new Set<string>();
	private readonly negatives = new Map<string, number>();

	constructor(
		private readonly exists: (path: string) => boolean,
		private readonly negativeTtlMs = 5000,
		private readonly now: () => number = Date.now,
	) {}

	has(path: string): boolean {
		if (this.positives.has(path)) return true;
		const checkedAt = this.negatives.get(path);
		if (checkedAt !== undefined && this.now() - checkedAt < this.negativeTtlMs) return false;
		let found = false;
		try {
			found = this.exists(path);
		} catch {
			found = false;
		}
		if (found) {
			this.positives.add(path);
			this.negatives.delete(path);
		} else {
			this.negatives.set(path, this.now());
		}
		return found;
	}
}
