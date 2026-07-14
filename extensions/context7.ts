/**
 * Context7 Extension for Pi
 *
 * Provides up-to-date, structured documentation for libraries and frameworks
 * via the Context7 CLI (npx ctx7). Preferred over web search for:
 *   - Dependency issues (npm, pip, cargo, etc.)
 *   - Framework/API usage questions
 *   - Breaking changes or migration guides
 *   - Any question where official docs are the best source
 *
 * Tools:
 *   context7_resolve  — Find the best Context7 library ID for a package/framework
 *   context7_docs     — Query documentation from a resolved library
 *
 * Setup:
 *   npx ctx7 must be available (already installed globally or via npm)
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const MAX_DOCS_CHARS = 32000;

// ─── Helpers ────────────────────────────────────────────────────────────────

async function runCtx7(args: string[], signal?: AbortSignal): Promise<string> {
	const ac = new AbortController();
	if (signal) {
		signal.addEventListener("abort", () => ac.abort());
	}

	const { stdout, stderr } = await execFileAsync("npx", ["ctx7", ...args], {
		timeout: 30000,
		signal: ac.signal,
		maxBuffer: 1024 * 1024,
	});

	if (stderr && !stdout) {
		throw new Error(stderr.slice(0, 500));
	}
	return stdout;
}

function truncateDocs(text: string): string {
	if (text.length <= MAX_DOCS_CHARS) return text;
	return text.slice(0, MAX_DOCS_CHARS) +
		"\n\n[Documentation truncated. Use a more specific query or ask for a particular section.]";
}

// ─── Library Resolution ─────────────────────────────────────────────────────

interface ResolvedLib {
	title: string;
	id: string;
	description: string;
	codeSnippets: number;
	reputation: string;
	score: number;
	versions?: string;
}

function parseLibraryOutput(stdout: string): ResolvedLib[] {
	const libs: ResolvedLib[] = [];
	const entries = stdout.split(/\n(?=\d+\.\s+Title:)/);

	for (const entry of entries) {
		if (!entry.trim()) continue;
		const titleMatch = entry.match(/Title:\s*(.+)/);
		const idMatch = entry.match(/Context7-compatible library ID:\s*(.+)/);
		const descMatch = entry.match(/Description:\s*(.+)/);
		const snippetsMatch = entry.match(/Code Snippets:\s*(\d+)/);
		const repMatch = entry.match(/Source Reputation:\s*(.+)/);
		const scoreMatch = entry.match(/Benchmark Score:\s*([\d.]+)/);
		const versionsMatch = entry.match(/Versions:\s*(.+)/);

		if (idMatch) {
			libs.push({
				title: titleMatch?.[1]?.trim() ?? "Unknown",
				id: idMatch[1].trim(),
				description: descMatch?.[1]?.trim() ?? "",
				codeSnippets: parseInt(snippetsMatch?.[1] ?? "0", 10),
				reputation: repMatch?.[1]?.trim() ?? "Unknown",
				score: parseFloat(scoreMatch?.[1] ?? "0"),
				versions: versionsMatch?.[1]?.trim(),
			});
		}
	}

	return libs.sort((a, b) => b.score - a.score);
}

// ─── Extension ─────────────────────────────────────────────────────────────

export default function context7Extension(pi: ExtensionAPI) {
	// Status indicator
	pi.on("session_start", async (_event, ctx) => {
		ctx.ui.setStatus("context7", "📚 Context7");
	});

	// ─── Directive: prefer Context7 for library/framework docs ───────────
	pi.on("before_agent_start", async (event, _ctx) => {
		const directive =
			"\n\n[Documentation Directive] You have access to Context7 (context7_resolve + context7_docs), " +
			"which provides structured, up-to-date official documentation for libraries and frameworks. " +
			"For ANY task involving dependencies, package installation errors, framework usage, API references, " +
			"breaking changes, migration guides, or library configuration, you MUST use Context7 FIRST. " +
			"Only fall back to web_search if Context7 cannot resolve the library or the query is about " +
			"non-library topics (news, general facts, etc.). This preserves search quota and gives you " +
			"higher-quality structured docs.\n\n" +
			"Workflow: 1) context7_resolve('<library-name>') → 2) context7_docs('<library-id>', '<query>') → 3) Answer.";
		return { systemPrompt: event.systemPrompt + directive };
	});

	// ─── Tool: context7_resolve ──────────────────────────────────────────

	pi.registerTool({
		name: "context7_resolve",
		label: "Context7 Resolve",
		description:
			"Resolve a library or framework name to its Context7 documentation ID. " +
			"Use this FIRST before querying docs. Returns ranked matches with IDs, scores, and descriptions. " +
			"Example libraries: react, nextjs, vue, angular, django, flask, fastapi, express, lodash, axios, etc.",
		promptSnippet: "Find Context7 documentation ID for a library",
		promptGuidelines: [
			"ALWAYS call context7_resolve first when you need docs for a library or framework.",
			"Pass the library name as 'name' (e.g., 'react', 'nextjs', 'python').",
			"Optionally include a brief 'query' to improve ranking (e.g., 'hooks' for React).",
			"Use the top-ranked result's 'id' for context7_docs.",
			"If no results are found, fall back to web_search.",
		],
		parameters: Type.Object({
			name: Type.String({ description: "Library or framework name (e.g., 'react', 'nextjs', 'django')" }),
			query: Type.Optional(Type.String({ description: "Optional query context to improve ranking (e.g., 'hooks', 'routing')" })),
		}),

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const name = params.name.trim();
			if (!name) throw new Error("Library name cannot be empty");

			const query = params.query?.trim() ?? "";
			const args = query ? ["library", name, query] : ["library", name];

			ctx.ui.setStatus("context7", `📚 resolving: ${truncateToWidth(name, 30)}`);

			try {
				const stdout = await runCtx7(args, signal);
				const libs = parseLibraryOutput(stdout);

				ctx.ui.setStatus("context7", `📚 ${libs.length} lib${libs.length === 1 ? "" : "s"} found`);

				if (libs.length === 0) {
					return {
						content: [{ type: "text", text: `No Context7 library found for "${name}". Try web_search instead.` }],
						details: { name, query, libs: [] },
					};
				}

				const lines: string[] = [`Context7 libraries for "${name}":\n`];
				for (let i = 0; i < libs.length; i++) {
					const l = libs[i];
					lines.push(`${i + 1}. ${l.title}`);
					lines.push(`   ID: ${l.id}`);
					lines.push(`   Score: ${l.score} | Snippets: ${l.codeSnippets} | Reputation: ${l.reputation}`);
					if (l.versions) lines.push(`   Versions: ${l.versions}`);
					if (l.description) lines.push(`   ${l.description}`);
					lines.push("");
				}
				lines.push("Use the 'id' field with context7_docs to query documentation.");

				return {
					content: [{ type: "text", text: lines.join("\n") }],
					details: { name, query, libs },
				};
			} catch (err) {
				ctx.ui.setStatus("context7", "📚 error");
				throw err;
			}
		},

		renderCall(args, theme) {
			const name = args.name ?? "";
			return new Text(
				theme.fg("toolTitle", theme.bold("Context7 Resolve ")) +
					theme.fg("muted", truncateToWidth(name, 50)),
				0, 0,
			);
		},

		renderResult(result, _options, theme) {
			const details = result.details as { libs?: ResolvedLib[] } | undefined;
			const count = details?.libs?.length ?? 0;
			return new Text(
				theme.fg("success", "✓ ") +
					theme.fg("muted", `${count} library match${count === 1 ? "" : "es"}`),
				0, 0,
			);
		},
	});

	// ─── Tool: context7_docs ─────────────────────────────────────────────

	pi.registerTool({
		name: "context7_docs",
		label: "Context7 Docs",
		description:
			"Query structured documentation from a Context7 library. " +
			"Use AFTER context7_resolve to get the library ID. " +
			"Returns official docs, code snippets, and API references for the exact query. " +
			"Ideal for dependency errors, framework usage, breaking changes, and API questions.",
		promptSnippet: "Query official library docs via Context7",
		promptGuidelines: [
			"Call context7_docs AFTER context7_resolve with the library ID from the top result.",
			"Write a specific, concise query — this is answered from structured docs, not a search engine.",
			"For errors: include the exact error message or symptom in the query.",
			"For APIs: include the function/hook/component name and what you need to know.",
			"If the docs don't answer the question, you may fall back to web_search.",
		],
		parameters: Type.Object({
			libraryId: Type.String({ description: "Context7 library ID from context7_resolve (e.g., '/facebook/react')" }),
			query: Type.String({ description: "Specific question about the library (e.g., 'useEffect cleanup memory leak', 'App Router migration from pages')" }),
		}),

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const libraryId = params.libraryId.trim();
			const query = params.query.trim();
			if (!libraryId) throw new Error("libraryId cannot be empty");
			if (!query) throw new Error("query cannot be empty");

			ctx.ui.setStatus("context7", `📚 docs: ${truncateToWidth(query, 35)}`);

			try {
				const stdout = await runCtx7(["docs", libraryId, query], signal);
				const docs = truncateDocs(stdout.trim());

				ctx.ui.setStatus("context7", `📚 docs fetched`);

				return {
					content: [{ type: "text", text: docs }],
					details: { libraryId, query, length: docs.length },
				};
			} catch (err) {
				ctx.ui.setStatus("context7", "📚 error");
				throw err;
			}
		},

		renderCall(args, theme) {
			const query = args.query ?? "";
			return new Text(
				theme.fg("toolTitle", theme.bold("Context7 Docs ")) +
					theme.fg("muted", truncateToWidth(query, 50)),
				0, 0,
			);
		},

		renderResult(result, _options, theme) {
			const details = result.details as { length?: number } | undefined;
			const len = details?.length ?? 0;
			return new Text(
				theme.fg("success", "✓ ") +
					theme.fg("muted", `${len} chars of docs`),
				0, 0,
			);
		},
	});
}
