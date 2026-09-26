# pi-extensions

[![CI](https://github.com/DysektAI/pi-extensions/actions/workflows/ci.yml/badge.svg)](https://github.com/DysektAI/pi-extensions/actions/workflows/ci.yml)

Public-safe [Pi](https://github.com/earendil-works/pi) coding-agent extensions from DysektAI.

Install once, then enable/disable individual extensions with `pi config` or package filters.

> **LSP moved:** The LSP extension is now a dedicated package at
> [DysektAI/pi-lsp](https://github.com/DysektAI/pi-lsp) with managed isolated installs,
> an interactive `/lsp` manager, and 9 tools. The lightweight `lsp.ts` that was
> previously bundled here has been removed to prevent duplicate tool registration.

## Install

```bash
# pinned release
pi install git:github.com/DysektAI/pi-extensions@v0.5.1

# or latest main (less safe for production pins)
pi install git:github.com/DysektAI/pi-extensions
```

Private machines with SSH:

```bash
pi install git:git@github.com:DysektAI/pi-extensions@v0.5.1
```

Local checkout (dev — edits apply live, no copy):

```bash
pi install /absolute/path/to/pi-extensions
```

On Windows, for example:

```bash
pi install C:\Users\You\Documents\Github\pi-extensions
```

## Update / remove

```bash
pi list
pi update git:github.com/DysektAI/pi-extensions@v0.5.1   # bump pin
pi remove git:github.com/DysektAI/pi-extensions
```

## What's included

| Extension | Role |
|-----------|------|
| `config` | `/config` menu: registered settings, subagent model lists, model-role pickers |
| `session-recap` | Post-turn recap footer; registers `recaps` with `/config` |
| `clear-command` | `/clear` alias for `/new` with full redraw |
| `status-tracker` | Working-status timer |
| `read-full-header` | Full `[Read Tool]` header + dependency-free `view: "outline"` source navigation |
| `custom-footer` | Token / cost / cache footer |
| `auto-title` | Auto session titles |
| `auto-update` | Opt-in package updates on startup or via `/auto-update` |
| `continue-button` | `/continue` command and Ctrl+Shift+C resume shortcut |
| `context-management` | Proactive mid-run compaction (`compaction.maxContextTokens`, per-model overrides, GPT-5.6 limits) + `/clear-implement` fresh-session handoff |
| `thinking-label` | Bold `[Thinking]` header above each visible thinking block |
| `tool-headers` | Built-in tool calls render as a bold `[Name Tool]` header with arguments beneath; multi-line shell commands collapse to one line; file paths use the link colour (plain absolute paths in VS Code) |
| `path-links` | Inline code naming an existing file renders as a clickable file link (plain styled text in VS Code so its own link detector opens it) |
| `synthetic` | Optional Synthetic provider (`api.synthetic.new`), live catalog; key from `~/.pi/agent/auth.json` `synthetic` entry or `SYNTHETIC_API_KEY` |
| `notes-box` | Global `/note` and `/notes` inbox |
| `task-tracker` | Plan/tasks tools + UI |
| `web-search` | Brave / DuckDuckGo search + fetch tools |
| `context7` | Library docs via Context7 CLI |
| `discord` | Discord REST tool (`DISCORD_BOT_TOKEN`) |
| `goal` | Persistent `/goal` loop + judge |
| `subagent` | Subagent helpers ([docs](extensions/subagent/README.md)) |
| `credential-pool` | API-key / OAuth pool rotation (example config only) |
| `megallm-provider` | Optional MegaLLM OpenAI-compat provider |
| `tokenrouter-provider` | Optional TokenRouter routing provider (`api.tokenrouter.com`); key from `~/.pi/agent/auth.json` `tokenrouter` entry or `TOKENROUTER_API_KEY`. Infers reasoning/image/context/thinking-level metadata via [pure.ts](extensions/tokenrouter/pure.ts) |
| `typesafe` | TypeSafe/Jev decision model as the `typesafe_ask` tool (noul/choice/score), `/jev` status, optional opt-in prompt pre-checks. Credential from `~/.pi/agent/auth.json` (`typesafe`) or `TYPESAFE_API_KEY`; never bundles one ([docs](extensions/typesafe/README.md)) |
| `_shared/model-roles` | Shared role helpers (title/recap/judge) |
| `_shared/subagent-models` | Ordered subagent model lists, per-agent lists, fail-fast health |
| `skills/typesafe-ai` | Pi skill for designing TypeSafe integrations (primitives, state, fan-out); ships with the `typesafe` extension |
| `_shared/config-settings` | Registry for extension settings shown in `/config` |

## `/config`

`extensions/config.ts` owns the `/config` command. Other extensions contribute
settings with `registerConfigSetting` from `_shared/config-settings.ts`.

```bash
/config                  # interactive menu
/config recaps on|off    # session-recap toggle (when that extension is loaded)
/config recap            # pick recap model role
/config title|judge
/config subagents        # ordered subagent model list (priority 1..100)
/config plan             # per-agent list (any ~/.pi/agent/agents/*.md name)
/config subagent-timeout 30s
```

Model roles and subagent model lists are stored in
`~/.pi/agent/model-roles.json` (not this repo). See
[subagent model selection](extensions/subagent/README.md#model-selection).

## Context management

`extensions/context-management.ts` compacts at `turn_end`, before Pi's normal
`agent_end` check (`contextWindow - reserveTokens`), once context exceeds the
effective limit, then resumes the interrupted run:

- `compaction.maxContextTokens` in settings caps every model (large windows still
  compact at a sane budget); `compaction.modelOverrides["provider/id"].maxContextTokens`
  sets per-model values. Project settings override global ones.
- GPT-5.6 has built-in limits (Sol/Terra 200K, Luna 500K); the lower value wins.

```json
{ "compaction": { "maxContextTokens": 400000,
    "modelOverrides": { "tokenrouter/anthropic/claude-opus-5.5": { "maxContextTokens": 180000 } } } }
```

After brainstorming reaches an agreed implementation, use:

```bash
/clear-implement
/clear-implement optional final instruction
```

The command creates an implementation-focused summary, starts a fresh linked
session with no raw brainstorming history, and immediately asks the new session
to implement the handoff. The original session remains available through
`/resume`.

## Not included (on purpose)

Brand-specific or machine-private pieces stay elsewhere:

- DysektLB provider / startup branding
- Orca / Herdr / local worker extensions
- Live `pools.json` (lives in `~/.pi/agent/credential-pool/`; see `pools.example.json`)
- `codex-auth-sync` (removed): Codex CLI OAuth mirroring into Pi. Prefer built-in
  `openai-codex` login only if you use a ChatGPT subscription; otherwise use a
  gateway/provider (e.g. DysektLB) and do not leave stale `openai-codex`
  credentials in `~/.pi/agent/auth.json`.

Those belong in a private package or a personal profile repo (e.g. an agent kit),
not this public install unit.

## TypeSafe / Jev

`extensions/typesafe` reads its credential from a machine-private `typesafe` entry
in `~/.pi/agent/auth.json` (a `TYPESAFE_API_KEY` env var is the fallback). It
deliberately has no bundled key: without a credential, `typesafe_ask` sends
nothing and reports setup once. Automatic per-prompt consultation is opt-in via
`TYPESAFE_AUTO=on` because it transmits prompt text. See
[extensions/typesafe/README.md](extensions/typesafe/README.md).

## Optional: load a subset

```json
{
  "packages": [
    {
      "source": "git:github.com/DysektAI/pi-extensions@v0.5.1",
      "extensions": [
        "extensions/config.ts",
        "extensions/session-recap.ts",
        "extensions/task-tracker.ts",
        "!extensions/discord.ts"
      ]
    }
  ]
}
```

Or run `pi config` after install.

## Credential pool

Copy the example to the agent dir (never into the installed package, which
`pi update` replaces) and keep secrets out of git:

```bash
mkdir -p ~/.pi/agent/credential-pool
cp extensions/credential-pool/pools.example.json ~/.pi/agent/credential-pool/pools.json
# edit pools.json to point at env vars
```

## Development notes

1. Prefer **local path install** while editing this repo.
2. Do not treat `~/.pi/agent/extensions` loose copies as the source of truth for
   these public extensions — they will drift.
3. Keep package defaults generic (no private provider names in fallbacks).
4. Never edit or commit inside the installed git clone
   (`~/.pi/agent/git/github.com/...`): it is a managed mirror that `pi update`
   fast-forwards to `origin/main`, so local commits there are lost and
   uncommitted edits there never reach Pi. Commit + push from your own clone,
   then `pi update`. Definition of done: no stashes, clean trees, `main` equal
   to `origin/main` in both checkouts (see DEVELOPMENT.md).

## License

MIT
