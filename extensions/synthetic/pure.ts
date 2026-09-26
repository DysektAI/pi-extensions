/**
 * Pure catalog helpers for the Synthetic provider (no pi imports, unit-testable).
 */

export const SYNTHETIC_BASE_URL = "https://api.synthetic.new/openai/v1";

export const SYNTHETIC_COMPAT = {
	supportsStore: false,
	supportsDeveloperRole: false,
	supportsReasoningEffort: true,
	maxTokensField: "max_completion_tokens" as const,
	supportsStrictMode: true,
	supportsLongCacheRetention: false,
};

export interface SyntheticModel {
	id?: string;
	name?: string;
	context_length?: number;
	max_output_length?: number;
	input_modalities?: string[];
	supported_features?: string[];
	reasoning_parameters?: { efforts?: string[] };
	pricing?: {
		prompt?: string | number;
		completion?: string | number;
		input_cache_reads?: string | number;
		input_cache_writes?: string | number;
	};
}

type Level = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** Per-token price strings (`"$0.0000009"`) to per-million-token numbers. */
export function parsePrice(value: string | number | undefined): number {
	const numeric = typeof value === "number" ? value : Number.parseFloat(value?.replace(/^\$/u, "") ?? "0");
	return Number.isFinite(numeric) ? Math.round(numeric * 1_000_000 * 1e6) / 1e6 : 0;
}

export function thinkingLevelMap(efforts: readonly string[] | undefined): Partial<Record<Level, string | null>> | undefined {
	if (!efforts || efforts.length === 0) return undefined;
	const supported = new Set(efforts.map((effort) => effort.toLowerCase()));
	const map: Partial<Record<Level, string | null>> = { off: supported.has("none") ? "none" : null };
	for (const level of ["minimal", "low", "medium", "high", "xhigh", "max"] as const) {
		map[level] = supported.has(level) ? level : null;
	}
	return map;
}

/** Tool-capable catalog entries as Pi model definitions; others are dropped. */
export function toPiModel(source: SyntheticModel) {
	if (!source.id || !source.supported_features?.includes("tools")) return undefined;
	const reasoning =
		source.supported_features.includes("reasoning") || (source.reasoning_parameters?.efforts?.length ?? 0) > 0;
	const levels = reasoning ? thinkingLevelMap(source.reasoning_parameters?.efforts) : undefined;
	return {
		id: source.id,
		name: source.name ?? source.id,
		reasoning,
		...(levels ? { thinkingLevelMap: levels } : {}),
		input: source.input_modalities?.includes("image") ? (["text", "image"] as const) : (["text"] as const),
		cost: {
			input: parsePrice(source.pricing?.prompt),
			output: parsePrice(source.pricing?.completion),
			cacheRead: parsePrice(source.pricing?.input_cache_reads),
			cacheWrite: parsePrice(source.pricing?.input_cache_writes),
		},
		contextWindow: source.context_length ?? 128000,
		maxTokens: source.max_output_length ?? 65536,
		compat: SYNTHETIC_COMPAT,
	};
}

export function extractModels(payload: unknown): SyntheticModel[] {
	const data = (payload as { data?: unknown } | null)?.data;
	return Array.isArray(data) ? (data as SyntheticModel[]) : [];
}
