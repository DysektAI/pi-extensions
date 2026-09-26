/**
 * Pure helpers for the thinking-label extension (no pi imports, unit-testable).
 */

/**
 * SGR 23;1 = italic off + bold on in ONE sequence. Thinking blocks render italic, and
 * chalk re-opens the outer italic after a bare "\x1b[23m" it finds inside nested text,
 * so the combined form is what keeps the label upright. 22;3 restores the block style.
 */
export const LABEL_OPEN = "\x1b[23;1m";
export const LABEL_CLOSE = "\x1b[22;3m";
export const LABEL_TEXT = "[Thinking]";

/** Indented code cannot interrupt a paragraph, so it needs a blank line after the label. */
const NEEDS_BLANK_LINE = /^( {4}|\t)/;

/**
 * Prefix thinking markdown with a bold `[Thinking]` line. `colorize` applies the
 * theme's thinkingText foreground so the label matches the block colour.
 */
export function labelThinking(markdown: string, colorize: (text: string) => string): string {
	if (!markdown.trim()) return markdown;
	const label = `${LABEL_OPEN}${colorize(LABEL_TEXT)}${LABEL_CLOSE}`;
	const separator = NEEDS_BLANK_LINE.test(markdown) ? "\n\n" : "\n";
	return `${label}${separator}${markdown}`;
}
