import type { Api, Model, RefreshModelsContext } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";

export const USER_AGENT = "claude-cli/2.1.218 (external, sdk-cli)";
const REFRESH_INTERVAL_MS = 5 * 60 * 1000;

// Pi 1.0 lacks this optional context field; newer hosts provide it for overrides.
export type CatalogRefreshContext = RefreshModelsContext & { baseUrl?: string };

export interface CatalogModel {
	id: string;
	supported_endpoint_types: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Reject partial/malformed catalogs rather than replacing a good cache with them. */
export function parseCatalog(payload: unknown): CatalogModel[] {
	if (!isRecord(payload) || payload.success === false || !Array.isArray(payload.data)) {
		throw new Error("Invalid AgentRouter model catalog");
	}
	const seen = new Set<string>();
	return payload.data.map((value: unknown) => {
		if (
			!isRecord(value) ||
			typeof value.id !== "string" ||
			!value.id.trim() ||
			value.id !== value.id.trim() ||
			seen.has(value.id) ||
			!Array.isArray(value.supported_endpoint_types) ||
			!value.supported_endpoint_types.every((entry: unknown) => typeof entry === "string")
		) {
			throw new Error("Invalid AgentRouter model entry");
		}
		seen.add(value.id);
		return { id: value.id, supported_endpoint_types: [...value.supported_endpoint_types] };
	});
}

function transport(model: CatalogModel): Api | undefined {
	if (model.id.startsWith("claude-") && model.supported_endpoint_types.includes("anthropic")) {
		return "anthropic-messages";
	}
	if (model.supported_endpoint_types.includes("openai")) {
		// AgentRouter's "openai" marker includes Responses for GPT models (live-tested).
		return /^gpt-/.test(model.id) ? "openai-responses" : "openai-completions";
	}
	return undefined;
}

export function toModel(entry: CatalogModel, baseUrl: string, upstream: readonly Model<Api>[]): Model<Api> | undefined {
	const api = transport(entry);
	if (!api) return undefined;
	// Exact upstream IDs only: don't give an unknown alias another model's limits.
	const metadata = upstream.find((model) => model.id === entry.id);
	return {
		type: "chat",
		provider: "agentrouter",
		id: entry.id,
		name: `${metadata?.name ?? entry.id} (AgentRouter)`,
		api,
		baseUrl: api === "anthropic-messages" ? baseUrl.replace(/\/v1\/?$/, "") : baseUrl,
		reasoning: metadata?.reasoning ?? false,
		input: metadata?.input ?? ["text"],
		contextWindow: metadata?.contextWindow ?? 8192,
		maxTokens: metadata?.maxTokens ?? 2048,
		thinkingLevelMap: metadata?.thinkingLevelMap,
		inputLimits: metadata?.inputLimits,
		// AgentRouter doesn't publish USD/token rates in /models. Do not copy upstream billing.
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		// Transport capabilities aren't inferred from upstream compat flags. Local
		// modelOverrides remain the authority for verified gateway differences.
	};
}

export function createCatalogRefresh(options: {
	baseUrl: string;
	initialModels: Model<Api>[];
	upstream: readonly Model<Api>[];
	fetch?: typeof fetch;
	now?: () => number;
}): (context: CatalogRefreshContext) => Promise<ProviderModelConfig[]> {
	let current = options.initialModels;
	let checkedAt: number | undefined;
	let lastKey: string | undefined;
	let lastBaseUrl: string | undefined;
	const fetchCatalog = options.fetch ?? fetch;
	const now = options.now ?? Date.now;

	return async (context) => {
		const baseUrl = (context.baseUrl ?? options.baseUrl).replace(/\/+$/, "");
		if (
			current.some(
				(model) =>
					model.baseUrl !== baseUrl &&
					!(model.api === "anthropic-messages" && model.baseUrl === baseUrl.replace(/\/v1$/, "")),
			)
		) {
			current = options.initialModels.map((model) => ({
				...model,
				baseUrl: model.api === "anthropic-messages" ? baseUrl.replace(/\/v1$/, "") : baseUrl,
			}));
			checkedAt = undefined;
		}
		// Pi restores the store before resolving credentials or permitting network I/O.
		// Check endpoint identity so a proxy change never reuses the old catalog.
		const stored = context.stored;
		if (
			stored &&
			stored.models.every(
				(model) =>
					model.provider === "agentrouter" &&
					model.type === "chat" &&
					(model.baseUrl === baseUrl ||
						(model.api === "anthropic-messages" && model.baseUrl === baseUrl.replace(/\/v1$/, ""))),
			)
		) {
			current = stored.models as Model<Api>[];
			checkedAt = stored.checkedAt;
		}
		if (!context.allowNetwork) return current;
		if (
			context.credential?.type !== "api_key" ||
			typeof context.credential.key !== "string" ||
			!context.credential.key.trim()
		) {
			if (context.force) throw new Error("AgentRouter refresh needs an API key resolved by Pi; check models.json.");
			return current;
		}
		// A disk cache never proves access for this process/key. Refresh once per
		// startup and after key/endpoint changes, then debounce picker refreshes.
		if (
			!context.force &&
			lastKey === context.credential.key &&
			lastBaseUrl === baseUrl &&
			checkedAt !== undefined &&
			now() - checkedAt >= 0 &&
			now() - checkedAt < REFRESH_INTERVAL_MS
		)
			return current;

		const response = await fetchCatalog(`${baseUrl}/models`, {
			headers: { Authorization: `Bearer ${context.credential.key}`, "User-Agent": USER_AGENT },
			signal: AbortSignal.any([context.signal, AbortSignal.timeout(10000)]),
			redirect: "error",
		});
		context.signal.throwIfAborted();
		if (!response.ok) {
			if (response.status === 401 || response.status === 403) {
				// A rejected key must not keep advertising models from a previous key.
				if (await context.publish({ persist: { models: [] } })) {
					current = [];
					checkedAt = undefined;
					lastKey = undefined;
				}
				console.warn(
					`[agentrouter-provider] Catalog authentication failed (HTTP ${response.status}); check the configured AgentRouter key.`,
				);
				return current;
			}
			throw new Error(`AgentRouter catalog HTTP ${response.status}`);
		}
		const models = parseCatalog(await response.json())
			.map((entry) => toModel(entry, baseUrl, options.upstream))
			.filter((model): model is Model<Api> => model !== undefined);
		context.signal.throwIfAborted();
		const timestamp = now();
		if (await context.publish({ persist: { models, checkedAt: timestamp } })) {
			current = models;
			checkedAt = timestamp;
			lastKey = context.credential.key;
			lastBaseUrl = baseUrl;
		}
		return current;
	};
}

export function registerAgentRouter(pi: ExtensionAPI, baseUrl: string, upstream: readonly Model<Api>[]): void {
	const initial = toModel({ id: "gpt-6.1-sol", supported_endpoint_types: ["openai"] }, baseUrl, upstream)!;
	pi.registerProvider("agentrouter", {
		name: "AgentRouter",
		// Omit apiKey, baseUrl, and headers: models.json/Pi resolve those normally.
		models: [initial],
		refreshModels: createCatalogRefresh({ baseUrl, initialModels: [initial], upstream }),
	});
	const warn = () =>
		console.warn(
			"[agentrouter-provider] Catalog refresh failed; keeping the last known models. Use /agentrouter-refresh to retry.",
		);
	pi.on("session_start", (_event, ctx) => {
		// The registry honors --offline. Don't delay startup on a warm-cache fetch.
		void ctx.modelRegistry
			.refresh({ providers: ["agentrouter"] })
			.then((result) => {
				if (result.errors.has("agentrouter")) warn();
			})
			.catch(warn);
	});
	pi.registerCommand("agentrouter-refresh", {
		description: "Refresh the AgentRouter models accessible to the configured key",
		handler: async (_args, ctx) => {
			// Pi skips the network refresh phase when auth resolves empty, so check
			// here too: that skip must not be reported as a successful forced fetch.
			if (!(await ctx.modelRegistry.getApiKeyForProvider("agentrouter"))?.trim()) {
				ctx.ui.notify("AgentRouter refresh needs a configured API key; check models.json.", "warning");
				return;
			}
			const result = await ctx.modelRegistry.refresh({ providers: ["agentrouter"], force: true });
			const error = result.errors.get("agentrouter");
			if (error || result.aborted) {
				ctx.ui.notify(error?.message ?? "AgentRouter refresh cancelled", "warning");
				return;
			}
			const count = ctx.modelRegistry.getAll().filter((model) => model.provider === "agentrouter").length;
			if (count === 0) {
				// A rejected key publishes an empty catalog without an error; a genuinely
				// empty catalog looks the same, so the warning covers both causes.
				ctx.ui.notify("AgentRouter catalog: 0 models available; the key may be rejected or have no model access.", "warning");
				return;
			}
			ctx.ui.notify(`AgentRouter catalog: ${count} known model(s)`, "info");
		},
	});
}
