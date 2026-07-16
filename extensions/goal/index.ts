/**
 * Goal Extension - Persistent autonomous goal loop with quality review
 *
 * Implements Claude Code / Codex CLI / Hermes-style persistent goals:
 * - /goal <condition>  Set or replace active goal and start immediately
 * - /goal              Show current goal status
 * - /goal status       Same as /goal
 * - /goal pause        Pause continuation loop
 * - /goal resume       Resume paused goal
 * - /goal clear        Clear active goal
 * - /goal stop         Alias for pause
 * - /goal cancel       Alias for clear
 * - /goal reset        Reset goal counter and restart
 * - /goal off          Alias for clear
 * - /goal none         Alias for clear
 *
 * State is persisted in session via pi.appendEntry("goal-state", data).
 *
 * ## Judge Architecture
 *
 * The judge is a STRONGER model that evaluates the working model's output
 * as a quality reviewer — not just checking "is the goal met?" but actively
 * looking for bugs, bad patterns, incomplete implementations, and regressions.
 *
 * The judge only runs when the working model signals completion (stops making
 * tool calls, says it's done, or the turn ends without further action). This
 * avoids wasting judge calls on mid-work turns where the model is still
 * actively implementing.
 *
 * When the judge finds issues, they are fed back as specific numbered items
 * in the continuation prompt, giving the working model clear direction on
 * what to fix. The loop only stops when the judge confirms the work is BOTH
 * goal-complete AND correctly implemented.
 *
 * Configuration via environment variables:
 *   PI_GOAL_MAX_TURNS        Max turns per run, default 20
 *   PI_GOAL_JUDGE_MODEL      Judge model as "provider/model", e.g. "anthropic/claude-opus-4"
 *   PI_GOAL_CONTEXT_CHARS    Max context chars for judge, default 12000
 *   PI_GOAL_FAIL_OPEN        Continue on errors (default true)
 *   PI_GOAL_CONT_ON_ERROR    Continue on judge errors (default true)
 *   PI_GOAL_JUDGE_EVERY      Force judge every N turns (0 = only on completion signal, default 0)
 *   PI_GOAL_DECOMPOSE        Run goal decomposition before starting (default true)
 *   PI_GOAL_DECOMPOSE_MODEL  Model for decomposition as "provider/model" (falls back to judge model)
 *
 * ## Subagent Parallelism
 *
 * The extension instructs the working model to use the `subagent` tool for:
 * - Parallel reconnaissance (scanning multiple files simultaneously with scout agents)
 * - Parallel independent edits (changing unrelated files simultaneously with implement agents)
 * - Parallel verification (running tests + lint + typecheck simultaneously)
 * - Sequential chains (when output of step N feeds step N+1, using {previous} placeholder)
 *
 * An optional decomposition pre-step (PI_GOAL_DECOMPOSE=true, default) calls a model before
 * the first turn to generate a phased parallel execution plan embedded in the kickoff prompt.
 */

import {
  complete,
  getModel,
  type Model,
  type UserMessage,
} from "@earendil-works/pi-ai";
import type {
  AgentEndEvent,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { resolveRoleCandidates } from "../_shared/model-roles.ts";
import {
  type GoalConfig,
  type GoalState,
  type JudgeOutput,
  CONTINUATION_TAG,
  CUSTOM_TYPE,
  buildContinuationPrompt as buildContinuationPromptPure,
  detectCompletionSignalFromMessages,
  extractUserMessageText,
  generateId,
  loadConfigFromEnv,
  now,
  parseJudgeOutput,
  shouldRunJudgeOnTurn,
  statusIcon,
} from "./pure.ts";

// Hard upper bound on the judge/decompose LLM calls. These run inside the
// awaited `agent_end` handler (judge) and the goal-start flow (decompose);
// pi awaits every extension lifecycle handler with NO timeout of its own, so
// an unbounded `complete()` that never settles (e.g. a gateway SSE stream that
// delivers all text but never sends a terminal event) freezes the whole agent
// loop — `agent_end` never reaches the UI and the working spinner spins
// forever ("Responding [Ns]"). A bounded signal turns that hang into a caught
// error that fails open per config. Override with PI_GOAL_JUDGE_TIMEOUT_MS.
const LLM_TIMEOUT_MS =
  parseInt(process.env.PI_GOAL_JUDGE_TIMEOUT_MS ?? "", 10) || 90_000;

// ── State ───────────────────────────────────────────────────────────────────

let goalState: GoalState | null = null;
let continuationInFlight = false;

// ctx.modelRegistry captured from pi — includes ALL user-configured custom providers
// (custom providers, fireworks routers, google-aistudio, etc.). The bare getModel()
// from @earendil-works/pi-ai only knows built-in providers, which caused every custom
// model in the scout/plan/decompose tier lists to return null and fall through to the
// working model fallback. capturedModelRegistry.find() is the authoritative check.
let capturedModelRegistry: any = null;

/**
 * Get a model object using capturedModelRegistry (which knows all custom providers
 * defined in models.json: custom providers, freemodel, openai-codex, etc.)
 * with fallback to the bare getModel() from pi-ai (built-ins only).
 *
 * Fixes the isModelAvailable/getModel mismatch: isModelAvailable uses
 * capturedModelRegistry.find() and correctly returns true for custom providers,
 * but the old getModel() call would then return null for those same providers,
 * causing `pickDecomposeModel` / `pickJudgeModel` to return `{ model: null }`,
 * which surfaced as "Goal decomposition skipped: undefined" in the UI.
 */
function getModelFromRegistry(provider: string, modelId: string): Model<any> | null {
  if (capturedModelRegistry) {
    return capturedModelRegistry.find(provider, modelId) ?? null;
  }
  return getModel(provider, modelId);
}

// Cached config
let loadedConfig: GoalConfig | null = null;

// ── Helpers ─────────────────────────────────────────────────────────────────

function loadConfig(): GoalConfig {
  if (loadedConfig) return loadedConfig;
  loadedConfig = loadConfigFromEnv(process.env as Record<string, string | undefined>);
  return loadedConfig;
}

function isActive(): boolean {
  return goalState !== null && goalState.status === "active";
}

/**
 * Check whether a model is registered and available in pi's model registry.
 *
 * Uses capturedModelRegistry (ctx.modelRegistry from pi) which includes ALL
 * user-configured custom providers from models.json — custom providers, fireworks
 * custom routers, google-aistudio, etc. Falls back to the bare getModel() from
 * @earendil-works/pi-ai for built-in providers if the registry hasn't been
 * captured yet (e.g. on the very first goal before any session event fires).
 */
function isModelAvailable(provider: string, modelId: string): boolean {
  if (capturedModelRegistry) {
    return capturedModelRegistry.find(provider, modelId) != null;
  }
  // Fallback: built-in providers only (better than nothing for bootstrap)
  return getModel(provider, modelId) != null;
}

// ── Completion Signal Detection ─────────────────────────────────────────────

/**
 * Detect whether the working model has signalled it's done working.
 * Delegates to the pure helper so tests cover the same logic.
 */
function detectCompletionSignal(event: AgentEndEvent): boolean {
  return detectCompletionSignalFromMessages(event.messages as any);
}

/**
 * Determine whether the judge should run on this turn.
 * The judge runs when:
 * 1. The completion signal is detected (model appears done), OR
 * 2. The PI_GOAL_JUDGE_EVERY interval is set and has elapsed
 */
function shouldRunJudge(
  event: AgentEndEvent,
  state: GoalState,
  config: GoalConfig,
): boolean {
  return shouldRunJudgeOnTurn(event.messages as any, state, config);
}

// ── Persistence ─────────────────────────────────────────────────────────────

function persistGoalState(pi: ExtensionAPI) {
  pi.appendEntry(CUSTOM_TYPE, goalState ?? undefined);
}

function restoreGoalState(
  ctx: ExtensionContext | ExtensionCommandContext,
): boolean {
  goalState = null;

  try {
    for (const entry of ctx.sessionManager.getEntries()) {
      if (
        entry.type === "custom" &&
        (entry as any).customType === CUSTOM_TYPE
      ) {
        const data = (entry as any).data as GoalState | null | undefined;
        if (data && data.id) {
          // Later entries supercede earlier ones
          goalState = { ...data };
        } else if (data === null || data === undefined) {
          // Explicit null means goal was cleared
          goalState = null;
        }
      }
    }
  } catch {
    goalState = null;
  }

  // Reset in-memory transient state
  continuationInFlight = false;

  return goalState !== null;
}

// ── Status Display ──────────────────────────────────────────────────────────

function goalStatusParts(): string {
  if (!goalState) return "No active goal";

  const parts: string[] = [];

  parts.push(`Goal: ${goalState.condition}`);
  parts.push(`Status: ${goalState.status}`);
  parts.push(
    `Turns (this run): ${goalState.turnsUsed}/${goalState.maxTurns}`,
  );
  parts.push(`Lifetime turns: ${goalState.lifetimeTurnsUsed}`);

  if (goalState.judgeCallCount) {
    parts.push(`Judge evaluations: ${goalState.judgeCallCount}`);
  }

  if (goalState.lastJudgeReason) {
    parts.push(`Last judge: ${goalState.lastJudgeReason}`);
  }

  if (goalState.lastJudgeIssues && goalState.lastJudgeIssues.length > 0) {
    parts.push(`Open issues:`);
    for (const issue of goalState.lastJudgeIssues) {
      parts.push(`  • ${issue}`);
    }
  }

  // Next action hint
  let hint: string;
  switch (goalState.status) {
    case "active":
      hint = "Goal is running. Use /goal pause to pause, /goal clear to stop.";
      break;
    case "paused":
      hint = "Goal is paused. Use /goal resume to continue.";
      break;
    case "stalled":
      hint = "Goal auto-paused after consecutive failures. Use /goal resume to retry or /goal clear to stop.";
      break;
    case "done":
      hint = "Goal completed! Use /goal <new> to start a new goal.";
      break;
    case "done_with_notes":
      hint = "Goal completed with minor notes. Use /goal <new> to start a new goal.";
      break;
    case "blocked":
      hint =
        "Goal is blocked. Review the reason above. Use /goal resume to retry.";
      break;
    case "budget_exhausted":
      hint = `Max turns (${goalState.maxTurns}) reached. Use /goal resume to add another run.`;
      break;
    default:
      hint = "";
  }
  parts.push(`Hint: ${hint}`);

  return parts.join("\n");
}

// ── Judge ───────────────────────────────────────────────────────────────────

function buildJudgeTranscript(
  ctx: ExtensionContext,
  config: GoalConfig,
): string {
  const branch = ctx.sessionManager.getBranch();
  // Get the most recent entries for context — increased for quality review
  const recentEntries = branch.slice(-40);

  const parts: string[] = [];
  for (const entry of recentEntries) {
    if (entry.type !== "message") continue;
    const msg = (entry as any).message;
    if (!msg) continue;

    if (msg.role === "assistant") {
      const content = msg.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === "text" && typeof block.text === "string") {
            parts.push(`[Assistant]: ${block.text}`);
          } else if (block.type === "toolCall" && typeof block.name === "string") {
            // Include tool call names and key arguments for context
            const args = block.arguments;
            const argsStr = args ? JSON.stringify(args).slice(0, 200) : "";
            parts.push(`[Assistant called ${block.name}]: ${argsStr}`);
          }
        }
      }
    } else if (msg.role === "user") {
      const text = extractUserMessageText(msg.content);
      if (text && !text.includes(CONTINUATION_TAG)) {
        parts.push(`[User]: ${text}`);
      }
    } else if (msg.role === "toolResult") {
      const content = msg.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === "text" && typeof block.text === "string") {
            // Truncate long tool output but give more room for quality review
            const truncated =
              block.text.length > 800
                ? block.text.slice(0, 800) + "..."
                : block.text;
            parts.push(`[Tool ${msg.toolName}]: ${truncated}`);
          }
        }
      }
      if (msg.isError) {
        parts.push(`[Tool ${msg.toolName} ERROR]`);
      }
    }
  }

  let transcript = parts.join("\n");
  // Truncate to context chars
  if (transcript.length > config.contextChars) {
    transcript =
      transcript.slice(0, config.contextChars / 2) +
      "\n...\n" +
      transcript.slice(-config.contextChars / 2);
  }

  return transcript;
}

async function pickJudgeModel(): Promise<{
  model?: Model<any>;
  error?: string;
}> {
  const config = loadConfig();

  // Try explicit judge model
  if (config.judgeModel) {
    const parts = config.judgeModel.split("/");
    // Support 2-part (provider/model) and 3-part (provider/model/submodel) formats
    if (parts.length >= 2) {
      const provider = parts[0];
      const modelId = parts.slice(1).join("/");
      if (!isModelAvailable(provider, modelId)) return { error: `Judge model not found: ${config.judgeModel}` };
      const m = getModelFromRegistry(provider, modelId);
      if (!m) return { error: `Judge model not available (custom provider not yet registered): ${config.judgeModel}` };
      return { model: m };
    }
    return {
      error: `Invalid judge model format: ${config.judgeModel}. Use "provider/model" or "provider/model/submodel"`,
    };
  }

  // Fallback: configured "judge" role first (set via /config), then a list of
  // models likely to be configured, ordered by strength. These match common
  // provider names in pi configurations.
  const fallbackPairs: [string, string][] = [
    // Configured judge role wins (empty when set to auto/unset).
    ...resolveRoleCandidates("judge").map((m) => [m.provider, m.id] as [string, string]),
    // Strong models via common built-in / well-known providers
    ["openai-codex", "gpt-5.5"],
    ["openai-codex", "gpt-5.4"],
    ["openai-codex", "gpt-5.2"],
    ["anthropic", "claude-sonnet-4-5"],
    ["anthropic", "claude-haiku-4-5"],
    ["openai", "gpt-5.2"],
    ["openai", "gpt-4o-mini"],
    // Free/cheap providers as last resort
    ["freemodel", "gpt-5.5"],
    ["freemodel", "gpt-5.4"],
    ["fireworks", "accounts/fireworks/models/glm-5p1"],
    ["xiaomi-token-plan-sgp", "mimo-v2.5-pro"],
  ];

  for (const [provider, modelId] of fallbackPairs) {
    if (isModelAvailable(provider, modelId)) {
      const model = getModelFromRegistry(provider, modelId);
      if (model) return { model };
    }
  }

  return { error: "No suitable judge model found. Set PI_GOAL_JUDGE_MODEL." };
}

/**
 * Quality-focused judge prompt.
 *
 * This prompt treats the judge as a code reviewer, not just a goal-checker.
 * It evaluates whether the work is both GOAL-COMPLETE and CORRECTLY IMPLEMENTED,
 * actively looking for bugs, bad patterns, incomplete implementations, and
 * regressions.
 */
const JUDGE_SYSTEM_PROMPT = `You are an expert code reviewer evaluating a coding agent's work. You must determine whether the agent's output BOTH satisfies the goal condition AND is correctly implemented.

Your role is CRITICAL: you are the quality gate. The working model may have made subtle mistakes, introduced regressions, or left incomplete work. You must catch these BEFORE the loop stops.

## Evaluation Criteria

You must check ALL of the following:

1. **Goal Completion**: Does the visible output clearly prove the goal condition is fully satisfied? Not partially, not "mostly" — fully.

2. **Correctness**: Are there any bugs, logic errors, or incorrect implementations? Check edge cases, error handling, and boundary conditions.

3. **Completeness**: Is anything half-implemented? Are there TODO comments, placeholder code, or skipped steps that the goal requires?

4. **Regressions**: Did the agent introduce any new problems while fixing others? Check that existing functionality is preserved.

5. **Code Quality**: Are there severe anti-patterns, security issues, or performance problems that would fail a real code review?

## Severity Levels

- **critical**: Must fix before goal can be marked done. Bugs, regressions, incomplete core functionality.
- **major**: Should fix. Poor patterns, missing error handling, incomplete edge cases.
- **minor**: Nice to fix but not blocking. Style issues, minor inefficiencies, missing comments.

## Rules

- BE CONSERVATIVE: only mark done=true when ALL criteria are met with no critical or major issues.
- If there are critical issues, done MUST be false.
- If there are major issues but no critical ones, you may mark done=true ONLY if the issues are genuinely minor and the goal condition is clearly met. Otherwise, set done=false.
- Minor issues alone do not block completion.
- Evaluate ONLY from the visible transcript. Do not assume hidden state.
- If you cannot determine whether something is correct from the transcript, set done=false and list it as an issue.`;

const JUDGE_USER_PROMPT_TEMPLATE = `## Standing Goal
{condition}

## Goal State
Status: {status}
Turns used this run: {turnsUsed}/{maxTurns}
Judge evaluations so far: {judgeCallCount}

## Recent Agent Transcript
{transcript}

## Instructions
Review the agent's work above against the standing goal. Evaluate for goal completion, correctness, completeness, regressions, and code quality.

Respond with STRICT JSON only:
{"done": boolean, "blocked": boolean, "reason": "concise overall assessment", "confidence": 0.0-1.0, "issues": [{"description": "what's wrong", "severity": "critical|major|minor", "location": "file:line or component"}]}

- done: true ONLY if the goal is fully satisfied AND no critical/major issues exist
- blocked: true ONLY if progress is impossible (missing API key, external dependency, etc.)
- reason: brief overall assessment (1-2 sentences)
- confidence: how confident you are in your evaluation (0.0-1.0)
- issues: list of specific problems found. Empty array if everything looks good.`;

async function callJudge(
  ctx: ExtensionContext,
): Promise<JudgeOutput> {
  const config = loadConfig();

  if (!goalState) {
    return {
      done: true,
      blocked: false,
      reason: "No active goal state",
      confidence: 1,
      issues: [],
    };
  }

  // Pick judge model
  const { model: judgeModel, error: modelError } = await pickJudgeModel();
  if (!judgeModel) {
    if (config.failOpen) {
      return {
        done: false,
        blocked: false,
        reason: `No judge model: ${modelError} - continuing`,
        confidence: 0,
        issues: [],
      };
    }
    return {
      done: false,
      blocked: true,
      reason: `No judge model available: ${modelError}`,
      confidence: 0,
      issues: [],
    };
  }

  // Get auth via pi's model registry (includes all configured providers)
  let auth;
  try {
    auth = await ctx.modelRegistry.getApiKeyAndHeaders(judgeModel);
  } catch (err: any) {
    if (config.failOpen) {
      return {
        done: false,
        blocked: false,
        reason: `Auth lookup failed: ${err.message ?? "unknown"} - continuing`,
        confidence: 0,
        issues: [],
      };
    }
    return {
      done: false,
      blocked: true,
      reason: `Auth lookup failed: ${err.message ?? "unknown"}`,
      confidence: 0,
      issues: [],
    };
  }

  if (!auth.ok || !auth.apiKey) {
    if (config.failOpen) {
      return {
        done: false,
        blocked: false,
        reason: `No auth for judge model - continuing (${auth.error ?? "no API key"})`,
        confidence: 0,
        issues: [],
      };
    }
    return {
      done: false,
      blocked: true,
      reason: `No auth for judge model: ${auth.error ?? "no API key"}`,
      confidence: 0,
      issues: [],
    };
  }

  // Build transcript
  const transcript = buildJudgeTranscript(ctx, config);

  // Build judge prompt from template
  const judgePrompt = JUDGE_USER_PROMPT_TEMPLATE
    .replace("{condition}", goalState.condition)
    .replace("{status}", goalState.status)
    .replace("{turnsUsed}", String(goalState.turnsUsed))
    .replace("{maxTurns}", String(goalState.maxTurns))
    .replace("{judgeCallCount}", String(goalState.judgeCallCount ?? 0))
    .replace("{transcript}", transcript);

  const messages: UserMessage[] = [
    {
      role: "user",
      content: [{ type: "text", text: judgePrompt }],
      timestamp: Date.now(),
    },
  ];

  try {
    const response = await complete(
      judgeModel,
      { messages, systemPrompt: JUDGE_SYSTEM_PROMPT },
      {
        apiKey: auth.apiKey,
        headers: auth.headers,
        maxTokens: 800,
        signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
      },
    );

    const text = response.content
      .filter(
        (c): c is { type: "text"; text: string } => c.type === "text",
      )
      .map((c) => c.text)
      .join("\n");

    // Parse JSON from response via shared pure helper
    const parsed = parseJudgeOutput(text);
    if (parsed) {
      return {
        done: parsed.done === true,
        blocked: parsed.blocked === true,
        reason: parsed.reason || "Judge evaluation completed",
        confidence: parsed.confidence,
        issues: parsed.issues,
      };
    }

    // Malformed / unparseable output - fail open
    return {
      done: false,
      blocked: false,
      reason: `Judge produced malformed output, continuing: ${text.slice(0, 200)}`,
      confidence: 0,
      issues: [],
    };
  } catch (err: any) {
    if (config.continueOnJudgeError) {
      return {
        done: false,
        blocked: false,
        reason: `Judge call failed: ${err.message ?? "Unknown error"} - continuing`,
        confidence: 0,
        issues: [],
      };
    }
    return {
      done: false,
      blocked: true,
      reason: `Judge call failed: ${err.message ?? "Unknown error"}`,
      confidence: 0,
      issues: [],
    };
  }
}

// ── Subagent Instructions ──────────────────────────────────────────────────

/**
 * Build the subagent instruction block injected into every kickoff and
 * continuation prompt. The goal extension intentionally does not set or
 * override subagent models. Model routing and fallback selection live in the
 * subagent agent files (for example, ~/.pi/agent/agents/scout.md) and are
 * handled by the subagent extension.
 */
function buildSubagentInstructions(): string {
  return `
## ⚡ Execute Efficiently: Use Subagents Selectively

You have a \`subagent\` tool. Use it when parallelism or isolated context is likely to save more time than process/model startup costs. Do not pass model overrides from goal prompts; let each subagent's agent file choose its model and fallbacks.

### Use PARALLEL subagents for:
- **Broad reconnaissance**: Multiple independent local areas/filesystems → \`tasks\` array = parallel
- **Independent edits**: Unrelated files that can be changed without coordinating shared state
- **Long verification**: Independent slow commands (tests/lint/typecheck) when running them concurrently is safe
- **External/API research**: Use **implement**, not scout, for GitHub/API/URL/doc lookups

### Prefer DIRECT work for:
- Small PRs/diffs (roughly ≤3 files or ≤200 changed lines)
- Single-file inspections, simple bug fixes, or one obvious command
- Any task where a subagent would only restate information already returned

### Use CHAIN mode when:
- Output of step N is needed as input to step N+1 → use \`chain\` array with \`{previous}\` placeholder


### Agent types and when to use each:
- **scout**:     LOCAL files only — read, bash, grep, find. NO web_fetch, NO external APIs, NO GitHub calls. For any HTTP/URL/API task → use implement
- **implement**: Code edits, running commands, GitHub/API/URL work — model/fallbacks are defined in implement.md
- **review**:    Code review, security audit, quality check — model/fallbacks are defined in review.md
- **plan**:      Architecture decisions, complex tradeoff analysis — model/fallbacks are defined in plan.md

### Avoid subagent coordination traps:
- Ask every subagent for a **concise but complete final answer** on the first call.
- Do **not** call a follow-up subagent only to “return your previous output”; use the subagent tool result/details already returned.
- Do not run multiple agents against the same file for edits unless one clearly owns the final merge.
- Cap reconnaissance to one focused batch before deciding whether more context is truly needed.

### Patterns:

Parallel reconnaissance:
\`\`\`json
{ "tasks": [
  { "agent": "scout", "task": "Find all files that import from [module] and show imports. Return concise complete findings; no follow-up needed." },
  { "agent": "scout", "task": "Check test coverage for [module] — list test files. Return concise complete findings; no follow-up needed." },
  { "agent": "scout", "task": "Find all TypeScript interfaces/types related to [topic]. Return concise complete findings; no follow-up needed." }
]}
\`\`\`

Parallel independent file edits:
\`\`\`json
{ "tasks": [
  { "agent": "implement", "task": "In src/auth/login.ts: add null check before auth.verify() on line 42" },
  { "agent": "implement", "task": "In src/auth/types.ts: export the new AuthResult interface" }
]}
\`\`\`

Parallel verification:
\`\`\`json
{ "tasks": [
  { "agent": "implement", "task": "Run: npm test -- --testPathPattern=auth and report pass/fail/errors" },
  { "agent": "implement", "task": "Run: npm run lint src/auth and report any errors" },
  { "agent": "implement", "task": "Run: npx tsc --noEmit and report type errors" }
]}
\`\`\`

Code review after implementation:
\`\`\`json
{ "tasks": [
  { "agent": "review", "task": "Review src/auth/login.ts for security issues and correctness" },
  { "agent": "review", "task": "Review src/auth/types.ts for type safety" }
]}
\`\`\`

Architecture decision (use plan sparingly — strong model, use for genuine complexity):
\`\`\`json
{ "agent": "plan", "task": "Should we use JWT or session tokens? Consider: [constraints]" }
\`\`\`

Chain (discover then change):
\`\`\`json
{ "chain": [
  { "agent": "scout", "task": "List all files that import from auth/login.ts" },
  { "agent": "implement", "task": "Update each import in these files: {previous}" }
]}
\`\`\`

**The rule**: Run independent work in parallel only when the expected savings exceed subagent startup/coordination overhead. For small, local, or already-understood tasks, work directly.
`;
}

// ── Decomposition ────────────────────────────────────────────────────────────

const DECOMPOSITION_SYSTEM_PROMPT = `You are an expert coding task decomposer. Given a goal, produce a structured parallel execution plan that a coding agent will follow.

Break the goal into phases, explicitly calling out which tasks can run in PARALLEL (saving time) vs which must be SEQUENTIAL (due to dependencies). First decide whether subagents are worth their startup/coordination overhead. For small PRs/diffs, single-file tasks, or one-command checks, recommend direct execution instead of subagents.

## STRICT agent type rules — do not break these:

- scout: LOCAL filesystem only — read files, bash, grep, find. NEVER use scout for web_fetch, external APIs, GitHub, URLs, or any HTTP call. Scout has no web tools.
- implement: code edits, running commands, web_fetch, external APIs, GitHub calls, HTTP requests
- review: code review after implementation
- plan: architecture decisions requiring deep reasoning

If the goal involves GitHub PRs, web APIs, URLs, or any external resource → assign ALL such tasks to implement, never scout.
Scout is ONLY for: reading local files, grepping patterns, listing directories.

Best-practice constraints:
- Cap initial reconnaissance at one focused parallel batch; avoid follow-up agents that only repeat prior output.
- Tell every subagent to return concise complete findings in its final answer.
- Do not split edits to the same file across multiple implement agents.
- Only parallelize verification commands when they are independent and safe to run concurrently.

Be specific and actionable. Each task must be independently executable with no ambiguity.
Avoid vague tasks like "implement the feature" — say exactly which file and what change.

Output ONLY the markdown plan. No preamble, no explanation outside the plan.`;

const DECOMPOSITION_USER_PROMPT_TEMPLATE = `Goal: {condition}

Generate an efficient execution plan. If this is a small/local task where subagent overhead is unlikely to pay off, say so and keep the plan direct. Otherwise structure it as phases:

## Execution Plan

### Parallelism Decision
- Use subagents: yes/no
- Reason: [why overhead is or is not justified]

### Phase 1: Reconnaissance ⚡ parallel if justified
[LOCAL file reads only — list files, grep patterns, read configs. For web/API goals use implement here instead of scout. Ask for concise complete findings; no follow-up restatement agents.]
- scout: "... Return concise complete findings; no follow-up needed."   ← only if task is local filesystem
- implement: "... Return concise complete findings; no follow-up needed." ← for any web_fetch, GitHub API, URL, or external resource

### Phase 2: Implementation
#### 2a: [Group name] ⚡ parallel (independent changes)
- implement: "In [file]: [exact change]"
- implement: "In [file]: [exact change]"

#### 2b: [Group name] → sequential (depends on 2a)
- implement: "..."

### Phase 3: Verification ⚡ parallel if commands are independent and slow enough to justify it
- implement: "Run: [exact command] and report results concisely and completely"
- implement: "Run: [exact command] and report results concisely and completely"

### Key Dependencies
- [What must complete before what]

Keep it concise. Be specific about file paths and exact changes where possible.`;

/**
 * Pick a model for decomposition — prefer cheaper/faster models since
 * decomposition is a planning task, not complex reasoning.
 */
async function pickDecomposeModel(): Promise<{
  model?: Model<any>;
  error?: string;
}> {
  const config = loadConfig();

  // Explicit decompose model
  if (config.decomposeModel) {
    const parts = config.decomposeModel.split("/");
    if (parts.length >= 2) {
      const provider = parts[0];
      const modelId = parts.slice(1).join("/");
      if (!isModelAvailable(provider, modelId)) return { error: `Decompose model not found: ${config.decomposeModel}` };
      const m = getModelFromRegistry(provider, modelId);
      if (!m) return { error: `Decompose model not available (custom provider not yet registered): ${config.decomposeModel}` };
      return { model: m };
    }
    return { error: `Invalid decompose model format: ${config.decomposeModel}` };
  }

  // Fall back to judge model if set
  if (config.judgeModel) {
    const parts = config.judgeModel.split("/");
    if (parts.length >= 2) {
      const provider = parts[0];
      const modelId = parts.slice(1).join("/");
      if (isModelAvailable(provider, modelId)) {
        const m = getModelFromRegistry(provider, modelId);
        if (m) return { model: m };
      }
    }
  }

  // Auto-detect — prefer mid-tier models (fast enough for planning)
  const fallbackPairs: [string, string][] = [
    ["openai-codex", "gpt-5.2"],
    ["openai-codex", "gpt-5.4"],
    ["anthropic", "claude-sonnet-4-5"],
    ["anthropic", "claude-haiku-4-5"],
    ["openai", "gpt-4o-mini"],
    ["openai", "gpt-4o"],
    ["xiaomi-token-plan-sgp", "mimo-v2.5-pro"],
  ];

  for (const [provider, modelId] of fallbackPairs) {
    if (isModelAvailable(provider, modelId)) {
      const m = getModelFromRegistry(provider, modelId);
      if (m) return { model: m };
    }
  }

  return { error: "No suitable decompose model found. Set PI_GOAL_DECOMPOSE_MODEL." };
}

/**
 * Run a goal decomposition — call a fast model to generate a phased parallel
 * execution plan that gets embedded in the kickoff prompt.
 *
 * Returns the markdown plan string, or null if decomposition fails or is disabled.
 */
async function decomposeGoal(
  condition: string,
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
): Promise<string | null> {
  const config = loadConfig();
  if (!config.decompose) return null;

  const { model: decomposeModel, error: modelError } = await pickDecomposeModel();
  if (!decomposeModel) {
    // Non-fatal: log and continue without decomposition
    if (ctx.hasUI) {
      ctx.ui.notify(`Goal decomposition skipped: ${modelError}`, "warning");
    }
    return null;
  }

  // Get auth via pi's model registry (includes all configured providers)
  let auth;
  try {
    auth = await ctx.modelRegistry.getApiKeyAndHeaders(decomposeModel);
  } catch {
    return null;
  }

  if (!auth.ok || !auth.apiKey) return null;

  const userPrompt = DECOMPOSITION_USER_PROMPT_TEMPLATE
    .replace("{condition}", condition);

  try {
    if (ctx.hasUI) {
      ctx.ui.notify("Decomposing goal into parallel tasks…", "info");
    }

    const response = await complete(
      decomposeModel,
      {
        messages: [{
          role: "user",
          content: [{ type: "text", text: userPrompt }],
          timestamp: Date.now(),
        }],
        systemPrompt: DECOMPOSITION_SYSTEM_PROMPT,
      },
      {
        apiKey: auth.apiKey,
        headers: auth.headers,
        maxTokens: 1200,
        signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
      },
    );

    const text = response.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n")
      .trim();

    if (text.length < 50) return null; // Too short — likely an error response
    return text;
  } catch {
    return null;
  }
}

/**
 * Build the initial kickoff prompt sent to the working model when a goal starts.
 * Embeds subagent instructions and, if available, the decomposed task plan.
 */
function buildKickoffPrompt(state: GoalState): string {
  const planSection = state.taskPlan
    ? `\n\n## Pre-analyzed Execution Plan\n\nThe goal has been decomposed into the following task plan. Treat it as guidance, not a mandate: use \`subagent\` for indicated parallel phases only when the work is broad enough to justify startup/coordination overhead. Prefer direct work for small or already-understood tasks.\n\n${state.taskPlan}\n`
    : "";

  const subagentInstructions = buildSubagentInstructions();
  return `${CONTINUATION_TAG}\nStanding goal: ${state.condition}${planSection}\n${subagentInstructions}\nStart working on this goal immediately. Follow the execution plan above when it fits, but prefer direct work for small/local tasks. Use \`subagent\` only for genuinely independent work where parallelism or isolation is likely to save time. Do not ask the user to continue — work autonomously.\n\nWhen you believe the goal is fully satisfied, summarize what you did, what verification you ran, and what remains. Then stop — a quality reviewer will evaluate your work.`;
}

// ── Goal Lifecycle ──────────────────────────────────────────────────────────

async function setGoal(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  condition: string,
  source?: string,
) {
  const cfg = loadConfig();

  goalState = {
    id: generateId(),
    condition,
    status: "paused", // Start paused to prevent agent_end triggering for this command
    createdAt: now(),
    updatedAt: now(),
    turnsUsed: 0,
    lifetimeTurnsUsed: 0, // New goal always starts fresh
    maxTurns: cfg.maxTurns,
    source: source ?? "interactive",
    judgeCallCount: 0,
  };

  persistGoalState(pi);

  // Show status
  if (ctx.hasUI) {
    ctx.ui.notify(
      `Goal set: ${condition} (max ${cfg.maxTurns} turns/run)`,
      "info",
    );
  }

  // Run decomposition before starting — generates a parallel task plan
  if (cfg.decompose) {
    const plan = await decomposeGoal(condition, pi, ctx);
    if (plan && goalState) {
      goalState.taskPlan = plan;
      goalState.decomposedAt = now();
      persistGoalState(pi);
    }
  }

  // Immediately start working
  await resumeGoal(pi, ctx);
}

async function resumeGoal(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
) {
  if (!goalState) {
    if (ctx.hasUI) {
      ctx.ui.notify("No goal to resume. Set one with /goal <condition>.", "warning");
    }
    return;
  }

  if (goalState.status === "done" || goalState.status === "done_with_notes") {
    if (ctx.hasUI) {
      ctx.ui.notify(
        "Goal is already done. Set a new goal with /goal <condition>.",
        "warning",
      );
    }
    return;
  }

  // Reset per-run counter and failure tracking
  goalState.status = "active";
  goalState.turnsUsed = 0;
  goalState.consecutiveFailures = 0;
  goalState.updatedAt = now();
  goalState.lastError = undefined;
  goalState.lastContinuationAt = undefined;
  goalState.lastJudgeReason = undefined;
  goalState.lastJudgeIssues = undefined;
  persistGoalState(pi);

  continuationInFlight = false;

  if (ctx.hasUI) {
    ctx.ui.notify(
      `Goal resumed: ${goalState.condition} (max ${goalState.maxTurns} turns)`,
      "info",
    );
    ctx.ui.setStatus("goal", `${statusIcon("active")} Goal active`);
  }

  // Send initial prompt to start working on the goal
  const kickoff = buildKickoffPrompt(goalState);

  pi.sendUserMessage(kickoff, { deliverAs: "followUp" });
}

async function pauseGoal(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
) {
  if (!goalState) {
    if (ctx.hasUI) {
      ctx.ui.notify("No active goal to pause", "warning");
    }
    return;
  }

  // Break the in-flight lock so the loop stops immediately
  continuationInFlight = false;

  goalState.status = "paused";
  goalState.updatedAt = now();
  persistGoalState(pi);

  if (ctx.hasUI) {
    ctx.ui.notify(`Goal paused: ${goalState.condition}`, "info");
    ctx.ui.setStatus("goal", `${statusIcon("paused")} Goal paused`);
  }
}

async function clearGoal(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
) {
  if (!goalState) {
    if (ctx.hasUI) {
      ctx.ui.notify("No active goal to clear", "info");
    }
    return;
  }

  const oldCondition = goalState.condition;
  goalState = null;
  continuationInFlight = false;

  // Persist cleared state by appending an entry without data
  pi.appendEntry(CUSTOM_TYPE);

  if (ctx.hasUI) {
    ctx.ui.notify(`Goal cleared: ${oldCondition}`, "info");
    ctx.ui.setStatus("goal", undefined as any);
  }
}

function showStatus(ctx: ExtensionCommandContext) {
  if (!goalState) {
    if (ctx.hasUI) {
      ctx.ui.notify(
        "No active goal. Set one with /goal <condition>",
        "info",
      );
    }
    return;
  }

  const parts = goalStatusParts();

  if (ctx.hasUI) {
    ctx.ui.notify(
      parts,
      goalState.status === "active" ? "info" : "warning",
    );
  }
}

// ── Continuation ────────────────────────────────────────────────────────────

function buildContinuationPrompt(state: GoalState, verdict: JudgeOutput): string {
  // Shared pure builder + live subagent instruction block.
  return buildContinuationPromptPure(state, verdict, {
    extraInstructions: buildSubagentInstructions() + "\n",
  });
}

async function handleAgentEnd(
  pi: ExtensionAPI,
  event: AgentEndEvent,
  ctx: ExtensionContext,
) {
  // Guard: only proceed if goal is active (also catches pause/clear that
  // happened while a turn was in-flight — the status will have changed)
  if (!isActive()) return;

  // Guard: prevent re-entrant loops
  if (continuationInFlight) return;

  const config = loadConfig();

  // ── Dead Loop Detection ──────────────────────────────────────────────
  //
  // Detect empty, error, or no-progress turns. If the model produces
  // nothing useful for N consecutive turns, auto-pause to prevent
  // the spinning behavior where the loop runs all 20 turns uncontrolled.
  //
  // A "failed turn" is one where:
  //   - event.messages is empty or missing
  //   - The last assistant message has only error blocks
  //   - The last assistant message has no text AND no tool calls
  //   - The model aborted with an error stop reason

  const isEmptyTurn = !event.messages || event.messages.length === 0;

  let isFailedTurn = isEmptyTurn;
  if (!isEmptyTurn && event.messages) {
    const lastAssistant = [...event.messages]
      .reverse()
      .find((m: any) => m?.role === "assistant");
    if (lastAssistant) {
      const content = (lastAssistant as any).content;
      if (Array.isArray(content)) {
        const hasText = content.some(
          (block: any) => block.type === "text" && typeof block.text === "string" && block.text.trim().length > 0,
        );
        const hasToolCalls = content.some(
          (block: any) => block.type === "toolCall",
        );
        const hasOnlyErrors = content.some(
          (block: any) => block.type === "error",
        );
        // If no text, no tool calls, or only errors — it's a failed turn
        if (!hasText && !hasToolCalls) isFailedTurn = true;
        if (hasOnlyErrors && !hasText && !hasToolCalls) isFailedTurn = true;
      } else {
        // Non-array content with no useful structure
        isFailedTurn = true;
      }

      // Check for error/aborted stop reason
      if ((lastAssistant as any).stopReason === "error" || (lastAssistant as any).stopReason === "aborted") {
        isFailedTurn = true;
      }
    } else {
      // No assistant message at all
      isFailedTurn = true;
    }
  }

  // Track consecutive failures
  if (isFailedTurn) {
    goalState!.consecutiveFailures = (goalState!.consecutiveFailures ?? 0) + 1;
    goalState!.lastError = `Turn produced no useful output (failure ${goalState!.consecutiveFailures}/${config.stallLimit})`;
    persistGoalState(pi);

    if (goalState!.consecutiveFailures >= config.stallLimit) {
      // Auto-pause: too many consecutive failures — break the loop
      goalState!.status = "stalled";
      goalState!.updatedAt = now();
      goalState!.lastJudgeReason = `Auto-paused after ${goalState!.consecutiveFailures} consecutive failed turns. The model may be stuck, unable to respond, or hitting errors.`;
      persistGoalState(pi);
      continuationInFlight = false;

      if (ctx.hasUI) {
        ctx.ui.notify(
          `⚠ Goal stalled: ${goalState!.consecutiveFailures} consecutive failed turns. Use /goal resume to retry or /goal clear to stop.`,
          "error",
        );
        ctx.ui.setStatus(
          "goal",
          `${statusIcon("stalled")} Goal stalled`,
        );
      }
      return;
    }

    // Failed turn but under the limit — still skip processing but let the loop continue
    // (a single empty turn might just be a transient issue)
    if (isEmptyTurn) return;
  } else {
    // Reset failure counter on a successful turn
    if (goalState!.consecutiveFailures && goalState!.consecutiveFailures > 0) {
      goalState!.consecutiveFailures = 0;
      goalState!.lastError = undefined;
      persistGoalState(pi);
    }
  }

  // Skip processing for genuinely empty turns (no messages at all)
  if (isEmptyTurn) return;

  // Check if this was our continuation - look at last user message
  const branch = ctx.sessionManager.getBranch();
  const lastUser = branch
    .filter((e) => e.type === "message")
    .map((e) => (e as any).message)
    .reverse()
    .find((m: any) => m?.role === "user");

  const lastUserText = lastUser ? extractUserMessageText(lastUser.content) : "";
  const isOurContinuation = lastUserText.includes(CONTINUATION_TAG);

  // Bump turn counts for our continuation turns
  if (isOurContinuation) {
    goalState!.turnsUsed += 1;
    goalState!.lifetimeTurnsUsed += 1;
    goalState!.lastContinuationAt = now();
    persistGoalState(pi);
  }

  // Check budget
  if (goalState!.turnsUsed >= goalState!.maxTurns) {
    goalState!.status = "budget_exhausted";
    goalState!.updatedAt = now();
    goalState!.lastJudgeReason = `Budget exhausted after ${goalState!.turnsUsed}/${goalState!.maxTurns} turns`;
    persistGoalState(pi);

    if (ctx.hasUI) {
      ctx.ui.notify(
        `Goal budget exhausted: ${goalState!.turnsUsed}/${goalState!.maxTurns} turns used. Use /goal resume.`,
        "warning",
      );
      ctx.ui.setStatus(
        "goal",
        `${statusIcon("budget_exhausted")} Goal budget exhausted`,
      );
    }
    return;
  }

  // Determine whether to run the judge
  if (!shouldRunJudge(event, goalState!, config)) {
    // No completion signal and not on interval — just continue
    const midLoopPlan = goalState!.taskPlan
      ? `\n\n## Execution Plan (reference)\n\nUse this as guidance; prefer direct work for small/local steps and avoid extra subagent calls that only restate previous results.\n\n${goalState!.taskPlan}\n`
      : "";
    const continuationMessage = `${CONTINUATION_TAG}\nStanding goal:\n${goalState!.condition}${midLoopPlan}\n${buildSubagentInstructions()}\nContinue working toward the standing goal. Use \`subagent\` only when parallelism or isolated context is worth the overhead; prefer direct work for small/local tasks. Do not ask the user to continue.\n\nWhen you believe the goal is fully satisfied, summarize what you did and stop — a quality reviewer will evaluate your work.`;

    pi.sendUserMessage(continuationMessage, { deliverAs: "followUp" });
    return;
  }

  // Run judge — completion signal detected or interval reached
  continuationInFlight = true;

  try {
    // Re-check if goal was paused/cleared while we were waiting
    if (!isActive()) {
      continuationInFlight = false;
      return;
    }

    goalState!.judgeCallCount = (goalState!.judgeCallCount ?? 0) + 1;
    persistGoalState(pi);

    const verdict = await callJudge(ctx);

    // Re-check again after the async judge call
    if (!isActive()) {
      continuationInFlight = false;
      return;
    }

    goalState!.lastJudgeReason = verdict.reason;
    goalState!.lastJudgeIssues = verdict.issues.map((i) => {
      const loc = i.location ? ` [${i.location}]` : "";
      return `${i.severity}: ${i.description}${loc}`;
    });

    if (verdict.done) {
      // Check if there are minor issues to note
      const hasMinorIssues = verdict.issues.some((i) => i.severity === "minor");
      const hasNoCriticalOrMajor = !verdict.issues.some(
        (i) => i.severity === "critical" || i.severity === "major",
      );

      if (hasMinorIssues && hasNoCriticalOrMajor) {
        goalState!.status = "done_with_notes";
        goalState!.lastJudgeIssues = verdict.issues
          .filter((i) => i.severity === "minor")
          .map((i) => i.description);
      } else {
        goalState!.status = "done";
      }

      goalState!.updatedAt = now();
      persistGoalState(pi);

      if (ctx.hasUI) {
        const issueNote = verdict.issues.length > 0
          ? ` (${verdict.issues.length} minor note${verdict.issues.length > 1 ? "s" : ""})`
          : "";
        ctx.ui.notify(`Goal completed!${issueNote} ${verdict.reason}`, "success");
        ctx.ui.setStatus("goal", `${statusIcon("done")} Goal done`);
      }
    } else if (verdict.blocked) {
      goalState!.status = "blocked";
      goalState!.updatedAt = now();
      persistGoalState(pi);

      if (ctx.hasUI) {
        ctx.ui.notify(`Goal blocked: ${verdict.reason}`, "error");
        ctx.ui.setStatus("goal", `${statusIcon("blocked")} Goal blocked`);
      }
    } else {
      // Continue with specific feedback from the judge
      persistGoalState(pi);

      const continuationMessage = buildContinuationPrompt(goalState!, verdict);

      // Send continuation as a new user message to trigger next turn
      pi.sendUserMessage(continuationMessage, { deliverAs: "followUp" });
    }
  } catch (err: any) {
    goalState!.lastError = err.message ?? "Unknown error";
    persistGoalState(pi);

    if (ctx.hasUI) {
      ctx.ui.notify(`Judge error: ${err.message}`, "error");
    }
  } finally {
    continuationInFlight = false;
  }
}

// ── Command Registration ────────────────────────────────────────────────────

function registerCommands(pi: ExtensionAPI) {
  // Main /goal command
  pi.registerCommand("goal", {
    description: "Set or manage a persistent autonomous goal",
    handler: async (args, ctx) => {
      const trimmed = args.trim();

      if (!trimmed) {
        // /goal - show status
        showStatus(ctx);
        return;
      }

      const lower = trimmed.toLowerCase();

      // Handle subcommands
      if (lower === "status") {
        showStatus(ctx);
        return;
      }
      if (lower === "pause" || lower === "stop") {
        await pauseGoal(pi, ctx);
        return;
      }
      if (lower === "resume") {
        await resumeGoal(pi, ctx);
        return;
      }
      if (
        lower === "clear" ||
        lower === "cancel" ||
        lower === "off" ||
        lower === "none"
      ) {
        await clearGoal(pi, ctx);
        return;
      }
      if (lower === "reset") {
        // Clear and re-set the same condition
        if (goalState) {
          const prevCondition = goalState.condition;
          goalState = null;
          continuationInFlight = false;
          await setGoal(pi, ctx, prevCondition);
        } else {
          if (ctx.hasUI) {
            ctx.ui.notify("No active goal to reset", "warning");
          }
        }
        return;
      }

      // /goal <condition> - set new goal
      await setGoal(pi, ctx, trimmed);
    },
  });
}

// ── Main Extension ──────────────────────────────────────────────────────────

export default function goalExtension(pi: ExtensionAPI) {
  // Restore state on session start
  pi.on("session_start", async (_event: SessionStartEvent, ctx) => {
    // Capture pi's model registry — includes user-configured custom providers.
    // This must be done at session start before any goal can be set.
    capturedModelRegistry = ctx.modelRegistry;

    const hadGoal = restoreGoalState(ctx);

    if (hadGoal && goalState && ctx.hasUI) {
      if (goalState.status === "active") {
        ctx.ui.setStatus("goal", `${statusIcon("active")} Goal active`);
      } else if (goalState.status === "paused") {
        ctx.ui.setStatus("goal", `${statusIcon("paused")} Goal paused`);
      }
    }
  });

  // Refresh model registry when models change; subagent model selection remains in agent files.
  pi.on("model_select", async (_event, ctx) => {
    capturedModelRegistry = ctx.modelRegistry; // refresh — may include newly registered providers
  });

  // Handle agent end for continuation loop
  pi.on("agent_end", async (event, ctx) => {
    await handleAgentEnd(pi, event, ctx);
  });

  // Register commands
  registerCommands(pi);
}
