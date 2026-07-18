# pi-extensions

Public-safe [Pi](https://github.com/earendil-works/pi) coding-agent extensions from DysektAI.

Install once, then enable/disable individual extensions with `pi config` or package filters.

## Install

```bash
# pinned release
pi install git:github.com/DysektAI/pi-extensions@v0.3.1

# or latest main (less safe for production pins)
pi install git:github.com/DysektAI/pi-extensions
```

Private machines with SSH:

```bash
pi install git:git@github.com:DysektAI/pi-extensions@v0.3.1
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
pi update git:github.com/DysektAI/pi-extensions@v0.3.1   # bump pin
pi remove git:github.com/DysektAI/pi-extensions
```

## What's included

| Extension | Role |
|-----------|------|
| `config` | `/config` menu: registered settings + model-role pickers |
| `session-recap` | Post-turn recap footer; registers `recaps` with `/config` |
| `clear-command` | `/clear` alias for `/new` with full redraw |
| `status-tracker` | Working-status timer |
| `read-full-header` | Full Read header + dependency-free `view: "outline"` source navigation |
| `custom-footer` | Token / cost / cache footer |
| `auto-title` | Auto session titles |
| `auto-update` | Opt-in package updates on startup or via `/auto-update` |
| `continue-button` | `/continue` command and Ctrl+Shift+C resume shortcut |
| `context-management` | GPT-5.6 mid-run compaction guards + `/clear-implement` fresh-session handoff |
| `notes-box` | Global `/note` and `/notes` inbox |
| `task-tracker` | Plan/tasks tools + UI |
| `web-search` | Brave / DuckDuckGo search + fetch tools |
| `context7` | Library docs via Context7 CLI |
| `lsp` | Warm multi-language LSP tools |
| `discord` | Discord REST tool (`DISCORD_BOT_TOKEN`) |
| `goal` | Persistent `/goal` loop + judge |
| `subagent` | Subagent helpers ([docs](extensions/subagent/README.md)) |
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

## Context management

`extensions/context-management.ts` prevents long GPT-5.6 tool loops from passing
their useful context limits before Pi's normal `agent_end` compaction check runs.
It compacts Sol and Terra at 200K tokens and Luna at 500K, then resumes the
interrupted run.

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
- Live `credential-pool/pools.json` (local only; use `pools.example.json`)
- `codex-auth-sync` (removed): Codex CLI OAuth mirroring into Pi. Prefer built-in
  `openai-codex` login only if you use a ChatGPT subscription; otherwise use a
  gateway/provider (e.g. DysektLB) and do not leave stale `openai-codex`
  credentials in `~/.pi/agent/auth.json`.

Those belong in a private package or a personal profile repo (e.g. an agent kit),
not this public install unit.

## Optional: load a subset

```json
{
  "packages": [
    {
      "source": "git:github.com/DysektAI/pi-extensions@v0.3.1",
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
