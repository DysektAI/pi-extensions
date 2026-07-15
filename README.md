# pi-extensions

Public-safe [Pi](https://github.com/earendil-works/pi) coding-agent extensions from DysektAI.

Install once, then enable/disable individual extensions with `pi config` or package filters.

## Install

```bash
# pinned release
pi install git:github.com/DysektAI/pi-extensions@v0.2.0

# or latest main (less safe for production pins)
pi install git:github.com/DysektAI/pi-extensions
```

Private machines with SSH:

```bash
pi install git:git@github.com:DysektAI/pi-extensions@v0.2.0
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
pi update git:github.com/DysektAI/pi-extensions@v0.2.0   # bump pin
pi remove git:github.com/DysektAI/pi-extensions
```

## What's included

| Extension | Role |
|-----------|------|
| `config` | `/config` menu: registered settings + model-role pickers |
| `session-recap` | Post-turn recap footer; registers `recaps` with `/config` |
| `clear-command` | `/clear` alias for `/new` with full redraw |
| `status-tracker` | Working-status timer |
| `read-full-header` | Always show full Read tool path header |
| `custom-footer` | Token / cost / cache footer |
| `auto-title` | Auto session titles |
| `task-tracker` | Plan/tasks tools + UI |
| `web-search` | Brave / DuckDuckGo search + fetch tools |
| `context7` | Library docs via Context7 CLI |
| `lsp` | Warm multi-language LSP tools |
| `discord` | Discord REST tool (`DISCORD_BOT_TOKEN`) |
| `goal` | Persistent `/goal` loop + judge |
| `subagent` | Subagent helpers |
| `codex-auth-sync` | Mirror Codex CLI OAuth into Pi |
| `credential-pool` | API-key / OAuth pool rotation (example config only) |
| `megallm-provider` | Optional MegaLLM OpenAI-compat provider |
| `_shared/model-roles` | Shared role helpers (title/recap/judge/subagent) |
| `_shared/config-settings` | Registry for extension settings shown in `/config` |

## `/config`

`extensions/config.ts` owns the `/config` command. Other extensions contribute
settings with `registerConfigSetting` from `_shared/config-settings.ts`.

```bash
/config                  # interactive menu
/config recaps on|off    # session-recap toggle (when that extension is loaded)
/config recap            # pick recap model role
/config title|judge|subagent
```

Model roles are stored in `~/.pi/agent/model-roles.json` (not this repo).

## Not included (on purpose)

Brand-specific or machine-private pieces stay elsewhere:

- DysektLB provider / startup branding
- Orca / Herdr / local worker extensions
- Live `credential-pool/pools.json` (local only; use `pools.example.json`)

Those belong in a private package or a personal profile repo (e.g. an agent kit),
not this public install unit.

## Optional: load a subset

```json
{
  "packages": [
    {
      "source": "git:github.com/DysektAI/pi-extensions@v0.2.0",
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

Copy the example and keep secrets out of git:

```bash
cp extensions/credential-pool/pools.example.json \
   ~/.pi/agent/git/github.com/DysektAI/pi-extensions/extensions/credential-pool/pools.json
# edit pools.json to point at env vars
```

## Development notes

1. Prefer **local path install** while editing this repo.
2. Do not treat `~/.pi/agent/extensions` loose copies as the source of truth for
   these public extensions — they will drift.
3. Keep package defaults generic (no private provider names in fallbacks).

## License

MIT
