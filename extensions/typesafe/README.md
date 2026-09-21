# typesafe (Jev)

Ask [TypeSafe](https://typesafe.ai)'s **Jev** decision model typed questions from Pi.

Jev is not a chat model, a subagent, or a named agent definition. It evaluates a
`state` against typed questions and returns structured, calibrated answers that
code and the agent can act on.

| Primitive | Returns |
|-----------|---------|
| `noul` | Probability the answer is yes (`0`–`1`) |
| `choice` | Highest-probability option plus the full distribution |
| `score` | Probability-weighted position across ordered levels |

## Setup

```bash
export TYPESAFE_API_KEY="tsk_..."   # required
```

Set it in the environment that launches Pi, then restart Pi. The extension never
ships a bundled or trial credential.

| Variable | Default | Purpose |
|----------|---------|---------|
| `TYPESAFE_API_KEY` | *(none)* | Required. Without it the tool reports setup guidance and sends nothing |
| `TYPESAFE_MODEL` | `jev-latest` | Model id or alias |
| `TYPESAFE_BASE_URL` | `https://api.typesafe.ai/v1` | Must be HTTPS, without credentials, query, or fragment |
| `TYPESAFE_AUTO` | `off` | `on` consults Jev on eligible prompts before the agent starts |
| `TYPESAFE_AUTO_THRESHOLD` | `0.5` | Minimum `noul` probability that triggers the automatic advisory |

## Usage

The agent calls the `typesafe_ask` tool. It is instructed to use it proactively
for classification, ranking, verification, and comparisons, and to keep mechanical
work in code.

```
typesafe_ask
  state:      "plain text, or a JSON-encoded object/array"
  questions:  [{ id, type, instructions, criteria }]
  model:      optional override
```

Limits: 1–64 questions per call, 256 KiB request, 512 KiB response, output
truncated to 50 KiB/2000 lines. Each call has a 30s deadline (8s for automatic
pre-checks) and honors cancellation.

`/jev` prints setup status without making a network request.

## Data handling

- **The tool sends what you pass it.** `state` and `questions` go to the configured
  endpoint. Do not include secrets; keep API keys server-side in applications.
- **Automatic pre-checks are opt-in.** With `TYPESAFE_AUTO=on`, eligible prompts
  (15–16,000 characters) are sent to TypeSafe for an advisory probability. This
  costs tokens and transmits prompt text, so it is off by default.
- **Errors never echo upstream bodies**, which can contain request state, and
  responses are size-capped before parsing.
- TypeSafe's [confidence](https://docs.typesafe.ai/confidence) values describe the
  answer distribution. They are evidence, not proof or authorization to act.

## Skill

`skills/typesafe-ai/` teaches the agent how to design TypeSafe integrations
(choosing primitives, shaping state, composing fan-out). Invoke with
`/skill:typesafe-ai`, or let the agent load it on demand.

## Development

Pure client logic lives in `client.ts` and is covered by `tests.ts`
(`npm test`). Keep that module free of `@earendil-works/*` imports.
