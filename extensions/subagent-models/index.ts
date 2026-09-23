/**
 * subagent-models — keep user agent model pins in sync with /config roles.
 *
 * Agent definitions in ~/.pi/agent/agents/*.md pin their own `model:` and
 * `fallbackModels:`. Left to drift, those pins can point at expensive or
 * scoped-off models (e.g. kimi-k3) while the /config "Subagent model" role
 * says something else entirely — and the pins silently win at spawn time.
 *
 * This extension is the bridge: on every pi startup it rewrites those two
 * frontmatter lines from resolveSubagentChain() ("Subagent model" +
 * "Subagent fallback 1..3" from model-roles.json, cheap built-in defaults
 * when unset). /config re-applies immediately after you pick a role model,
 * so startup is only the backstop.
 *
 * Project agents (<project>/.pi/agents/*.md) are never touched.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { applySubagentChainToAgents } from "../_shared/model-roles.ts";

export default function (_pi: ExtensionAPI) {
	try {
		const { updated, chain } = applySubagentChainToAgents();
		if (updated.length > 0 && chain.length > 0) {
			console.log(
				`[subagent-models] synced ${updated.join(", ")} to ${chain[0]} (+${chain.length - 1} fallbacks)`,
			);
		}
	} catch {
		// Agent sync must never break pi startup.
	}
}
