/**
 * MegaLLM Provider Extension for Pi
 *
 * Registers https://ai.megallm.io/v1 as an OpenAI-compatible provider
 * with dynamically fetched models.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const BASE_URL = "https://ai.megallm.io/v1";
// Key comes from the environment, never hardcoded. Set MEGALLM_API_KEY (e.g. in
// ~/.secrets/api-keys.env). When unset, the provider is skipped entirely.
const API_KEY = process.env.MEGALLM_API_KEY ?? "";

interface MegaModel {
	id: string;
	owned_by: string;
	pricing?: {
		inputCostPerToken: number;
		outputCostPerToken: number;
	};
}

const REASONING_MODELS = new Set([
	"gemini-2.5-pro",
	"gemini-2.5-flash",
	"gemini-3-pro-preview",
	"gemini-3.1-pro-preview",
	"gemini-3.5-flash",
	"gemini-3-flash-preview",
	"deepseek-v3.2",
	"deepseek-ai/deepseek-v3.1",
	"deepseek-ai/deepseek-v4-pro",
	"deepseek-ai/deepseek-v4-flash",
	"claude-opus-4-6",
	"claude-opus-4-7",
	"claude-sonnet-4-6",
	"gpt-5.3-codex",
	"gpt-5.4",
	"gpt-5.4-mini",
	"gpt-5.5",
	"moonshotai/kimi-k2.5",
	"moonshotai/kimi-k2.6",
]);

// Vision-capable families. Substring match, NOT an exact-ID allowlist, so new
// releases (claude-opus-4.8, gemini-3.5, gpt-5.x) keep image support instead of
// silently regressing to text-only — which makes read.ts strip attachments and
// the model report it "can't see" the image. deepseek/kimi/llama stay text-only.
// ponytail: family match over per-ID list; one line per family, never edit on release.
const IMAGE_FAMILIES = [
	"claude-opus",
	"claude-sonnet",
	"claude-haiku",
	"gemini",
	"gpt-4o",
	"gpt-5",
];
const supportsImages = (id: string): boolean => {
	const s = id.toLowerCase();
	return IMAGE_FAMILIES.some((f) => s.includes(f));
};

function getContextWindow(id: string): number {
	if (id.includes("gemini")) return 1000000;
	if (id.includes("claude")) return 200000;
	if (id.includes("gpt-5")) return 200000;
	if (id.includes("gpt-4o")) return 128000;
	if (id.includes("deepseek")) return 128000;
	if (id.includes("kimi")) return 128000;
	if (id.includes("llama")) return 128000;
	return 128000;
}

function getMaxTokens(id: string): number {
	if (id.includes("gemini")) return 65536;
	if (id.includes("claude-opus")) return 32000;
	if (id.includes("claude-sonnet")) return 16384;
	if (id.includes("gpt-5")) return 32768;
	if (id.includes("deepseek")) return 16384;
	return 16384;
}

export default async function megallmProvider(pi: ExtensionAPI) {
	// No key configured -> don't register the provider (avoids unauthenticated calls).
	if (!API_KEY) return;

	let models: MegaModel[] = [];

	try {
		const response = await fetch(`${BASE_URL}/models`, {
			headers: { Authorization: `Bearer ${API_KEY}` },
			signal: AbortSignal.timeout(10000),
		});
		const payload = (await response.json()) as { data: MegaModel[] };
		models = payload.data;
	} catch (e) {
		// Fallback: register with a known subset
		models = [
			{ id: "claude-sonnet-4-6", owned_by: "Anthropic", pricing: { inputCostPerToken: 0.000003, outputCostPerToken: 0.000015 } },
			{ id: "claude-opus-4-7", owned_by: "Anthropic", pricing: { inputCostPerToken: 0.000005, outputCostPerToken: 0.000025 } },
			{ id: "gemini-2.5-flash", owned_by: "Google", pricing: { inputCostPerToken: 0.000001, outputCostPerToken: 0.000001 } },
			{ id: "gemini-2.5-pro", owned_by: "Google", pricing: { inputCostPerToken: 0.00000125, outputCostPerToken: 0.00001 } },
			{ id: "deepseek-ai/deepseek-v4-flash", owned_by: "DeepSeek", pricing: { inputCostPerToken: 0.00000014, outputCostPerToken: 0.00000028 } },
			{ id: "gpt-5.4", owned_by: "OpenAI", pricing: { inputCostPerToken: 0.0000025, outputCostPerToken: 0.000015 } },
		];
	}

	pi.registerProvider("megallm", {
		name: "MegaLLM",
		baseUrl: BASE_URL,
		apiKey: "$MEGALLM_API_KEY",
		api: "openai-completions",
		authHeader: true,
		models: models.map((m) => ({
			id: m.id,
			name: `${m.id} (MegaLLM)`,
			reasoning: REASONING_MODELS.has(m.id),
			input: supportsImages(m.id) ? ["text", "image"] as const : ["text"] as const,
			cost: {
				input: (m.pricing?.inputCostPerToken ?? 0) * 1_000_000,
				output: (m.pricing?.outputCostPerToken ?? 0) * 1_000_000,
				cacheRead: 0,
				cacheWrite: 0,
			},
			contextWindow: getContextWindow(m.id),
			maxTokens: getMaxTokens(m.id),
			compat: {
				supportsDeveloperRole: false,
				maxTokensField: "max_tokens" as const,
			},
		})),
	});
}
