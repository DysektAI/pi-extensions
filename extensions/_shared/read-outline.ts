/** Dependency-free structural outline extraction for source files. */

export interface OutlineEntry {
	line: number;
	depth: number;
	text: string;
}

export interface OutlineResult {
	entries: OutlineEntry[];
	family?: OutlineFamily;
}

type OutlineFamily = "c-like" | "python" | "ruby" | "go" | "rust";

function familyForLanguage(language: string | undefined): OutlineFamily | undefined {
	switch (language) {
		case "typescript":
		case "javascript":
		case "java":
		case "kotlin":
		case "swift":
		case "c":
		case "cpp":
		case "csharp":
		case "php":
		case "scala":
			return "c-like";
		case "python":
			return "python";
		case "ruby":
			return "ruby";
		case "go":
			return "go";
		case "rust":
			return "rust";
		default:
			return undefined;
	}
}

const DECL_PATTERNS: Record<OutlineFamily, RegExp> = {
	"c-like":
		/^(export\s+)?(default\s+)?(public\s+|private\s+|protected\s+|internal\s+|static\s+|abstract\s+|final\s+|async\s+|override\s+|readonly\s+|sealed\s+|partial\s+)*(class|interface|enum|struct|namespace|module|trait|protocol|extension|function|func|fn|def|record)\b/,
	python: /^(\s*)(async\s+)?(def|class)\s+\w+/,
	ruby: /^(\s*)(def|class|module)\s+[\w:.<]/,
	go: /^(func|type)\s+/,
	rust: /^(\s*)(pub\s+)?(async\s+)?(unsafe\s+)?(fn|struct|enum|trait|impl|mod|type)\b/,
};

const CLIKE_ASSIGNED =
	/^(export\s+)?(default\s+)?(public\s+|private\s+|protected\s+|static\s+|async\s+|readonly\s+)*(const|let|var)\s+\w+\s*[:=].*(=>|\bfunction\b)/;
const CLIKE_METHOD =
	/^(public\s+|private\s+|protected\s+|static\s+|async\s+|get\s+|set\s+|\*\s*)*[\w$]+\s*\([^;]*\)\s*(:[^{;]+)?\{?\s*$/;
const CLIKE_TYPE = /^(export\s+)?(declare\s+)?type\s+\w+[^=]*=/;
const CLIKE_CONTROL = /^(if|else|for|while|switch|catch|do|try|return|case|default|break|continue)\b/;

function indentWidth(line: string): number {
	let width = 0;
	for (const ch of line) {
		if (ch === " " || ch === "\t") width++;
		else break;
	}
	return width;
}

function isCommentOrBlank(trimmed: string): boolean {
	return (
		trimmed === "" ||
		trimmed.startsWith("//") ||
		trimmed.startsWith("#") ||
		trimmed.startsWith("*") ||
		trimmed.startsWith("/*") ||
		trimmed.startsWith("--")
	);
}

export function extractOutline(content: string, language: string | undefined, startLine = 1): OutlineResult {
	const family = familyForLanguage(language);
	if (!family) return { entries: [] };

	const lines = content.split("\n");
	const entries: OutlineEntry[] = [];
	let unit = 0;
	for (const line of lines) {
		const trimmed = line.trim();
		if (isCommentOrBlank(trimmed)) continue;
		const width = indentWidth(line);
		if (width > 0 && (unit === 0 || width < unit)) unit = width;
	}
	if (unit === 0) unit = 1;

	const pattern = DECL_PATTERNS[family];
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index];
		const trimmed = line.trim();
		if (isCommentOrBlank(trimmed)) continue;

		let isDeclaration = pattern.test(family === "go" || family === "c-like" ? trimmed : line);
		if (!isDeclaration && family === "c-like") {
			isDeclaration =
				CLIKE_TYPE.test(trimmed) ||
				CLIKE_ASSIGNED.test(trimmed) ||
				(!CLIKE_CONTROL.test(trimmed) && CLIKE_METHOD.test(trimmed));
		}
		if (!isDeclaration) continue;

		let text = trimmed;
		if (text.endsWith("{")) text = text.slice(0, -1).trimEnd();
		entries.push({ line: startLine + index, depth: Math.floor(indentWidth(line) / unit), text });
	}

	return { entries, family };
}

export function renderOutline(result: OutlineResult, options: { path: string; totalLines: number }): string {
	const count = result.entries.length;
	const header = `Outline of ${options.path} (${options.totalLines} lines, ${count} symbol${count === 1 ? "" : "s"}):`;
	const width = String(options.totalLines).length;
	const body = result.entries
		.map((entry) => {
			const line = String(entry.line).padStart(width, " ");
			return `${line}  ${"  ".repeat(entry.depth)}${entry.text}`;
		})
		.join("\n");
	return `${header}\n${body}\n\n[Outline view: bodies elided. Use read with offset/limit to view a symbol's implementation.]`;
}
