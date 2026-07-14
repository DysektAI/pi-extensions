# Persistent Goals (`/goal`)

Pi supports persistent autonomous goals — a mode where the agent works continuously toward a completion condition across multiple turns without needing you to say "continue" after each response. Goal prompts encourage selective subagent use: parallelize broad independent work, but prefer direct execution for small PRs, single-file fixes, and one-command checks where subagent startup overhead would dominate.

## Quick Start

```text
/goal Refactor the auth module until npm test passes and docs are updated
```

Pi will:

1. Store the goal condition persistently in the current session
2. Start working on it immediately
3. When the working model signals it's done, a separate **judge** model evaluates the work for both goal completion AND code quality
4. If issues are found, specific numbered feedback is sent back to the working model
5. The loop continues until the work is both goal-complete AND correctly implemented, paused, cleared, blocked, or the turn budget is exhausted

## Commands

| Command | Description |
| --------- | ------------- |
| `/goal <condition>` | Set or replace the active goal and start working immediately |
| `/goal` | Show current goal status |
| `/goal status` | Same as `/goal` (show status) |
| `/goal pause` | Pause the continuation loop without deleting goal state |
| `/goal stop` | Alias for `/goal pause` |
| `/goal resume` | Resume a paused or budget-exhausted goal |
| `/goal clear` | Remove the active goal |
| `/goal cancel` | Alias for `/goal clear` |
| `/goal off` | Alias for `/goal clear` |
| `/goal none` | Alias for `/goal clear` |
| `/goal reset` | Reset turn counter and restart the current goal |

## How It Works

### Goal State

Goal state is persisted in your session. If you close Pi and resume the session later, the goal is restored (though the loop does not auto-resume — you must use `/goal resume` to restart it).

The state includes:

- **Condition**: the text you provided
- **Status**: `active`, `paused`, `stalled`, `done`, `done_with_notes`, `blocked`, or `budget_exhausted`
- **Turn counts**: turns used in the current run and lifetime total
- **Judge evaluations**: how many times the judge has been called
- **Judge reason**: the last evaluation result from the judge model
- **Open issues**: specific issues identified by the judge

### The Judge — Quality Review, Not Just Goal Checking

After the working model signals completion (says it's done, stops making tool calls, or gives a summary), a separate **judge** model evaluates the work as a code reviewer.

The judge is NOT just checking "is the goal met?" — it actively evaluates:

1. **Goal Completion**: Does the visible output clearly prove the goal condition is fully satisfied?
2. **Correctness**: Are there bugs, logic errors, or incorrect implementations?
3. **Completeness**: Is anything half-implemented? TODO comments, placeholder code, skipped steps?
4. **Regressions**: Did the agent introduce new problems while fixing others?
5. **Code Quality**: Severe anti-patterns, security issues, or performance problems?

The judge categorizes issues by severity:

- **critical**: Must fix before the goal can be marked done (bugs, regressions, incomplete core functionality)
- **major**: Should fix (poor patterns, missing error handling, incomplete edge cases)
- **minor**: Nice to fix but not blocking (style issues, minor inefficiencies)

A goal is only marked `done` when there are no critical or major issues. If only minor issues remain, the goal is marked `done_with_notes`.

### Completion Signal Detection

The judge only runs when the working model signals it's done — not on every turn. This saves expensive judge calls and makes the evaluation meaningful. Completion signals include:

- The model explicitly says "I'm done", "finished", "completed", etc.
- The model's last message has no tool calls and no intent-to-continue phrases
- The model gives a long text-only response (likely a summary)

You can force periodic judge evaluations with `PI_GOAL_JUDGE_EVERY=N` (see Configuration).

### Continuation with Structured Feedback

When the judge finds issues, the continuation prompt includes specific numbered items:

```text
[Pi /goal continuation]
Standing goal: Fix the auth bug in login.ts

## Quality Review Assessment
The auth bug fix is partially implemented but has issues.

## Issues Found by Quality Review

### ❌ Critical (must fix)
1. The null check on line 42 is still missing — auth.verify() can return undefined
   [login.ts:42]

### ⚠️ Major (should fix)
1. Error handling for token expiry is missing — users with expired tokens get a 500
   [auth.ts:89]

### 💡 Minor (optional)
1. Consider caching the verification result for repeated calls
   [auth.ts:15]

Fix the critical and major issues above. Minor issues are optional but recommended.

Continue working toward the standing goal. Address the issues identified above...
```

This gives the working model clear, specific direction on what to fix rather than just "keep going."

### Dead Loop Detection

When the working model fails to produce useful output (empty responses, errors, or no tool calls and no text), the extension tracks **consecutive failures**. After a configurable number of consecutive failed turns (default: 3, set by `PI_GOAL_STALL_LIMIT`), the goal is automatically paused with `stalled` status.

This prevents the spinning behavior where a failing model runs through all 20 turns uncontrollably. Instead, the loop stops after 3 consecutive failures, and you can decide whether to:

- `/goal resume` to retry (resets the failure counter)
- `/goal clear` to stop entirely
- Change the model and then `/goal resume`

### Turn Budget

To prevent infinite loops, each goal run has a maximum number of turns (default: 20). When the budget is exhausted:

- The goal enters `budget_exhausted` status
- Pi shows a warning explaining how many turns were used
- You can use `/goal resume` to add another run of 20 turns
- Lifetime turns continue accumulating within the same goal

**Note**: Setting a new goal (via `/goal <new condition>`) or resetting (via `/goal reset`) resets lifetime turns to 0. Only `/goal resume` preserves them.

### Safety Guards

- **Dead loop detection**: After N consecutive failed turns (default 3), the goal auto-pauses with `stalled` status — no more uncontrolled spinning
- **Emergency stop**: `/goal pause` and `/goal clear` immediately break the in-flight lock, so you can always stop the loop even while a turn is running
- **In-flight lock**: Only one continuation can be active at a time
- **Human preemption**: Typing a message while the goal is running works normally — your input is processed and does not count toward the turn budget, then the loop resumes
- **Compatibility**: Status and clear commands work in all modes (interactive, print, RPC). Auto-continuation works best in interactive mode.

## Subagent Parallelism

The goal extension instructs the working model to use the built-in `subagent` tool selectively. Parallel subagents can cut wall-clock time significantly for broad multi-file goals, but direct work is preferred for small/local tasks to avoid coordination overhead.

### How it works

**1. Goal Decomposition (pre-flight)** — When you set a goal, the extension calls a fast model to generate a phased parallel execution plan before the first turn starts:

```text
## Execution Plan

### Phase 1: Reconnaissance ⚡ parallel
- scout: "Find all files importing from auth/login.ts"
- scout: "Check test coverage for auth module"
- scout: "Find all TypeScript interfaces related to auth"

### Phase 2: Implementation
#### 2a: Independent changes ⚡ parallel
- implement: "In src/auth/login.ts: add null check before auth.verify()"
- implement: "In src/auth/types.ts: export the new AuthResult type"

#### 2b: Final wiring → sequential (after 2a)
- implement: "In src/auth/index.ts: re-export AuthResult"

### Phase 3: Verification ⚡ parallel
- implement: "Run: npm test -- auth and report results"
- implement: "Run: npm run lint src/auth and report errors"
- implement: "Run: npx tsc --noEmit and report type errors"
```

This plan is embedded in the kickoff prompt and referenced in every continuation.

**2. Subagent Instructions** — Every kickoff and continuation prompt includes explicit instructions and code patterns showing the working model *when* and *how* to use `subagent` for parallel and chain tasks. The prompt also warns not to launch follow-up subagents just to restate previous output; subagent tool results now include larger final-answer excerpts plus structured details.

**3. Available agent types:**

| Agent | Best for |
| ------- | ---------- |
| `scout` | File reads, grep, reconnaissance (fast model, no code edits) |
| `implement` | Code edits, running commands |
| `review` | Code review and quality checks |
| `plan` | Architecture decisions, complex tradeoffs |

### Subagent model ownership

The `/goal` extension does **not** select, override, route, or fallback subagent models. It only suggests when to use subagents. Model choice is centralized in each subagent file and executed by the `subagent` extension.

| Agent type | Model source of truth |
| ------------ | ----------------------- |
| `scout` | `~/.pi/agent/agents/scout.md` |
| `implement` | `~/.pi/agent/agents/implement.md` |
| `review` | `~/.pi/agent/agents/review.md` |
| `plan` | `~/.pi/agent/agents/plan.md` |

Each agent file can define:

```yaml
model: provider/model-id
fallbackModels: provider/fallback-1, provider/fallback-2
```

The `subagent` extension tries `model` first, then advances through `fallbackModels` if the model call fails. This keeps direct subagent calls and `/goal`-created subagent calls deterministic and consistent.

### Scout model fallback handling

Scout tasks (reading files, grepping, finding imports, summarising code) look simple but a too-weak model silently misunderstands code structure. Scout model selection is centralized in `~/.pi/agent/agents/scout.md`; the `/goal` extension does not duplicate this fallback chain. The subagent extension tries the scout `model` first and then `fallbackModels` if the model call fails.

| Priority | Model | Why |
| ---------- | ------- | ----- |
| 1 | `fireworks/accounts/fireworks/routers/kimi-k2p5-turbo` | Fast load-balanced router, strong code reading |
| 2 | `fireworks/accounts/fireworks/models/glm-5p1` | Fast Fireworks recon fallback |
| 3 | `fireworks/accounts/fireworks/models/kimi-k2p6` | Fast hosted Kimi fallback |
| 4 | `fireworks/accounts/fireworks/models/deepseek-v4-pro` | Fast hosted deep-code fallback |
| 5 | `xiaomi-token-plan-sgp/mimo-v2.5-pro` | Pro MiMo fallback; intentionally **not** non-pro `mimo-v2.5` |
| fallback | Subagent failure fallback | The subagent tool advances through `fallbackModels` automatically if a model attempt fails |

Edit `~/.pi/agent/agents/scout.md` to change this order. This keeps normal `subagent scout` calls and `/goal`-created scout calls on the same source of truth.

**Is Kimi K2.5 Turbo overkill for scout?** No. The `k2p5-turbo` is a load-balanced router — fast *and* capable enough for complex code reading. Models that are too cheap (sub-8B) fail silently by misidentifying what they're looking for in the codebase.

To change scout routing, edit `~/.pi/agent/agents/scout.md`. Do not configure scout routing in `/goal`.

### Disabling decomposition

```bash
# Skip the decomposition pre-step (saves ~1 model call for trivial goals)
export PI_GOAL_DECOMPOSE=false

# Use a different (cheaper) model for decomposition
export PI_GOAL_DECOMPOSE_MODEL="anthropic/claude-sonnet-4-5"
```

### What parallel execution looks like

With subagents, a goal like "refactor auth module until tests pass" now runs as:

```text
Turn 1: 3 scout subagents run simultaneously — map codebase
Turn 2: 2 implement subagents run in parallel — independent file changes
Turn 3: 3 verification subagents run in parallel — tests + lint + typecheck
Judge: evaluates → done
```

Instead of the old sequential model (one tool call at a time).

## Configuration

Configure goal behavior via environment variables:

| Variable | Default | Description |
| ---------- | --------- | ------------- |
| `PI_GOAL_DISABLED` | (unset) | Set to `1` or `true` to disable the `/goal` command entirely |
| `PI_GOAL_MAX_TURNS` | `20` | Maximum turns per goal run |
| `PI_GOAL_JUDGE_MODEL` | (auto) | Judge model as `provider/model`, e.g. `anthropic/claude-opus-4-5` |
| `PI_GOAL_CONTEXT_CHARS` | `12000` | Maximum characters of transcript sent to the judge |
| `PI_GOAL_FAIL_OPEN` | `true` | When `true`, errors during judging default to "continue" |
| `PI_GOAL_CONT_ON_ERROR` | `true` | When `true`, judge model call failures default to "continue" |
| `PI_GOAL_JUDGE_EVERY` | `0` | Force judge every N turns. `0` = only on completion signal (default) |
| `PI_GOAL_STALL_LIMIT` | `3` | Consecutive failed turns before auto-pause. Set `0` to disable |
| `PI_GOAL_DECOMPOSE` | `true` | Run goal decomposition pre-step to generate a parallel task plan |
| `PI_GOAL_DECOMPOSE_MODEL` | (auto) | Model for decomposition. Falls back to judge model, then auto-detect |

### Recommended Judge Models

For best results, use a **stronger model as judge** than the working model. This creates asymmetric evaluation — the judge catches mistakes the working model would miss.

| Working Model | Recommended Judge | Why |
| --------------- | ------------------- | ----- |
| MiMo V2.5 / Kimi K2.6 | Opus 4.7 or GPT-5.5 | Strong evaluator catches cheap model's mistakes |
| Sonnet 4.5 | Opus 4.7 or GPT-5.5 | Opus-level review for mid-tier implementation |
| Opus 4.6/4.7 | GPT-5.5 or same model | Even strong models benefit from different perspective |

Example configuration:

```bash
# Use Kiro gateway Opus 4.7 as judge (free, strong)
export PI_GOAL_JUDGE_MODEL="anthropic/claude-opus-4-5"

# Or use Bedrock
export PI_GOAL_JUDGE_MODEL="anthropic/claude-opus-4-5"

# Force a quality check every 5 turns even if the model hasn't signalled completion
export PI_GOAL_JUDGE_EVERY="5"
```

### Auto-detected Judge Models

If you don't set `PI_GOAL_JUDGE_MODEL`, Pi tries these models in order of strength:

1. `anthropic/claude-opus-4-5`
2. `anthropic/claude-opus-4-5`
3. `openai-codex/gpt-5.5`
4. `openai-codex/gpt-5.4`
5. `openai-codex/gpt-5.2`
6. `anthropic/claude-opus-4-5`
7. `anthropic/claude-opus-4-5`
8. `anthropic/claude-sonnet-4-5`
9. `anthropic/claude-sonnet-4-5`
10. Generic `anthropic/*` and `openai/*` providers
11. Free/cheap providers as last resort

The first one with valid authentication is used.

## Status Display

```text
/goal status

Goal: Refactor auth module
Status: active
Turns (this run): 3/20
Lifetime turns: 12
Judge evaluations: 2
Last judge: Core functionality implemented but null check missing on login.ts:42
Open issues:
  • critical: The null check on line 42 is still missing [login.ts:42]
  • major: Error handling for token expiry is missing [auth.ts:89]
Hint: Goal is running. Use /goal pause to pause, /goal clear to stop.
```

Status icons shown in the Pi footer:

- ↻ Goal active (running)
- ⏸ Goal paused
- ⚠ Goal stalled (auto-paused due to failures)
- ✓ Goal done
- ✗ Goal blocked
- ⏰ Budget exhausted

## Tips for Effective Goals

1. **Be specific**: "Refactor auth" is vague. "Refactor auth module until `npm test -- auth` passes and CHANGELOG.md is updated" is better.
2. **Include verification**: The judge evaluates visible output. Make sure your condition includes verifiable criteria (test results, file existence, lint output).
3. **Use checkpoints**: The judge needs evidence. The agent should run verification commands and summarize results before each turn ends.
4. **Start small**: Try `/goal Create a test file GOAL_SMOKE_TEST.md with 3 checklist items` as a first test.
5. **Set a strong judge**: Use a model stronger than your working model for asymmetric evaluation. `PI_GOAL_JUDGE_MODEL=anthropic/claude-opus-4-5` is a good default.
6. **Use PI_GOAL_JUDGE_EVERY for long goals**: If the goal might take many turns, set `PI_GOAL_JUDGE_EVERY=5` to get periodic quality checks even before the model signals completion.

## Installation

The goal extension is auto-discovered from `~/.pi/agent/extensions/goal/index.ts`. Place the extension files there to enable it.

### Files

```text
pi/agent/extensions/goal/   (synced to ~/.pi/agent/extensions/goal/)
├── index.ts     # Main extension
├── pure.ts      # Pure helpers shared with tests
├── docs.md      # This documentation
└── tests.ts     # Unit tests (import pure.ts — no duplicated logic)
```

Run tests with:

```bash
# From the repo (preferred while editing)
npx tsx --test pi/agent/extensions/goal/tests.ts

# Or against the installed copy after sync_pi
npx tsx --test ~/.pi/agent/extensions/goal/tests.ts
```

Pure helpers shared by the extension and tests live in `pure.ts` so tests import
production logic instead of maintaining a second copy.

## Limitations

- Auto-continuation works best in interactive mode. In print mode, goals can be set/checked but auto-continuation is disabled.
- The judge model requires an API key for at least one configured provider.
- The judge evaluates only from visible transcript — it cannot inspect hidden local state.
- Human input during a goal loop pauses the loop briefly but the loop resumes after your turn completes (if the goal is active).

## Reference

This implementation follows the pattern established by:

- [Claude Code `/goal`](https://code.claude.com/docs/en/goal)
- [Codex CLI Follow a Goal](https://developers.openai.com/codex/use-cases/follow-goals)
- [Hermes Persistent Goals](https://hermes-agent.nousresearch.com/docs/user-guide/features/goals)

## Source

- Extension: `pi/agent/extensions/goal/index.ts` (installed to `~/.pi/agent/extensions/goal/index.ts`)
- Pure helpers: `pi/agent/extensions/goal/pure.ts`
- Tests: `pi/agent/extensions/goal/tests.ts`
