/**
 * Read enhancements:
 * - always render the built-in read tool's full header, even when collapsed;
 * - add `view: "outline"` for a compact declaration index of source files.
 *
 * Normal reads delegate to Pi's built-in implementation. Unsupported outline
 * formats and files without declarations also fall back to a normal read.
 */
import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import {
	createReadToolDefinition,
	getLanguageFromPath,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { extractOutline, renderOutline } from "./_shared/read-outline.ts";

const parameters = Type.Object({
	path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
	offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
	view: Type.Optional(
		Type.Union([Type.Literal("full"), Type.Literal("outline")], {
			description:
				"How to render the file. 'full' (default) returns file contents. 'outline' returns a line-numbered structural summary of declarations with bodies elided.",
		}),
	),
});

type ReadArgs = {
	path: string;
	offset?: number;
	limit?: number;
	view?: "full" | "outline";
};

export default function (pi: ExtensionAPI) {
	const builtin = createReadToolDefinition(process.cwd());
	pi.registerTool({
		...builtin,
		description: `${builtin.description} Use view="outline" to get a line-numbered structural summary of a large source file before reading specific ranges.`,
		parameters,
		async execute(toolCallId, args: ReadArgs, signal, onUpdate, ctx) {
			if (args.view === "outline") {
				const rawPath = args.path.startsWith("@") ? args.path.slice(1) : args.path;
				const absolutePath = isAbsolute(rawPath) ? rawPath : resolve(ctx?.cwd ?? process.cwd(), rawPath);
				try {
					const content = await readFile(absolutePath, { encoding: "utf8", signal });
					const outline = extractOutline(content, getLanguageFromPath(absolutePath));
					if (outline.entries.length > 0) {
						const cwd = ctx?.cwd ?? process.cwd();
						const relativePath = relative(cwd, absolutePath);
						const displayPath = relativePath && !relativePath.startsWith("..") ? relativePath : absolutePath;
						return {
							content: [
								{
									type: "text" as const,
									text: renderOutline(outline, {
										path: displayPath,
										totalLines: content.split("\n").length,
									}),
								},
							],
							details: undefined,
						};
					}
				} catch {
					// Delegate so the built-in tool reports its normal path/read error.
				}
			}

			return builtin.execute(
				toolCallId,
				{ path: args.path, offset: args.offset, limit: args.limit },
				signal,
				onUpdate,
				ctx,
			);
		},
		renderCall(args, theme, context) {
			return builtin.renderCall!(args, theme, { ...context, expanded: true });
		},
	});
}
