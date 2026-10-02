import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";
import { mkdir, readFile, writeFile } from "fs/promises";
import { dirname, join } from "path";

/**
 * Morph (Morphllm) provider for pi — https://morphllm.com
 *
 * Morph serves Open-weight "Fast Models" (Kimi K3, GLM-5.3, GLM-5.3-Flash,
 * DeepSeek V4(.1) Flash, GLM-5.2) plus specialized tool models (Fast Apply
 * v3, Compact, WarpGrep) over an OpenAI-compatible API at
 * https://api.morphllm.com/v1. This extension fetches GET /models at startup
 * and registers the catalog under the `morph` provider.
 *
 * Fast Apply / Compact / WarpGrep are single-purpose tools with built-in
 * prompt formats (NOT chat agents) — they are registered for completeness
 * but marked text-only toolless so pi doesn't route coding sessions at them.
 *
 * Auth: the key that successfully fetched the catalog is the one registered
 * for chat, so discovery and requests stay consistent. `readApiKey` checks
 * `auth.json` first (`{"morph": {"type": "api_key", "key": "sk-..."}}` or a
 * bare string), then `$MORPH_API_KEY`.
 *
 * Resilience:
 * - Never throws. A failed fetch falls back to the last-known model list
 *   cached on disk, so models still appear when Morph is briefly unreachable.
 * - If neither the fetch nor the cache yields a catalog, a curated fallback
 *   list (Fast Models from docs.morphllm.com) is registered so the provider
 *   is immediately usable; pricing there is a snapshot and the catalog fetch
 *   is authoritative.
 *
 * Live-verified against api.morphllm.com (2026-09):
 * - streaming works with stream_options.include_usage (usage on final chunk)
 * - reasoning_effort accepts none/minimal/low/medium/high/xhigh/max — exactly
 *   pi's native levels, so no thinkingLevelMap mapping is needed
 * - OpenAI function tool calling works (finish_reason "tool_calls")
 * - max_tokens up to 32768 accepted on Fast Models
 * - session affinity: x-session-id / x-client-request-id headers + OpenAI
 *   prompt_cache_key are honored for automatic prefix caching
 */

const BASE_URL = (process.env.MORPH_BASE_URL ?? "https://api.morphllm.com/v1").replace(/\/+$/, "");
const FETCH_TIMEOUT_MS = Number(process.env.MORPH_MODELS_TIMEOUT_MS ?? 10000);
const USER_AGENT = "morph-pi/1.0";

interface CatalogModel {
	id: string;
	name?: string;
	owned_by?: string;
	supported_parameters?: string[];
}

/** Curated metadata per model id: display name, cost $/Mtok, capabilities. */
interface ModelMeta {
	name: string;
	input: number;
	output: number;
	cacheRead?: number;
	cacheWrite?: number;
	contextWindow?: number;
	maxTokens?: number;
	input_types?: ("text" | "image")[];
	reasoning?: boolean;
}

// Pricing snapshot from morphllm.com/pricing + docs.morphllm.com (2026-09).
// The catalog fetch is authoritative for which models exist; this table is
// authoritative for names/prices/limits because GET /models carries neither.
const MODEL_META: Record<string, ModelMeta> = {
	// --- Fast Models (docs.morphllm.com/sdk/components/fast-models) ---
	"morph-kimik3": {
		name: "Kimi K3 2.8T",
		input: 2.5,
		output: 14.0,
		cacheRead: 0.29,
		contextWindow: 1_000_000,
		maxTokens: 32_768,
		reasoning: true,
	},
	"morph-kimik3-fast": {
		name: "Kimi K3 2.8T (latency-tuned)",
		input: 6.0,
		output: 22.5,
		cacheRead: 0.6,
		contextWindow: 1_000_000,
		maxTokens: 32_768,
		reasoning: true,
	},
	"morph-glm53-744b": {
		name: "GLM-5.3 744B",
		input: 1.19,
		output: 3.74,
		cacheRead: 0.1955,
		contextWindow: 1_000_000,
		maxTokens: 32_768,
		reasoning: true,
	},
	"morph-glm53flash": {
		name: "GLM-5.3-Flash",
		input: 0.1,
		output: 0.35,
		cacheRead: 0.02,
		contextWindow: 1_000_000,
		maxTokens: 32_768,
		reasoning: true,
		input_types: ["text", "image"],
	},
	"morph-dsv41flash": {
		name: "DeepSeek V4.1 Flash",
		input: 0.3,
		output: 1.2,
		contextWindow: 1_000_000,
		maxTokens: 32_768,
		reasoning: true, // enabled by default; reasoning_effort: none disables
		input_types: ["text", "image"],
	},
	"morph-dsv4flash": {
		name: "DeepSeek V4 Flash",
		input: 0.1420,
		output: 0.3996,
		cacheRead: 0.0359,
		contextWindow: 1_000_000,
		maxTokens: 32_768,
		reasoning: true,
	},
	"morph-dsv4flash-0731": {
		name: "DeepSeek V4 Flash 0731",
		input: 0.1420,
		output: 0.3996,
		cacheRead: 0.0359,
		contextWindow: 1_000_000,
		maxTokens: 32_768,
		reasoning: true,
	},
	"morph-glm52-744b": {
		name: "GLM-5.2 744B",
		input: 1.1,
		output: 4.1,
		cacheRead: 0.2,
		contextWindow: 1_000_000,
		maxTokens: 32_768,
		reasoning: true,
	},
	// --- Single-purpose tool models: NOT chat agents ---
	"morph-v3-fast": { name: "Fast Apply v3 (fast)", input: 0.8, output: 1.2, contextWindow: 82_000, maxTokens: 8192 },
	"morph-v3-large": { name: "Fast Apply v3 (large)", input: 0.9, output: 1.9, contextWindow: 262_000, maxTokens: 8192 },
	auto: { name: "Fast Apply (auto route)", input: 0.9, output: 1.9, contextWindow: 262_000, maxTokens: 8192 },
	"morph-compactor": { name: "Compact (context compression)", input: 0, output: 0, contextWindow: 200_000, maxTokens: 8192 },
	"morph-warp-grep-v2.1": { name: "WarpGrep (semantic search)", input: 0, output: 0, contextWindow: 200_000, maxTokens: 2048 },
};

const FALLBACK_META_IDS = [
	"morph-kimik3",
	"morph-glm53-744b",
	"morph-glm53flash",
	"morph-dsv41flash",
	"morph-dsv4flash-0731",
];

const DEFAULT_CONTEXT = 1_000_000;
const DEFAULT_MAX_TOKENS = 32_768;

function agentDir(): string {
	return getAgentDir();
}

function cachePath(): string {
	return join(agentDir(), ".cache", "morph-models.json");
}

/** Resolve the Morph API key. auth.json first, then $MORPH_API_KEY. */
async function readApiKey(): Promise<string | undefined> {
	try {
		const auth = JSON.parse(await readFile(join(agentDir(), "auth.json"), "utf8")) as Record<string, unknown>;
		const entry = auth.morph;
		if (typeof entry === "string") return entry;
		if (entry && typeof entry === "object" && typeof (entry as { key?: unknown }).key === "string") {
			return (entry as { key: string }).key;
		}
	} catch {
		// No auth.json entry; fall back to the environment for migration/bootstrap.
	}
	return process.env.MORPH_API_KEY;
}

function extractModels(payload: unknown): CatalogModel[] {
	if (Array.isArray(payload)) return payload as CatalogModel[];
	if (payload && typeof payload === "object" && Array.isArray((payload as { data?: CatalogModel[] }).data)) {
		return (payload as { data: CatalogModel[] }).data;
	}
	return [];
}

async function fetchModels(apiKey: string): Promise<CatalogModel[]> {
	const response = await fetch(`${BASE_URL}/models`, {
		headers: { Authorization: `Bearer ${apiKey}`, "User-Agent": USER_AGENT },
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
	});
	if (!response.ok) {
		const hint = response.status === 401 ? "; update the morph entry in ~/.pi/agent/auth.json" : "";
		throw new Error(`HTTP ${response.status}${hint}`);
	}
	const models = extractModels(await response.json());
	if (models.length === 0) throw new Error("no models returned for this key");
	return models;
}

/** Best-effort cache write; never throws (a cache failure must not break pi). */
async function writeCache(models: CatalogModel[]): Promise<void> {
	try {
		const path = cachePath();
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, JSON.stringify(models), "utf8");
	} catch {
		/* cache is best-effort */
	}
}

async function loadCache(): Promise<CatalogModel[]> {
	try {
		const content = await readFile(cachePath(), "utf8");
		return extractModels(JSON.parse(content));
	} catch {
		return [];
	}
}

function toPiModel(model: CatalogModel) {
	const meta = MODEL_META[model.id];
	return {
		id: model.id,
		name: meta ? `${meta.name} (Morph)` : `${model.name ?? model.id} (Morph)`,
		reasoning: meta?.reasoning ?? false,
		// Morph's reasoning_effort accepts exactly pi's native level names.
		thinkingLevelMap: meta?.reasoning
			? {
					off: "none",
					minimal: "minimal",
					low: "low",
					medium: "medium",
					high: "high",
					xhigh: "xhigh",
					max: "max",
				}
			: undefined,
		input: meta?.input_types ?? (["text"] as ("text" | "image")[]),
		contextWindow: meta?.contextWindow ?? DEFAULT_CONTEXT,
		maxTokens: meta?.maxTokens ?? DEFAULT_MAX_TOKENS,
		cost: {
			input: meta?.input ?? 0,
			output: meta?.output ?? 0,
			cacheRead: meta?.cacheRead ?? 0,
			cacheWrite: meta?.cacheWrite ?? 0,
		},
		compat: {
			// Morph runs a custom inference stack; don't send OpenAI-only fields.
			supportsStore: false,
			supportsDeveloperRole: false,
			// reasoning_effort verified live (none/minimal/low/medium/high/xhigh/max)
			supportsReasoningEffort: true,
			// Morph documents max_tokens (not max_completion_tokens)
			maxTokensField: "max_tokens" as const,
			// Morph advertises prompt_cache_key / x-session-id for prefix-cache
			// affinity; pi sends them only when sessionAffinityFormat is "openai".
			sessionAffinityFormat: "openai" as const,
			sendSessionAffinityHeaders: true,
		},
	};
}

/** Catalog-shaped fallback so `toPiModel` maps them like fetched models. */
function fallbackModels(): CatalogModel[] {
	return FALLBACK_META_IDS.map((id) => ({ id, owned_by: "morph" }));
}

function register(pi: ExtensionAPI, apiKey: string, models: CatalogModel[]): void {
	pi.registerProvider("morph", {
		name: "Morph",
		baseUrl: BASE_URL,
		// Same credential that successfully fetched this catalog so discovery
		// and chat stay consistent; auth.json works without a shell env var.
		apiKey,
		api: "openai-completions",
		authHeader: true,
		headers: { "User-Agent": USER_AGENT },
		models: models.map(toPiModel),
	});
}

export default async function morphProvider(pi: ExtensionAPI): Promise<void> {
	const apiKey = await readApiKey();
	if (!apiKey) {
		console.warn(
			"[morph-provider] No API key found — set MORPH_API_KEY or add a `morph` entry to ~/.pi/agent/auth.json. Morph models will not be listed.",
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
				`[morph-provider] Model fetch failed (${reason}); using ${cached.length} cached models from ${cachePath()}.`,
			);
		} else {
			register(pi, apiKey, fallbackModels());
			console.warn(
				`[morph-provider] Model fetch failed (${reason}) and no cache is available; registered the curated fallback models. Check MORPH_BASE_URL (${BASE_URL}) and that the key is valid.`,
			);
		}
	}
}
