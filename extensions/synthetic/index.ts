/**
 * Synthetic provider (https://synthetic.new): OpenAI-compatible, catalog fetched live.
 *
 * Auth: `synthetic` entry in ~/.pi/agent/auth.json, then SYNTHETIC_API_KEY. Without a
 * key the provider is skipped silently. A failed fetch falls back to the last catalog
 * cached (0600) under ~/.pi/agent/.cache/synthetic-models.json.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { extractModels, SYNTHETIC_BASE_URL, type SyntheticModel, toPiModel } from "./pure.ts";

const FETCH_TIMEOUT_MS = 10000;

async function readApiKey(): Promise<string | undefined> {
	try {
		const auth = JSON.parse(await readFile(join(getAgentDir(), "auth.json"), "utf8")) as Record<string, unknown>;
		const entry = auth.synthetic;
		if (typeof entry === "string") return entry;
		const key = (entry as { key?: unknown } | undefined)?.key;
		if (typeof key === "string") return key;
	} catch {
		// Fall back to the environment.
	}
	return process.env.SYNTHETIC_API_KEY || undefined;
}

const cachePath = () => join(getAgentDir(), ".cache", "synthetic-models.json");

async function fetchCatalog(apiKey: string): Promise<SyntheticModel[]> {
	const response = await fetch(`${SYNTHETIC_BASE_URL}/models`, {
		headers: { Authorization: `Bearer ${apiKey}` },
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
	});
	if (!response.ok) throw new Error(`HTTP ${response.status}`);
	return extractModels(await response.json());
}

async function cached(): Promise<SyntheticModel[]> {
	try {
		return extractModels(JSON.parse(await readFile(cachePath(), "utf8")));
	} catch {
		return [];
	}
}

async function saveCache(models: SyntheticModel[]): Promise<void> {
	try {
		await mkdir(dirname(cachePath()), { recursive: true });
		await writeFile(cachePath(), JSON.stringify({ data: models }), { encoding: "utf8", mode: 0o600 });
	} catch {
		/* best-effort */
	}
}

export default async function syntheticProvider(pi: ExtensionAPI): Promise<void> {
	const apiKey = await readApiKey();
	if (!apiKey) return;

	let catalog: SyntheticModel[];
	try {
		catalog = await fetchCatalog(apiKey);
		await saveCache(catalog);
	} catch (error) {
		catalog = await cached();
		const reason = error instanceof Error ? error.message : String(error);
		console.warn(`[synthetic] Catalog fetch failed (${reason}); using ${catalog.length} cached models.`);
	}

	const models = catalog.flatMap((entry) => {
		const model = toPiModel(entry);
		return model ? [model] : [];
	});
	if (models.length === 0) return;

	pi.registerProvider("synthetic", {
		name: "Synthetic",
		baseUrl: SYNTHETIC_BASE_URL,
		apiKey,
		api: "openai-completions",
		authHeader: true,
		models: models as never,
	});
}
