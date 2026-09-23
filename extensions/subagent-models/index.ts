/**
 * subagent-models — startup housekeeping for /config-owned subagent models.
 *
 * The subagent tool resolves its model chain from model-roles.json at spawn
 * time (see _shared/subagent-models.ts); agent files no longer carry models.
 * On every pi startup this extension:
 *
 *   1. migrates the legacy single-select roles (subagent, subagentFallback1..3)
 *      into the ordered `subagentModels` list, and
 *   2. strips stale `model:` / `fallbackModels:` pins from
 *      ~/.pi/agent/agents/*.md so no file suggests a model that is not used.
 *
 * Project agents (<project>/.pi/agents/*.md) are never touched.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { migrateLegacySubagentRoles, stripModelPinsFromAgents } from "../_shared/subagent-models.ts";

export default function (_pi: ExtensionAPI) {
	try {
		migrateLegacySubagentRoles();
		stripModelPinsFromAgents();
	} catch {
		// Housekeeping must never break pi startup.
	}
}
