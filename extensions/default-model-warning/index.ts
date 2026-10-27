import { getAgentDir, SettingsManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createDefaultModelCheck } from "./pure.js";

/**
 * Stock 1.4.0 APIs: docs/extensions.md (session lifecycle, ctx.ui.notify),
 * src/core/extensions/types.ts:755-761 (startup/new reasons), :325-352 (model/trust).
 * Public SettingsManager.fromStorage + getDefaultProvider/getDefaultModel:
 * src/core/settings-manager.ts:325-327, :695-700; docs/sdk.md (settings).
 * Read-only storage preserves stock merge/migration/BOM semantics and trust,
 * without SettingsManager.create's filesystem locks or any model/auth calls.
 */
export default function defaultModelWarning(pi: ExtensionAPI): void {
 pi.on("session_start", createDefaultModelCheck(getAgentDir, (storage, options) => SettingsManager.fromStorage(storage, options)));
}
