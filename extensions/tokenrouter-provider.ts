/**
 * TokenRouter Provider Extension for Pi
 *
 * Registers https://api.tokenrouter.io/v1 as an OpenAI-compatible provider
 * with dynamically fetched models. TokenRouter is an intelligent LLM routing
 * platform that automatically selects the best AI provider and model for your
 * requests, supporting OpenAI, Anthropic, Google, Mistral, DeepSeek, and Meta.
 *
 * Auth resolution order:
 * 1. `tokenrouter` entry in ~/.pi/agent/auth.json (persistent, no env var needed)
 * 2. TOKENROUTER_API_KEY environment variable
 *
 * When neither is set, the provider is skipped entirely.
 *
 * @see https://docs.tokenrouter.io
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";

const BASE_URL = "https://api.tokenrouter.io/v1";

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
	owned_by: string;
	pricing?: {
		inputCostPerToken: number;
		outputCostPerToken: number;
	};
}

// Models known to support extended reasoning / chain-of-thought.
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
	"o1-preview",
	"o1-mini",
	"o3-mini",
]);

// Vision-capable families. Substring match so new releases keep image support
// instead of silently regressing to text-only.
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
	if (id.includes("o1") || id.includes("o3")) return 200000;
	if (id.includes("mistral")) return 128000;
	if (id.includes("llama")) return 128000;
	return 128000;
}

function getMaxTokens(id: string): number {
	if (id.includes("gemini")) return 65536;
	if (id.includes("claude-opus")) return 32000;
	if (id.includes("claude-sonnet")) return 16384;
	if (id.includes("gpt-5")) return 32768;
	if (id.includes("gpt-4o")) return 16384;
	if (id.includes("deepseek")) return 16384;
	if (id.includes("o1") || id.includes("o3")) return 32768;
	if (id.includes("mistral")) return 16384;
	return 16384;
}

export default async function tokenrouterProvider(pi: ExtensionAPI) {
	const apiKey = await readApiKey();
	// No key configured -> don't register the provider (avoids unauthenticated calls).
	if (!apiKey) return;

	let models: TokenRouterModel[] = [];

	try {
		const response = await fetch(`${BASE_URL}/models`, {
			headers: { Authorization: `Bearer ${apiKey}` },
			signal: AbortSignal.timeout(10000),
		});
		const payload = (await response.json()) as { data?: TokenRouterModel[] };
		// Throw on non-OK or malformed payloads so the fallback catalog below kicks in
		// instead of crashing the extension (payload.data is undefined on e.g. 401).
		if (!response.ok || !Array.isArray(payload.data)) {
			throw new Error(`models fetch failed (HTTP ${response.status})`);
		}
		models = payload.data;
	} catch {
		// Fallback: register with a known subset so the provider is still usable
		// even when the catalog endpoint is unreachable at startup.
		models = [
			{ id: "claude-sonnet-4-6", owned_by: "Anthropic", pricing: { inputCostPerToken: 0.000003, outputCostPerToken: 0.000015 } },
			{ id: "claude-opus-4-7", owned_by: "Anthropic", pricing: { inputCostPerToken: 0.000005, outputCostPerToken: 0.000025 } },
			{ id: "gemini-2.5-flash", owned_by: "Google", pricing: { inputCostPerToken: 0.000001, outputCostPerToken: 0.000001 } },
			{ id: "gemini-2.5-pro", owned_by: "Google", pricing: { inputCostPerToken: 0.00000125, outputCostPerToken: 0.00001 } },
			{ id: "gpt-5.4", owned_by: "OpenAI", pricing: { inputCostPerToken: 0.0000025, outputCostPerToken: 0.000015 } },
			{ id: "gpt-4o", owned_by: "OpenAI", pricing: { inputCostPerToken: 0.0000025, outputCostPerToken: 0.00001 } },
			{ id: "deepseek-ai/deepseek-v4-flash", owned_by: "DeepSeek", pricing: { inputCostPerToken: 0.00000014, outputCostPerToken: 0.00000028 } },
			{ id: "mistral-large-latest", owned_by: "Mistral", pricing: { inputCostPerToken: 0.000002, outputCostPerToken: 0.000006 } },
		];
	}

	pi.registerProvider("tokenrouter", {
		name: "TokenRouter",
		baseUrl: BASE_URL,
		// Use the same credential that successfully fetched this catalog so
		// discovery and chat stay consistent; auth.json works without an env var.
		apiKey,
		api: "openai-completions",
		authHeader: true,
		models: models.map((m) => ({
			id: m.id,
			name: `${m.id} (TokenRouter)`,
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
