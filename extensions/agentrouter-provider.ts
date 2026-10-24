/** Authenticated model discovery using Pi's native refresh/cache lifecycle.
 * Requires providers.agentrouter in models.json; leaves request-time auth there.
 */
import type { Api, Model } from "@earendil-works/pi-ai";
import { getBuiltinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { registerAgentRouter } from "./agentrouter/catalog.ts";

export default async function agentrouterProvider(pi: ExtensionAPI): Promise<void> {
	const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
	let baseUrl: string;
	try {
		const config = JSON.parse(await readFile(join(agentDir, "models.json"), "utf8"));
		const provider = config?.providers?.agentrouter;
		if (!provider) return;
		if (typeof provider.baseUrl !== "string" || !provider.baseUrl.trim()) {
			throw new Error("AgentRouter requires a baseUrl");
		}
		baseUrl = provider.baseUrl.replace(/\/+$/, "");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			console.warn("[agentrouter-provider] Cannot load AgentRouter configuration; check models.json.");
		}
		return;
	}
	// Prefer direct-provider metadata to copies carried by other gateways.
	const preferred = ["openai", "anthropic", "deepseek"];
	const providers = [...getBuiltinProviders()].sort((a, b) => {
		const rank = (id: string) => (preferred.includes(id) ? preferred.indexOf(id) : preferred.length);
		return rank(a) - rank(b);
	});
	const upstream: Model<Api>[] = providers.flatMap((provider) => getBuiltinModels(provider));
	registerAgentRouter(pi, baseUrl, upstream);
}
