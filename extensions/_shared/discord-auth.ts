/**
 * Pure Discord auth resolution (no pi runtime imports) so it can be unit-tested.
 * Used by extensions/discord.ts.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";

export interface BotEntry {
	token: string;
	id?: string;
	name?: string;
	aliases?: string[];
}

export interface DiscordConfig {
	default?: string;
	bots?: Record<string, string | BotEntry>;
}

export interface ResolvedBot {
	token: string;
	id?: string;
	name: string;
	aliases: string[];
}

// Which account to act as. "bot" (default) uses a bot token with a "Bot "
// prefix; "user" uses DISCORD_USER_TOKEN with no prefix (self-account).
export type Account = "bot" | "user";

/** Bot tokens start with the base64-encoded application/user ID. */
export function extractBotId(token: string): string | undefined {
	try {
		const firstPart = token.split(".")[0];
		if (!firstPart) return undefined;
		const decoded = Buffer.from(firstPart, "base64").toString("utf-8");
		return /^\d{16,21}$/.test(decoded) ? decoded : undefined;
	} catch {
		return undefined;
	}
}

export function loadConfig(): DiscordConfig | null {
	const candidates = [
		nodePath.join(os.homedir(), ".pi", "agent", "discord.json"),
		nodePath.join(os.homedir(), ".pi", "discord.json"),
	];
	for (const p of candidates) {
		if (!fs.existsSync(p)) continue;
		try {
			return JSON.parse(fs.readFileSync(p, "utf-8")) as DiscordConfig;
		} catch {
			// Ignore malformed config and continue.
		}
	}
	return null;
}

export function resolveBot(botName?: string, config: DiscordConfig | null = loadConfig()): ResolvedBot {
	const bots = new Map<string, ResolvedBot>();

	// 1. DISCORD_BOT_TOKEN (default/primary)
	const envToken = process.env.DISCORD_BOT_TOKEN;
	if (envToken) {
		bots.set("primary", { token: envToken, id: extractBotId(envToken), name: "primary", aliases: ["default"] });
	}

	// 2. DISCORD_BOT_TOKEN_<NAME>
	for (const [key, value] of Object.entries(process.env)) {
		if (key.startsWith("DISCORD_BOT_TOKEN_") && value) {
			const name = key.slice("DISCORD_BOT_TOKEN_".length).toLowerCase();
			bots.set(name, { token: value, id: extractBotId(value), name, aliases: [] });
		}
	}

	// 3. ~/.pi/agent/discord.json
	if (config?.bots) {
		for (const [key, val] of Object.entries(config.bots)) {
			const lowerKey = key.toLowerCase();
			if (typeof val === "string") {
				bots.set(lowerKey, { token: val, id: extractBotId(val), name: key, aliases: [] });
			} else if (val && typeof val.token === "string") {
				bots.set(lowerKey, {
					token: val.token,
					id: val.id || extractBotId(val.token),
					name: val.name || key,
					aliases: (val.aliases || []).map((a) => a.toLowerCase()),
				});
			}
		}
	}

	if (bots.size === 0) {
		throw new Error("No Discord bot tokens configured. Set DISCORD_BOT_TOKEN or configure ~/.pi/agent/discord.json.");
	}

	if (!botName) {
		const preferred = config?.default?.toLowerCase();
		if (preferred && bots.has(preferred)) return bots.get(preferred)!;
		if (bots.has("primary")) return bots.get("primary")!;
		return bots.values().next().value!;
	}

	const search = botName.trim().toLowerCase();
	if (bots.has(search)) return bots.get(search)!;
	for (const entry of bots.values()) {
		if (entry.id === search || entry.name.toLowerCase() === search || entry.aliases.includes(search)) {
			return entry;
		}
	}

	const available = Array.from(bots.entries()).map(([k, v]) => `${k}${v.id ? ` (${v.id})` : ""}`);
	throw new Error(`Unknown Discord bot "${botName}". Available bots: ${available.join(", ")}`);
}

export function resolveAuth(
	account: Account,
	botName?: string,
): { headers: Record<string, string>; bot?: ResolvedBot } {
	if (account === "user") {
		if (botName) throw new Error('The "bot" argument cannot be combined with account="user".');
		const userToken = process.env.DISCORD_USER_TOKEN;
		if (!userToken) {
			throw new Error('DISCORD_USER_TOKEN is not set in the environment. Set it first, or call with account="bot".');
		}
		// User-account tokens must NOT have the "Bot " prefix.
		return { headers: { Authorization: userToken } };
	}
	const bot = resolveBot(botName);
	return { headers: { Authorization: `Bot ${bot.token}` }, bot };
}
