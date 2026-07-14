# pi-extensions

Public-safe [Pi](https://github.com/earendil-works/pi) coding-agent extensions from DysektAI.

Install once, then enable/disable individual extensions with `pi config` or package filters.

## Install

```bash
# pinned release
pi install git:github.com/DysektAI/pi-extensions@v0.1.0

# or latest main (gets update nags; less safe)
pi install git:github.com/DysektAI/pi-extensions
```

Private machines with SSH:

```bash
pi install git:git@github.com:DysektAI/pi-extensions@v0.1.0
```

Local checkout (dev):

```bash
pi install /path/to/pi-extensions
```

## Update / remove

```bash
pi list
pi update git:github.com/DysektAI/pi-extensions@v0.1.1   # bump pin
pi remove git:github.com/DysektAI/pi-extensions
```

## What's included

| Extension | Role |
|-----------|------|
| `clear-command` | `/clear` alias for `/new` with full redraw |
| `status-tracker` | Working-status timer |
| `read-full-header` | Always show full Read tool path header |
| `custom-footer` | Token / cost / cache footer |
| `auto-title` | Auto session titles |
| `session-recap` | Post-turn recap line |
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
| `_shared/model-roles` | Shared role helpers (title/recap/judge/…) |

## Not included (on purpose)

Brand-specific or third-party-managed pieces stay elsewhere:

- DysektLB provider / Dysekt startup branding
- Herdr / Orca managed integrations
- Live `credential-pool/pools.json` (local only; use `pools.example.json`)

## Optional: load a subset

```json
{
  "packages": [
    {
      "source": "git:github.com/DysektAI/pi-extensions@v0.1.0",
      "extensions": [
        "extensions/task-tracker.ts",
        "extensions/web-search.ts",
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

## License

MIT
