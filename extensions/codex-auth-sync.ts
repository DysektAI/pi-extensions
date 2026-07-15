/**
 * Codex Auth Sync Extension
 *
 * Makes the Codex CLI the single source of truth for openai-codex OAuth.
 * Pi never refreshes the OpenAI token itself (OpenAI uses single-use rotating
 * refresh tokens, so a second refresher always hits `refresh_token_reused`).
 * Instead Pi mirrors ~/.codex/auth.json and, when its access token expires,
 * re-reads that file to pick up whatever the Codex CLI last wrote.
 *
 * Flow:
 * - startup: copy Codex CLI tokens into Pi's auth.json (Codex wins).
 * - refresh: re-read ~/.codex/auth.json. If Codex's token is still good, use it.
 *   If Codex's token is also expired, tell the user to run `codex login`.
 *
 * Uses pi.registerProvider(..., { oauth }) — the old registerOAuthProvider API
 * was removed from @earendil-works/pi-ai/oauth (types-only entry now).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

// ============================================================================
// Codex auth.json types
// ============================================================================
interface CodexTokenData {
	id_token?: string;
	access_token: string;
	refresh_token: string;
	account_id?: string;
}

interface CodexAuthJson {
	auth_mode?: "chatgpt" | "apiKey" | "agentIdentity" | "chatgptAuthTokens";
	OPENAI_API_KEY?: string | null;
	openai_api_key?: string | null;
	tokens?: CodexTokenData | null;
	last_refresh?: string | null;
	agent_identity?: string | null;
}

// Pi persists oauth credentials with a leading `type` field.
type PiOAuthCredential = OAuthCredentials & {
	type: "oauth" | "api_key";
	[key: string]: unknown;
};

const REFRESH_BUFFER_MS = 30_000;

// ============================================================================
// Paths
// ============================================================================
function getPiAuthPath(): string {
	const piDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
	return join(piDir, "auth.json");
}

function getCodexAuthPath(): string {
	const codexHome = process.env.CODEX_HOME || join(homedir(), ".codex");
	return join(codexHome, "auth.json");
}

function loadJson<T>(path: string): T | undefined {
	if (!existsSync(path)) return undefined;
	try {
		return JSON.parse(readFileSync(path, "utf-8")) as T;
	} catch {
		return undefined;
	}
}

function saveJson(path: string, data: unknown): void {
	const dir = dirname(path);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
	}
	writeFileSync(path, JSON.stringify(data, null, 2), { mode: 0o600 });
}

// ============================================================================
// JWT helpers
// ============================================================================
function decodeJwtPayload(token: string): Record<string, unknown> | null {
	try {
		const parts = token.split(".");
		if (parts.length !== 3) return null;
		const decoded = Buffer.from(parts[1] ?? "", "base64url").toString("utf-8");
		return JSON.parse(decoded) as Record<string, unknown>;
	} catch {
		return null;
	}
}

function getAccountIdFromAccessToken(accessToken: string): string | null {
	const payload = decodeJwtPayload(accessToken);
	if (!payload) return null;
	const auth = payload["https://api.openai.com/auth"] as Record<string, unknown> | undefined;
	const accountId = auth?.chatgpt_account_id ?? payload["account_id"];
	return typeof accountId === "string" && accountId.length > 0 ? accountId : null;
}

function getExpiresFromAccessToken(accessToken: string): number | null {
	const payload = decodeJwtPayload(accessToken);
	if (!payload || typeof payload.exp !== "number") return null;
	return payload.exp * 1000; // seconds -> ms
}

// ============================================================================
// Read the Codex CLI credential (Codex is the source of truth)
// ============================================================================
function codexCredential(): PiOAuthCredential | undefined {
	const codexAuth = loadJson<CodexAuthJson>(getCodexAuthPath());
	if (!codexAuth) return undefined;
	const mode = codexAuth.auth_mode;

	if (mode === "apiKey") {
		const key = codexAuth.openai_api_key ?? codexAuth.OPENAI_API_KEY;
		if (!key) return undefined;
		return {
			type: "api_key",
			access: key,
			refresh: "",
			expires: Date.now() + 365 * 24 * 60 * 60 * 1000,
			authMode: "apiKey",
		};
	}

	if (mode === "agentIdentity") {
		const jwt = codexAuth.agent_identity;
		if (!jwt) return undefined;
		return {
			type: "oauth",
			access: jwt,
			refresh: "",
			expires: getExpiresFromAccessToken(jwt) ?? Date.now() + 24 * 60 * 60 * 1000,
			accountId: getAccountIdFromAccessToken(jwt) ?? "agent-identity",
			authMode: "agentIdentity",
		};
	}

	// chatgpt / chatgptAuthTokens
	const tokens = codexAuth.tokens;
	if (!tokens?.access_token) return undefined;
	return {
		type: "oauth",
		access: tokens.access_token,
		refresh: tokens.refresh_token ?? "",
		expires: getExpiresFromAccessToken(tokens.access_token) ?? Date.now() + 60 * 60 * 1000,
		accountId: tokens.account_id ?? getAccountIdFromAccessToken(tokens.access_token) ?? undefined,
		authMode: mode ?? "chatgpt",
		idToken: tokens.id_token,
	};
}

function isExpired(cred: PiOAuthCredential): boolean {
	if (cred.authMode === "apiKey" || cred.authMode === "agentIdentity") return false;
	return typeof cred.expires === "number" && cred.expires <= Date.now() + REFRESH_BUFFER_MS;
}

// ============================================================================
// Sync Codex -> Pi (Codex always wins)
// ============================================================================
function syncCodexAuthToPi(): string | undefined {
	const cred = codexCredential();
	if (!cred) return undefined;

	const piPath = getPiAuthPath();
	const piAuth = loadJson<Record<string, unknown>>(piPath) ?? {};
	const existing = piAuth["openai-codex"] as PiOAuthCredential | undefined;

	if (existing && existing.access === cred.access) return undefined;

	piAuth["openai-codex"] = cred;
	saveJson(piPath, piAuth);
	return `Synced ${String(cred.authMode ?? "chatgpt")} credentials from Codex CLI`;
}

// ============================================================================
// Extension entry point
// ============================================================================
export default function (pi: ExtensionAPI) {
	// Overlay OAuth on built-in openai-codex (no models = keep catalog).
	// refreshToken only re-reads ~/.codex/auth.json — never hits OpenAI.
	pi.registerProvider("openai-codex", {
		oauth: {
			name: "ChatGPT Plus/Pro (Codex CLI)",

			async login(_callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
				const cred = codexCredential();
				if (cred && !isExpired(cred)) {
					syncCodexAuthToPi();
					return cred;
				}
				throw new Error(
					"openai-codex: log in with the Codex CLI first (`codex login`), then run /sync-codex-auth or restart Pi. Pi does not refresh OpenAI tokens itself (rotating refresh tokens).",
				);
			},

			async refreshToken(_credentials: OAuthCredentials): Promise<OAuthCredentials> {
				const cred = codexCredential();
				if (!cred) {
					throw new Error(
						"openai-codex: no credentials at ~/.codex/auth.json. Run `codex login`, then retry.",
					);
				}
				if (isExpired(cred)) {
					throw new Error(
						"openai-codex: Codex CLI token is expired. Run `codex login` (or any codex command) to refresh it, then retry.",
					);
				}
				return cred;
			},

			getApiKey(credentials: OAuthCredentials): string {
				return credentials.access;
			},
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		const result = syncCodexAuthToPi();
		if (result) ctx.ui.notify(result, "info");
	});

	pi.registerCommand("sync-codex-auth", {
		description: "Pull the latest OAuth credentials from the Codex CLI",
		handler: async (_args, ctx) => {
			const result = syncCodexAuthToPi();
			if (result) {
				ctx.ui.notify(result, "info");
				return;
			}
			const codexPath = getCodexAuthPath();
			if (!existsSync(codexPath)) {
				ctx.ui.notify(`No Codex auth at ${codexPath}. Run \`codex login\` first.`, "warning");
			} else {
				ctx.ui.notify("Codex auth already in sync with Pi.", "info");
			}
		},
	});
}
