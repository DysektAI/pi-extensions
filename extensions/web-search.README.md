# Web Search Extension for Pi

A Pi extension that brings Claude Code / Codex CLI-style web search capabilities to your terminal coding agent.

## Features

- **`web_search`** — Search the web for current information, documentation, API references, and news
- **`web_fetch`** — Fetch and extract readable text from any URL
- **`/web-config`** — View current search backend configuration

## Search Backends

### Brave Search API (recommended)

High-quality, fast results. Same backend used by Claude Code.

```bash
export BRAVE_API_KEY=your_key_here
export WEB_SEARCH_BACKEND=brave
```

Get a free API key at [brave.com/search/api](https://brave.com/search/api/) (2000 queries/month free).

### DuckDuckGo Lite (fallback, no API key)

Free web scraping fallback that works out of the box. Used automatically when Brave is unavailable.

```bash
# No setup required — used by default when BRAVE_API_KEY is not set
export WEB_SEARCH_BACKEND=duckduckgo
```

### Auto mode (default)

Automatically uses Brave if `BRAVE_API_KEY` is set, otherwise falls back to DuckDuckGo.

## Installation

Copy `web-search.ts` to your Pi extensions directory:

```bash
# Global (all projects)
cp web-search.ts ~/.pi/agent/extensions/

# Project-local (current project only)
cp web-search.ts .pi/extensions/
```

Then reload Pi with `/reload` or restart.

## Usage

The model will automatically use `web_search` when you ask about:

- Recent events or current versions
- Documentation not in its training data
- API references or library usage
- Anything time-sensitive

Example prompts:

- "What is the latest version of React?"
- "Search for the Node.js fetch API documentation"
- "Find the current Tailwind CSS v4 migration guide"

After searching, the model can use `web_fetch` to read full content from the most relevant results.

## How It Works

### Web Search

1. Takes a query and result count
2. Calls Brave Search API or scrapes DuckDuckGo Lite
3. Returns structured results with title, URL, and snippet
4. Custom TUI renderer shows search status and result count

### Web Fetch

1. Takes a URL
2. Fetches with appropriate headers and redirect following
3. Extracts readable text from HTML (strips scripts, styles, nav, etc.)
4. Prefers `<main>` or `<article>` content
5. Truncates to ~48KB to avoid overwhelming context
6. Returns title, status, content-type, and extracted text

## Error Handling

- Empty queries are rejected before network calls
- Invalid URLs are rejected (must start with `http://` or `https://`)
- Network errors are surfaced to the model
- Brave failures automatically fall back to DuckDuckGo
- Binary content types are summarized instead of extracted

## Design Notes

- **No dependencies** — Uses only Node.js built-ins (`fetch`, `URL`, `URLSearchParams`)
- **Lightweight** — ~430 lines, no external npm packages needed
- **Respectful** — Sends proper User-Agent, follows redirects, handles robots.txt implicitly
- **Context-aware** — Truncates large pages, preserves structured output
