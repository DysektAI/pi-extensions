# pi-extensions

[![CI](https://github.com/DysektAI/pi-extensions/actions/workflows/ci.yml/badge.svg)](https://github.com/DysektAI/pi-extensions/actions/workflows/ci.yml)

Public-safe [Pi](https://github.com/earendil-works/pi) coding-agent extensions from DysektAI.

Install once, then customize via `/config` or granular package filters.

> [!NOTE]
> **LSP package separation:** LSP tools and the `/lsp` manager live in [DysektAI/pi-lsp](https://github.com/DysektAI/pi-lsp). `lsp.ts` was removed from this package to eliminate duplicate tool collisions.

## Installation

```bash
# Latest default branch (recommended; updates via `pi update`)
pi install git:github.com/DysektAI/pi-extensions

# Pinned release tag
pi install git:github.com/DysektAI/pi-extensions@v0.5.2

# Local checkout (development — loads directly from path without copying)
pi install /path/to/pi-extensions
```

Update or remove installed packages:
```bash
pi update git:github.com/DysektAI/pi-extensions
pi remove git:github.com/DysektAI/pi-extensions
```

## Extensions

### UX & Interface
- **`config`**: Interactive `/config` menu for registered extension settings, subagent model chains, and helper roles.
- **`session-recap`**: Post-turn recap footer showing changes and intent; toggled via `/config recaps on|off`.
- **`custom-footer`**: Turn footer displaying token consumption, cost estimates, and cache hit metrics.
- **`tool-headers`**: Visual `[Tool Name]` headers, one-line folding for long bash commands, and link-styled paths.
- **`thinking-label`**: Bold `[Thinking]` header anchoring model reasoning blocks.
- **`path-links`**: Formats file path mentions in inline code as clickable terminal/editor links.
- **`clear-command`**: `/clear` alias for `/new` with complete display redraw.
- **`auto-title` & `status-tracker`**: Background session naming and active turn elapsed timers.
- **`continue-button`**: `/continue` command and `Ctrl+Shift+C` keybinding to resume turn generation.
- **`notes-box`**: Global `/note <text>` scratchpad and `/notes` overview.

### Execution & Context
- **`context-management`**: Proactive `turn_end` context compaction before Pi's native limits (`compaction.maxContextTokens`, per-model caps, GPT-5.6 family bounds) and `/clear-implement` clean handoffs ([details](#context-management--clear-implement)).
- **`task-tracker`**: Structured task management tools (`task_create`, `task_update`, `task_list`) with progress rendering.
- **`goal`**: Autonomous `/goal` execution loop with goal assessment judge ([docs](extensions/goal/docs.md)).
- **`subagent`**: Child agent delegation (`scout`, `plan`, `implement`, `review`) with runtime model resolution from `model-roles.json` ([docs](extensions/subagent/README.md)).

### Providers & Routing
- **`tokenrouter-provider`**: Dynamic provider for `api.tokenrouter.com` with automatic model capability detection. Reads `tokenrouter` from `auth.json` or `TOKENROUTER_API_KEY`.
- **`synthetic`**: Synthetic provider (`api.synthetic.new`). Reads `synthetic` from `auth.json` or `SYNTHETIC_API_KEY`.
- **`megallm-provider`**: OpenAI-compatible adapter for MegaLLM endpoints.
- **`opencode-compat`**: OpenCode Zen/Go request compatibility on upstream Pi 0.99.1+: session identifiers, client headers, and inert tool declarations for summaries and helper calls. Retains fork conventions without changing upstream adapters; live service acceptance can change independently.
- **`credential-pool`**: API key rotation framework (template in `pools.example.json`).

### Integrations & Skills
- **`typesafe`**: TypeSafe Jev bounded judgment model (`typesafe_ask` tool, `/jev`). Key from `auth.json` (`typesafe`) or `TYPESAFE_API_KEY`. Pre-checks stay disabled unless `TYPESAFE_AUTO=on` ([docs](extensions/typesafe/README.md)). Bundles `skills/typesafe-ai` and `skills/jev-judgments`.
- **`web-search`**: Brave and DuckDuckGo web search and page fetch tools ([docs](extensions/web-search.README.md)).
- **`context7`**: Documentation query tools powered by Context7 CLI.
- **`discord`**: Discord REST client for bot and user tokens via `DISCORD_BOT_TOKEN*` or `~/.pi/agent/discord.json`.
- **`windows-desktop`**: Native Windows desktop GUI automation driver (screenshots, input, focus) ([docs](extensions/windows-desktop/README.md)).
- **`auto-update`**: Opt-in automatic package update checks on startup or via `/auto-update`.

---

## Operational Details

### Configuration (`/config`)
`extensions/config.ts` manages settings registered dynamically by other extensions via `registerConfigSetting` (`_shared/config-settings.ts`).
Model roles (`recap`, `title`, `judge`) and ordered subagent fallback chains (`subagentModels`, `agentModels`) persist in `~/.pi/agent/model-roles.json`. Subagents resolve their model chain at spawn time, keeping agent markdown files clean of environment-specific model pins.

### Context Management & `/clear-implement`
`extensions/context-management.ts` hooks `turn_end` rather than waiting for Pi's fallback `agent_end` trigger:
- Enforces `compaction.maxContextTokens` and per-model limits (`compaction.modelOverrides`), compacting early to preserve buffer.
- Built-in bounds respect model-specific limits (e.g. GPT-5.6 family: Sol/Terra 200K, Luna 500K).
- `/clear-implement [notes]`: Generates an implementation-ready handoff summary, starts a clean session without brainstorming history, and immediately prompts the new session to begin. Original sessions remain accessible via `/resume`.

### TypeSafe / Jev Privacy Guarantee
`extensions/typesafe` reads credentials from `~/.pi/agent/auth.json` (`{ "typesafe": { "type": "api_key", "key": "..." } }`).
- By default, prompt text is never transmitted without explicit `typesafe_ask` calls.
- Automated per-prompt safety pre-checks require `TYPESAFE_AUTO=on`. Run `/jev` to verify configuration.

### Selective Extension Loading
Filter extensions in `~/.pi/agent/settings.json` using inclusion (`path`) or exclusion (`!path`):
```json
{
  "packages": [
    {
      "source": "git:github.com/DysektAI/pi-extensions",
      "extensions": [
        "extensions/config.ts",
        "extensions/session-recap.ts",
        "extensions/context-management.ts",
        "!extensions/discord.ts"
      ]
    }
  ]
}
```

### Local Development Loop
When developing extensions in this repository:
1. Link your checkout: `pi install /absolute/path/to/pi-extensions`.
2. **Never edit directly inside `~/.pi/agent/git/...`**: That directory is a git mirror fast-forwarded by `pi update`, which discards local uncommitted edits.
3. Validate changes with `npm test` before committing.

### Upstream Compatibility Validation

`npm test` runs the normal extension tests. The additional integration suite requires a built
upstream Pi 0.99.1 checkout, with its `pi-ai`, `pi-coding-agent`, and `pi-tui` workspace packages
linked into this checkout's `node_modules/@earendil-works/`. Run:

```bash
PI_UPSTREAM_ROOT=/path/to/built/upstream/pi npm run test:upstream
```

The suite uses isolated settings and fake credentials. It loads every extension with upstream's
loader and tests native provider composition, custom models, Zen/Go API payloads, compaction,
and credential-pool rotation in both load orders. Network responses are mocked; the suite does
not use your account or prove that a provider's live access policy accepts the requests.

OpenCode pool rotations preserve native stream handlers. Other providers retain the existing
registration path. Keep `models.json` API-key overrides out of pooled providers, since upstream
configuration can override provider auth.

Horizontal code-block rules remain a fork renderer preference. Upstream's current extension
API does not expose that layout setting; this package does not change it through private APIs.
