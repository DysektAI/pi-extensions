/**
 * Pure helpers for proactive compaction thresholds (no pi imports, unit-testable).
 *
 * `compaction.maxContextTokens` caps the context size at which compaction runs, so
 * models with very large windows still compact at a sane budget. Per-model values go
 * in `compaction.modelOverrides["provider/id"].maxContextTokens`; project settings
 * override global ones. Pi's own trigger (`contextWindow - reserveTokens`) still
 * applies; this only ever compacts earlier.
 */

type Json = Record<string, unknown>;

/** Built-in per-model limits for models that degrade well before their window. */
export const MODEL_THRESHOLDS: Readonly<Record<string, number>> = {
	"gpt-5.6-sol": 200_000,
	"gpt-5.6-terra": 200_000,
	"gpt-5.6-luna": 500_000,
};

function asObject(value: unknown): Json | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : undefined;
}

function validCap(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** Settings values for one field: per-model override first, then the general value. */
function capsFrom(settings: unknown, modelKey: string): { model?: number; general?: number } {
	const compaction = asObject(asObject(settings)?.compaction);
	if (!compaction) return {};
	const override = asObject(asObject(compaction.modelOverrides)?.[modelKey]);
	return { model: validCap(override?.maxContextTokens), general: validCap(compaction.maxContextTokens) };
}

/**
 * Effective proactive threshold for a model, or undefined when nothing applies.
 * Mirrors Pi's settings merge: project over global, per-model over general.
 */
export function compactionThreshold(
	model: { provider: string; id: string } | undefined,
	globalSettings: unknown,
	projectSettings: unknown,
): number | undefined {
	if (!model) return undefined;
	const key = `${model.provider}/${model.id}`;
	const project = capsFrom(projectSettings, key);
	const global = capsFrom(globalSettings, key);
	const configured = project.model ?? global.model ?? project.general ?? global.general;
	const builtin = MODEL_THRESHOLDS[model.id];
	if (configured === undefined) return builtin;
	return builtin === undefined ? configured : Math.min(configured, builtin);
}
