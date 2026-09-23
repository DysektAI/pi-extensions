# subagent

Define reusable child agents in `~/.pi/agent/agents/*.md` or `<project>/.pi/agents/*.md`.

Each file is a Markdown document with YAML frontmatter. The Markdown body after the frontmatter is used as the agent's system prompt.

## Frontmatter

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `name` | string | required | Short identifier used in `/subagent <name> <task>` |
| `description` | string | required | One-line summary shown in the agent list |
| `tools` | string | - | Comma-separated list of tools |
| `systemPromptMode` | `"append"` \| `"replace"` | `"append"` | Whether to append the custom prompt to Pi's default prompt or replace it entirely |
| `inheritSkills` | boolean | `true` | Whether the child inherits the parent's skill catalog |

## Model selection

Subagent models come only from `/config`; nothing is hardcoded and there are
no built-in defaults.

- **Subagent models** is one ordered list (up to 100 entries). Entry 1 is tried
  first, then 2, 3, and so on. Each entry has its own reasoning level. In
  `/config`, add a model, pick its reasoning, and optionally give it a priority
  number; existing entries can be renumbered, moved, re-leveled, replaced, or
  removed.
- **`<Agent>` models** (one row per `~/.pi/agent/agents/*.md`, e.g. Plan,
  Scout): an optional ordered list tried *before* the shared list for that
  agent. Unset means the agent uses the shared list only.
- With no models configured the tool refuses to run and says so.
- Stored in `~/.pi/agent/model-roles.json` (`subagentModels`, `agentModels`)
  and read at every spawn. Frontmatter `model:` / `fallbackModels:` keys and
  per-call overrides are ignored; the tool exposes no `model` parameter.

### Fail-fast fallback

A model that is down must not stall every spawn:

- **Connect deadline** (`/config` → "Subagent fail-fast timeout", default 30s):
  if the provider has not answered by then, the child is killed and the next
  model starts.
- **Early errors**: an error response, or pi scheduling an automatic retry,
  before the model has produced any output skips straight to the next model
  instead of waiting out retry backoff.
- **Stall deadline**: connected but no output within max(120s, 4x timeout).
- **Circuit breaker**: models that failed before producing output are recorded
  in `~/.pi/agent/.cache/subagent-model-health.json` and moved to the back of
  the queue for a cooldown (1m, 2m, 4m, ... capped at 15m; cleared on
  success). Later spawns, including parallel ones and other pi processes, skip
  straight to a healthy model. Cooling models are still tried last, never
  dropped.
- Once a model streams output it is committed: pi's own retry handles
  transient errors mid-task. A failure after that still falls back to the next
  model (the task is re-run), but does not put the model into cooldown.

## Example

```md
---
name: scout
description: Quick codebase scout
tools: read, bash
systemPromptMode: replace
inheritSkills: false
---

You are a concise scout. Read the requested files and summarize their purpose.
```

## Child session defaults

Subagent child sessions start with a lean resource catalog:
- `--no-prompt-templates`
- `--no-themes`
- `--no-context-files`

Skills are inherited by default. Set `inheritSkills: false` to also disable skill discovery.
