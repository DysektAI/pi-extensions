import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { withOpenCodeCompat } from "./compat.js";

/** Install after startup auth registrations so credential pools retain their initial key. */
export default function opencodeCompat(pi: ExtensionAPI) {
	if (process.env.PI_OPENCODE_COMPAT !== "1") return;
	let installed = false;
	pi.on("session_start", (_event, ctx) => {
		if (installed) return;
		for (const id of ["opencode", "opencode-go"]) {
			const provider = ctx.modelRegistry.getProvider?.(id);
			if (provider)
				pi.registerProvider({ ...provider, ...withOpenCodeCompat(provider) });
		}
		installed = true;
	});
}
