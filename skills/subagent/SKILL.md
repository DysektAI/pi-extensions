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

## Child sessions

Children start lean: no prompt templates, themes, or context files. Skills are
inherited unless the agent sets `inheritSkills: false`, and tool access is
narrowed by the agent's `tools` allowlist. Results report per-call usage
(tokens, cost, model, fallbacks used) so the cost of delegation stays visible.
