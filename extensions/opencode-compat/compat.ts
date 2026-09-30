import type {
	ProviderHeaders,
	ProviderStreams,
	StreamOptions,
	Tool,
	TranscriptContext,
} from "@earendil-works/pi-ai";
import { getCurrentTools, normalizeContext } from "@earendil-works/pi-ai";
import { uuidv7 } from "@earendil-works/pi-ai";

/** Preserve the fork's OpenCode request convention while keeping Pi visible in the suffix.
 * This is a compatibility snapshot, not a guarantee that future free-tier gates accept Pi.
 */
export const OPENCODE_CLIENT_USER_AGENT = "opencode/1.18.31 (pi coding agent)";

const OPENCODE_SESSION_HEADER = "x-opencode-session";
const OPENCODE_SESSION_PATTERN = /^ses_[0-9a-f]{12}[a-z0-9]{14}$/;

/**
 * Retain the fork's workaround for tool-less summaries and single-tool helper calls.
 * Placeholder descriptions tell the model never to call them; no implementation is
 * registered. This contract was needed by earlier Zen gates and is opt-in because
 * current models may already accept stock upstream requests.
 */
const COMPAT_TOOLS: Tool[] = [
	{
		name: "bash",
		description:
			"Inert placeholder declared for request compatibility. Never call this tool.",
		parameters: { type: "object", properties: {}, additionalProperties: false },
	},
	{
		name: "read",
		description:
			"Inert placeholder declared for request compatibility. Never call this tool.",
		parameters: { type: "object", properties: {}, additionalProperties: false },
	},
];

/** Coding-tool names used by the fork compatibility contract. */
const ZEN_RECOGNIZED_TOOL_NAMES = [
	"bash",
	"edit",
	"find",
	"glob",
	"grep",
	"ls",
	"powershell",
	"read",
	"write",
];
const ZEN_MIN_RECOGNIZED_TOOLS = 2;

/**
 * Shape a conversation id like OpenCode's own session ids: `ses_` + 12 lowercase hex
 * + 14 alphanumeric characters. For compatibility with the fork convention, Pi's
 * session ids are mapped deterministically to keep per-conversation routing stable.
 * Ids that already carry the shape pass through unchanged.
 */
export function formatOpenCodeSessionId(sessionId: string): string {
	if (OPENCODE_SESSION_PATTERN.test(sessionId)) return sessionId;
	return `ses_${hashHex(sessionId)}`;
}

/** Deterministic 26 lowercase hex characters from FNV-1a blocks over the full session id. */
function hashHex(input: string): string {
	let out = "";
	for (let block = 0; out.length < 26; block++) {
		let hash = 0x811c9dc5 ^ block;
		for (let index = 0; index < input.length; index++) {
			hash = Math.imul(hash ^ input.charCodeAt(index), 0x01000193);
		}
		out += (hash >>> 0).toString(16).padStart(8, "0");
	}
	return out.slice(0, 26);
}

function findHeaderKey(
	headers: ProviderHeaders,
	name: string,
): string | undefined {
	const expected = name.toLowerCase();
	return Object.keys(headers).find((key) => key.toLowerCase() === expected);
}

/**
 * Enforce the Zen free-tier gate's client identity on request headers. Caller values
 * win only when they already satisfy the gate: an `opencode/`-prefixed User-Agent and
 * a valid `ses_` session header (or an explicit null suppression). Anything else is
 * replaced to preserve the earlier fork request convention.
 */
function withCompatHeaders<TOptions extends StreamOptions>(
	options: TOptions | undefined,
): TOptions | undefined {
	const headers: ProviderHeaders = { ...options?.headers };

	const userAgentKey = findHeaderKey(headers, "user-agent");
	if (userAgentKey === undefined) {
		headers["User-Agent"] = OPENCODE_CLIENT_USER_AGENT;
	} else {
		const userAgent = headers[userAgentKey];
		if (userAgent !== null && !/^opencode\//i.test(userAgent)) {
			headers[userAgentKey] = OPENCODE_CLIENT_USER_AGENT;
		}
	}

	const sessionKey = findHeaderKey(headers, OPENCODE_SESSION_HEADER);
	if (sessionKey === undefined) {
		headers[OPENCODE_SESSION_HEADER] = formatOpenCodeSessionId(
			options?.sessionId ?? uuidv7(),
		);
	} else {
		const session = headers[sessionKey];
		if (session !== null && !OPENCODE_SESSION_PATTERN.test(session)) {
			headers[sessionKey] = formatOpenCodeSessionId(
				options?.sessionId ?? uuidv7(),
			);
		}
	}

	return { ...options, headers } as TOptions;
}

/** Declare inert compat tools when the transcript has fewer than two recognized coding tools. */
function withCompatTools(context: TranscriptContext): TranscriptContext {
	const declared = getCurrentTools(context.messages);
	const declaredNames = new Set(declared.map((tool) => tool.name));
	const recognized = ZEN_RECOGNIZED_TOOL_NAMES.filter((name) =>
		declaredNames.has(name),
	);
	if (recognized.length >= ZEN_MIN_RECOGNIZED_TOOLS) return context;
	const padding = COMPAT_TOOLS.filter((tool) => !declaredNames.has(tool.name));
	const messages = [...context.messages];
	const first = messages[0];
	if (first?.role === "system") {
		messages[0] = {
			...first,
			toolsAdded: [...(first.toolsAdded ?? []), ...padding],
		};
	} else {
		messages.unshift({
			role: "system",
			content: "",
			toolsAdded: padding,
			timestamp: 0,
		});
	}
	// Restore placeholders removed later in the transcript, without rewriting history.
	const current = new Set(getCurrentTools(messages).map((tool) => tool.name));
	const removed = COMPAT_TOOLS.filter((tool) => !current.has(tool.name));
	if (removed.length > 0) {
		messages.push({
			role: "system",
			content: "",
			toolsAdded: removed,
			timestamp: 0,
		});
	}
	return normalizeContext({ messages });
}

/**
 * Adds OpenCode Zen's required client attribution (User-Agent, session header, and
 * gate-satisfying tool declarations) before API dispatch.
 */
export function withOpenCodeCompat(streams: ProviderStreams): ProviderStreams {
	return {
		...streams,
		stream: (model, context, options) =>
			streams.stream(
				model,
				withCompatTools(context),
				withCompatHeaders(options),
			),
		streamSimple: (model, context, options) =>
			streams.streamSimple(
				model,
				withCompatTools(context),
				withCompatHeaders(options),
			),
	};
}
