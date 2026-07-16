# Credential Pool Extension

Automatic API key rotation and load balancing for Pi providers. Now with **OAuth support** for subscription providers like OpenAI Codex (ChatGPT).

## How It Works

1. You define key pools in `pools.json` — multiple API keys or OAuth credentials per provider
2. The extension registers providers with the first available key/credential
3. On **429 (rate limit)** responses, the extension:
   - Marks the current key as rate-limited (with configurable cooldown)
   - Rotates to the next available key
   - Re-registers the provider so Pi's built-in retry uses the new key
   - Notifies you in the TUI
4. For **OAuth pools**, expired access tokens are **auto-refreshed** before use
5. On **401/403 (auth error)** for OAuth, the extension tries to refresh the token first, then rotates if refresh fails
6. When **all keys are exhausted**, suggests a fallback model (if configured)

## Setup

### 1. Configure pools.json

Edit `pools.json` in this directory. Each pool maps a provider name to a list of keys:

#### API Key Pools (default)

```json
{
  "pools": {
    "openrouter": {
      "keys": [
        { "env": "OPENROUTER_KEY_1", "label": "OR Primary" },
        { "env": "OPENROUTER_KEY_2", "label": "OR Secondary" }
      ],
      "cooldownMs": 60000,
      "fallbackModel": "xiaomi-token-plan-sgp/mimo-v2.5-pro"
    }
  }
}
```

#### OAuth Pools

```json
{
  "pools": {
    "openai-codex": {
      "type": "oauth",
      "keys": [
        {
          "label": "Account 1",
          "access": "eyJhbGciOiJSUzI1NiIs...",
          "refresh": "rt_...",
          "expires": 1779329248000,
          "accountId": "88cb8245-add7-40e9-9f82-610f1ed91e66"
        },
        {
          "label": "Account 2",
          "access": "eyJhbGciOiJSUzI1NiIs...",
          "refresh": "rt_...",
          "expires": 1778101182000,
          "accountId": "e96e22f7-5b4f-4e19-8885-1ef0027d7566"
        }
      ],
      "cooldownMs": 300000,
      "fallbackModel": "anthropic/claude-sonnet-4-20250514"
    }
  }
}
```

**OAuth fields:**

| Field | Required | Description |
|-------|----------|-------------|
| `type` | Yes | Must be `"oauth"` |
| `access` | Yes | The OAuth access token (JWT) |
| `refresh` | Yes | The OAuth refresh token |
| `expires` | Yes | Token expiry timestamp in **milliseconds** (from `Date.now() + expires_in * 1000`, or JWT `exp * 1000`) |
| `accountId` | No | ChatGPT account ID (auto-extracted from token if omitted) |
| `label` | No | Display label for `/pool` status |

**Getting tokens:** The easiest way to get ChatGPT OAuth tokens is from another Codex CLI installation's `~/.codex/auth.json` or by logging in with `pi /login` and copying the tokens from `~/.pi/agent/auth.json`.

### 2. Key Sources (API Key pools only)

Each key supports three resolution methods:

| Method | Example | Description |
|--------|---------|-------------|
| `env` | `{ "env": "MY_API_KEY" }` | Read from environment variable |
| `value` | `{ "value": "sk-..." }` | Literal key (⚠️ stored in plain text) |
| `envFile` | `{ "envFile": { "path": "~/.secrets/keys.env", "var": "MY_KEY" } }` | Source a file and read a variable |

### 3. Important: auth.json Priority

Pi resolves API keys in this order:
1. Runtime overrides (highest)
2. **auth.json** entries
3. Environment variables
4. registerProvider / models.json (lowest — where this extension operates)

**If your provider has an entry in `~/.pi/agent/auth.json`, the extension's key rotation will be ignored.**

Remove the auth.json entry for any provider you want to pool:
```bash
# Check what's in auth.json
cat ~/.pi/agent/auth.json | python3 -m json.tool

# The extension creates a backup when it migrates entries
```

## Secrets (single source for non-provider keys)

Provider pools above handle *model API keys* (rotation/OAuth). The `secrets`
block handles *plain secrets* other extensions read from `process.env` — like
`DISCORD_BOT_TOKEN` and `BRAVE_API_KEY`. Declare them once here and they're
injected into `process.env` at startup, before any other extension's tools run.

```json
{
  "pools": { },
  "secrets": {
    "DISCORD_BOT_TOKEN": { "env": "DISCORD_BOT_TOKEN" },
    "BRAVE_API_KEY": { "command": "pass show brave/api" },
    "SOME_TOKEN": "literal-value-here"
  }
}
```

Each secret is a literal string, or a source object:

| Form | Example | Notes |
|------|---------|-------|
| `env` | `{ "env": "DISCORD_BOT_TOKEN" }` | Reads from your shell. Keeps the secret out of this file. |
| `value` | `{ "value": "sk-..." }` or `"sk-..."` | ⚠️ plaintext in pools.json. |
| `envFile` | `{ "envFile": { "path": "~/.secrets.env", "var": "X" } }` | Sources a file, reads a var. |
| `command` | `{ "command": "pass show brave/api" }` | Trimmed stdout (password managers). |

**pools.json wins:** a resolved secret overrides the ambient env, so this file
is the single source of truth. Resolution is non-destructive — your shell
profile and `auth.json` are never modified. Unresolved secrets surface as a
startup warning rather than failing silently.

**Migration order:** these start as `{ "env": ... }` references, so behavior is
identical to today (they resolve from your shell). To make pools.json the
actual store, switch a secret to `value`/`command`/`envFile`, verify with
`/secrets`, then remove the `export` from your shell profile.

## Commands

| Command | Description |
|---------|-------------|
| `/pool` | Show pool status — active key, cooldowns, request/error counts, token expiry |
| `/pool-reset` | Clear all cooldowns and reset to key #1 |
| `/secrets` | Show declared secrets (masked) and their source |

## Footer Status

The extension shows a status indicator in the footer:
- `🔑 openrouter: 2 keys` — pool active, all healthy
- `🔑 openrouter rotated → key #2/3` — just rotated
- `⚠️ openrouter: all 2 keys rate-limited` — all keys exhausted

## Adding OpenRouter

When you have OpenRouter keys, add them to your shell profile or a secrets file:

```bash
# ~/.bashrc or ~/.profile
export OPENROUTER_KEY_1="sk-or-v1-..."
export OPENROUTER_KEY_2="sk-or-v1-..."
```

Then update pools.json:
```json
{
  "pools": {
    "openrouter": {
      "keys": [
        { "env": "OPENROUTER_KEY_1", "label": "OR Account 1" },
        { "env": "OPENROUTER_KEY_2", "label": "OR Account 2" }
      ],
      "cooldownMs": 60000,
      "fallbackModel": "xiaomi-token-plan-sgp/mimo-v2.5-pro"
    }
  }
}
```

And remove any `openrouter` entry from `~/.pi/agent/auth.json`.
