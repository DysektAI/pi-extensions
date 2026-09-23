/**
 * TokenRouter Extension Tests
 *
 * Pure metadata helpers live in `./pure.ts` and are shared with
 * `tokenrouter-provider.ts`, so tests never keep a second copy of production
 * logic.
 *
 * Covers:
 * 1. Catalogue parsing (chat-model filter, envelope/array/garbage unwrapping)
 * 2. Title formatting
 * 3. Reasoning detection — live-verified positive families
 * 4. Reasoning detection — live-verified negative ids
 * 5. Reasoning overrides (both directions, precedence, case-insensitivity)
 * 6. Image-input detection
 * 7. Context windows
 * 8. Thinking-level maps
 * 9. Full `toPiModel` descriptor wiring
 *
 * The "verified" ids below were probed on 2026-09-21 against
 * https://api.tokenrouter.com/v1/chat/completions with `reasoning_effort:
 * "high"`; positives returned a separate reasoning field, negatives did not.
 * (The xiaomi/mimo-v2.6-* ids were re-verified on 2026-09-23: all three
 * variants return a separate `reasoning` field, and the upstream accepts the
 * full effort enum none|minimal|low|medium|high|xhigh|max.)
 *
 * Run with:
 *   npx tsx --test extensions/tokenrouter/tests.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
	DEFAULT_CONTEXT_WINDOW,
	DEFAULT_MAX_OUTPUT_TOKENS,
	IMAGE_PATTERNS,
	REASONING_HEURISTICS,
	REASONING_OVERRIDES,
	extractModels,
	getContextWindow,
	getMaxTokens,
	getThinkingLevelMap,
	isChatModel,
	isReasoningModel,
	supportsImages,
	titleize,
	toPiModel,
} from "./pure.ts";

// Reasoning-capable ids verified against the live TokenRouter API.
const VERIFIED_REASONING = [
	"deepseek/deepseek-v4-flash",
	"deepseek/deepseek-v4.1-flash",
	"deepseek/deepseek-v3.2",
	"anthropic/claude-opus-5-huo",
	"anthropic/claude-fable-5-huo",
	"claude-haiku-4-5",
	"qwen/qwen3.5-9b",
	"qwen/qwen3.5-flash",
	"qwen/qwen3.5-397b-a17b",
	"qwen3.6-flash",
	"qwen/qwen3.6-plus",
	"qwen/qwen3.7-max",
	"qwen/qwen3.8-flash",
	"z-ai/glm-4.5-air",
	"z-ai/glm-4.6v",
	"z-ai/glm-4.7",
	"z-ai/glm-5.3",
	"openai/gpt-oss-120b",
	"openai/gpt-5.4-pro",
	"stepfun/step-3.5-flash",
	"stepfun/step-3.7-flash",
	"x-ai/grok-build-0.1",
	"x-ai/grok-4.6",
	"moonshotai/kimi-k3",
	"nvidia/nemotron-3-super-120b-a12b",
	"minimax/minimax-m2.7",
	"mistralai/mistral-medium-3-5",
	"seed-2-0-mini-260428",
	"tencent/hy4-preview",
	"xiaomi/mimo-v2.5-pro",
	"xiaomi/mimo-v2.6-flash",
	"xiaomi/mimo-v2.6-pro-ultraspeed",
];

// Ids verified to expose NO separate reasoning field (or otherwise unusable).
const VERIFIED_NON_REASONING = [
	"openai/gpt-4o-mini",
	"qwen/qwen3-coder-next",
	"qwen3.5-omni-plus",
	"MiniMax-M3",
	"google/gemini-3.1-flash-image-preview",
	"google/gemini-3.1-flash-lite-image",
	"microsoft/mai-image-2.5",
	"mistralai/devstral-2512",
	"mistralai/voxtral-small-24b-2507",
	"sakana/fugu-ultra",
	"xiaomi/mimo-v2-flash",
];

describe("isChatModel", () => {
	it("keeps models that expose the openai chat endpoint", () => {
		assert.equal(isChatModel({ id: "x", supported_endpoint_types: ["openai"] }), true);
		assert.equal(isChatModel({ id: "x", supported_endpoint_types: ["openai", "video-generation"] }), true);
	});

	it("rejects non-chat endpoints and missing endpoint metadata", () => {
		assert.equal(isChatModel({ id: "x", supported_endpoint_types: ["video-generation", "video-fetch"] }), false);
		assert.equal(isChatModel({ id: "x", supported_endpoint_types: [] }), false);
		assert.equal(isChatModel({ id: "x" }), false);
	});
});

describe("extractModels", () => {
	it("accepts the { data: [...] } envelope", () => {
		assert.deepEqual(extractModels({ data: [{ id: "a" }] }), [{ id: "a" }]);
	});

	it("accepts a bare array", () => {
		assert.deepEqual(extractModels([{ id: "a" }]), [{ id: "a" }]);
	});

	it("returns an empty list for unexpected payloads", () => {
		assert.deepEqual(extractModels(null), []);
		assert.deepEqual(extractModels({ data: "nope" }), []);
		assert.deepEqual(extractModels("nope"), []);
	});
});

describe("titleize", () => {
	it("splits vendor/id separators and capitalizes", () => {
		assert.equal(titleize("deepseek/deepseek-v4-pro"), "Deepseek Deepseek V4 Pro");
		assert.equal(titleize("MiniMax-M3"), "MiniMax M3");
	});
});

describe("isReasoningModel — verified positives", () => {
	for (const id of VERIFIED_REASONING) {
		it(`treats ${id} as reasoning`, () => {
			assert.equal(isReasoningModel(id), true);
		});
	}
});

describe("isReasoningModel — verified negatives", () => {
	for (const id of VERIFIED_NON_REASONING) {
		it(`treats ${id} as non-reasoning`, () => {
			assert.equal(isReasoningModel(id), false);
		});
	}
});

describe("reasoning overrides", () => {
	it("forces qwen3.5-omni-plus off despite matching the qwen3.5 heuristic", () => {
		// Sanity-check the premise: the heuristic alone would match.
		assert.ok(REASONING_HEURISTICS.some((p) => "qwen3.5-omni-plus".includes(p)));
		assert.equal(isReasoningModel("qwen3.5-omni-plus"), false);
	});

	it("forces MiniMax-M3 off (inline <think> only; no separate reasoning field)", () => {
		assert.equal(isReasoningModel("MiniMax-M3"), false);
	});

	it("keys every override by lower-cased id", () => {
		for (const key of Object.keys(REASONING_OVERRIDES)) {
			assert.equal(key, key.toLowerCase(), `override key "${key}" must be lower-case`);
		}
	});

	it("matches overrides case-insensitively", () => {
		assert.equal(isReasoningModel("MINIMAX-M3"), false);
		assert.equal(isReasoningModel("DeepSeek/DeepSeek-V4-Flash"), true);
	});
});

describe("supportsImages", () => {
	it("detects known vision families", () => {
		assert.equal(supportsImages("qwen/qwen3.5-omni-plus"), true);
		assert.equal(supportsImages("z-ai/glm-4.6v"), true);
		assert.equal(supportsImages("anthropic/claude-haiku-4-5"), true);
		// V4.1 Flash is natively multimodal despite the text-only catalogue tag.
		assert.equal(supportsImages("deepseek/deepseek-v4.1-flash"), true);
	});

	it("defaults to text-only", () => {
		assert.equal(supportsImages("openai/gpt-oss-120b"), false);
		assert.ok(IMAGE_PATTERNS.length > 0);
	});
});

describe("getContextWindow", () => {
	it("returns per-vendor defaults and a fallback", () => {
		assert.equal(getContextWindow("anthropic/claude-opus-5-huo"), 200_000);
		assert.equal(getContextWindow("qwen/qwen3.5-9b"), 1_000_000);
		// V4.1 Flash advertises 1M; other DeepSeek variants keep the 128k default.
		assert.equal(getContextWindow("deepseek/deepseek-v4.1-flash"), 1_000_000);
		assert.equal(getContextWindow("deepseek/deepseek-v4-pro"), 128_000);
		assert.equal(getContextWindow("totally/unknown-model"), DEFAULT_CONTEXT_WINDOW);
	});
});

describe("getMaxTokens", () => {
	it("returns verified caps and a safe fallback", () => {
		assert.equal(getMaxTokens("deepseek/deepseek-v4.1-flash"), 393_216);
		assert.equal(getMaxTokens("deepseek/deepseek-v4-flash-vision-exp"), 393_216);
		assert.equal(getMaxTokens("openai/gpt-oss-120b"), DEFAULT_MAX_OUTPUT_TOKENS);
	});
});

describe("getThinkingLevelMap", () => {
	it("exposes the full effort enum for DeepSeek V4.1 Flash", () => {
		const map = getThinkingLevelMap("deepseek/deepseek-v4.1-flash");
		assert.deepEqual(map, {
			off: "none",
			minimal: "minimal",
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: "xhigh",
			max: "max",
		});
	});

	it("exposes low..max (no off) for other DeepSeek V4 variants", () => {
		const map = getThinkingLevelMap("deepseek/deepseek-v4-pro");
		assert.deepEqual(map, { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" });
	});

	it("keeps GLM-5.3 always-on (no off value)", () => {
		const map = getThinkingLevelMap("z-ai/glm-5.3");
		assert.equal(map?.off, null);
		assert.equal(map?.low, "low");
		assert.equal(map?.max, "max");
	});

	it("gives Claude the adaptive low..max range", () => {
		const map = getThinkingLevelMap("claude-haiku-4-5");
		assert.equal(map?.low, "low");
		assert.equal(map?.max, "max");
	});

	it("returns undefined for families with no explicit map", () => {
		assert.equal(getThinkingLevelMap("qwen/qwen3.5-9b"), undefined);
	});
});

describe("toPiModel", () => {
	it("wires the reasoning flag, image support and endpoints", () => {
		const reasoning = toPiModel({
			id: "deepseek/deepseek-v4.1-flash",
			supported_endpoint_types: ["openai"],
		});
		assert.equal(reasoning.reasoning, true);
		assert.equal(reasoning.api, "openai-completions");
		// V4.1 Flash is multimodal despite the text-only catalogue tag.
		assert.deepEqual(reasoning.input, ["text", "image"]);
		assert.equal(reasoning.contextWindow, 1_000_000);
		assert.equal(reasoning.maxTokens, 393_216);
		assert.equal(reasoning.compat.maxTokensField, "max_tokens");
		assert.ok(reasoning.name.includes("TokenRouter"));
	});

	it("sends max_completion_tokens for OpenAI-family models", () => {
		const model = toPiModel({ id: "openai/gpt-6-luna", supported_endpoint_types: ["openai"] });
		assert.equal(model.compat.maxTokensField, "max_completion_tokens");
	});

	it("exposes the full openai effort range including max for gpt-5.2+/gpt-6", () => {
		const map = getThinkingLevelMap("openai/gpt-6-luna");
		assert.equal(map?.off, "none");
		assert.equal(map?.minimal, null);
		assert.equal(map?.high, "high");
		assert.equal(map?.xhigh, "xhigh");
		assert.equal(map?.max, "max");
		// Older families keep the conservative caps.
		assert.equal(getThinkingLevelMap("openai/gpt-5.1")?.max, null);
		assert.equal(getThinkingLevelMap("openai/o3")?.max, null);
	});

	it("registers native OpenAI reasoning models on the Responses API", () => {
		// Their chat-completions endpoint rejects tools + reasoning_effort.
		assert.equal(toPiModel({ id: "openai/gpt-6-luna", supported_endpoint_types: ["openai"] }).api, "openai-responses");
		assert.equal(toPiModel({ id: "openai/gpt-5.6-sol", supported_endpoint_types: ["openai"] }).api, "openai-responses");
		assert.equal(toPiModel({ id: "openai/o3", supported_endpoint_types: ["openai"] }).api, "openai-responses");
	});

	it("keeps third-party-upstream and non-OpenAI models on chat completions", () => {
		// gpt-oss is served via AkashML, which accepts tools + reasoning_effort.
		assert.equal(toPiModel({ id: "openai/gpt-oss-120b", supported_endpoint_types: ["openai"] }).api, "openai-completions");
		assert.equal(toPiModel({ id: "z-ai/glm-5.3", supported_endpoint_types: ["openai"] }).api, "openai-completions");
		assert.equal(toPiModel({ id: "openai/gpt-4o-mini", supported_endpoint_types: ["openai"] }).api, "openai-completions");
	});

	it("keeps legacy max_tokens for non-OpenAI vendors", () => {
		const glm = toPiModel({ id: "z-ai/glm-5.3", supported_endpoint_types: ["openai"] });
		assert.equal(glm.compat.maxTokensField, "max_tokens");
	});

	it("marks a vision reasoning model as both", () => {
		// NB: the live catalogue id is bare (no `qwen/` prefix).
		const model = toPiModel({ id: "qwen3.5-omni-plus", supported_endpoint_types: ["openai"] });
		assert.deepEqual(model.input, ["text", "image"]);
		// omni-plus is inline-<think> only, so it is deliberately not reasoning.
		assert.equal(model.reasoning, false);
	});

	it("marks a multimodal chat model without reasoning", () => {
		const model = toPiModel({ id: "openai/gpt-4o-mini", supported_endpoint_types: ["openai"] });
		assert.equal(model.reasoning, false);
		assert.deepEqual(model.input, ["text", "image"]);
		assert.equal(model.thinkingLevelMap, undefined);
	});

	it("marks a text-only, non-multimodal chat model as text-only", () => {
		const model = toPiModel({ id: "openai/gpt-oss-120b", supported_endpoint_types: ["openai"] });
		assert.equal(model.reasoning, true);
		assert.deepEqual(model.input, ["text"]);
	});
});
