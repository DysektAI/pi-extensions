import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";

// ─── Types ───────────────────────────────────────────────────────────

interface KeySource {
  /** Environment variable name */
  env?: string;
  /** Literal API key value */
  value?: string;
  /** Source from a file: { path, var } — sources the file and reads the var */
  envFile?: { path: string; var: string };
  /** Optional label for display */
  label?: string;

  // OAuth-specific fields (when pool type is "oauth")
  access?: string;
  refresh?: string;
  expires?: number;
  accountId?: string;
}

interface PoolEntry {
  /** Pool type: "api_key" (default) or "oauth" */
  type?: "api_key" | "oauth";
  /** Array of key sources to rotate through */
  keys: KeySource[];
  /** Cooldown in ms after a 429 before retrying this key (default: 60000) */
  cooldownMs?: number;
  /** Model to suggest when all keys are exhausted: "provider/model-id" */
  fallbackModel?: string;
}

interface PoolsConfig {
  pools: Record<string, PoolEntry>;
}

interface KeyState {
  source: KeySource;
  resolved: string; // For api_key: the key. For oauth: the access token.
  label: string;
  rateLimitedUntil: number;
  successCount: number;
  errorCount: number;
  // OAuth-only
  refreshToken?: string;
  expiresAt?: number;
  accountId?: string;
}

interface ProviderPool {
  provider: string;
  config: PoolEntry;
  keys: KeyState[];
  activeIndex: number;
  totalRotations: number;
  isOAuth: boolean;
}

// ─── OpenAI OAuth Refresh ────────────────────────────────────────────

const OPENAI_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const OPENAI_TOKEN_URL = "https://auth.openai.com/oauth/token";

// Hard upper bound on the OAuth token-refresh HTTP call. refreshOpenAICodexToken
// runs both at startup (awaited pool init) and inside the awaited
// `after_provider_response` handler on a 401/403. pi awaits every lifecycle
// handler with no timeout of its own, so an unbounded fetch that never settles
// (hung TLS, black-holed connection) would stall the agent loop. Bound it so a
// dead network surfaces as a normal refresh failure instead of a freeze.
// Matches the 10s bound used by megallm-provider.ts.
const TOKEN_REFRESH_TIMEOUT_MS = 10_000;

interface RefreshResult {
  access: string;
  refresh: string;
  expires: number;
  accountId: string;
}

async function refreshOpenAICodexToken(refreshToken: string): Promise<RefreshResult | null> {
  try {
    const response = await fetch(OPENAI_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: OPENAI_CLIENT_ID,
      }),
      signal: AbortSignal.timeout(TOKEN_REFRESH_TIMEOUT_MS),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      console.error(`[credential-pool] OpenAI refresh failed (${response.status}): ${text || response.statusText}`);
      return null;
    }

    const json = (await response.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
    };

    if (!json.access_token || !json.refresh_token || typeof json.expires_in !== "number") {
      console.error(`[credential-pool] OpenAI refresh response missing fields: ${JSON.stringify(json)}`);
      return null;
    }

    const accountId = extractAccountId(json.access_token);
    if (!accountId) {
      console.error("[credential-pool] Failed to extract accountId from refreshed token");
      return null;
    }

    return {
      access: json.access_token,
      refresh: json.refresh_token,
      expires: Date.now() + json.expires_in * 1000,
      accountId,
    };
  } catch (error) {
    console.error(`[credential-pool] OpenAI refresh error: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

function extractAccountId(accessToken: string): string | null {
  try {
    const parts = accessToken.split(".");
    if (parts.length !== 3) return null;
    const payload = JSON.parse(atob(parts[1]!));
    const id = payload?.["https://api.openai.com/auth"]?.chatgpt_account_id;
    return typeof id === "string" ? id : null;
  } catch {
    return null;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────

function resolveKey(source: KeySource): string | undefined {
  if (source.value) return source.value;

  if (source.env) {
    const val = process.env[source.env];
    if (val) return val;
  }

  if (source.envFile) {
    try {
      const expandedPath = source.envFile.path.replace(/^~/, process.env.HOME ?? "~");
      const output = execSync(
        `bash -lc 'source "${expandedPath}" && printf "%s" "\${${source.envFile.var}}"'`,
        { encoding: "utf-8", timeout: 5000 },
      );
      if (output) return output;
    } catch {
      // Silently skip unresolvable keys
    }
  }

  return undefined;
}

function keyLabel(source: KeySource, index: number): string {
  if (source.label) return source.label;
  if (source.env) return source.env;
  if (source.envFile) return `${source.envFile.var} (from ${path.basename(source.envFile.path)})`;
  if (source.accountId) return `acct-${source.accountId.slice(0, 8)}`;
  return `key-${index + 1}`;
}

function maskKey(key: string): string {
  if (key.length <= 12) return "***";
  return key.slice(0, 8) + "…" + key.slice(-4);
}

function formatDuration(ms: number): string {
  if (ms <= 0) return "0s";
  const s = Math.ceil(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  return rs > 0 ? `${m}m${rs}s` : `${m}m`;
}

// ─── Extension ───────────────────────────────────────────────────────

export default async function (pi: ExtensionAPI) {
  const extDir = path.resolve(
    path.dirname(
      typeof __filename !== "undefined"
        ? __filename
        : new URL(import.meta.url).pathname,
    ),
  );
  const configPath = path.join(extDir, "pools.json");

  if (!fs.existsSync(configPath)) {
    return;
  }

  let config: PoolsConfig;
  try {
    config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  } catch (err) {
    console.error(`[credential-pool] Failed to parse pools.json: ${err}`);
    return;
  }

  const pools = new Map<string, ProviderPool>();
  const initErrors: string[] = [];

  // ── Initialize pools ──────────────────────────────────────────────

  for (const [provider, entry] of Object.entries(config.pools)) {
    const isOAuth = entry.type === "oauth";
    const keys: KeyState[] = [];

    for (let i = 0; i < entry.keys.length; i++) {
      const source = entry.keys[i];

      if (isOAuth) {
        if (!source.access || !source.refresh) {
          initErrors.push(`${provider}: OAuth key #${i + 1} missing access or refresh token`);
          continue;
        }
        keys.push({
          source,
          resolved: source.access,
          label: keyLabel(source, i),
          rateLimitedUntil: 0,
          successCount: 0,
          errorCount: 0,
          refreshToken: source.refresh,
          expiresAt: source.expires,
          accountId: source.accountId || extractAccountId(source.access) || undefined,
        });
      } else {
        const resolved = resolveKey(source);
        if (!resolved) {
          initErrors.push(
            `${provider}: could not resolve ${keyLabel(source, i)}`,
          );
          continue;
        }
        keys.push({
          source,
          resolved,
          label: keyLabel(source, i),
          rateLimitedUntil: 0,
          successCount: 0,
          errorCount: 0,
        });
      }
    }

    if (keys.length === 0) {
      initErrors.push(`${provider}: no keys resolved — pool disabled`);
      continue;
    }

    const pool: ProviderPool = {
      provider,
      config: entry,
      keys,
      activeIndex: 0,
      totalRotations: 0,
      isOAuth,
    };
    pools.set(provider, pool);

    // For OAuth: refresh token if expired before registering
    if (isOAuth) {
      let registeredIndex = 0;
      for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        if (key.expiresAt && Date.now() >= key.expiresAt) {
          const refreshed = await refreshOpenAICodexToken(key.refreshToken!);
          if (refreshed) {
            key.resolved = refreshed.access;
            key.refreshToken = refreshed.refresh;
            key.expiresAt = refreshed.expires;
            key.accountId = refreshed.accountId;
            registeredIndex = i;
            break;
          } else {
            initErrors.push(`${provider}: OAuth key #${i + 1} expired and refresh failed`);
          }
        } else {
          registeredIndex = i;
          break;
        }
      }
      pool.activeIndex = registeredIndex;
      pi.registerProvider(provider, {
        apiKey: keys[registeredIndex].resolved,
      });
    } else {
      pi.registerProvider(provider, {
        apiKey: keys[0].resolved,
      });
    }
  }

  // ── Refresh OAuth key ─────────────────────────────────────────────

  async function refreshKeyIfNeeded(pool: ProviderPool, key: KeyState): Promise<boolean> {
    if (!pool.isOAuth || !key.expiresAt || !key.refreshToken) return true;
    if (Date.now() < key.expiresAt - 30_000) return true; // 30s buffer

    const refreshed = await refreshOpenAICodexToken(key.refreshToken);
    if (!refreshed) {
      key.errorCount++;
      return false;
    }

    key.resolved = refreshed.access;
    key.refreshToken = refreshed.refresh;
    key.expiresAt = refreshed.expires;
    key.accountId = refreshed.accountId;
    return true;
  }

  // ── Find next available key ───────────────────────────────────────

  async function rotateToNextKey(pool: ProviderPool): Promise<KeyState | null> {
    const now = Date.now();
    const n = pool.keys.length;

    // Try keys after the current one first
    for (let offset = 1; offset < n; offset++) {
      const idx = (pool.activeIndex + offset) % n;
      const key = pool.keys[idx];
      if (key.rateLimitedUntil <= now) {
        const fresh = await refreshKeyIfNeeded(pool, key);
        if (fresh) {
          pool.activeIndex = idx;
          pool.totalRotations++;
          return key;
        }
      }
    }

    // All keys rate-limited or unrefreshable — pick the one that unlocks soonest
    let bestIdx = 0;
    let bestTime = Infinity;
    for (let i = 0; i < n; i++) {
      if (pool.keys[i].rateLimitedUntil < bestTime) {
        bestTime = pool.keys[i].rateLimitedUntil;
        bestIdx = i;
      }
    }
    pool.activeIndex = bestIdx;
    pool.totalRotations++;
    const key = pool.keys[bestIdx];
    await refreshKeyIfNeeded(pool, key);
    return key;
  }

  function allKeysRateLimited(pool: ProviderPool): boolean {
    const now = Date.now();
    return pool.keys.every((k) => k.rateLimitedUntil > now);
  }

  // ── Event: after_provider_response ────────────────────────────────

  pi.on("after_provider_response", async (event, ctx) => {
    const provider = (ctx as any).model?.provider as string | undefined;
    if (!provider) return;

    const pool = pools.get(provider);
    if (!pool) return;

    const currentKey = pool.keys[pool.activeIndex];

    if (event.status === 429) {
      // ── Rate limited ──────────────────────────────────────────
      const defaultCooldown = pool.config.cooldownMs ?? 60_000;

      let cooldownMs = defaultCooldown;
      const retryAfter = event.headers?.["retry-after"];
      if (retryAfter) {
        const seconds = parseInt(retryAfter, 10);
        if (!isNaN(seconds) && seconds > 0) {
          cooldownMs = Math.min(seconds * 1000, defaultCooldown * 3);
        }
      }

      currentKey.rateLimitedUntil = Date.now() + cooldownMs;
      currentKey.errorCount++;

      const nextKey = await rotateToNextKey(pool);

      if (nextKey && !allKeysRateLimited(pool)) {
        pi.registerProvider(provider, {
          apiKey: nextKey.resolved,
        });

        const idx = pool.activeIndex + 1;
        const total = pool.keys.length;
        const cooldownStr = formatDuration(cooldownMs);

        ctx.ui.notify(
          `🔄 ${provider}: key #${pool.keys.indexOf(currentKey) + 1} rate-limited (${cooldownStr}) → rotated to key #${idx}/${total}`,
          "warn",
        );
        ctx.ui.setStatus(
          "credential-pool",
          `🔑 ${provider} rotated → key #${idx}/${total}`,
        );
      } else {
        const waits = pool.keys.map((k) => k.rateLimitedUntil - Date.now());
        const minWait = Math.min(...waits);

        if (pool.config.fallbackModel) {
          ctx.ui.notify(
            `⚠️ ${provider}: All ${pool.keys.length} keys rate-limited!\n` +
              `Shortest cooldown: ${formatDuration(minWait)}\n` +
              `💡 Switch to fallback model:\n  /model ${pool.config.fallbackModel}`,
            "error",
          );
        } else {
          ctx.ui.notify(
            `⚠️ ${provider}: All ${pool.keys.length} keys rate-limited!\n` +
              `Shortest cooldown: ${formatDuration(minWait)}`,
            "error",
          );
        }
        ctx.ui.setStatus(
          "credential-pool",
          `⚠️ ${provider}: all ${pool.keys.length} keys rate-limited`,
        );
      }
    } else if (event.status === 401 || event.status === 403) {
      // ── Auth error ────────────────────────────────────────────
      currentKey.errorCount++;

      if (pool.isOAuth) {
        // Try refreshing the current key first
        const refreshed = await refreshKeyIfNeeded(pool, currentKey);
        if (refreshed) {
          pi.registerProvider(provider, {
            apiKey: currentKey.resolved,
          });
          ctx.ui.notify(
            `🔑 ${provider}: key #${pool.activeIndex + 1} auth error → token refreshed`,
            "warn",
          );
          return;
        }
      }

      // Refresh failed or not OAuth — rotate
      const nextKey = await rotateToNextKey(pool);
      if (nextKey && !allKeysRateLimited(pool)) {
        pi.registerProvider(provider, {
          apiKey: nextKey.resolved,
        });
        ctx.ui.notify(
          `🔄 ${provider}: key #${pool.keys.indexOf(currentKey) + 1} auth error → rotated to key #${pool.activeIndex + 1}/${pool.keys.length}`,
          "warn",
        );
      } else {
        ctx.ui.notify(
          `⚠️ ${provider}: All ${pool.keys.length} keys failed auth!`,
          "error",
        );
      }
    } else if (event.status >= 200 && event.status < 300) {
      currentKey.successCount++;
      if (currentKey.rateLimitedUntil > 0) {
        currentKey.rateLimitedUntil = 0;
      }
    }
  });

  // ── Event: session_start ──────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    if (pools.size === 0) return;

    for (const err of initErrors) {
      ctx.ui.notify(`🔑 credential-pool: ${err}`, "warn");
    }

    const summary = [...pools.entries()]
      .map(([p, pool]) => `${p}: ${pool.keys.length} ${pool.isOAuth ? "OAuth" : "API"} keys`)
      .join(", ");

    ctx.ui.setStatus("credential-pool", `🔑 ${summary}`);
  });

  // ── Command: /pool ────────────────────────────────────────────────

  pi.registerCommand("pool", {
    description: "Show credential pool status and key health",
    handler: async (_args, ctx) => {
      if (pools.size === 0) {
        ctx.ui.notify("No credential pools configured.", "info");
        return;
      }

      const now = Date.now();
      const lines: string[] = [];

      for (const [provider, pool] of pools) {
        lines.push(`━━━ ${provider} (${pool.isOAuth ? "OAuth" : "API key"}) ━━━`);
        lines.push(
          `  Rotations: ${pool.totalRotations}  |  Cooldown: ${formatDuration(pool.config.cooldownMs ?? 60_000)}`,
        );
        if (pool.config.fallbackModel) {
          lines.push(`  Fallback: ${pool.config.fallbackModel}`);
        }
        lines.push("");

        for (let i = 0; i < pool.keys.length; i++) {
          const key = pool.keys[i];
          const active = i === pool.activeIndex ? " ← active" : "";
          const masked = maskKey(key.resolved);

          let status: string;
          if (key.rateLimitedUntil > now) {
            const remaining = key.rateLimitedUntil - now;
            status = `🔴 limited (${formatDuration(remaining)} left)`;
          } else if (pool.isOAuth && key.expiresAt && now >= key.expiresAt) {
            status = `🟡 expired`;
          } else {
            status = "🟢 available";
          }

          const oauthExtra = pool.isOAuth && key.expiresAt
            ? ` (expires ${formatDuration(key.expiresAt - now)})`
            : "";

          lines.push(
            `  #${i + 1} ${key.label}  ${masked}  ${status}${oauthExtra}  (✓${key.successCount} ✗${key.errorCount})${active}`,
          );
        }
        lines.push("");
      }

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  // ── Command: /pool-reset ──────────────────────────────────────────

  pi.registerCommand("pool-reset", {
    description: "Clear all credential pool cooldowns and reset to key #1",
    handler: async (_args, ctx) => {
      for (const [provider, pool] of pools) {
        pool.activeIndex = 0;
        for (const key of pool.keys) {
          key.rateLimitedUntil = 0;
        }
        const firstKey = pool.keys[0];
        if (pool.isOAuth) {
          await refreshKeyIfNeeded(pool, firstKey);
        }
        pi.registerProvider(provider, {
          apiKey: firstKey.resolved,
        });
      }
      ctx.ui.notify("🔑 All pools reset to key #1, cooldowns cleared.", "success");
      ctx.ui.setStatus(
        "credential-pool",
        `🔑 ${[...pools.entries()].map(([p, pool]) => `${p}: ${pool.keys.length} keys`).join(", ")}`,
      );
    },
  });
}
