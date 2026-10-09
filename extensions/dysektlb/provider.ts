import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { constants, readFileSync } from "node:fs";
import { mkdir, open, readFile } from "fs/promises";
import { dirname, join } from "path";
import { type CacheFirstResult, nonEmpty, registerCacheFirst } from "../_shared/cache-first.ts";

/**
 * DysektLB provider for pi.
 *
 * pi does not auto-discover models from an OpenAI-compatible endpoint, so this
 * extension fetches `GET {BASE_URL}/models` at startup and registers every
 * DysektLB-served model (Codex, Kiro, and provider-key models like GLM-5.2 /
 * ClinePass) under the `dysektlb` provider. New models added in the DysektLB
 * dashboard appear on the next pi start with no models.json editing.
 *
 * Base URL resolution order: `$DYSEKTLB_BASE_URL`, then `providers.dysektlb.baseUrl`
 * from models.json (pi's provider composition lets a registered extension baseUrl
 * win, so reading it here is what makes models.json authoritative), then the
 * production default.
 *
 * Auth: the key that successfully fetched the catalog is the one registered
 * for chat, so discovery and requests stay consistent and `auth.json` works
 * without a shell-inherited env var. `readApiKey` checks `auth.json` first,
 * then `$DYSEKTLB_API_KEY`.
 *
 * Resilience:
 * - The last-known model list cached on disk registers immediately and a
 *   background fetch replaces it (see _shared/cache-first.ts); only a cold
 *   cache waits for the network. A rejected key withdraws the provider.
 * - Missing key / failed fetch emit a one-line warning so the operator knows
 *   what to fix instead of silently showing no models.
 */

export function resolveBaseUrl(agentDir: string): string {
	const envUrl = process.env.DYSEKTLB_BASE_URL?.trim();
	if (envUrl) {
		return envUrl.replace(/\/+$/, "");
	}
	const modelsPath = join(agentDir, "models.json");
	try {
		const raw = readFileSync(modelsPath, "utf8");
		const data = JSON.parse(raw) as { providers?: Record<string, { baseUrl?: string }> };
		const url = data?.providers?.dysektlb?.baseUrl;
		if (typeof url === "string" && url.trim() !== "") {
			return url.trim().replace(/\/+$/, "");
		}
	} catch (error) {
		// A missing models.json is a normal setup; a present-but-unreadable or
		// malformed one means the operator's intended baseUrl is being ignored,
		// so warn instead of silently falling back to the production default.
		if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
			console.warn(
				`[dysektlb-provider] Could not read providers.dysektlb.baseUrl from ${modelsPath}; check file permissions and JSON syntax. Using the default URL.`,
			);
		}
	}
	return "https://api.dysektai.com/v1";
}

const FETCH_TIMEOUT_MS = Number(process.env.DYSEKTLB_MODELS_TIMEOUT_MS ?? 10000);
const USER_AGENT = "dysekt-pi/1.0";

interface DysektLBModel {
	id: string;
	name?: string;
	owned_by?: string;
	api_types?: string[];
	metadata?: {
		display_name?: string;
		context_window?: number;
		input_context_window?: number;
		max_output_tokens?: number;
		input_modalities?: string[];
		supported_reasoning_levels?: Array<{ effort?: string }>;
		pricing?: Pricing | null;
		prefer_websockets?: boolean;
		supported_in_api?: boolean;
	};
	capabilities?: {
		context_length?: number;
		max_output_tokens?: number;
		supports_reasoning?: boolean;
		supports_images?: boolean;
		supportsImages?: boolean;
		input_modalities?: string[];
	};
	context_length?: number;
	contextLength?: number;
	max_output_tokens?: number;
	maxOutputTokens?: number;
	supports_reasoning?: boolean;
	supportsReasoning?: boolean;
	supports_images?: boolean;
	supportsImages?: boolean;
	supports_vision?: boolean;
	supportsVision?: boolean;
	pricing?: Pricing | null;
}

type Pricing = Record<string, unknown>;

function num(...values: unknown[]): number | undefined {
	for (const value of values) {
		if (typeof value === "number" && Number.isFinite(value)) return value;
		if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
	}
}

function pricePerMillion(pricing: Pricing | null | undefined, ...keys: string[]): number {
	for (const key of keys) {
		const raw = num(pricing?.[key]);
		if (raw !== undefined) return key.endsWith("PerToken") ? raw * 1_000_000 : raw;
	}
	return 0;
}

function titleize(id: string): string {
	return id
		.split(/[\s/_-]+/)
		.filter(Boolean)
		.map((part) => (part.toUpperCase() === part ? part : part.charAt(0).toUpperCase() + part.slice(1)))
		.join(" ");
}

function thinkingLevelMap(model: DysektLBModel) {
	const levels = model.metadata?.supported_reasoning_levels?.map((level) => level.effort).filter(Boolean) ?? [];
	// Hardcoded overrides: some providers support higher reasoning efforts
	// natively even when the DysektLB API metadata doesn't advertise them yet.
	// GPT-6 zoyi models accept xhigh and max, like the GPT-5.6 zoyi models.
	// Match any model ID containing deepseek-v4 (e.g. ds/deepseek-v4-pro,
	// cline-pass/deepseek-v4-flash) plus the abbreviated fw/ds-v4.1-flash alias,
	// which would otherwise expose only low/medium/high while its sibling
	// deepseek/deepseek-v4.1-flash exposes xhigh/max. Only that one id matches
	// the ds-v4 shorthand in the current catalogue, so this adds no false hits.
	const isDeepSeekV4 = /deepseek-v4|ds-v4/.test(model.id);
	const isZoyiGpt6 = /^zoyi\/gpt-6(?:\.\d+)?-/.test(model.id);
	const hasLevels = levels.length > 0 || isDeepSeekV4 || isZoyiGpt6;
	if (!hasLevels) return undefined;
	return {
		minimal: levels.includes("minimal") ? "minimal" : null,
		low: levels.includes("low") ? "low" : null,
		medium: levels.includes("medium") ? "medium" : null,
		high: levels.includes("high") || isDeepSeekV4 ? "high" : null,
		xhigh: levels.includes("xhigh") || isDeepSeekV4 || isZoyiGpt6 ? "xhigh" : null,
		max: levels.includes("max") || isDeepSeekV4 || isZoyiGpt6 ? "max" : null,
	};
}

/** Resolve the DysektLB API key for the startup model-list fetch.
 * auth.json first (works without a shell env var), then $DYSEKTLB_API_KEY. */
async function readApiKey(agentDir: string): Promise<string | undefined> {
	try {
		const auth = JSON.parse(await readFile(join(agentDir, "auth.json"), "utf8")) as Record<string, unknown>;
		const entry = auth.dysektlb;
		if (typeof entry === "string") return entry;
		if (entry && typeof entry === "object" && typeof (entry as { key?: unknown }).key === "string") {
			return (entry as { key: string }).key;
		}
	} catch {
		// No auth.json entry; fall back to the environment for migration/bootstrap.
	}
	if (process.env.DYSEKTLB_API_KEY) return process.env.DYSEKTLB_API_KEY;
}

export function usesResponsesApi(model: DysektLBModel): boolean {
	// DysektLB's Codex-backed models support /v1/responses even though the
	// compatibility catalog currently advertises chat_completions. Prefer the
	// native Responses wire API for models whose catalog explicitly recommends
	// WebSockets: Pi then sends a stable prompt_cache_key/session identity and
	// DysektLB can preserve upstream cache and connection locality. Stateless
	// Kiro/provider-key models stay on Chat Completions.
	return model.owned_by === "dysekt-lb" && model.metadata?.prefer_websockets === true;
}

export function toPiModel(model: DysektLBModel) {
	const inputModalities = model.metadata?.input_modalities ?? model.capabilities?.input_modalities ?? [];
	const supportsImages =
		inputModalities.includes("image") ||
		model.capabilities?.supports_images === true ||
		model.capabilities?.supportsImages === true ||
		model.supports_images === true ||
		model.supportsImages === true ||
		model.supports_vision === true ||
		model.supportsVision === true;
	const pricing = model.metadata?.pricing ?? model.pricing;
	const levels = thinkingLevelMap(model);

	return {
		id: model.id,
		api: usesResponsesApi(model) ? ("openai-responses" as const) : ("openai-completions" as const),
		name: `${model.metadata?.display_name ?? model.name ?? titleize(model.id)} (DysektLB)`,
		reasoning: Boolean(model.capabilities?.supports_reasoning ?? model.supports_reasoning ?? model.supportsReasoning ?? levels),
		thinkingLevelMap: levels,
		input: supportsImages ? (["text", "image"] as const) : (["text"] as const),
		contextWindow: num(
			model.metadata?.context_window,
			model.metadata?.input_context_window,
			model.capabilities?.context_length,
			model.context_length,
			model.contextLength,
		) ?? 128000,
		maxTokens:
			num(
				model.metadata?.max_output_tokens,
				model.capabilities?.max_output_tokens,
				model.max_output_tokens,
				model.maxOutputTokens,
			) ?? 16384,
		cost: {
			input: pricePerMillion(
				pricing,
				"input",
				"prompt",
				"input_cost_per_million",
				"inputCostPerMillion",
				"inputCostPerToken",
				"input_per_1m",
			),
			output: pricePerMillion(
				pricing,
				"output",
				"completion",
				"output_cost_per_million",
				"outputCostPerMillion",
				"outputCostPerToken",
				"output_per_1m",
			),
			cacheRead: pricePerMillion(
				pricing,
				"cache_read",
				"cacheRead",
				"cache_read_cost_per_million",
				"cacheReadCostPerMillion",
				"cached_input_per_1m",
			),
			cacheWrite: pricePerMillion(
				pricing,
				"cache_write",
				"cacheWrite",
				"cache_write_cost_per_million",
				"cacheWriteCostPerMillion",
				"cache_write_per_1m",
			),
		},
		compat: usesResponsesApi(model)
			? {
					supportsDeveloperRole: false,
					sessionAffinityFormat: "openai" as const,
					supportsLongCacheRetention: true,
				}
			: {
					supportsDeveloperRole: false,
					supportsReasoningEffort: true,
				},
	};
}

function optionalStringArray(value: unknown): boolean {
	return value === undefined || (Array.isArray(value) && value.every((entry) => typeof entry === "string"));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validMetadata(value: unknown): boolean {
	if (value === undefined) return true;
	if (!isRecord(value)) return false;
	return (value.display_name === undefined || typeof value.display_name === "string") &&
		optionalStringArray(value.input_modalities) &&
		(value.pricing == null || isRecord(value.pricing)) &&
		(value.supported_reasoning_levels === undefined ||
			(Array.isArray(value.supported_reasoning_levels) && value.supported_reasoning_levels.every((level) =>
				isRecord(level) && (level.effort === undefined || typeof level.effort === "string"))));
}

function isCatalogModel(value: unknown): value is DysektLBModel {
	if (!isRecord(value) || typeof value.id !== "string" || !value.id.trim()) return false;
	return (value.name === undefined || typeof value.name === "string") &&
		(value.owned_by === undefined || typeof value.owned_by === "string") &&
		optionalStringArray(value.api_types) && validMetadata(value.metadata) &&
		(value.capabilities === undefined || (isRecord(value.capabilities) && optionalStringArray(value.capabilities.input_modalities))) &&
		(value.pricing == null || isRecord(value.pricing));
}

export function extractModels(payload: unknown): DysektLBModel[] {
	const entries: unknown[] = Array.isArray(payload) ? payload
		: isRecord(payload) && Array.isArray(payload.data) ? payload.data : [];
	return entries.every(isCatalogModel) ? entries as DysektLBModel[] : [];
}

class CatalogHttpError extends Error {
	constructor(readonly status: number) {
		super(`HTTP ${status}`);
	}
}

async function fetchModels(apiKey: string, baseUrl: string): Promise<DysektLBModel[]> {
	const response = await fetch(`${baseUrl}/models`, {
		headers: { Authorization: `Bearer ${apiKey}`, "User-Agent": USER_AGENT },
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
	});
	if (!response.ok) {
		throw new CatalogHttpError(response.status);
	}
	const models = extractModels(await response.json());
	if (models.length === 0) throw new Error("no models returned for this key");
	return models;
}

/** Best-effort cache write; never throws (a cache failure must not break pi). */
async function writeCache(models: DysektLBModel[], path: string): Promise<void> {
	try {
		await mkdir(dirname(path), { recursive: true, mode: 0o700 });
		// Avoid truncation until POSIX permissions are private; append mode lacks
		// Windows FILE_WRITE_DATA access needed for the subsequent truncation.
		const file = await open(path, constants.O_WRONLY | constants.O_CREAT, 0o600);
		try {
			// Windows relies on the per-user directory ACL, not POSIX chmod.
			if (process.platform !== "win32") await file.chmod(0o600);
			await file.truncate(0);
			await file.writeFile(JSON.stringify(models), "utf8");
		} finally {
			await file.close();
		}
	} catch {
		/* cache is best-effort */
	}
}

async function loadCache(path: string): Promise<DysektLBModel[]> {
	try {
		const content = await readFile(path, "utf8");
		return extractModels(JSON.parse(content));
	} catch {
		return [];
	}
}

function register(pi: ExtensionAPI, apiKey: string, models: DysektLBModel[], baseUrl: string): void {
	pi.registerProvider("dysektlb", {
		name: "DysektLB",
		baseUrl,
		// Use the same credential that successfully fetched this catalog so
		// discovery and chat stay consistent; auth.json works without a shell env var.
		apiKey,
		api: "openai-completions",
		authHeader: true,
		compat: {
			supportsDeveloperRole: false,
			supportsReasoningEffort: true,
		},
		headers: { "User-Agent": USER_AGENT },
		models: models.map(toPiModel),
	});
}

const isAuthFailure = (error: unknown): boolean =>
	error instanceof CatalogHttpError && (error.status === 401 || error.status === 403);

function warnColdFailure(error: unknown, baseUrl: string): void {
	const reason = error instanceof Error ? error.message : String(error);
	if (isAuthFailure(error)) {
		console.warn(`[dysektlb-provider] Authentication failed (${reason}); update the dysektlb entry in auth.json or DYSEKTLB_API_KEY. DysektLB models will not be listed.`);
		return;
	}
	console.warn(
		`[dysektlb-provider] Model fetch failed (${reason}) and no cache is available. Check DYSEKTLB_BASE_URL (${baseUrl}) and that the key is valid.`,
	);
}

export async function dysektlbProvider(pi: ExtensionAPI, agentDir: string): Promise<CacheFirstResult> {
	const baseUrl = resolveBaseUrl(agentDir);
	const path = join(agentDir, ".cache", "dysektlb-models.json");
	const apiKey = await readApiKey(agentDir);
	if (!apiKey) {
		console.warn(
			"[dysektlb-provider] No API key found — set DYSEKTLB_API_KEY or add a `dysektlb` entry to ~/.pi/agent/auth.json. DysektLB models will not be listed.",
		);
		return {};
	}

	return registerCacheFirst({
		loadCache: async () => nonEmpty(await loadCache(path)),
		fetchFresh: () => fetchModels(apiKey, baseUrl),
		saveCache: (models) => writeCache(models, path),
		register: (models) => register(pi, apiKey, models, baseUrl),
		onColdFailure: (error) => warnColdFailure(error, baseUrl),
		onRefreshFailure: (error) => {
			if (!isAuthFailure(error)) return;
			pi.unregisterProvider("dysektlb");
			warnColdFailure(error, baseUrl);
		},
	});
}
