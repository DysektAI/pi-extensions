---
name: subagent
license: MIT
description: >
  Delegate work to child pi agents with the `subagent` tool: specialized
  isolated-context workers defined as agent markdown files (typically scout,
  plan, implement, and review). Load before delegating recon, design,
  implementation, or review so the work leaves the orchestrator's context.
  Covers agent routing, single/parallel/chain modes, project-agent scoping,
  and the /config-only model rules.
---

# Delegating with the `subagent` tool

The `subagent` tool spawns child pi sessions with isolated context windows.
Load this skill before first use — the details below are intentionally kept
out of the always-in-context instructions.

## When to delegate

- Delegate work that is self-contained, read-heavy, or would bloat the
  orchestrator's context: codebase reconnaissance, design analysis, mechanical
  implementation, code review.
- Do the work directly when it is a few quick steps or needs tight
  back-and-forth with the user.
- Typical routing (agent names come from your agent files): recon → `scout`,
  design/analysis → `plan`, mechanical implementation → `implement`, review →
  `review`.

## Modes

Exactly one mode per call:

- **single** — `agent` + `task`: one delegated task.
- **parallel** — `tasks: [{ agent, task, cwd? }]`: independent tasks that can
  run simultaneously.
- **chain** — `chain: [{ agent, task, cwd? }]`: sequential steps; `{previous}`
  in a later task expands to the prior step's output.

Optional `cwd` sets the child's working directory. `agentScope` selects which
agent directories to use (below).

## Agent definitions

- User agents: `~/.pi/agent/agents/*.md`. Project agents: `<project>/.pi/agents/`.
- Default scope is `"user"`. Set `agentScope: "both"` (or `"project"`) to use
  project-local agents — the tool asks for confirmation first, because project
  agents are repo-controlled.
- Frontmatter keys: `name`, `description` (both required), `tools`
  (comma-separated allowlist for the child), `systemPromptMode`
  (`append` | `replace`), `inheritSkills` (default `true`).

## Model selection

Every subagent runs on the chain configured in `/config` ("Subagent model" +
"Subagent fallback 1..3", including each entry's reasoning level), read from
`~/.pi/agent/model-roles.json` at call time. Frontmatter `model:` /
`fallbackModels:` keys and per-call overrides are ignored; the tool exposes no
`model` parameter. Change subagent models only via `/config`.

## Child sessions

Children start lean: no prompt templates, themes, or context files. Skills are
inherited unless the agent sets `inheritSkills: false`, and tool access is
narrowed by the agent's `tools` allowlist. Results report per-call usage
(tokens, cost, model, fallbacks used) so the cost of delegation stays visible.
