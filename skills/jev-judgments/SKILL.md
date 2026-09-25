---
name: jev-judgments
license: MIT
description: >
  Use Jev (the typesafe_ask tool) for fast structured judgments over supplied
  evidence: classify, triage, label, route, sort, rank, compare, verify, score,
  identify, or get an independent second opinion. These triggers are examples,
  not an allowlist — consider Jev whenever a semantic judgment is needed, the
  relevant evidence is available, and the answer can be represented as a yes/no
  probability, a choice among defined options, or an ordered score.
---

# Jev: fast structured judgments

Jev is TypeSafe's judgment model, called through the `typesafe_ask` tool. You
send a **state** (the evidence) and typed **questions**; Jev returns
probabilities, not generated text. It is fast enough to call mid-task. It is
not a chat model, a subagent, or a reasoning engine.

Use this skill to decide four things: whether Jev applies, what evidence to
send, which question primitive to use, and how to read the result.

## 1. Should I use Jev here?

Use Jev when semantic judgment is needed but the decision space can be clearly
bounded and the necessary evidence can be supplied in the state.

Examples of this broader pattern — illustrative, not a permitted-use list:

- triage, categorize, label, or route items (issues, support tickets, messages)
- judge severity or priority; score an item on a defined scale
- estimate duplicate likelihood, relevance, or how well two things match
- rank candidates; compare alternatives against stated criteria
- verify whether a condition appears to hold from the evidence
- identify which known category or option best fits something
- sort or organize semantic data into defined buckets
- get a quick independent second opinion on a judgment you already formed

Do **not** use Jev when the task primarily requires:

- open-ended generation, explanation, or writing
- substantial multi-step reasoning
- investigation where important context has not been gathered yet
- broad research or discovering unknown facts
- planning that depends on many interacting consequences
- deterministic calculation, parsing, transformation, or exact rules — use code
- anything that cannot reasonably be expressed as a bounded noul/choice/score
  judgment

If evidence is missing, gather it first, then use Jev to judge the completed
state. Do not avoid Jev merely because a task is important or nuanced: the test
is whether the judgment can be made from the evidence you can supply, not
whether the subject is complex.

## 2. What evidence should I send?

Send the smallest **complete** and **relevant** evidence set for the judgment:
source text, issue descriptions, logs, known metadata, requirements, relevant
policies or rules, candidate options, relationships, and other observations the
decision depends on. Prefer named JSON fields when there are several parts;
plain text is fine for simple inputs.

**Keep the state neutral: do not mix in your own tentative conclusion.** Leading
evidence biases the judgment and destroys its value as an independent signal.

Bad — leads the model toward your existing opinion:

    { "report": "...", "analysis": "This seems like a UI bug" }

Good — raw evidence; the question does the judging:

    { "report": "...", "reproduction_steps": ["..."],
      "affected_component": "...", "observed_behavior": "..." }

- Avoid "this probably means…", "I think…", "it seems like…", "likely a…",
  "the user appears to be reporting…" in state — unless that inference is
  itself explicitly what you are asking Jev to evaluate.
- Deterministically derived facts (counts, parse results, rule outcomes) are
  acceptable when useful; present them as derived facts, distinct from raw
  observations.
- For a second opinion, omit your first conclusion by default: send the
  underlying evidence and ask the same bounded question independently.
- Neutral does not mean stripped. Include everything materially relevant to
  the judgment; do not cut context Jev needs to decide.

## 3. Which question primitive?

| Primitive | Use for | Returns |
|-----------|---------|---------|
| `noul` | whether one condition is true | probability of yes (0–1) |
| `choice` | selecting among defined alternatives | probability distribution over the options |
| `score` | position along a defined ordered scale | probability-weighted position across 2–10 levels |

- Ask one coherent judgment per question: the judgment goes in `instructions`,
  its possible answers in `criteria` (choice: map of options; score: ordered
  level descriptions).
- When several independent judgments use the same state, batch them in one
  `typesafe_ask` call. Do not invent speculative questions just because
  batching is available.

## 4. How do I interpret the result?

Probabilities are calibrated evidence and uncertainty signals — not proof,
truth, or authorization to act. Let them inform the workflow, not blindly
control it.

- High confidence can support straightforward bounded decisions where
  appropriate.
- Low, split, or ambiguous results mean the evidence did not decide the
  question: gather better evidence, work it through with full reasoning, ask
  the user, or escalate to human review — whichever the task and stakes call
  for.
- Do not apply a universal confidence threshold; cutoffs depend on the
  workflow and the consequences of being wrong. A noul near 0.5 means
  "undecided between yes and no", not "medium".

## References

Setup, credentials, endpoints, and request limits live in the `typesafe`
extension README. If `typesafe_ask` reports a missing credential, state the
setup step once and continue without Jev. Consult the live TypeSafe docs
(https://docs.typesafe.ai) when implementing or changing an API integration,
or when version-specific behavior matters — not for normal `typesafe_ask` use.
