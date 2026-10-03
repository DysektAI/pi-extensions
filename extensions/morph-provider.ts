import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";
import { morphProvider } from "./morph/provider.ts";

export default async function (pi: ExtensionAPI): Promise<void> {
	await morphProvider(pi, getAgentDir());
}
