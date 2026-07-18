# subagent

Define reusable child agents in `~/.pi/agent/agents/*.md` or `<project>/.pi/agents/*.md`.

Each file is a Markdown document with YAML frontmatter. The Markdown body after the frontmatter is used as the agent's system prompt.

## Frontmatter

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `name` | string | required | Short identifier used in `/subagent <name> <task>` |
| `description` | string | required | One-line summary shown in the agent list |
| `model` | string | Pi default | Model to run the child with |
| `fallbackModels` | string | - | Comma-separated list of fallback models |
| `tools` | string | - | Comma-separated list of tools |
| `systemPromptMode` | `"append"` \| `"replace"` | `"append"` | Whether to append the custom prompt to Pi's default prompt or replace it entirely |
| `inheritSkills` | boolean | `true` | Whether the child inherits the parent's skill catalog |

## Example

```md
---
name: scout
description: Quick codebase scout
model: claude-sonnet-4-20250514
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
