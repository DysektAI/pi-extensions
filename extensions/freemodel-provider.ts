import {
	anthropicMessagesApi,
	type Api,
	type AssistantMessageEventStream,
	getModel,
	openAICompletionsApi,
	type Model,
	type SimpleStreamOptions,
	type TranscriptContext,
} from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Direct FreeModel.dev1 provider for Pi.
 *
 * The credential lives in ~/.pi/agent/auth.json under `freemodel`; this file
 * contains no secret. FreeModel exposes two direct surfaces for the same key:
 * an OpenAI-compatible GPT surface and a Claude-compatible Anthropic surface.
 * Pi uses the former for normal coding prompts and keeps the latter available
 * for Claude models.
 *
 * The Claude surface is rooted at the host rather than /v1 because Pi's
 * Anthropic client appends /v1/messages itself. The identity headers match the
 * Claude Code client expected by the gateway; the per-request session id is
 * deliberately fresh and no request or response payload is logged.
 */

const OPENAI_BASE_URL = "https://api.freemodel.dev/v1";
const ANTHROPIC_BASE_URL = "https://cc-hq.freemodel.dev";
const CLAUDE_CLI_VERSION = "2.1.218";

const CLAUDE_CODE_HEADERS: Record<string, string> = {
	"user-agent": `claude-cli/${CLAUDE_CLI_VERSION} (external, sdk-cli)`,
	"x-app": "cli",
	"anthropic-version": "2023-06-01",
	"anthropic-dangerous-direct-browser-access": "true",
};

type FreeModelDefinition = {
	id: string;
	name: string;
	api: "openai-completions" | "anthropic-messages";
	baseUrl: string;
	reasoning: boolean;
	input: ("text" | "image")[];
	contextWindow: number;
	maxTokens: number;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	thinkingLevelMap?: Model<Api>["thinkingLevelMap"];
	compat?: Model<Api>["compat"];
};

const MODELS: FreeModelDefinition[] = [
	{
		id: "gpt-5.6-luna",
		name: "GPT-5.6 Luna (FreeModel.dev1)",
		api: "openai-completions",
		baseUrl: OPENAI_BASE_URL,
		reasoning: true,
		input: ["text"],
		contextWindow: 1_000_000,
		maxTokens: 128_000,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		compat: { supportsDeveloperRole: false, supportsReasoningEffort: true },
	},
	{
		id: "gpt-5.6-sol",
		name: "GPT-5.6 Sol (FreeModel.dev1)",
		api: "openai-completions",
		baseUrl: OPENAI_BASE_URL,
		reasoning: true,
		input: ["text"],
		contextWindow: 1_000_000,
		maxTokens: 128_000,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		compat: { supportsDeveloperRole: false, supportsReasoningEffort: true },
	},
	{
		id: "gpt-5.6-terra",
		name: "GPT-5.6 Terra (FreeModel.dev1)",
		api: "openai-completions",
		baseUrl: OPENAI_BASE_URL,
		reasoning: true,
		input: ["text"],
		contextWindow: 1_000_000,
		maxTokens: 128_000,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		compat: { supportsDeveloperRole: false, supportsReasoningEffort: true },
	},
	{
		id: "claude-opus-5-5",
		name: "Claude Opus 5.5 (FreeModel.dev1)",
		api: "anthropic-messages",
		baseUrl: ANTHROPIC_BASE_URL,
		reasoning: true,
		input: ["text", "image"],
		contextWindow: 1_000_000,
		maxTokens: 128_000,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	},
	{
		id: "claude-opus-5",
		name: "Claude Opus 5 (FreeModel.dev1)",
		api: "anthropic-messages",
		baseUrl: ANTHROPIC_BASE_URL,
		reasoning: true,
		input: ["text", "image"],
		contextWindow: 1_000_000,
		maxTokens: 128_000,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	},
	{
		id: "claude-opus-4-8",
		name: "Claude Opus 4.8 (FreeModel.dev1)",
		api: "anthropic-messages",
		baseUrl: ANTHROPIC_BASE_URL,
		reasoning: true,
		input: ["text", "image"],
		contextWindow: 1_000_000,
		maxTokens: 128_000,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	},
	{
		id: "claude-opus-4-7",
		name: "Claude Opus 4.7 (FreeModel.dev1)",
		api: "anthropic-messages",
		baseUrl: ANTHROPIC_BASE_URL,
		reasoning: true,
		input: ["text", "image"],
		contextWindow: 1_000_000,
		maxTokens: 128_000,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	},
	{
		id: "claude-opus-4-6",
		name: "Claude Opus 4.6 (FreeModel.dev1)",
		api: "anthropic-messages",
		baseUrl: ANTHROPIC_BASE_URL,
		reasoning: true,
		input: ["text", "image"],
		contextWindow: 1_000_000,
		maxTokens: 128_000,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	},
	{
		id: "claude-fable-5-1",
		name: "Claude Fable 5.1 (FreeModel.dev1)",
		api: "anthropic-messages",
		baseUrl: ANTHROPIC_BASE_URL,
		reasoning: true,
		input: ["text", "image"],
		contextWindow: 1_000_000,
		maxTokens: 128_000,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	},
	{
		id: "claude-fable-5",
		name: "Claude Fable 5 (FreeModel.dev1)",
		api: "anthropic-messages",
		baseUrl: ANTHROPIC_BASE_URL,
		reasoning: true,
		input: ["text", "image"],
		contextWindow: 1_000_000,
		maxTokens: 128_000,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	},
	{
		id: "claude-sonnet-5",
		name: "Claude Sonnet 5 (FreeModel.dev1)",
		api: "anthropic-messages",
		baseUrl: ANTHROPIC_BASE_URL,
		reasoning: true,
		input: ["text", "image"],
		contextWindow: 1_000_000,
		maxTokens: 128_000,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	},
	{
		id: "claude-sonnet-4-6",
		name: "Claude Sonnet 4.6 (FreeModel.dev1)",
		api: "anthropic-messages",
		baseUrl: ANTHROPIC_BASE_URL,
		reasoning: true,
		input: ["text", "image"],
		contextWindow: 1_000_000,
		maxTokens: 64_000,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	},
	{
		id: "claude-haiku-4-5-20251001",
		name: "Claude Haiku 4.5 (FreeModel.dev1)",
		api: "anthropic-messages",
		baseUrl: ANTHROPIC_BASE_URL,
		reasoning: false,
		input: ["text", "image"],
		contextWindow: 200_000,
		maxTokens: 64_000,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	},
];

/**
 * Claude models that require adaptive thinking (`thinking.type: "adaptive"` +
 * `output_config.effort`) reject budget-based `thinking.type: "enabled"` with
 * a 400. Pi only sends the adaptive shape when `compat.forceAdaptiveThinking`
 * is set, so each Claude model inherits the thinking-shape metadata from Pi's
 * built-in Anthropic catalog. This keeps new/changed upstream models correct
 * after a Pi update without hand-maintaining the list here.
 *
 * Only thinking/sampling fields are copied: the gateway speaks the Claude Code
 * surface, so catalog betas (mid-conversation effort/tool changes, strict
 * tools, server-side fallbacks) stay off. `getModel` is used (not
 * `pi-ai/providers/all`) because Pi's extension loader only aliases the
 * `pi-ai/compat` entry; the regexes cover ids missing from the catalog.
 */
const ADAPTIVE_FALLBACK = /^claude-(opus-(4-[6-9]|[5-9])|sonnet-(4-[6-9]|[5-9])|fable-)/;
const NO_TEMPERATURE_FALLBACK = /^claude-opus-(4-[7-9]|[5-9])/;

function withAnthropicThinkingMetadata(model: FreeModelDefinition): FreeModelDefinition {
	if (model.api !== "anthropic-messages" || !model.reasoning) return model;
	const builtin = (getModel as (provider: string, id: string) => Model<Api> | undefined)(
		"anthropic",
		model.id,
	);
	const builtinCompat = builtin?.compat as
		| { forceAdaptiveThinking?: boolean; supportsTemperature?: boolean }
		| undefined;
	const forceAdaptiveThinking =
		builtinCompat?.forceAdaptiveThinking ?? ADAPTIVE_FALLBACK.test(model.id);
	const supportsTemperature =
		builtinCompat?.supportsTemperature ?? !NO_TEMPERATURE_FALLBACK.test(model.id);
	return {
		...model,
		thinkingLevelMap: model.thinkingLevelMap ?? builtin?.thinkingLevelMap,
		compat: {
			...(forceAdaptiveThinking ? { forceAdaptiveThinking: true } : {}),
			...(supportsTemperature ? {} : { supportsTemperature: false }),
			...model.compat,
		},
	};
}

function streamFreeModel(
	model: Model<Api>,
	context: TranscriptContext,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const headers: Record<string, string> = {
		...(options?.headers as Record<string, string> | undefined),
		...CLAUDE_CODE_HEADERS,
	};
	if (model.api === "anthropic-messages") {
		headers["x-claude-code-session-id"] = crypto.randomUUID();
	}
	const requestModel = {
		...model,
		headers: {
			...(model.headers as Record<string, string> | undefined),
			...headers,
		},
	} as Model<Api>;
	const requestOptions = { ...options, headers };

	if (requestModel.api === "openai-completions") {
		return openAICompletionsApi().streamSimple(
			requestModel as Model<"openai-completions">,
			context,
			requestOptions,
		);
	}
	return anthropicMessagesApi().streamSimple(
		requestModel as Model<"anthropic-messages">,
		context,
		requestOptions,
	);
}

export default function freemodelProvider(pi: ExtensionAPI): void {
	pi.registerProvider("freemodel", {
		name: "FreeModel.dev1 (direct)",
		baseUrl: OPENAI_BASE_URL,
		apiKey: "$FREEMODEL_API_KEY",
		api: "openai-completions",
		authHeader: true,
		headers: CLAUDE_CODE_HEADERS,
		models: MODELS.map(withAnthropicThinkingMetadata),
		streamSimple: streamFreeModel,
	});
}
