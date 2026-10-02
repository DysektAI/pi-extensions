/**
 * AgentRouter stored-item-ID fix for OpenAI Responses requests.
 *
 * Root cause of the error:
 *   OpenAI API error (400): "The requested item was created under a different
 *   ... OpenAI resource. Use the same resource that created the item to access it."
 *
 * AgentRouter (agentrouter.org) serves its `openai-responses` models from a pool
 * of upstream Azure OpenAI resources and rotates the resource between requests.
 * Pi replays prior-turn output items and keeps their upstream IDs (`msg_…`,
 * `fc_…`, `rs_…`) so OpenAI can pair function calls with reasoning items. Those
 * IDs are resource-scoped: when turn 2 lands on a different Azure resource than
 * turn 1, the upstream rejects the request with the 400 above.
 *
 * Fix:
 *   Strip the resource-scoped `id` fields from `input` items before sending.
 *   IDs are optional on replayed items (pairing is done via `call_id`), while
 *   the portable payload — including `reasoning.encrypted_content` — is kept.
 *   The stored IDs stay in the local session history, so other providers that
 *   live on a single resource still replay them normally.
 *
 * Scope: only OpenAI Responses requests made to AgentRouter. Anthropic-style
 * requests to the same provider use `messages` and are left untouched.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const AGENTROUTER_HOST = "agentrouter.org";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAgentRouterRequest(provider: string | undefined, baseUrl: string | undefined): boolean {
	return provider === "agentrouter" || (baseUrl?.includes(AGENTROUTER_HOST) ?? false);
}

/** Drop `id` from every replayed output item while keeping all other fields. */
export function stripStoredItemIds(payload: unknown): unknown {
	if (!isRecord(payload) || !Array.isArray(payload.input)) return payload;

	let changed = false;
	const input = payload.input.map((item) => {
		if (!isRecord(item) || !("id" in item)) return item;
		const { id: _storedItemId, ...rest } = item;
		changed = true;
		return rest;
	});
	if (!changed) return payload;
	return { ...payload, input };
}

export default function (pi: ExtensionAPI) {
	pi.on("before_provider_request", (event, ctx) => {
		if (!isAgentRouterRequest(ctx.model?.provider, ctx.model?.baseUrl)) return;
		return stripStoredItemIds(event.payload);
	});
}
