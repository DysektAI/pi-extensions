/**
 * Web Search Extension — Claude Code / Codex CLI-style web search for Pi
 *
 * Provides:
 *   Tool: web_search  — Search the web via Brave Search API or DuckDuckGo fallback
 *   Tool: web_fetch   — Fetch and extract readable text from a specific URL
 *   Command: /web-config — Configure search backend and view status
 *
 * Setup:
 *   export BRAVE_API_KEY=your_key   (optional, enables Brave Search)
 *   export WEB_SEARCH_BACKEND=auto  (auto | brave | duckduckgo)
 *
 * Brave Search is used by Claude Code. DuckDuckGo scraping requires no API key.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";

// ─── Types ───────────────────────────────────────────────────────────────────

interface SearchResult {
	title: string;
	url: string;
	snippet: string;
}

interface FetchResult {
	url: string;
	title: string;
	text: string;
	contentType: string;
	status: number;
}

// ─── Configuration ───────────────────────────────────────────────────────────

const BRAVE_API_KEY = process.env.BRAVE_API_KEY;
const BACKEND = (process.env.WEB_SEARCH_BACKEND ?? "auto") as "auto" | "brave" | "duckduckgo";

function effectiveBackend(): "brave" | "duckduckgo" {
	if (BACKEND === "brave" && BRAVE_API_KEY) return "brave";
	if (BACKEND === "duckduckgo") return "duckduckgo";
	if (BACKEND === "auto" && BRAVE_API_KEY) return "brave";
	return "duckduckgo";
}

// ─── HTML Text Extraction ────────────────────────────────────────────────────

function extractTextFromHtml(html: string, url: string): { title: string; text: string } {
	// Extract title
	const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
	const title = titleMatch?.[1]?.trim() ?? url;

	// Remove scripts, styles, nav, footer, aside, header
	let cleaned = html
		.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ")
		.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
		.replace(/<nav[\s\S]*?<\/nav>/gi, " ")
		.replace(/<footer[\s\S]*?<\/footer>/gi, " ")
		.replace(/<aside[\s\S]*?<\/aside>/gi, " ")
		.replace(/<header[\s\S]*?<\/header>/gi, " ")
		.replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
		.replace(/<!--[\s\S]*?-->/g, " ");

	// Extract text from main/article/content areas preferentially
	const mainMatch = cleaned.match(/<main[\s\S]*?<\/main>/i)
		?? cleaned.match(/<article[\s\S]*?<\/article>/i)
		?? cleaned.match(/<div[^>]*id=["']?(?:content|main)["']?[^>]*>[\s\S]*?<\/div>/i);

	if (mainMatch) {
		cleaned = mainMatch[0];
	}

	// Convert common block elements to newlines
	cleaned = cleaned
		.replace(/<\/(?:p|div|h[1-6]|li|tr|pre|blockquote)>/gi, "\n")
		.replace(/<br\s*\/?>/gi, "\n");

	// Strip remaining tags
	cleaned = cleaned.replace(/<[^>]+>/g, " ");

	// Decode common entities
	cleaned = cleaned
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));

	// Normalize whitespace
	cleaned = cleaned
		.replace(/\r\n/g, "\n")
		.replace(/\r/g, "\n")
		.replace(/[ \t]+/g, " ")
		.replace(/\n{3,}/g, "\n\n")
		.trim();

	return { title, text: cleaned };
}

// ─── Brave Search ────────────────────────────────────────────────────────────

async function searchBrave(query: string, count: number, signal?: AbortSignal): Promise<SearchResult[]> {
	if (!BRAVE_API_KEY) {
		throw new Error("BRAVE_API_KEY not set");
	}

	const url = new URL("https://api.search.brave.com/res/v1/web/search");
	url.searchParams.set("q", query);
	url.searchParams.set("count", String(Math.min(count, 20)));
	url.searchParams.set("offset", "0");
	url.searchParams.set("mkt", "en-US");
	url.searchParams.set("safesearch", "off");
	url.searchParams.set("text_decorations", "false");

	const response = await fetch(url.toString(), {
		headers: {
			Accept: "application/json",
			"X-Subscription-Token": BRAVE_API_KEY,
		},
		signal,
	});

	if (!response.ok) {
		const body = await response.text().catch(() => "");
		throw new Error(`Brave Search HTTP ${response.status}: ${body.slice(0, 200)}`);
	}

	const data = (await response.json()) as {
		web?: {
			results?: Array<{
				title?: string;
				url?: string;
				description?: string;
			}>;
		};
	};

	const results = data.web?.results ?? [];
	return results.map((r) => ({
		title: r.title ?? "Untitled",
		url: r.url ?? "",
		snippet: r.description ?? "",
	}));
}

// ─── DuckDuckGo Search (Lite HTML scraping) ──────────────────────────────────

async function searchDuckDuckGo(query: string, count: number, signal?: AbortSignal): Promise<SearchResult[]> {
	// DuckDuckGo Lite is a simple HTML interface with no JS required
	const url = new URL("https://lite.duckduckgo.com/lite/");
	const formData = new URLSearchParams();
	formData.set("q", query);
	formData.set("kl", "us-en");

	const response = await fetch(url.toString(), {
		method: "POST",
		body: formData,
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
			Accept: "text/html",
			Referer: "https://lite.duckduckgo.com/",
		},
		signal,
	});

	if (!response.ok) {
		throw new Error(`DuckDuckGo Lite HTTP ${response.status}`);
	}

	const html = await response.text();
	const results: SearchResult[] = [];

	// DuckDuckGo Lite HTML: href comes before class='result-link'
	const linkRegex = /<a[^>]+href=['"]([^'"]+)['"][^>]*class=['"]result-link['"][^>]*>([\s\S]*?)<\/a>/gi;
	const links: Array<{ url: string; title: string; index: number }> = [];
	let match: RegExpExecArray | null;

	while ((match = linkRegex.exec(html)) !== null) {
		links.push({
			url: match[1],
			title: match[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
			index: match.index,
		});
	}

	for (let i = 0; i < links.length && results.length < count; i++) {
		const link = links[i];
		let resultUrl = link.url;
		if (resultUrl.startsWith("//")) resultUrl = "https:" + resultUrl;
		if (resultUrl.startsWith("/")) resultUrl = "https://lite.duckduckgo.com" + resultUrl;

		// Find snippet between this link and the next link (or end)
		const start = link.index;
		const end = i + 1 < links.length ? links[i + 1].index : html.length;
		const segment = html.slice(start, end);

		const snippetMatch = segment.match(/<td[^>]*class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/i);
		const snippet = snippetMatch
			? snippetMatch[1]
				.replace(/<[^>]+>/g, " ")
				.replace(/\s+/g, " ")
				.trim()
			: "";

		results.push({
			title: link.title || "Untitled",
			url: resultUrl,
			snippet,
		});
	}

	return results;
}

// ─── Unified Search ──────────────────────────────────────────────────────────

async function searchWeb(query: string, count: number, signal?: AbortSignal): Promise<SearchResult[]> {
	const backend = effectiveBackend();

	if (backend === "brave") {
		try {
			return await searchBrave(query, count, signal);
		} catch (err) {
			// Fallback to DuckDuckGo on Brave failure
			console.error(`[web-search] Brave failed: ${err}. Falling back to DuckDuckGo.`);
			return searchDuckDuckGo(query, count, signal);
		}
	}

	return searchDuckDuckGo(query, count, signal);
}

// ─── Web Fetch ───────────────────────────────────────────────────────────────

async function fetchUrl(url: string, signal?: AbortSignal): Promise<FetchResult> {
	const response = await fetch(url, {
		headers: {
			Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8",
			"User-Agent": "Mozilla/5.0 (compatible; PiWebSearch/1.0)",
		},
		signal,
		redirect: "follow",
	});

	const contentType = response.headers.get("content-type") ?? "unknown";
	const status = response.status;

	let title = url;
	let text: string;

	if (contentType.includes("text/html")) {
		const html = await response.text();
		const extracted = extractTextFromHtml(html, url);
		title = extracted.title;
		text = extracted.text;
	} else if (contentType.includes("text/plain")) {
		text = await response.text();
	} else {
		// For other content types, return a summary
		const blob = await response.blob();
		text = `[Binary content: ${contentType}, ${blob.size} bytes]`;
	}

	// Truncate to avoid overwhelming context
	const MAX_CHARS = 48000;
	if (text.length > MAX_CHARS) {
		text = text.slice(0, MAX_CHARS) + "\n\n[Content truncated. Use web_fetch with a more specific URL or ask for a specific section.]";
	}

	return { url, title, text, contentType, status };
}

// ─── Schemas ─────────────────────────────────────────────────────────────────

const WebSearchParams = Type.Object({
	query: Type.String({ description: "Search query" }),
	count: Type.Optional(Type.Number({ description: "Number of results (1-20, default 5)", default: 5 })),
});

const WebFetchParams = Type.Object({
	url: Type.String({ description: "URL to fetch" }),
});

// ─── Extension ───────────────────────────────────────────────────────────────

export default function webSearchExtension(pi: ExtensionAPI) {
	// Notify on load about available backend
	pi.on("session_start", async (_event, ctx) => {
		const backend = effectiveBackend();
		const source = backend === "brave" ? "Brave Search API" : "DuckDuckGo (no API key)";
		ctx.ui.setStatus("web-search", `🔍 ${source}`);
	});

	pi.on("session_shutdown", async () => {
		/* cleanup if needed */
	});

	// ─── Proactive search injection ────────────────────────────────────────
	// Append a strong reminder to the system prompt on every turn so the
	// agent does not skip search when current info is needed.
	pi.on("before_agent_start", async (event, _ctx) => {
		const reminder =
			"\n\n[Web Search Directive] You have real-time web search (web_search) and page fetching (web_fetch) available. " +
			"For ANY user query involving current versions, recent releases, latest documentation, API changes, breaking changes, " +
			"deprecated features, pricing, or facts that may have changed after your knowledge cutoff, you MUST call web_search " +
			"proactively BEFORE answering. Do not guess, hallucinate, or rely on training-data memory when current information " +
			"is likely to have changed. After searching, use web_fetch to read full content from the most relevant result(s).";
		return { systemPrompt: event.systemPrompt + reminder };
	});

	// ─── Tool: web_search ──────────────────────────────────────────────────

	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description:
			"Search the web for current information. Use when you need up-to-date facts, documentation, API references, or information that may not be in your training data. Returns a list of search results with titles, URLs, and snippets.",
		promptSnippet: "Search the web for current information",
		promptGuidelines: [
			"ALWAYS use web_search proactively when the user asks about current versions, recent releases, latest documentation, API changes, breaking changes, deprecated features, or any information that may have changed after your knowledge cutoff. Do not guess.",
			"Use web_search to find official documentation, API references, or library usage examples.",
			"After searching, use web_fetch to retrieve full content from the most relevant result(s).",
			"Keep queries specific and concise for better results.",
			"If search returns no useful results, try rephrasing the query with different keywords.",
		],
		parameters: WebSearchParams,

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const query = params.query.trim();
			if (!query) {
				throw new Error("Search query cannot be empty");
			}

			const count = Math.min(Math.max(params.count ?? 5, 1), 20);
			const backend = effectiveBackend();

			ctx.ui.setStatus("web-search", `🔍 searching: ${truncateToWidth(query, 40)}`);

			try {
				const results = await searchWeb(query, count, signal);
				ctx.ui.setStatus("web-search", `🔍 ${backend} (${results.length} results)`);

				if (results.length === 0) {
					return {
						content: [{ type: "text", text: "No results found." }],
						details: { query, backend, results: [] },
					};
				}

				const lines: string[] = [`Search results for "${query}":\n`];
				for (let i = 0; i < results.length; i++) {
					const r = results[i];
					lines.push(`${i + 1}. ${r.title}`);
					lines.push(`   URL: ${r.url}`);
					if (r.snippet) lines.push(`   ${r.snippet}`);
					lines.push("");
				}

				return {
					content: [{ type: "text", text: lines.join("\n") }],
					details: { query, backend, results },
				};
			} catch (err) {
				ctx.ui.setStatus("web-search", "🔍 error");
				throw err;
			}
		},

		renderCall(args, theme) {
			const query = args.query ?? "";
			return new Text(
				theme.fg("toolTitle", theme.bold("Web Search ")) +
					theme.fg("muted", truncateToWidth(query, 60)),
				0,
				0,
			);
		},

		renderResult(result, _options, theme) {
			const details = result.details as { query?: string; backend?: string; results?: SearchResult[] } | undefined;
			const count = details?.results?.length ?? 0;
			const backend = details?.backend ?? "unknown";
			return new Text(
				theme.fg("success", "✓ ") +
					theme.fg("muted", `${count} result${count === 1 ? "" : "s"} via ${backend}`),
				0,
				0,
			);
		},
	});

	// ─── Tool: web_fetch ───────────────────────────────────────────────────

	pi.registerTool({
		name: "web_fetch",
		label: "Web Fetch",
		description:
			"Fetch and extract readable text content from a specific URL. Use after web_search to read full articles, documentation pages, or any web page. Returns the page title and extracted text content.",
		promptSnippet: "Fetch readable text from a URL",
		promptGuidelines: [
			"Use web_fetch after web_search to read the full content of the most relevant result.",
			"If a page is too long, it will be truncated; ask the user if they need a specific section.",
			"Use web_fetch for documentation pages, blog posts, GitHub readmes, or any HTML page.",
			"Respect robots.txt and do not aggressively fetch from the same domain in rapid succession.",
		],
		parameters: WebFetchParams,

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const url = params.url.trim();
			if (!url) {
				throw new Error("URL cannot be empty");
			}
			if (!url.startsWith("http://") && !url.startsWith("https://")) {
				throw new Error("URL must start with http:// or https://");
			}

			ctx.ui.setStatus("web-search", `📄 fetching: ${truncateToWidth(url, 50)}`);

			try {
				const fetched = await fetchUrl(url, signal);
				ctx.ui.setStatus("web-search", `📄 ${truncateToWidth(fetched.title, 40)}`);

				const text = [`Title: ${fetched.title}`, `URL: ${fetched.url}`, `Status: ${fetched.status}`, `Content-Type: ${fetched.contentType}`, "", fetched.text];

				return {
					content: [{ type: "text", text: text.join("\n") }],
					details: { url: fetched.url, title: fetched.title, status: fetched.status, contentType: fetched.contentType },
				};
			} catch (err) {
				ctx.ui.setStatus("web-search", "📄 error");
				throw err;
			}
		},

		renderCall(args, theme) {
			const url = args.url ?? "";
			return new Text(
				theme.fg("toolTitle", theme.bold("Web Fetch ")) +
					theme.fg("muted", truncateToWidth(url, 60)),
				0,
				0,
			);
		},

		renderResult(result, _options, theme) {
			const details = result.details as { title?: string; status?: number } | undefined;
			const title = details?.title ?? "fetched";
			const status = details?.status ?? 0;
			const ok = status >= 200 && status < 300;
			return new Text(
				(ok ? theme.fg("success", "✓ ") : theme.fg("warning", `⚠ ${status} `)) +
					theme.fg("muted", truncateToWidth(title, 60)),
				0,
				0,
			);
		},
	});

	// ─── Command: /web-config ──────────────────────────────────────────────

	pi.registerCommand("web-config", {
		description: "Show web search configuration",
		handler: async (_args, ctx) => {
			const backend = effectiveBackend();
			const lines = [
				"Web Search Configuration",
				"",
				`Backend:     ${backend}`,
				`BRAVE_API_KEY: ${BRAVE_API_KEY ? "✓ set" : "✗ not set"}`,
				`WEB_SEARCH_BACKEND: ${BACKEND}`,
				"",
				backend === "brave"
					? "Using Brave Search API (high quality, fast)"
					: "Using DuckDuckGo Lite scraping (free, no API key)",
				"",
				"To use Brave Search:",
				"  export BRAVE_API_KEY=your_key",
				"  export WEB_SEARCH_BACKEND=brave",
				"",
				"Get a free Brave Search API key at:",
				"  https://brave.com/search/api/",
			];
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
