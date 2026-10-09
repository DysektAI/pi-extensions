/**
 * TokenRouter Provider Extension for Pi
 *
 * Registers https://api.tokenrouter.com/v1 as a multi-API provider
 * with dynamically fetched models. TokenRouter is an intelligent LLM routing
 * platform that routes requests across OpenAI, Anthropic, Google, DeepSeek,
 * Qwen, Moonshot, Z-AI, MiniMax, xAI, and more.
 *
 * Most models speak the OpenAI wire API, but Claude ids served only via
 * TokenRouter's Anthropic endpoint are registered as `anthropic-messages`
 * (see `isAnthropicOnlyModel` in ./tokenrouter/pure.ts): sending them OpenAI
 * `reasoning_effort` makes TokenRouter emit legacy `thinking.enabled`, which
 * current Claude generations reject.
 *
 * Auth resolution order:
 * 1. `tokenrouter` entry in ~/.pi/agent/auth.json (persistent, no env var needed)
 * 2. TOKENROUTER_API_KEY environment variable
 *
 * When neither is set, the provider is skipped entirely.
 *
 * Resilience: never throws. The last-known model list cached on disk registers
 * immediately and a background fetch replaces it (see _shared/cache-first.ts),
 * so startup never waits on TokenRouter once a cache exists. The cache is written with 0600 because a catalog fetch requires
 * sending the API key and catalog contents can be sensitive.
 *
 * Model metadata (reasoning support, image input, context window, thinking
 * levels) is derived by the pure helpers in ./tokenrouter/pure.ts so it can be
 * unit tested without the extension runtime.
 *
 * @see https://docs.tokenrouter.io
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdir, readFile, writeFile } from "fs/promises";
import { homedir } from "os";
import { dirname, join } from "path";

import { type CacheFirstResult, nonEmpty, registerCacheFirst } from "./_shared/cache-first.ts";
import { extractModels, isServableModel, type TokenRouterModel, toPiModel } from "./tokenrouter/pure.ts";

const BASE_URL = "https://api.tokenrouter.com/v1";
const FETCH_TIMEOUT_MS = 10000;

/** Resolve the TokenRouter API key: auth.json first (persistent), then env. */
async function readApiKey(): Promise<string | undefined> {
	try {
		const auth = JSON.parse(await readFile(join(homedir(), ".pi", "agent", "auth.json"), "utf8")) as Record<
			string,
			unknown
		>;
		const entry = auth.tokenrouter;
		if (typeof entry === "string") return entry;
		if (entry && typeof entry === "object" && typeof (entry as { key?: unknown }).key === "string") {
			return (entry as { key: string }).key;
		}
	} catch {
		// No auth.json entry; fall back to the environment.
	}
	return process.env.TOKENROUTER_API_KEY;
}

function cachePath(): string {
	return join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), ".cache", "tokenrouter-models.json");
}

async function fetchModels(apiKey: string): Promise<TokenRouterModel[]> {
	const response = await fetch(`${BASE_URL}/models`, {
		headers: { Authorization: `Bearer ${apiKey}` },
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
	});
	if (!response.ok) {
		const hint = response.status === 401 ? "; update the tokenrouter entry in ~/.pi/agent/auth.json" : "";
		throw Object.assign(new Error(`HTTP ${response.status}${hint}`), { status: response.status });
	}
	const models = extractModels(await response.json()).filter(isServableModel);
	if (models.length === 0) throw new Error("no servable models returned for this key");
	return models;
}

/** Best-effort cache write; never throws (a cache failure must not break pi). */
async function writeCache(models: TokenRouterModel[]): Promise<void> {
	try {
		const path = cachePath();
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, JSON.stringify(models), { encoding: "utf8", mode: 0o600 });
	} catch {
		/* cache is best-effort */
	}
}

async function loadCache(): Promise<TokenRouterModel[]> {
	try {
		const content = await readFile(cachePath(), "utf8");
		return extractModels(JSON.parse(content)).filter(isServableModel);
	} catch {
		return [];
	}
}

function register(pi: ExtensionAPI, apiKey: string, models: TokenRouterModel[]): void {
	pi.registerProvider("tokenrouter", {
		name: "TokenRouter",
		baseUrl: BASE_URL,
		// Use the same credential that successfully fetched this catalog so
		// discovery and chat stay consistent; auth.json works without an env var.
		apiKey,
		api: "openai-completions",
		authHeader: true,
		models: models.map(toPiModel),
	});
}

const isAuthFailure = (error: unknown): boolean => [401, 403].includes((error as { status?: number }).status ?? 0);

export default async function tokenrouterProvider(pi: ExtensionAPI): Promise<CacheFirstResult> {
	const apiKey = await readApiKey();
	if (!apiKey) {
		console.warn(
			"[tokenrouter-provider] No API key found — set TOKENROUTER_API_KEY or add a `tokenrouter` entry to ~/.pi/agent/auth.json. TokenRouter models will not be listed.",
		);
		return {};
	}

	return registerCacheFirst({
		loadCache: async () => nonEmpty(await loadCache()),
		fetchFresh: () => fetchModels(apiKey),
		saveCache: writeCache,
		register: (models) => register(pi, apiKey, models),
		onColdFailure: (error) => {
			const reason = error instanceof Error ? error.message : String(error);
			console.warn(
				`[tokenrouter-provider] Model fetch failed (${reason}) and no cache is available. Check the base URL (${BASE_URL}) and that the key is valid.`,
			);
		},
		onRefreshFailure: (error) => {
			if (!isAuthFailure(error)) return;
			pi.unregisterProvider("tokenrouter");
			console.warn(`[tokenrouter-provider] Authentication failed (${(error as Error).message}). TokenRouter models will not be listed.`);
		},
	});
}
