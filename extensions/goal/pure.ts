/**
 * Pure goal helpers shared by the extension (index.ts) and unit tests (tests.ts).
 *
 * Keep this module free of pi-ai / pi-coding-agent imports so tests can run with
 * `npx tsx --test` without loading the live extension runtime.
 */

// ── Types ───────────────────────────────────────────────────────────────────

export type GoalStatus =
  | "active"
  | "paused"
  | "stalled"
  | "done"
  | "done_with_notes"
  | "blocked"
  | "budget_exhausted";

export interface GoalState {
  id: string;
  condition: string;
  status: GoalStatus;
  createdAt: string;
  updatedAt: string;
  turnsUsed: number;
  lifetimeTurnsUsed: number;
  maxTurns: number;
  lastJudgeReason?: string;
  lastJudgeIssues?: string[];
  lastError?: string;
  lastContinuationAt?: string;
  source?: "interactive" | "rpc" | "sdk" | "extension" | string;
  judgeCallCount?: number;
  taskPlan?: string;
  decomposedAt?: string;
  consecutiveFailures?: number;
}

export interface JudgeIssue {
  description: string;
  severity: "critical" | "major" | "minor";
  location?: string;
}

export interface JudgeOutput {
  done: boolean;
  blocked: boolean;
  reason: string;
  confidence: number;
  issues: JudgeIssue[];
}

export interface GoalConfig {
  enabled: boolean;
  maxTurns: number;
  judgeModel?: string;
  contextChars: number;
  failOpen: boolean;
  continueOnJudgeError: boolean;
  judgeEvery: number;
  stallLimit: number;
  decompose: boolean;
  decomposeModel?: string;
}

// ── Defaults ────────────────────────────────────────────────────────────────

export const DEFAULT_MAX_TURNS = 20;
export const DEFAULT_CONTEXT_CHARS = 12000;
export const DEFAULT_JUDGE_EVERY = 0;
export const DEFAULT_STALL_LIMIT = 3;
export const CUSTOM_TYPE = "goal-state";
export const CONTINUATION_TAG = "[Pi /goal continuation]";

// ── Small helpers ───────────────────────────────────────────────────────────

export function generateId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from({ length: 8 }, () =>
    chars.charAt(Math.floor(Math.random() * chars.length)),
  ).join("");
}

export function now(): string {
  return new Date().toISOString();
}

export function createGoalState(
  condition: string,
  overrides: Partial<GoalState> = {},
): GoalState {
  return {
    id: generateId(),
    condition,
    status: "active",
    createdAt: now(),
    updatedAt: now(),
    turnsUsed: 0,
    lifetimeTurnsUsed: 0,
    maxTurns: DEFAULT_MAX_TURNS,
    judgeCallCount: 0,
    ...overrides,
  };
}

/**
 * Extract plain text from a user message's content field.
 * Pi stores user messages as content: [{type:"text", text:"..."}] (array format),
 * but we also handle the string format defensively.
 */
export function extractUserMessageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b: any) => b.type === "text" && typeof b.text === "string")
      .map((b: any) => b.text)
      .join("\n");
  }
  return "";
}

export function loadConfigFromEnv(
  env: Record<string, string | undefined> = process.env as Record<
    string,
    string | undefined
  >,
): GoalConfig {
  return {
    enabled: env.PI_GOAL_DISABLED !== "1" && env.PI_GOAL_DISABLED !== "true",
    maxTurns: parseInt(env.PI_GOAL_MAX_TURNS ?? "", 10) || DEFAULT_MAX_TURNS,
    judgeModel: env.PI_GOAL_JUDGE_MODEL ?? undefined,
    contextChars:
      parseInt(env.PI_GOAL_CONTEXT_CHARS ?? "", 10) || DEFAULT_CONTEXT_CHARS,
    failOpen: env.PI_GOAL_FAIL_OPEN !== "false",
    continueOnJudgeError: env.PI_GOAL_CONT_ON_ERROR !== "false",
    judgeEvery: parseInt(env.PI_GOAL_JUDGE_EVERY ?? "", 10) || DEFAULT_JUDGE_EVERY,
    stallLimit: parseInt(env.PI_GOAL_STALL_LIMIT ?? "", 10) || DEFAULT_STALL_LIMIT,
    decompose: env.PI_GOAL_DECOMPOSE !== "false",
    decomposeModel: env.PI_GOAL_DECOMPOSE_MODEL ?? undefined,
  };
}

export function statusIcon(status: GoalStatus): string {
  switch (status) {
    case "active":
      return "↻";
    case "paused":
      return "⏸";
    case "stalled":
      return "⚠";
    case "done":
      return "✓";
    case "done_with_notes":
      return "✓";
    case "blocked":
      return "✗";
    case "budget_exhausted":
      return "⏰";
  }
}

export function goalStatusLines(state: GoalState): string[] {
  const parts: string[] = [];
  parts.push(`Goal: ${state.condition}`);
  parts.push(`Status: ${state.status}`);
  parts.push(`Turns (this run): ${state.turnsUsed}/${state.maxTurns}`);
  parts.push(`Lifetime turns: ${state.lifetimeTurnsUsed}`);
  if (state.judgeCallCount) {
    parts.push(`Judge evaluations: ${state.judgeCallCount}`);
  }
  if (state.lastJudgeReason) {
    parts.push(`Last judge: ${state.lastJudgeReason}`);
  }
  if (state.lastJudgeIssues && state.lastJudgeIssues.length > 0) {
    parts.push(`Open issues:`);
    for (const issue of state.lastJudgeIssues) {
      parts.push(`  • ${issue}`);
    }
  }
  return parts;
}

// ── Judge parsing ───────────────────────────────────────────────────────────

export function parseJudgeOutput(text: string): JudgeOutput | null {
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;
  try {
    const parsed = JSON.parse(jsonMatch[0]);
    if (
      typeof parsed.done !== "boolean" ||
      typeof parsed.blocked !== "boolean" ||
      typeof parsed.reason !== "string"
    ) {
      return null;
    }
    const issues: JudgeIssue[] = [];
    if (Array.isArray(parsed.issues)) {
      for (const item of parsed.issues) {
        if (item && typeof item.description === "string") {
          issues.push({
            description: item.description,
            severity:
              item.severity === "critical" ||
              item.severity === "major" ||
              item.severity === "minor"
                ? item.severity
                : "major",
            location:
              typeof item.location === "string" ? item.location : undefined,
          });
        }
      }
    }
    return {
      done: parsed.done,
      blocked: parsed.blocked,
      reason: parsed.reason,
      confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.5,
      issues,
    };
  } catch {
    return null;
  }
}

// ── Completion signal ───────────────────────────────────────────────────────

export interface CompletionMessage {
  role?: string;
  content?: unknown;
}

/**
 * Detect whether the working model has signalled it's done working by inspecting
 * the last assistant message for completion phrases / text-only wrap-up.
 */
export function detectCompletionSignalFromMessages(
  messages: CompletionMessage[] | undefined | null,
): boolean {
  if (!messages || messages.length === 0) return false;

  const lastAssistant = [...messages]
    .reverse()
    .find((m) => m?.role === "assistant");

  if (!lastAssistant) return false;

  const content = lastAssistant.content;
  if (!Array.isArray(content)) return false;

  const hasToolCalls = content.some((block: any) => block.type === "toolCall");
  if (hasToolCalls) return false;

  const textBlocks = content.filter(
    (block: any) => block.type === "text" && typeof block.text === "string",
  );
  const assistantText = textBlocks
    .map((b: any) => b.text)
    .join("\n")
    .toLowerCase();

  const completionPhrases = [
    "i'm done",
    "i am done",
    "im done",
    "i've completed",
    "i have completed",
    "i've finished",
    "i have finished",
    "task is complete",
    "task is completed",
    "goal is complete",
    "goal is completed",
    "all done",
    "all changes have been",
    "everything is working",
    "the implementation is complete",
    "the fix is complete",
    "successfully implemented",
    "successfully completed",
    "this is now working",
    "the issue is now resolved",
    "the bug is now fixed",
    "tests are passing",
    "all tests pass",
    "all tests are passing",
  ];

  const hasCompletionPhrase = completionPhrases.some((phrase) =>
    assistantText.includes(phrase),
  );
  if (hasCompletionPhrase) return true;

  if (!hasToolCalls && textBlocks.length > 0) {
    const continuePhrases = [
      "let me",
      "i'll now",
      "i will now",
      "next, i",
      "next i'll",
      "i need to",
      "i still need to",
      "i should also",
      "let me also",
      "now i'll",
      "now i will",
      "first, i'll",
      "first i will",
      "i'm going to",
      "i am going to",
    ];
    const hasContinuePhrase = continuePhrases.some((phrase) =>
      assistantText.includes(phrase),
    );
    if (!hasContinuePhrase && assistantText.length > 100) {
      return true;
    }
  }

  return false;
}

export function shouldRunJudgeOnTurn(
  messages: CompletionMessage[] | undefined | null,
  state: Pick<GoalState, "turnsUsed">,
  config: Pick<GoalConfig, "judgeEvery">,
): boolean {
  if (detectCompletionSignalFromMessages(messages)) return true;
  if (config.judgeEvery > 0 && state.turnsUsed > 0) {
    return state.turnsUsed % config.judgeEvery === 0;
  }
  return false;
}

// ── State transitions ───────────────────────────────────────────────────────

export function canResumeGoal(status: GoalStatus): boolean {
  return status !== "done" && status !== "done_with_notes";
}

export function isBudgetExhausted(state: Pick<GoalState, "turnsUsed" | "maxTurns">): boolean {
  return state.turnsUsed >= state.maxTurns;
}

/**
 * Apply a successful judge verdict to a mutable goal state and return the new status.
 * Pure transition helper for tests + future use from the extension loop.
 */
export function applyJudgeVerdict(
  state: GoalState,
  verdict: JudgeOutput,
  updatedAt: string = now(),
): GoalStatus {
  state.lastJudgeReason = verdict.reason;
  state.updatedAt = updatedAt;
  state.judgeCallCount = (state.judgeCallCount ?? 0) + 1;

  if (verdict.blocked) {
    state.status = "blocked";
    return state.status;
  }

  if (verdict.done) {
    const criticalOrMajor = verdict.issues.filter(
      (i) => i.severity === "critical" || i.severity === "major",
    );
    if (criticalOrMajor.length === 0) {
      const minor = verdict.issues.filter((i) => i.severity === "minor");
      if (minor.length > 0) {
        state.status = "done_with_notes";
        state.lastJudgeIssues = minor.map((i) => `minor: ${i.description}`);
      } else {
        state.status = "done";
        state.lastJudgeIssues = [];
      }
    } else {
      // Judge said done but also reported blocking issues — keep active and surface them.
      state.status = "active";
      state.lastJudgeIssues = criticalOrMajor.map(
        (i) => `${i.severity}: ${i.description}`,
      );
    }
    return state.status;
  }

  // Not done — remain active with issues (if any).
  state.status = "active";
  if (verdict.issues.length > 0) {
    state.lastJudgeIssues = verdict.issues.map(
      (i) => `${i.severity}: ${i.description}`,
    );
  }
  return state.status;
}

export function pauseGoal(state: GoalState, updatedAt: string = now()): void {
  state.status = "paused";
  state.updatedAt = updatedAt;
}

export function resumeGoal(state: GoalState, updatedAt: string = now()): boolean {
  if (!canResumeGoal(state.status)) return false;
  state.status = "active";
  state.turnsUsed = 0;
  state.consecutiveFailures = 0;
  state.updatedAt = updatedAt;
  return true;
}

export function markBudgetExhausted(state: GoalState, updatedAt: string = now()): void {
  state.status = "budget_exhausted";
  state.updatedAt = updatedAt;
}

// ── Prompt builders ─────────────────────────────────────────────────────────

export function formatIssuesSection(issues: JudgeIssue[]): string {
  if (issues.length === 0) return "";

  const criticalIssues = issues.filter((i) => i.severity === "critical");
  const majorIssues = issues.filter((i) => i.severity === "major");
  const minorIssues = issues.filter((i) => i.severity === "minor");

  let issuesSection = "\n\n## Issues Found by Quality Review\n";

  if (criticalIssues.length > 0) {
    issuesSection += "\n### ❌ Critical (must fix)\n";
    for (const issue of criticalIssues) {
      const loc = issue.location ? ` [${issue.location}]` : "";
      issuesSection += `1. ${issue.description}${loc}\n`;
    }
  }

  if (majorIssues.length > 0) {
    issuesSection += "\n### ⚠️ Major (should fix)\n";
    for (const issue of majorIssues) {
      const loc = issue.location ? ` [${issue.location}]` : "";
      issuesSection += `1. ${issue.description}${loc}\n`;
    }
  }

  if (minorIssues.length > 0) {
    issuesSection += "\n### 💡 Minor (optional)\n";
    for (const issue of minorIssues) {
      const loc = issue.location ? ` [${issue.location}]` : "";
      issuesSection += `1. ${issue.description}${loc}\n`;
    }
  }

  issuesSection +=
    "\nFix the critical and major issues above. Minor issues are optional but recommended.\n";
  return issuesSection;
}

export interface ContinuationOptions {
  /** Extra text injected after the issues section (subagent instructions, etc.). */
  extraInstructions?: string;
  /** When true (default), include the task plan reminder if present. */
  includePlan?: boolean;
}

/**
 * Build the continuation prompt fed back to the working model after a judge verdict.
 * Callers that need the live subagent block pass it via `extraInstructions`.
 */
export function buildContinuationPrompt(
  state: GoalState,
  verdict: JudgeOutput,
  options: ContinuationOptions = {},
): string {
  const includePlan = options.includePlan !== false;
  const issuesSection = formatIssuesSection(verdict.issues);
  const planReminder =
    includePlan && state.taskPlan
      ? `\n\n## Original Execution Plan\n\nRefer back to this plan for remaining work. Treat parallel phases as guidance and use subagents only when the overhead is justified:\n\n${state.taskPlan}\n`
      : "";
  const extra = options.extraInstructions ?? "";

  return `${CONTINUATION_TAG}
Standing goal:
${state.condition}

## Quality Review Assessment
${verdict.reason}${issuesSection}${planReminder}
${extra}Continue working toward the standing goal. Address the issues identified above. Use \`subagent\` only for genuinely independent work where parallelism or isolation is likely to save time; otherwise work directly. Do not ask the user to continue.

When you believe the goal is fully satisfied AND all critical/major issues are resolved, summarize what you did and stop — the quality reviewer will evaluate again.`;
}

export function buildKickoffPrompt(
  state: GoalState,
  subagentInstructions: string,
  continuationTag: string = CONTINUATION_TAG,
): string {
  const planSection = state.taskPlan
    ? `\n\n## Pre-analyzed Execution Plan\n\n${state.taskPlan}\n`
    : "";

  return `${continuationTag}\nStanding goal: ${state.condition}${planSection}\n${subagentInstructions}\nStart working on this goal immediately.`;
}

/**
 * Minimal structural validation for a decomposition plan produced by the model.
 */
export function isValidDecompositionPlan(text: string): boolean {
  return (
    text.length >= 50 &&
    (text.includes("Phase") ||
      text.includes("Reconnaissance") ||
      text.includes("Implementation"))
  );
}
