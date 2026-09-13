/**
 * Discord - manage Discord via its REST API directly (no MCP).
 *
 * Setup:
 *   1. Create a bot at https://discord.com/developers/applications,
 *      enable the intents you need, invite it to your server.
 *   2. export DISCORD_BOT_TOKEN="..."   (bot token, NOT a user token)
 *   3. (optional) export DISCORD_USER_TOKEN="..."  (user/account token,
 *      to act as the human account; see 'account' param below)
 *   4. Drop this file in ~/.pi/agent/extensions/ (done) and restart pi.
 *
 * The LLM calls one generic tool; it knows Discord's REST routes.
 */

import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const API = "https://discord.com/api/v10";
const MAX_BODY = 50_000; // ponytail: truncate big payloads, raise if you hit it

// Which account to act as. "bot" (default) uses DISCORD_BOT_TOKEN with a
// "Bot " prefix; "user" uses DISCORD_USER_TOKEN with no prefix (self-account).
type Account = "bot" | "user";

function authHeaders(account: Account): Record<string, string> {
	if (account === "user") {
		const userToken = process.env.DISCORD_USER_TOKEN;
		if (!userToken) {
			throw new Error(
				'DISCORD_USER_TOKEN is not set in the environment. ' +
					'Set it first, or call with account="bot".',
			);
		}
		// User-account tokens must NOT have the "Bot " prefix.
		return { Authorization: userToken };
	}
	const token = process.env.DISCORD_BOT_TOKEN;
	if (!token) throw new Error("DISCORD_BOT_TOKEN is not set in the environment.");
	return { Authorization: `Bot ${token}` };
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "discord",
		label: "Discord",
		description:
			"Call the Discord REST API (v10). Provide an HTTP method and a path " +
			"like '/users/@me', '/guilds/{id}/channels', or " +
			"'/channels/{id}/messages'. Defaults to the bot account; pass " +
			'account="user" to act as the human user account (requires ' +
			"DISCORD_USER_TOKEN).",
		promptSnippet:
			"Manage Discord: read/send messages, channels, roles, guilds via REST",
		promptGuidelines: [
			"Use discord for any Discord action. Base is https://discord.com/api/v10; pass only the path. Auth is automatic.",
			"To send a message: POST /channels/{channelId}/messages with body {\"content\":\"...\"}.",
			'Defaults to the bot account. To act as the user\'s personal account, pass account="user" (requires DISCORD_USER_TOKEN env var).',
		],
		parameters: Type.Object({
			method: StringEnum(["GET", "POST", "PATCH", "PUT", "DELETE"] as const),
			path: Type.String({ description: "API path starting with '/', e.g. '/guilds/{id}/channels'" }),
			body: Type.Optional(Type.Record(Type.String(), Type.Any(), { description: "JSON body for POST/PATCH/PUT" })),
			account: Type.Optional(
				StringEnum(["bot", "user"] as const, {
					description:
						'Which account to act as. "bot" (default) = the bot token; "user" = the personal user account via DISCORD_USER_TOKEN.',
				}),
			),
		}),

		async execute(_id, params, signal) {
			const account: Account = params.account ?? "bot";
			const headers = authHeaders(account);

			const path = params.path.startsWith("/") ? params.path : `/${params.path}`;
			const res = await fetch(API + path, {
				method: params.method,
				headers: {
					...headers,
					"Content-Type": "application/json",
				},
				body: params.body ? JSON.stringify(params.body) : undefined,
				signal,
			});

			let text = await res.text();
			if (text.length > MAX_BODY) text = text.slice(0, MAX_BODY) + "\n…[truncated]";
			const label = `${res.status} ${res.statusText}`;
			return {
				content: [{ type: "text", text: `${label}\n${text || "(empty body)"}` }],
				details: { status: res.status, ok: res.ok, account },
			};
		},
	});
}
