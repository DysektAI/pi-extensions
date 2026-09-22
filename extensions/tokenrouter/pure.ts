/**
 * Pure metadata helpers for the TokenRouter provider extension.
 *
 * Dependency-free (no pi-ai / pi-coding-agent imports) so the extension
 * (tokenrouter-provider.ts) and the unit tests (tests.ts) share a single copy of
 * the logic — the same split used by extensions/goal and extensions/subagent.
 *
 * The TokenRouter catalogue exposes no reasoning capability flag: its `tags`
 * field is modality only (Text/Image/Video/Audio/Embedding). Reasoning support
 * is therefore inferred from the model id:
 *
 *   1. REASONING_HEURISTICS — broad, live-verified family prefixes (the default).
 *   2. REASONING_OVERRIDES   — explicit per-id exceptions in BOTH directions.
 *
 * Every family in the heuristic list was verified on 2026-09-21 against
 * https://api.tokenrouter.com/v1/chat/completions to return a real, separate
 * reasoning field (reasoning_content / reasoning / reasoning_text) when sent
 * `reasoning_effort: "high"`. Ids that match a heuristic but do NOT return such
 * a field are forced off in REASONING_OVERRIDES. There is deliberately no
 * runtime probing: the extension load path already blocks on one catalogue
 * fetch, and listed ids are not guaranteed to be servable.
 */

// ── Types ───────────────────────────────────────────────────────────────────

export interface TokenRouterModel {
	id: string;
	owned_by?: string;
	supported_endpoint_types?: string[];
	tags?: string;
}

// ── Catalogue parsing ───────────────────────────────────────────────────────

/**
 * Models that speak the OpenAI chat-completions wire API. Everything else
 * (gemini-native, anthropic-native, image/video/embeddings/audio endpoints) is
 * not usable through pi's openai-completions driver and is skipped.
 */
export function isChatModel(model: TokenRouterModel): boolean {
	const endpoints = model.supported_endpoint_types ?? [];
	return endpoints.includes("openai");
}

/** Accepts the `{ data: [...] }` envelope, a bare array, or anything else. */
export function extractModels(payload: unknown): TokenRouterModel[] {
	if (payload && typeof payload === "object" && Array.isArray((payload as { data?: TokenRouterModel[] }).data)) {
		return (payload as { data: TokenRouterModel[] }).data;
	}
	if (Array.isArray(payload)) return payload as TokenRouterModel[];
	return [];
}

export function titleize(id: string): string {
	return id
		.split(/[\s/_-]+/)
		.filter(Boolean)
		.map((part) => (part.toUpperCase() === part ? part : part.charAt(0).toUpperCase() + part.slice(1)))
		.join(" ");
}

// ── Reasoning support ───────────────────────────────────────────────────────

/**
 * Substring heuristics over vendor/model ids (matched case-insensitively).
 * Ordered most-recent family first; only membership matters.
 *
 * Keep prefixes reasonably broad so new point releases are covered without
 * another edit, and add a REASONING_OVERRIDES entry for any exception.
 */
export const REASONING_HEURISTICS: string[] = [
	// DeepSeek: V4 family (v4-pro, v4-flash, v4.1-flash, ...) plus V3.2 + reasoner.
	"deepseek-v4",
	"deepseek-v3.2",
	"deepseek-reasoner",
	// Anthropic Claude: Opus / Sonnet / Haiku / Fable all expose reasoning.
	"claude-opus",
	"claude-sonnet",
	"claude-haiku",
	"claude-fable",
	// Google Gemini: only the 3.x flash/pro reasoning tiers (image models excluded).
	"gemini-3-pro",
	"gemini-3.5-flash",
	"gemini-3.6-flash",
	"gemini-3.7-flash",
	"gemini-3.8-flash",
	// OpenAI: gpt-5/6, the open-weight gpt-oss family, and the o-series.
	"gpt-5",
	"gpt-6",
	"gpt-oss",
	"o1",
	"o3",
	"o4",
	// Z.AI GLM: 5.x always reasons; 4.5/4.6/4.7 verified reasoning.
	"glm-5",
	"glm-4.5",
	"glm-4.6",
	"glm-4.7",
	// xAI Grok: 4.x and the grok-build preview.
	"grok-4",
	"grok-build",
	// NVIDIA Nemotron 3 family.
	"nemotron-3",
	// Moonshot Kimi K2 / K3.
	"kimi-k2",
	"kimi-k3",
	// Alibaba Qwen 3.5–3.8 (coder/omni variants are handled via overrides).
	"qwen3.5",
	"qwen3.6",
	"qwen3.7",
	"qwen3.8",
	// MiniMax M2.x.
	"minimax-m2",
	// StepFun Step-3.x.
	"step-3",
	// Mistral Medium (3.5) — Small/Devstral/Voxtral are not reasoning.
	"mistral-medium",
	// ByteDance Seed 2.0 family.
	"seed-2-0",
	// Tencent Hunyuan preview models.
	"tencent/hy",
	// Xiaomi MiMo v2.5 (the deprecated mimo-v2-* ids are excluded).
	"xiaomi/mimo-v2.5",
];

/**
 * Explicit per-model overrides keyed by lower-cased exact model id. Takes
 * precedence over REASONING_HEURISTICS so a family prefix that over- or
 * under-matches can be corrected per id.
 *
 * Only add entries backed by a live request against
 * https://api.tokenrouter.com/v1/chat/completions.
 */
export const REASONING_OVERRIDES: Record<string, boolean> = {
	// MiniMax-M3 always inlines its reasoning as a `<think>…</think>` block
	// inside message `content`; TokenRouter never returns a separate reasoning
	// field for it, and pi has no inline `<think>` parsing. Advertising it as
	// reasoning would surface a no-op effort selector, so force it off.
	"minimax-m3": false,
	// Matches the "qwen3.5" heuristic but returns the same inline `<think>`
	// block with no separate reasoning field (verified 2026-09-21).
	"qwen3.5-omni-plus": false,
};

/** Whether pi should treat this model as reasoning-capable. */
export function isReasoningModel(id: string): boolean {
	const key = id.toLowerCase();
	if (Object.hasOwn(REASONING_OVERRIDES, key)) return REASONING_OVERRIDES[key];
	return REASONING_HEURISTICS.some((pattern) => key.includes(pattern));
}

// ── Image input support ─────────────────────────────────────────────────────

/** Vendor/model families that accept image input. */
export const IMAGE_PATTERNS: string[] = [
	"gemini",
	"gpt-4o",
	"gpt-5-image",
	"gpt-5.4-vision",
	"glm-4.6v",
	"claude-opus",
	"claude-sonnet",
	"claude-haiku",
	"deepseek-v4-flash-vision",
	"deepseek-v4.1-flash",
	"qwen3.5-omni",
	"mimo-v2-omni",
];

export function supportsImages(id: string): boolean {
	const key = id.toLowerCase();
	return IMAGE_PATTERNS.some((pattern) => key.includes(pattern));
}

// ── Context windows ─────────────────────────────────────────────────────────

/** Context windows per vendor/model family (fallback covers unknown models). */
export const CONTEXT_WINDOWS: Array<[RegExp, number]> = [
	[/^google\//, 1_000_000],
	[/gemini/, 1_000_000],
	[/^openai\/gpt-5|^openai\/gpt-6|^openai\/o[134]/, 400_000],
	[/^anthropic\//, 200_000],
	// DeepSeek V4.1 Flash: 1M-token context (model card; verified live with a
	// 170k-token prompt). Must precede the generic deepseek rule.
	[/deepseek-v4\.1-flash/, 1_000_000],
	[/^deepseek\//, 128_000],
	[/^z-ai\/glm/, 200_000],
	[/^moonshotai\//, 256_000],
	[/^minimax\//, 200_000],
	[/^qwen/, 1_000_000],
	[/^x-ai\//, 256_000],
];

export const DEFAULT_CONTEXT_WINDOW = 128_000;

export function getContextWindow(id: string): number {
	for (const [pattern, size] of CONTEXT_WINDOWS) {
		if (pattern.test(id)) return size;
	}
	return DEFAULT_CONTEXT_WINDOW;
}

// ── Max output tokens ───────────────────────────────────────────────────────

/**
 * Maximum output tokens per vendor/model family. The catalogue does not publish
 * this either, so models with a verified higher cap get an explicit entry
 * (TokenRouter rejects larger values with "Invalid max_tokens value, the valid
 * range ...").
 */
export const MAX_OUTPUT_TOKENS: Array<[RegExp, number]> = [
	// Verified live 2026-09-21: range [1, 393216] for both.
	[/deepseek-v4\.1-flash|deepseek-v4-flash-vision/, 393_216],
];

export const DEFAULT_MAX_OUTPUT_TOKENS = 16_384;

export function getMaxTokens(id: string): number {
	for (const [pattern, size] of MAX_OUTPUT_TOKENS) {
		if (pattern.test(id)) return size;
	}
	return DEFAULT_MAX_OUTPUT_TOKENS;
}

// ── Max-tokens request field ───────────────────────────────────────────────

/**
 * OpenAI's current-generation chat models (GPT-5.x/6.x, o-series) reject the
 * legacy `max_tokens` parameter with "Unsupported parameter: 'max_tokens' is
 * not supported with this model. Use 'max_completion_tokens' instead.", so
 * OpenAI-family ids must send `max_completion_tokens`. The other vendors on
 * TokenRouter accept (and some require) the legacy `max_tokens` field.
 */
export const MAX_COMPLETION_TOKENS_PATTERN = /^openai\/(gpt-5|gpt-6|gpt-oss|o[134])/;

export function getMaxTokensField(id: string): "max_tokens" | "max_completion_tokens" {
	return MAX_COMPLETION_TOKENS_PATTERN.test(id.toLowerCase()) ? "max_completion_tokens" : "max_tokens";
}

/**
 * Native OpenAI GPT-5.x/6.x and o-series models on TokenRouter are served from
 * OpenAI's own upstream, whose /v1/chat/completions rejects combining function
 * tools with reasoning_effort ("Function tools with reasoning_effort are not
 * supported ... use /v1/responses or set reasoning_effort to 'none'"). Since a
 * coding agent always sends tools, these ids are registered against the
 * Responses API instead. openai/* ids served by third-party upstreams (e.g.
 * gpt-oss via AkashML) still accept tools + reasoning_effort on chat
 * completions and keep the completions API. Verified live 2026-09-21.
 */
export const RESPONSES_API_PATTERN = /^openai\/(gpt-5|gpt-6|o[134])/;

export function getModelApi(id: string): "openai-completions" | "openai-responses" {
	return RESPONSES_API_PATTERN.test(id.toLowerCase()) ? "openai-responses" : "openai-completions";
}

// ── Thinking levels ─────────────────────────────────────────────────────────

/**
 * Reasoning-effort maps per vendor/model family, mirroring pi's built-in
 * provider catalogs (packages/ai/dist/providers/data/*.json). Levels set to
 * null are hidden by pi; unset keys fall back to pass-through. `xhigh`/`max`
 * are only offered when explicitly listed here.
 *
 * `off` maps to "none" only for families with a documented none value; families
 * without one use null (toggle reasoning off client-side instead).
 */
export const THINKING_LEVEL_MAPS: Array<{ pattern: RegExp; map: Record<string, string | null> }> = [
	// Z.AI GLM-5.3/5.2 always reason; TokenRouter upstream rejects disabling
	// ("cannot be disabled; please use low, high, or max").
	{
		pattern: /glm-5\.3|glm-5\.2/,
		map: { off: null, minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: "max" },
	},
	{
		pattern: /glm/,
		map: { off: "none", minimal: null, low: "low", medium: "medium", high: "high", xhigh: null, max: null },
	},
	// DeepSeek V4.1 Flash: full 7-level enum. Verified live 2026-09-21 — the
	// gateway accepts none/minimal/low/medium/high/xhigh/max, and `none` returns
	// no reasoning_content (thinking off). Must precede the generic V4 rule.
	{
		pattern: /deepseek-v4\.1-flash/,
		map: { off: "none", minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
	},
	// Other DeepSeek V4 variants (v4-flash, v4-pro): low..max only. Verified live:
	// none/minimal are rejected with "'reasoning_effort' must be one of: 'low',
	// 'medium', 'high', 'xhigh', 'max'".
	{
		pattern: /deepseek-v4/,
		map: { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
	},
	{
		pattern: /deepseek/,
		map: { off: null, minimal: null, low: "low", medium: null, high: "high", max: "max" },
	},
	// Moonshot Kimi K3: off/low/high/max.
	{
		pattern: /kimi-k3/,
		map: { off: null, minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: "max" },
	},
	{ pattern: /kimi/, map: { off: null } },
	// OpenAI gpt-5.2+ and gpt-6: minimal..max. Verified live 2026-09-21 against
	// TokenRouter's /v1/responses: gpt-6-luna accepts effort xhigh and max (and
	// pi's built-in openai provider exposes the same levels for gpt-5.6-*). The
	// newer OpenAI upstreams live on /v1/responses (see RESPONSES_API_PATTERN).
	{
		pattern: /^openai\/gpt-5\.2|^openai\/gpt-5\.3|^openai\/gpt-5\.4|^openai\/gpt-5\.5|^openai\/gpt-5\.6|^openai\/gpt-6/,
		map: { off: "none", minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
	},
	{
		pattern: /^openai\/gpt-5($|[^.])|^openai\/gpt-5\.0|^openai\/gpt-5\.1/,
		map: { off: null, minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: null, max: null },
	},
	{
		pattern: /^openai\/o[134]/,
		map: { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: null, max: null },
	},
	// xAI Grok: 4.6 adds xhigh.
	{
		pattern: /grok-4\.6/,
		map: { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: null },
	},
	{
		pattern: /grok/,
		map: { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: null, max: null },
	},
	// Anthropic Claude: low..max (adaptive; pi clamps internally).
	{
		pattern: /claude/,
		map: { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: null, max: "max" },
	},
];

export function getThinkingLevelMap(id: string): Record<string, string | null> | undefined {
	const key = id.toLowerCase();
	for (const { pattern, map } of THINKING_LEVEL_MAPS) {
		if (pattern.test(key)) return map;
	}
	return undefined;
}

// ── pi model descriptor ─────────────────────────────────────────────────────

export function toPiModel(model: TokenRouterModel) {
	const id = model.id;
	return {
		id,
		api: getModelApi(id),
		name: `${titleize(id)} (TokenRouter)`,
		reasoning: isReasoningModel(id),
		input: supportsImages(id) ? (["text", "image"] as const) : (["text"] as const),
		contextWindow: getContextWindow(id),
		maxTokens: getMaxTokens(id),
		thinkingLevelMap: getThinkingLevelMap(id),
		// The catalog doesn't expose pricing; 0 avoids fake cost math.
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		compat: {
			supportsDeveloperRole: false,
			maxTokensField: getMaxTokensField(id),
			supportsReasoningEffort: true,
		},
	};
}
