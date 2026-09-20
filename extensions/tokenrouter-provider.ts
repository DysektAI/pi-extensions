/**
 * TokenRouter Provider Extension for Pi
 *
 * Registers https://api.tokenrouter.com/v1 as an OpenAI-compatible provider
 * with dynamically fetched models. TokenRouter is an intelligent LLM routing
 * platform that routes requests across OpenAI, Anthropic, Google, DeepSeek,
 * Qwen, Moonshot, Z-AI, MiniMax, xAI, and more.
 *
 * Auth resolution order:
 * 1. `tokenrouter` entry in ~/.pi/agent/auth.json (persistent, no env var needed)
 * 2. TOKENROUTER_API_KEY environment variable
 *
 * When neither is set, the provider is skipped entirely.
 *
 * Resilience: never throws. A failed fetch falls back to the last-known model
 * list cached on disk, so models still appear when TokenRouter is briefly
 * unreachable. The cache is written with 0600 because a catalog fetch requires
 * sending the API key and catalog contents can be sensitive.
 *
 * @see https://docs.tokenrouter.io
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdir, readFile, writeFile } from "fs/promises";
import { homedir } from "os";
import { dirname, join } from "path";

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

interface TokenRouterModel {
	id: string;
	owned_by?: string;
	supported_endpoint_types?: string[];
	tags?: string;
}

function cachePath(): string {
	return join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), ".cache", "tokenrouter-models.json");
}

/** Models that speak the OpenAI chat-completions wire API. Everything else
 * (gemini-native, anthropic-native, image/video/embeddings/audio endpoints)
 * is not usable through pi's openai-completions driver and is skipped. */
function isChatModel(model: TokenRouterModel): boolean {
	const endpoints = model.supported_endpoint_types ?? [];
	return endpoints.includes("openai");
}

function extractModels(payload: unknown): TokenRouterModel[] {
	if (payload && typeof payload === "object" && Array.isArray((payload as { data?: TokenRouterModel[] }).data)) {
		return (payload as { data: TokenRouterModel[] }).data;
	}
	if (Array.isArray(payload)) return payload as TokenRouterModel[];
	return [];
}

async function fetchModels(apiKey: string): Promise<TokenRouterModel[]> {
	const response = await fetch(`${BASE_URL}/models`, {
		headers: { Authorization: `Bearer ${apiKey}` },
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
	});
	if (!response.ok) {
		const hint = response.status === 401 ? "; update the tokenrouter entry in ~/.pi/agent/auth.json" : "";
		throw new Error(`HTTP ${response.status}${hint}`);
	}
	const models = extractModels(await response.json()).filter(isChatModel);
	if (models.length === 0) throw new Error("no chat models returned for this key");
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
		return extractModels(JSON.parse(content)).filter(isChatModel);
	} catch {
		return [];
	}
}

function titleize(id: string): string {
	return id
		.split(/[\s/_-]+/)
		.filter(Boolean)
		.map((part) => (part.toUpperCase() === part ? part : part.charAt(0).toUpperCase() + part.slice(1)))
		.join(" ");
}

// Substring matches over vendor/model IDs. Ordered most-specific first.
const REASONING_PATTERNS = [
	"deepseek-v4-pro",
	"deepseek-v3.2",
	"deepseek-reasoner",
	"claude-opus",
	"claude-sonnet",
	"gemini-3-pro",
	"gemini-3.5-flash",
	"gemini-3.6-flash",
	"gemini-3.7-flash",
	"gemini-3.8-flash",
	"gpt-5",
	"gpt-6",
	"o1",
	"o3",
	"o4",
	"glm-5",
	"grok-4",
	"nemotron-3",
	"kimi-k2",
	"kimi-k3",
	"qwen3.7",
	"qwen3.8",
	"minimax-m2",
	"step-3.7",
];

// Vendor/model families that accept image input.
const IMAGE_PATTERNS = [
	"gemini",
	"gpt-4o",
	"gpt-5-image",
	"gpt-5.4-vision",
	"glm-4.6v",
	"claude-opus",
	"claude-sonnet",
	"claude-haiku",
	"deepseek-v4-flash-vision",
	"qwen3.5-omni",
	"mimo-v2-omni",
];

const supportsImages = (id: string): boolean => IMAGE_PATTERNS.some((p) => id.toLowerCase().includes(p));

// Context windows per vendor/model family (defaults for unknown models).
const CONTEXT_WINDOWS: Array<[RegExp, number]> = [
	[/^google\//, 1_000_000],
	[/gemini/, 1_000_000],
	[/^openai\/gpt-5|^openai\/gpt-6|^openai\/o[134]/, 400_000],
	[/^anthropic\//, 200_000],
	[/^deepseek\//, 128_000],
	[/^z-ai\/glm/, 200_000],
	[/^moonshotai\//, 256_000],
	[/^minimax\//, 200_000],
	[/^qwen/, 1_000_000],
	[/^x-ai\//, 256_000],
];

function getContextWindow(id: string): number {
	for (const [pattern, size] of CONTEXT_WINDOWS) {
		if (pattern.test(id)) return size;
	}
	return 128_000;
}

/**
 * Reasoning-effort maps per vendor/model family, mirroring pi's built-in
 * provider catalogs (packages/ai/dist/providers/data/*.json). Levels set to
 * null are hidden by pi; unset keys fall back to pass-through. `xhigh`/`max`
 * are only offered when explicitly listed here (getSupportedThinkingLevels).
 *
 * Off maps to "none" only for families with a documented none value; families
 * without one use null (toggle reasoning off client-side instead).
 */
const THINKING_LEVEL_MAPS: Array<{ pattern: RegExp; map: Record<string, string | null> }> = [
	// Z.AI GLM-5.3/5.2 always reason; TokenRouter upstream rejects disabling
	// ("cannot be disabled; please use low, high, or max").
	{ pattern: /glm-5\.3|glm-5\.2/, map: { off: null, minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: "max" } },
	{ pattern: /glm/, map: { off: "none", minimal: null, low: "low", medium: "medium", high: "high", xhigh: null, max: null } },
	// DeepSeek V4: high/max only (V4 advertises max natively)
	{ pattern: /deepseek-v4/, map: { off: null, minimal: null, low: null, medium: null, high: "high", xhigh: null, max: "max" } },
	{ pattern: /deepseek/, map: { off: null, minimal: null, low: "low", medium: null, high: "high", max: "max" } },
	// Moonshot Kimi K3: off/low/high/max
	{ pattern: /kimi-k3/, map: { off: null, minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: "max" } },
	{ pattern: /kimi/, map: { off: null } },
	// OpenAI gpt-5/6, o-series: minimal..xhigh where supported
	{ pattern: /^openai\/gpt-5\.2|^openai\/gpt-5\.3|^openai\/gpt-5\.4|^openai\/gpt-5\.5|^openai\/gpt-5\.6|^openai\/gpt-6/, map: { off: "none", minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: null } },
	{ pattern: /^openai\/gpt-5($|[^.])|^openai\/gpt-5\.0|^openai\/gpt-5\.1/, map: { off: null, minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: null, max: null } },
	{ pattern: /^openai\/o[134]/, map: { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: null, max: null } },
	// xAI Grok: 4.6 adds xhigh
	{ pattern: /grok-4\.6/, map: { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: null } },
	{ pattern: /grok/, map: { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: null, max: null } },
	// Anthropic Claude: low..max (adaptive; pi clamps internally)
	{ pattern: /claude/, map: { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: null, max: "max" } },
];

function getThinkingLevelMap(id: string): Record<string, string | null> | undefined {
	for (const { pattern, map } of THINKING_LEVEL_MAPS) {
		if (pattern.test(id.toLowerCase())) return map;
	}
	return undefined;
}

function toPiModel(model: TokenRouterModel) {
	const id = model.id;
	return {
		id,
		api: "openai-completions" as const,
		name: `${titleize(id)} (TokenRouter)`,
		reasoning: REASONING_PATTERNS.some((p) => id.toLowerCase().includes(p)),
		input: supportsImages(id) ? (["text", "image"] as const) : (["text"] as const),
		contextWindow: getContextWindow(id),
		maxTokens: 16384,
		thinkingLevelMap: getThinkingLevelMap(id),
		// The catalog doesn't expose pricing; 0 avoids fake cost math.
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		compat: {
			supportsDeveloperRole: false,
			maxTokensField: "max_tokens" as const,
			supportsReasoningEffort: true,
		},
	};
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

export default async function tokenrouterProvider(pi: ExtensionAPI): Promise<void> {
	const apiKey = await readApiKey();
	if (!apiKey) {
		console.warn(
			"[tokenrouter-provider] No API key found — set TOKENROUTER_API_KEY or add a `tokenrouter` entry to ~/.pi/agent/auth.json. TokenRouter models will not be listed.",
		);
		return;
	}

	try {
		const models = await fetchModels(apiKey);
		await writeCache(models);
		register(pi, apiKey, models);
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		const cached = await loadCache();
		if (cached.length > 0) {
			register(pi, apiKey, cached);
			console.warn(
				`[tokenrouter-provider] Model fetch failed (${reason}); using ${cached.length} cached models from ${cachePath()}.`,
			);
		} else {
			console.warn(
				`[tokenrouter-provider] Model fetch failed (${reason}) and no cache is available. Check the base URL (${BASE_URL}) and that the key is valid.`,
			);
		}
	}
}
