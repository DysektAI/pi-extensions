/**
 * Run with: npx tsx --test extensions/_shared/discord-auth.tests.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { extractBotId, resolveAuth, resolveBot } from "./discord-auth.ts";

const saved = { ...process.env };
const idToken = (id: string, rest = "xxxx.yyyy") => `${Buffer.from(id).toString("base64")}.${rest}`;

beforeEach(() => {
	for (const key of Object.keys(process.env)) {
		if (key.startsWith("DISCORD_")) delete process.env[key];
	}
	// Keep the user's real ~/.pi/agent/discord.json out of the tests.
	const home = mkdtempSync(join(tmpdir(), "discord-tests-"));
	process.env.HOME = home;
	process.env.USERPROFILE = home;
});

afterEach(() => {
	for (const key of Object.keys(process.env)) {
		if (key.startsWith("DISCORD_")) delete process.env[key];
	}
	Object.assign(process.env, saved);
	if (saved.HOME === undefined) delete process.env.HOME;
	if (saved.USERPROFILE === undefined) delete process.env.USERPROFILE;
});

describe("discord auth", () => {
	it("extracts the bot id from a token", () => {
		assert.equal(extractBotId(idToken("123456789012345678")), "123456789012345678");
		assert.equal(extractBotId("not-a-token"), undefined);
	});

	it("defaults to DISCORD_BOT_TOKEN with the Bot prefix", () => {
		process.env.DISCORD_BOT_TOKEN = "primary-token";
		const { headers, bot } = resolveAuth("bot");
		assert.equal(headers.Authorization, "Bot primary-token");
		assert.equal(bot?.name, "primary");
	});

	it("selects named bots from env and config, honouring default and aliases", () => {
		process.env.DISCORD_BOT_TOKEN = "primary-token";
		process.env.DISCORD_BOT_TOKEN_HELPBOT = "help-token";
		const config = { default: "dysekt", bots: { dysekt: { token: "dysekt-token", aliases: ["Main"] } } };
		assert.equal(resolveBot(undefined, config).token, "dysekt-token");
		assert.equal(resolveBot("helpbot", config).token, "help-token");
		assert.equal(resolveBot("main", config).token, "dysekt-token");
		assert.throws(() => resolveBot("nope", config), /Unknown Discord bot "nope"/);
	});

	it("uses DISCORD_USER_TOKEN without the Bot prefix for account=user", () => {
		process.env.DISCORD_USER_TOKEN = "user-token";
		const { headers, bot } = resolveAuth("user");
		assert.equal(headers.Authorization, "user-token");
		assert.equal(bot, undefined);
	});

	it("rejects account=user without a token or combined with a bot name", () => {
		assert.throws(() => resolveAuth("user"), /DISCORD_USER_TOKEN is not set/);
		process.env.DISCORD_USER_TOKEN = "user-token";
		assert.throws(() => resolveAuth("user", "helpbot"), /cannot be combined/);
	});
});
