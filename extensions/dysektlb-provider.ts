import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";
import { dysektlbProvider } from "./dysektlb/provider.ts";
export { toPiModel, usesResponsesApi } from "./dysektlb/provider.ts";

export default async function (pi: ExtensionAPI): Promise<void> {
	await dysektlbProvider(pi, getAgentDir());
}
