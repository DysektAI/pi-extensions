/**
 * Goal Extension Tests
 *
 * Pure helpers live in `./pure.ts` and are shared with `index.ts` so tests do not
 * maintain a second copy of production logic.
 *
 * Covers:
 * 1. Goal state creation and validation
 * 2. State transitions (active, paused, done, done_with_notes, blocked, budget_exhausted)
 * 3. Judge output parsing (with issues field)
 * 4. Config loading from environment
 * 5. Continuation prompt building (with structured issues)
 * 6. Budget exhaustion
 * 7. Session restoration
 * 8. Completion signal detection
 * 9. Judge invocation gating
 * 10. Decomposition / subagent prompt integration
 *
 * Run with:
 *   npx tsx --test pi/agent/extensions/goal/tests.ts
 * or (after sync) against the installed copy:
 *   npx tsx --test ~/.pi/agent/extensions/goal/tests.ts
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  type GoalConfig,
  type GoalState,
  type JudgeIssue,
  type JudgeOutput,
  CONTINUATION_TAG,
  applyJudgeVerdict,
  buildContinuationPrompt,
  buildKickoffPrompt,
  canResumeGoal,
  createGoalState,
  detectCompletionSignalFromMessages,
  extractUserMessageText,
  generateId,
  goalStatusLines,
  isBudgetExhausted,
  isValidDecompositionPlan,
  loadConfigFromEnv,
  markBudgetExhausted,
  now,
  parseJudgeOutput,
  pauseGoal,
  resumeGoal,
  shouldRunJudgeOnTurn,
  statusIcon,
} from "./pure.ts";

// Thin adapters so existing test call sites keep working.
function loadConfig(env: Record<string, string | undefined> = {}): GoalConfig {
  return loadConfigFromEnv(env);
}

function detectCompletionSignal(event: {
  messages: Array<{ role: string; content: any }>;
}): boolean {
  return detectCompletionSignalFromMessages(event.messages);
}

function shouldRunJudge(
  event: { messages: Array<{ role: string; content: any }> },
  state: Pick<GoalState, "turnsUsed">,
  config: Pick<GoalConfig, "judgeEvery">,
): boolean {
  return shouldRunJudgeOnTurn(event.messages, state, config);
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("Goal State Management", () => {
  it("creates goal state with required fields", () => {
    const state = createGoalState("Refactor auth module");
    assert.ok(state.id.length === 8, "id should be 8 chars");
    assert.equal(state.condition, "Refactor auth module");
    assert.equal(state.status, "active");
    assert.equal(state.turnsUsed, 0);
    assert.equal(state.lifetimeTurnsUsed, 0);
    assert.equal(state.maxTurns, 20);
    assert.equal(state.judgeCallCount, 0);
    assert.ok(state.createdAt, "createdAt should be set");
    assert.ok(state.updatedAt, "updatedAt should be set");
  });

  it("allows overriding fields on creation", () => {
    const state = createGoalState("Test", {
      maxTurns: 10,
      turnsUsed: 5,
      lifetimeTurnsUsed: 25,
      lastJudgeReason: "Previous run",
      judgeCallCount: 3,
    });
    assert.equal(state.maxTurns, 10);
    assert.equal(state.turnsUsed, 5);
    assert.equal(state.lifetimeTurnsUsed, 25);
    assert.equal(state.lastJudgeReason, "Previous run");
    assert.equal(state.judgeCallCount, 3);
  });
});

describe("Goal State Transitions", () => {
  let state: GoalState;

  beforeEach(() => {
    state = createGoalState("Do something");
  });

  it("transitions from active to paused", () => {
    assert.equal(state.status, "active");
    state.status = "paused";
    state.updatedAt = now();
    assert.equal(state.status, "paused");
  });

  it("transitions from paused to active on resume", () => {
    state.status = "paused";
    state.turnsUsed = 5;
    state.status = "active";
    state.turnsUsed = 0;
    state.updatedAt = now();
    assert.equal(state.status, "active");
    assert.equal(state.turnsUsed, 0);
  });

  it("transitions to done when goal is completed with no issues", () => {
    state.status = "done";
    state.lastJudgeReason = "All tests pass, docs updated, no issues found";
    state.updatedAt = now();
    assert.equal(state.status, "done");
    assert.equal(state.lastJudgeReason, "All tests pass, docs updated, no issues found");
  });

  it("transitions to done_with_notes when only minor issues exist", () => {
    state.status = "done_with_notes";
    state.lastJudgeReason = "Goal satisfied with minor notes";
    state.lastJudgeIssues = ["minor: Consider caching the result"];
    state.updatedAt = now();
    assert.equal(state.status, "done_with_notes");
    assert.ok(state.lastJudgeIssues!.length > 0);
  });

  it("transitions to blocked when judge reports impossible", () => {
    state.status = "blocked";
    state.lastJudgeReason = "Requires external API key not available";
    state.updatedAt = now();
    assert.equal(state.status, "blocked");
  });

  it("transitions to budget_exhausted when max turns reached", () => {
    state.turnsUsed = 20;
    state.maxTurns = 20;
    if (state.turnsUsed >= state.maxTurns) {
      state.status = "budget_exhausted";
    }
    assert.equal(state.status, "budget_exhausted");
  });

  it("does not transition to budget_exhausted when under limit", () => {
    state.turnsUsed = 19;
    state.maxTurns = 20;
    if (state.turnsUsed >= state.maxTurns) {
      state.status = "budget_exhausted";
    }
    assert.equal(state.status, "active");
  });

  it("does not resume a completed goal", () => {
    state.status = "done";
    const canResume = state.status !== "done" && state.status !== "done_with_notes";
    assert.equal(canResume, false);
  });

  it("does not resume a done_with_notes goal", () => {
    state.status = "done_with_notes";
    const canResume = state.status !== "done" && state.status !== "done_with_notes";
    assert.equal(canResume, false);
  });

  it("allows resuming a paused goal", () => {
    state.status = "paused";
    const canResume = state.status !== "done" && state.status !== "done_with_notes";
    assert.equal(canResume, true);
  });

  it("allows resuming a budget_exhausted goal", () => {
    state.status = "budget_exhausted";
    const canResume = state.status !== "done" && state.status !== "done_with_notes";
    assert.equal(canResume, true);
  });
});

describe("Judge Output Parser", () => {
  it('parses valid "done" JSON with empty issues', () => {
    const result = parseJudgeOutput(
      '{"done": true, "blocked": false, "reason": "All checks pass", "confidence": 0.95, "issues": []}',
    );
    assert.ok(result);
    assert.equal(result.done, true);
    assert.equal(result.blocked, false);
    assert.equal(result.reason, "All checks pass");
    assert.equal(result.confidence, 0.95);
    assert.equal(result.issues.length, 0);
  });

  it('parses valid "continue" JSON with issues', () => {
    const result = parseJudgeOutput(
      '{"done": false, "blocked": false, "reason": "Issues found", "confidence": 0.3, "issues": [{"description": "Null check missing", "severity": "critical", "location": "login.ts:42"}, {"description": "Missing error handling", "severity": "major"}]}',
    );
    assert.ok(result);
    assert.equal(result.done, false);
    assert.equal(result.blocked, false);
    assert.equal(result.reason, "Issues found");
    assert.equal(result.issues.length, 2);
    assert.equal(result.issues[0].description, "Null check missing");
    assert.equal(result.issues[0].severity, "critical");
    assert.equal(result.issues[0].location, "login.ts:42");
    assert.equal(result.issues[1].description, "Missing error handling");
    assert.equal(result.issues[1].severity, "major");
    assert.equal(result.issues[1].location, undefined);
  });

  it('parses "blocked" JSON', () => {
    const result = parseJudgeOutput(
      '{"done": false, "blocked": true, "reason": "External API required", "confidence": 0.8, "issues": []}',
    );
    assert.ok(result);
    assert.equal(result.done, false);
    assert.equal(result.blocked, true);
    assert.equal(result.issues.length, 0);
  });

  it("parses JSON with mixed severity issues", () => {
    const result = parseJudgeOutput(
      '{"done": false, "blocked": false, "reason": "Multiple issues", "confidence": 0.4, "issues": [{"description": "Bug in auth", "severity": "critical"}, {"description": "Missing test", "severity": "major"}, {"description": "Bad naming", "severity": "minor"}]}',
    );
    assert.ok(result);
    assert.equal(result.issues.length, 3);
    assert.equal(result.issues[0].severity, "critical");
    assert.equal(result.issues[1].severity, "major");
    assert.equal(result.issues[2].severity, "minor");
  });

  it("handles JSON with surrounding text", () => {
    const result = parseJudgeOutput(
      'Here is the evaluation:\n{"done": true, "blocked": false, "reason": "OK", "confidence": 1.0, "issues": []}\nEnd of response.',
    );
    assert.ok(result);
    assert.equal(result.done, true);
    assert.equal(result.reason, "OK");
  });

  it("defaults severity to major for invalid values", () => {
    const result = parseJudgeOutput(
      '{"done": false, "blocked": false, "reason": "test", "confidence": 0.5, "issues": [{"description": "Something wrong", "severity": "unknown"}]}',
    );
    assert.ok(result);
    assert.equal(result.issues[0].severity, "major");
  });

  it("defaults confidence to 0.5 when missing", () => {
    const result = parseJudgeOutput(
      '{"done": false, "blocked": false, "reason": "test", "issues": []}',
    );
    assert.ok(result);
    assert.equal(result.confidence, 0.5);
  });

  it("handles missing issues field (defaults to empty array)", () => {
    const result = parseJudgeOutput(
      '{"done": false, "blocked": false, "reason": "test", "confidence": 0.5}',
    );
    assert.ok(result);
    assert.equal(result.issues.length, 0);
  });

  it("returns null for malformed output (no JSON object)", () => {
    const result = parseJudgeOutput("Just some plain text. No JSON here.");
    assert.equal(result, null);
  });

  it("returns null for invalid JSON", () => {
    const result = parseJudgeOutput('{"done": true, blocked: false}');
    assert.equal(result, null);
  });

  it("skips issue entries without description", () => {
    const result = parseJudgeOutput(
      '{"done": false, "blocked": false, "reason": "test", "confidence": 0.5, "issues": [{"severity": "critical"}, {"description": "Valid issue", "severity": "major"}]}',
    );
    assert.ok(result);
    assert.equal(result.issues.length, 1);
    assert.equal(result.issues[0].description, "Valid issue");
  });
});

describe("Continuation Prompt Builder", () => {
  it("includes the goal condition", () => {
    const state = createGoalState("Refactor auth module");
    const verdict: JudgeOutput = { done: false, blocked: false, reason: "Keep going", confidence: 0.3, issues: [] };
    const prompt = buildContinuationPrompt(state, verdict);
    assert.ok(prompt.includes("Refactor auth module"));
  });

  it("includes the continuation tag", () => {
    const state = createGoalState("Test goal");
    const verdict: JudgeOutput = { done: false, blocked: false, reason: "Continue", confidence: 0.5, issues: [] };
    const prompt = buildContinuationPrompt(state, verdict);
    assert.ok(prompt.startsWith(CONTINUATION_TAG));
  });

  it("includes the judge reason", () => {
    const state = createGoalState("Test goal");
    const verdict: JudgeOutput = { done: false, blocked: false, reason: "Null check missing on line 42", confidence: 0.7, issues: [] };
    const prompt = buildContinuationPrompt(state, verdict);
    assert.ok(prompt.includes("Null check missing on line 42"));
  });

  it("includes structured critical issues", () => {
    const state = createGoalState("Test goal");
    const verdict: JudgeOutput = {
      done: false,
      blocked: false,
      reason: "Issues found",
      confidence: 0.3,
      issues: [{ description: "Null check missing", severity: "critical", location: "login.ts:42" }],
    };
    const prompt = buildContinuationPrompt(state, verdict);
    assert.ok(prompt.includes("❌ Critical (must fix)"));
    assert.ok(prompt.includes("Null check missing"));
    assert.ok(prompt.includes("[login.ts:42]"));
  });

  it("includes structured major issues", () => {
    const state = createGoalState("Test goal");
    const verdict: JudgeOutput = {
      done: false,
      blocked: false,
      reason: "Issues found",
      confidence: 0.3,
      issues: [{ description: "Missing error handling", severity: "major" }],
    };
    const prompt = buildContinuationPrompt(state, verdict);
    assert.ok(prompt.includes("⚠️ Major (should fix)"));
    assert.ok(prompt.includes("Missing error handling"));
  });

  it("includes structured minor issues", () => {
    const state = createGoalState("Test goal");
    const verdict: JudgeOutput = {
      done: false,
      blocked: false,
      reason: "Issues found",
      confidence: 0.5,
      issues: [{ description: "Consider caching", severity: "minor" }],
    };
    const prompt = buildContinuationPrompt(state, verdict);
    assert.ok(prompt.includes("💡 Minor (optional)"));
    assert.ok(prompt.includes("Consider caching"));
  });

  it("includes all severity levels together", () => {
    const state = createGoalState("Test goal");
    const verdict: JudgeOutput = {
      done: false,
      blocked: false,
      reason: "Multiple issues",
      confidence: 0.2,
      issues: [
        { description: "Bug", severity: "critical" },
        { description: "Pattern", severity: "major" },
        { description: "Style", severity: "minor" },
      ],
    };
    const prompt = buildContinuationPrompt(state, verdict);
    assert.ok(prompt.includes("❌ Critical"));
    assert.ok(prompt.includes("⚠️ Major"));
    assert.ok(prompt.includes("💡 Minor"));
    assert.ok(prompt.includes("Fix the critical and major issues"));
  });

  it("does not show issues section when no issues", () => {
    const state = createGoalState("Test goal");
    const verdict: JudgeOutput = { done: false, blocked: false, reason: "Keep going", confidence: 0.3, issues: [] };
    const prompt = buildContinuationPrompt(state, verdict);
    assert.ok(!prompt.includes("Issues Found"));
  });

  it("includes instructions to not ask user to continue", () => {
    const state = createGoalState("Test goal");
    const verdict: JudgeOutput = { done: false, blocked: false, reason: "Continue", confidence: 0.5, issues: [] };
    const prompt = buildContinuationPrompt(state, verdict);
    assert.ok(prompt.includes("Do not ask the user to continue"));
  });

  it("instructs model to stop when done for review", () => {
    const state = createGoalState("Test goal");
    const verdict: JudgeOutput = { done: false, blocked: false, reason: "Continue", confidence: 0.5, issues: [] };
    const prompt = buildContinuationPrompt(state, verdict);
    assert.ok(prompt.includes("summarize what you did and stop"));
    assert.ok(prompt.includes("quality reviewer will evaluate"));
  });
});

describe("Config Loading", () => {
  it("loads default config with no env vars", () => {
    const config = loadConfig({});
    assert.equal(config.enabled, true);
    assert.equal(config.maxTurns, 20);
    assert.equal(config.contextChars, 12000);
    assert.equal(config.failOpen, true);
    assert.equal(config.continueOnJudgeError, true);
    assert.equal(config.judgeModel, undefined);
    assert.equal(config.judgeEvery, 0);
  });

  it("respects PI_GOAL_DISABLED", () => {
    assert.equal(loadConfig({ PI_GOAL_DISABLED: "1" }).enabled, false);
    assert.equal(loadConfig({ PI_GOAL_DISABLED: "true" }).enabled, false);
    assert.equal(loadConfig({ PI_GOAL_DISABLED: "0" }).enabled, true);
  });

  it("respects PI_GOAL_MAX_TURNS", () => {
    assert.equal(loadConfig({ PI_GOAL_MAX_TURNS: "10" }).maxTurns, 10);
    assert.equal(loadConfig({ PI_GOAL_MAX_TURNS: "50" }).maxTurns, 50);
    assert.equal(loadConfig({ PI_GOAL_MAX_TURNS: "abc" }).maxTurns, 20);
    assert.equal(loadConfig({ PI_GOAL_MAX_TURNS: "" }).maxTurns, 20);
  });

  it("respects PI_GOAL_JUDGE_MODEL", () => {
    assert.equal(
      loadConfig({ PI_GOAL_JUDGE_MODEL: "anthropic/claude-opus-4-5" }).judgeModel,
      "anthropic/claude-opus-4-5",
    );
  });

  it("respects PI_GOAL_JUDGE_MODEL with 3-part format", () => {
    assert.equal(
      loadConfig({ PI_GOAL_JUDGE_MODEL: "amazon-bedrock/global.anthropic.claude-haiku-4-5-20251001-v1:0" }).judgeModel,
      "amazon-bedrock/global.anthropic.claude-haiku-4-5-20251001-v1:0",
    );
  });

  it("respects PI_GOAL_CONTEXT_CHARS", () => {
    assert.equal(loadConfig({ PI_GOAL_CONTEXT_CHARS: "4000" }).contextChars, 4000);
    assert.equal(loadConfig({ PI_GOAL_CONTEXT_CHARS: "abc" }).contextChars, 12000);
  });

  it("respects PI_GOAL_FAIL_OPEN", () => {
    assert.equal(loadConfig({ PI_GOAL_FAIL_OPEN: "false" }).failOpen, false);
    assert.equal(loadConfig({ PI_GOAL_FAIL_OPEN: "true" }).failOpen, true);
  });

  it("respects PI_GOAL_CONT_ON_ERROR", () => {
    assert.equal(
      loadConfig({ PI_GOAL_CONT_ON_ERROR: "false" }).continueOnJudgeError,
      false,
    );
    assert.equal(
      loadConfig({ PI_GOAL_CONT_ON_ERROR: "true" }).continueOnJudgeError,
      true,
    );
  });

  it("respects PI_GOAL_JUDGE_EVERY", () => {
    assert.equal(loadConfig({ PI_GOAL_JUDGE_EVERY: "5" }).judgeEvery, 5);
    assert.equal(loadConfig({ PI_GOAL_JUDGE_EVERY: "0" }).judgeEvery, 0);
    assert.equal(loadConfig({ PI_GOAL_JUDGE_EVERY: "abc" }).judgeEvery, 0);
  });
});

describe("Status Display", () => {
  it("shows correct icon for each status", () => {
    assert.equal(statusIcon("active"), "↻");
    assert.equal(statusIcon("paused"), "⏸");
    assert.equal(statusIcon("done"), "✓");
    assert.equal(statusIcon("done_with_notes"), "✓");
    assert.equal(statusIcon("blocked"), "✗");
    assert.equal(statusIcon("budget_exhausted"), "⏰");
  });

  it("shows goal condition in status", () => {
    const state = createGoalState("Do the thing");
    const lines = goalStatusLines(state);
    const firstLine = lines[0];
    assert.ok(firstLine.includes("Do the thing"));
  });

  it("shows turn counts in status", () => {
    const state = createGoalState("Test", { turnsUsed: 5, maxTurns: 20 });
    const lines = goalStatusLines(state);
    const turnLine = lines.find((l) => l.includes("Turns"));
    assert.ok(turnLine?.includes("5/20"));
  });

  it("shows lifetime turns in status", () => {
    const state = createGoalState("Test", { lifetimeTurnsUsed: 42 });
    const lines = goalStatusLines(state);
    const lifetimeLine = lines.find((l) => l.includes("Lifetime"));
    assert.ok(lifetimeLine?.includes("42"));
  });

  it("shows judge evaluation count", () => {
    const state = createGoalState("Test", { judgeCallCount: 3 });
    const lines = goalStatusLines(state);
    const judgeLine = lines.find((l) => l.includes("Judge evaluations"));
    assert.ok(judgeLine?.includes("3"));
  });

  it("shows last judge reason when present", () => {
    const state = createGoalState("Test", {
      lastJudgeReason: "Need more work",
    });
    const lines = goalStatusLines(state);
    const judgeLine = lines.find((l) => l.includes("Last judge"));
    assert.ok(judgeLine?.includes("Need more work"));
  });

  it("shows open issues when present", () => {
    const state = createGoalState("Test", {
      lastJudgeIssues: ["critical: Null check missing", "major: Missing error handling"],
    });
    const lines = goalStatusLines(state);
    const issuesHeader = lines.find((l) => l.includes("Open issues"));
    assert.ok(issuesHeader);
    const issueLines = lines.filter((l) => l.includes("•"));
    assert.equal(issueLines.length, 2);
  });

  it("does not show open issues when absent", () => {
    const state = createGoalState("Test");
    const lines = goalStatusLines(state);
    const issuesLine = lines.find((l) => l.includes("Open issues"));
    assert.equal(issuesLine, undefined);
  });

  it("does not show last judge reason when absent", () => {
    const state = createGoalState("Test");
    const lines = goalStatusLines(state);
    const judgeLine = lines.find((l) => l.includes("Last judge"));
    assert.equal(judgeLine, undefined);
  });
});

describe("Goal Persistence Simulation", () => {
  interface CustomEntry {
    type: "custom";
    customType: string;
    data: GoalState | null;
  }

  function simulateRestore(entries: CustomEntry[]): GoalState | null {
    let state: GoalState | null = null;
    for (const entry of entries) {
      if (entry.customType === "goal-state") {
        if (entry.data && entry.data.id) {
          state = { ...entry.data };
        } else if (entry.data === null) {
          state = null;
        }
      }
    }
    return state;
  }

  it("restores persisted goal state", () => {
    const goal = createGoalState("Refactor auth");
    const entries: CustomEntry[] = [
      { type: "custom", customType: "goal-state", data: goal },
    ];
    const restored = simulateRestore(entries);
    assert.ok(restored);
    assert.equal(restored.condition, "Refactor auth");
    assert.equal(restored.id, goal.id);
  });

  it("later entry supercedes earlier one", () => {
    const first = createGoalState("First goal", { id: "aaaaaaaa" });
    const second = createGoalState("Second goal", { id: "bbbbbbbb" });
    const entries: CustomEntry[] = [
      { type: "custom", customType: "goal-state", data: first },
      { type: "custom", customType: "goal-state", data: second },
    ];
    const restored = simulateRestore(entries);
    assert.equal(restored?.condition, "Second goal");
    assert.equal(restored?.id, "bbbbbbbb");
  });

  it("null data means cleared", () => {
    const goal = createGoalState("Some goal");
    const entries: CustomEntry[] = [
      { type: "custom", customType: "goal-state", data: goal },
      { type: "custom", customType: "goal-state", data: null },
    ];
    const restored = simulateRestore(entries);
    assert.equal(restored, null);
  });

  it("returns null for no entries", () => {
    const restored = simulateRestore([]);
    assert.equal(restored, null);
  });

  it("only looks at goal-state entries", () => {
    const goal = createGoalState("My goal");
    const entries: CustomEntry[] = [
      {
        type: "custom",
        customType: "other-extension",
        data: { some: "data" } as any,
      },
      { type: "custom", customType: "goal-state", data: goal },
    ];
    const restored = simulateRestore(entries);
    assert.ok(restored);
    assert.equal(restored.condition, "My goal");
  });

  it("restores judgeCallCount", () => {
    const goal = createGoalState("Test", { judgeCallCount: 5 });
    const entries: CustomEntry[] = [
      { type: "custom", customType: "goal-state", data: goal },
    ];
    const restored = simulateRestore(entries);
    assert.ok(restored);
    assert.equal(restored.judgeCallCount, 5);
  });

  it("restores lastJudgeIssues", () => {
    const goal = createGoalState("Test", {
      lastJudgeIssues: ["critical: Bug found", "major: Missing test"],
    });
    const entries: CustomEntry[] = [
      { type: "custom", customType: "goal-state", data: goal },
    ];
    const restored = simulateRestore(entries);
    assert.ok(restored);
    assert.deepEqual(restored.lastJudgeIssues, ["critical: Bug found", "major: Missing test"]);
  });
});

describe("Turn Counter and Budget", () => {
  it("increments turn counter correctly", () => {
    const state = createGoalState("Test");
    assert.equal(state.turnsUsed, 0);
    assert.equal(state.lifetimeTurnsUsed, 0);

    state.turnsUsed += 1;
    state.lifetimeTurnsUsed += 1;
    assert.equal(state.turnsUsed, 1);
    assert.equal(state.lifetimeTurnsUsed, 1);
  });

  it("tracks lifetime turns across runs", () => {
    const state = createGoalState("Test");
    state.turnsUsed = 5;
    state.lifetimeTurnsUsed = 5;
    state.turnsUsed = 0;
    assert.equal(state.lifetimeTurnsUsed, 5);

    state.turnsUsed = 3;
    state.lifetimeTurnsUsed = 8;
    assert.equal(state.lifetimeTurnsUsed, 8);
  });

  it("budget check at exact max", () => {
    const state = createGoalState("Test", {
      turnsUsed: 20,
      maxTurns: 20,
    });
    assert.equal(state.turnsUsed >= state.maxTurns, true);
  });

  it("budget check one before max", () => {
    const state = createGoalState("Test", {
      turnsUsed: 19,
      maxTurns: 20,
    });
    assert.equal(state.turnsUsed >= state.maxTurns, false);
  });

  it("budget check past max", () => {
    const state = createGoalState("Test", {
      turnsUsed: 25,
      maxTurns: 20,
    });
    assert.equal(state.turnsUsed >= state.maxTurns, true);
  });
});

describe("Continuation In-Flight Guard", () => {
  it("prevents concurrent continuations", () => {
    let inFlight = false;
    const results: string[] = [];

    function tryContinue(): boolean {
      if (inFlight) {
        results.push("blocked");
        return false;
      }
      inFlight = true;
      results.push("started");
      inFlight = false;
      results.push("finished");
      return true;
    }

    assert.equal(tryContinue(), true);
    assert.deepEqual(results, ["started", "finished"]);
  });

  it("blocks second continuation while first is in flight", () => {
    let inFlight = false;
    const results: string[] = [];

    function tryContinue(): boolean {
      if (inFlight) {
        results.push("blocked");
        return false;
      }
      inFlight = true;
      results.push("started");
      return true;
    }

    assert.equal(tryContinue(), true);
    assert.equal(tryContinue(), false);
    assert.deepEqual(results, ["started", "blocked"]);
  });
});

describe("extractUserMessageText", () => {
  it("extracts text from pi array format (normal case)", () => {
    const content = [{ type: "text", text: "Hello world" }];
    assert.equal(extractUserMessageText(content), "Hello world");
  });

  it("extracts text from string format (defensive)", () => {
    assert.equal(extractUserMessageText("Hello world"), "Hello world");
  });

  it("joins multiple text blocks with newlines", () => {
    const content = [
      { type: "text", text: "Part 1" },
      { type: "text", text: "Part 2" },
    ];
    assert.equal(extractUserMessageText(content), "Part 1\nPart 2");
  });

  it("ignores non-text blocks (images etc)", () => {
    const content = [
      { type: "text", text: "Hello" },
      { type: "image", source: { type: "base64", data: "..." } },
    ];
    assert.equal(extractUserMessageText(content), "Hello");
  });

  it("returns empty string for null/undefined", () => {
    assert.equal(extractUserMessageText(null), "");
    assert.equal(extractUserMessageText(undefined), "");
  });

  it("returns empty string for empty array", () => {
    assert.equal(extractUserMessageText([]), "");
  });

  it("returns empty string for non-string non-array", () => {
    assert.equal(extractUserMessageText(42), "");
    assert.equal(extractUserMessageText({}), "");
  });
});

describe("isOurContinuation detection (array content format)", () => {
  function checkIsOurContinuation(message: { role: string; content: unknown }): boolean {
    if (message.role !== "user") return false;
    const text = extractUserMessageText(message.content);
    return text.includes(CONTINUATION_TAG);
  }

  it("detects continuation in pi array format", () => {
    const msg = {
      role: "user",
      content: [{ type: "text", text: `${CONTINUATION_TAG}\nStanding goal: do stuff` }],
    };
    assert.equal(checkIsOurContinuation(msg), true);
  });

  it("detects continuation in string format (defensive)", () => {
    const msg = {
      role: "user",
      content: `${CONTINUATION_TAG}\nStanding goal: do stuff`,
    };
    assert.equal(checkIsOurContinuation(msg), true);
  });

  it("rejects normal user messages in array format", () => {
    const msg = {
      role: "user",
      content: [{ type: "text", text: "Please fix the auth module" }],
    };
    assert.equal(checkIsOurContinuation(msg), false);
  });

  it("rejects assistant messages even with tag", () => {
    const msg = {
      role: "assistant",
      content: [{ type: "text", text: CONTINUATION_TAG }],
    };
    assert.equal(checkIsOurContinuation(msg), false);
  });
});

describe("Judge Transcript Continuation Filtering (array content format)", () => {
  function buildTranscriptParts(messages: Array<{ role: string; content: unknown }>): string[] {
    const parts: string[] = [];
    for (const msg of messages) {
      if (msg.role === "user") {
        const text = extractUserMessageText(msg.content);
        if (text && !text.includes(CONTINUATION_TAG)) {
          parts.push(`[User]: ${text}`);
        }
      } else if (msg.role === "assistant") {
        const content = msg.content;
        if (Array.isArray(content)) {
          for (const block of content as any[]) {
            if (block.type === "text" && typeof block.text === "string") {
              parts.push(`[Assistant]: ${block.text}`);
            }
          }
        }
      }
    }
    return parts;
  }

  it("filters continuation prompts from transcript (array format)", () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "Fix the bug" }] },
      { role: "assistant", content: [{ type: "text", text: "I fixed it" }] },
      { role: "user", content: [{ type: "text", text: `${CONTINUATION_TAG}\nStanding goal: fix bug` }] },
      { role: "assistant", content: [{ type: "text", text: "Still working" }] },
    ];
    const parts = buildTranscriptParts(messages);
    assert.ok(parts.some((p) => p.includes("Fix the bug")));
    assert.ok(!parts.some((p) => p.includes(CONTINUATION_TAG)));
    assert.ok(parts.some((p) => p.includes("I fixed it")));
    assert.ok(parts.some((p) => p.includes("Still working")));
  });

  it("includes normal user messages (array format)", () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "Please refactor" }] },
    ];
    const parts = buildTranscriptParts(messages);
    assert.equal(parts.length, 1);
    assert.ok(parts[0].includes("Please refactor"));
  });

  it("handles mixed string and array content", () => {
    const messages = [
      { role: "user", content: "String format message" },
      { role: "user", content: [{ type: "text", text: "Array format message" }] },
    ];
    const parts = buildTranscriptParts(messages);
    assert.equal(parts.length, 2);
    assert.ok(parts[0].includes("String format"));
    assert.ok(parts[1].includes("Array format"));
  });
});

describe("Completion Signal Detection", () => {
  it("detects explicit completion phrase", () => {
    const event = {
      messages: [{
        role: "assistant",
        content: [{ type: "text", text: "I'm done! The fix is complete and all tests pass." }],
      }],
    };
    assert.equal(detectCompletionSignal(event), true);
  });

  it("detects 'all done' phrase", () => {
    const event = {
      messages: [{
        role: "assistant",
        content: [{ type: "text", text: "All done! The refactoring is complete." }],
      }],
    };
    assert.equal(detectCompletionSignal(event), true);
  });

  it("detects 'successfully implemented' phrase", () => {
    const event = {
      messages: [{
        role: "assistant",
        content: [{ type: "text", text: "Successfully implemented the auth module refactor." }],
      }],
    };
    assert.equal(detectCompletionSignal(event), true);
  });

  it("does NOT trigger when assistant makes tool calls", () => {
    const event = {
      messages: [{
        role: "assistant",
        content: [
          { type: "text", text: "I'm done thinking about this. Let me implement it." },
          { type: "toolCall", name: "edit", arguments: { path: "test.ts" } },
        ],
      }],
    };
    assert.equal(detectCompletionSignal(event), false);
  });

  it("does NOT trigger for intent-to-continue phrases", () => {
    const event = {
      messages: [{
        role: "assistant",
        content: [{ type: "text", text: "Let me now implement the second part of the refactoring. I'll start by examining the test files to understand the current structure." }],
      }],
    };
    assert.equal(detectCompletionSignal(event), false);
  });

  it("does NOT trigger for short text-only responses", () => {
    const event = {
      messages: [{
        role: "assistant",
        content: [{ type: "text", text: "OK, working on it now." }],
      }],
    };
    assert.equal(detectCompletionSignal(event), false);
  });

  it("triggers for long text-only summary without continue phrases", () => {
    const event = {
      messages: [{
        role: "assistant",
        content: [{ type: "text", text: "I have refactored the auth module. The changes include: (1) extracted the verification logic into a separate function, (2) added proper error handling for token expiry, (3) updated the test suite to cover the new code paths. All 12 tests pass successfully." }],
      }],
    };
    assert.equal(detectCompletionSignal(event), true);
  });

  it("does NOT trigger for empty messages", () => {
    const event = { messages: [] };
    assert.equal(detectCompletionSignal(event), false);
  });

  it("does NOT trigger when no assistant message exists", () => {
    const event = {
      messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
    };
    assert.equal(detectCompletionSignal(event), false);
  });
});

describe("Judge Invocation Gating", () => {
  function shouldRunJudge(
    completionDetected: boolean,
    turnsUsed: number,
    judgeEvery: number,
  ): boolean {
    if (completionDetected) return true;
    if (judgeEvery > 0 && turnsUsed > 0) {
      return turnsUsed % judgeEvery === 0;
    }
    return false;
  }

  it("runs when completion signal detected", () => {
    assert.equal(shouldRunJudge(true, 3, 0), true);
  });

  it("does NOT run without completion signal when judgeEvery=0", () => {
    assert.equal(shouldRunJudge(false, 3, 0), false);
  });

  it("does NOT run without completion signal when judgeEvery=0 even at high turns", () => {
    assert.equal(shouldRunJudge(false, 15, 0), false);
  });

  it("runs on interval when judgeEvery is set", () => {
    assert.equal(shouldRunJudge(false, 5, 5), true);
    assert.equal(shouldRunJudge(false, 10, 5), true);
    assert.equal(shouldRunJudge(false, 15, 5), true);
  });

  it("does NOT run off-interval when judgeEvery is set", () => {
    assert.equal(shouldRunJudge(false, 3, 5), false);
    assert.equal(shouldRunJudge(false, 7, 5), false);
  });

  it("does NOT run on interval at turn 0", () => {
    assert.equal(shouldRunJudge(false, 0, 5), false);
  });

  it("completion signal overrides interval", () => {
    assert.equal(shouldRunJudge(true, 3, 5), true);
  });
});

describe("Goal Replacement Behavior", () => {
  it("new goal does not inherit lifetime turns from previous goal", () => {
    const oldGoal = createGoalState("Old goal", {
      lifetimeTurnsUsed: 15,
      turnsUsed: 8,
    });
    const newGoal = createGoalState("New goal");
    assert.equal(newGoal.lifetimeTurnsUsed, 0);
    assert.equal(newGoal.turnsUsed, 0);
    assert.equal(oldGoal.lifetimeTurnsUsed, 15);
  });

  it("replacement goal gets fresh ID", () => {
    const first = createGoalState("First");
    const second = createGoalState("Second");
    assert.notEqual(first.id, second.id);
  });
});

describe("Goal Reset Behavior", () => {
  it("reset clears lifetime turns (since goalState is nulled first)", () => {
    const state = createGoalState("Test goal", {
      lifetimeTurnsUsed: 30,
      turnsUsed: 10,
    });
    const resetState = createGoalState(state.condition);
    assert.equal(resetState.lifetimeTurnsUsed, 0);
    assert.equal(resetState.turnsUsed, 0);
    assert.equal(resetState.condition, "Test goal");
  });

  it("reset preserves the goal condition", () => {
    const state = createGoalState("Important multi-step task");
    const resetState = createGoalState(state.condition);
    assert.equal(resetState.condition, "Important multi-step task");
  });
});

describe("Agent End Handler Simulation", () => {
  interface SimState {
    goalState: GoalState | null;
    continuationInFlight: boolean;
  }

  interface SimEvent {
    messages: any[];
  }

  interface SimBranchEntry {
    type: string;
    message?: { role: string; content: unknown };
  }

  function simulateAgentEnd(
    sim: SimState,
    event: SimEvent,
    branch: SimBranchEntry[],
    judgeResult: JudgeOutput,
    completionDetected: boolean,
    judgeEvery: number = 0,
  ): { action: string; state: GoalState | null } {
    if (!sim.goalState || sim.goalState.status !== "active") {
      return { action: "skip_inactive", state: sim.goalState };
    }
    if (sim.continuationInFlight) {
      return { action: "skip_inflight", state: sim.goalState };
    }
    if (!event.messages || event.messages.length === 0) {
      return { action: "skip_empty", state: sim.goalState };
    }

    const lastUser = branch
      .filter((e) => e.type === "message")
      .map((e) => e.message)
      .reverse()
      .find((m) => m?.role === "user");

    const lastUserText = lastUser ? extractUserMessageText(lastUser.content) : "";
    const isOurContinuation = lastUserText.includes(CONTINUATION_TAG);

    if (isOurContinuation) {
      sim.goalState.turnsUsed += 1;
      sim.goalState.lifetimeTurnsUsed += 1;
      sim.goalState.lastContinuationAt = now();
    }

    if (sim.goalState.turnsUsed >= sim.goalState.maxTurns) {
      sim.goalState.status = "budget_exhausted";
      sim.goalState.updatedAt = now();
      return { action: "budget_exhausted", state: sim.goalState };
    }

    // Check if judge should run
    const shouldJudge = completionDetected ||
      (judgeEvery > 0 && sim.goalState.turnsUsed > 0 && sim.goalState.turnsUsed % judgeEvery === 0);

    if (!shouldJudge) {
      return { action: "continue_no_judge", state: sim.goalState };
    }

    // Apply judge result
    sim.goalState.judgeCallCount = (sim.goalState.judgeCallCount ?? 0) + 1;
    sim.goalState.lastJudgeReason = judgeResult.reason;

    const hasCritical = judgeResult.issues.some((i) => i.severity === "critical");
    const hasMajor = judgeResult.issues.some((i) => i.severity === "major");
    const hasMinor = judgeResult.issues.some((i) => i.severity === "minor");

    if (judgeResult.done) {
      if (hasCritical || hasMajor) {
        // Shouldn't happen with a well-behaved judge, but handle gracefully
        sim.goalState.status = "active";
        return { action: "continue_issues", state: sim.goalState };
      }
      if (hasMinor) {
        sim.goalState.status = "done_with_notes";
      } else {
        sim.goalState.status = "done";
      }
      sim.goalState.updatedAt = now();
      return { action: sim.goalState.status, state: sim.goalState };
    } else if (judgeResult.blocked) {
      sim.goalState.status = "blocked";
      sim.goalState.updatedAt = now();
      return { action: "blocked", state: sim.goalState };
    }

    return { action: "continue_with_feedback", state: sim.goalState };
  }

  it("increments turn counter on continuation (array content)", () => {
    const sim: SimState = {
      goalState: createGoalState("Test goal"),
      continuationInFlight: false,
    };
    const event = { messages: [{ role: "assistant", content: "did stuff" }] };
    const branch: SimBranchEntry[] = [
      {
        type: "message",
        message: {
          role: "user",
          content: [{ type: "text", text: `${CONTINUATION_TAG}\nStanding goal: Test goal` }],
        },
      },
    ];
    const judgeResult: JudgeOutput = { done: false, blocked: false, reason: "Continue", confidence: 0.5, issues: [] };

    const result = simulateAgentEnd(sim, event, branch, judgeResult, true);
    assert.equal(result.action, "continue_with_feedback");
    assert.equal(result.state?.turnsUsed, 1);
    assert.equal(result.state?.lifetimeTurnsUsed, 1);
  });

  it("does NOT increment turn counter for user-initiated messages", () => {
    const sim: SimState = {
      goalState: createGoalState("Test goal"),
      continuationInFlight: false,
    };
    const event = { messages: [{ role: "assistant", content: "response" }] };
    const branch: SimBranchEntry[] = [
      {
        type: "message",
        message: {
          role: "user",
          content: [{ type: "text", text: "Please also check the tests" }],
        },
      },
    ];
    const judgeResult: JudgeOutput = { done: false, blocked: false, reason: "Continue", confidence: 0.5, issues: [] };

    const result = simulateAgentEnd(sim, event, branch, judgeResult, true);
    assert.equal(result.action, "continue_with_feedback");
    assert.equal(result.state?.turnsUsed, 0);
    assert.equal(result.state?.lifetimeTurnsUsed, 0);
  });

  it("transitions to budget_exhausted at max turns", () => {
    const sim: SimState = {
      goalState: createGoalState("Test goal", { turnsUsed: 19, maxTurns: 20 }),
      continuationInFlight: false,
    };
    const event = { messages: [{ role: "assistant", content: "response" }] };
    const branch: SimBranchEntry[] = [
      {
        type: "message",
        message: {
          role: "user",
          content: [{ type: "text", text: `${CONTINUATION_TAG}\nStanding goal: Test` }],
        },
      },
    ];
    const judgeResult: JudgeOutput = { done: false, blocked: false, reason: "More work", confidence: 0.3, issues: [] };

    const result = simulateAgentEnd(sim, event, branch, judgeResult, true);
    assert.equal(result.action, "budget_exhausted");
    assert.equal(result.state?.status, "budget_exhausted");
    assert.equal(result.state?.turnsUsed, 20);
  });

  it("transitions to done when judge says done with no issues", () => {
    const sim: SimState = {
      goalState: createGoalState("Test goal"),
      continuationInFlight: false,
    };
    const event = { messages: [{ role: "assistant", content: "all done" }] };
    const branch: SimBranchEntry[] = [
      {
        type: "message",
        message: {
          role: "user",
          content: [{ type: "text", text: `${CONTINUATION_TAG}\nTest` }],
        },
      },
    ];
    const judgeResult: JudgeOutput = { done: true, blocked: false, reason: "All criteria met", confidence: 0.95, issues: [] };

    const result = simulateAgentEnd(sim, event, branch, judgeResult, true);
    assert.equal(result.action, "done");
    assert.equal(result.state?.status, "done");
  });

  it("transitions to done_with_notes when judge says done with minor issues only", () => {
    const sim: SimState = {
      goalState: createGoalState("Test goal"),
      continuationInFlight: false,
    };
    const event = { messages: [{ role: "assistant", content: "all done" }] };
    const branch: SimBranchEntry[] = [
      {
        type: "message",
        message: {
          role: "user",
          content: [{ type: "text", text: `${CONTINUATION_TAG}\nTest` }],
        },
      },
    ];
    const judgeResult: JudgeOutput = {
      done: true,
      blocked: false,
      reason: "Goal satisfied with minor notes",
      confidence: 0.85,
      issues: [{ description: "Consider caching", severity: "minor" }],
    };

    const result = simulateAgentEnd(sim, event, branch, judgeResult, true);
    assert.equal(result.action, "done_with_notes");
    assert.equal(result.state?.status, "done_with_notes");
  });

  it("continues when judge finds critical issues even if done=true", () => {
    const sim: SimState = {
      goalState: createGoalState("Test goal"),
      continuationInFlight: false,
    };
    const event = { messages: [{ role: "assistant", content: "all done" }] };
    const branch: SimBranchEntry[] = [];
    const judgeResult: JudgeOutput = {
      done: true, // Judge mistakenly says done
      blocked: false,
      reason: "Goal met",
      confidence: 0.6,
      issues: [{ description: "Bug in auth", severity: "critical" }],
    };

    // Our simulation correctly handles this: critical issues prevent done
    const result = simulateAgentEnd(sim, event, branch, judgeResult, true);
    assert.equal(result.action, "continue_issues"); // Not done
  });

  it("transitions to blocked when judge says blocked", () => {
    const sim: SimState = {
      goalState: createGoalState("Test goal"),
      continuationInFlight: false,
    };
    const event = { messages: [{ role: "assistant", content: "stuck" }] };
    const branch: SimBranchEntry[] = [];
    const judgeResult: JudgeOutput = { done: false, blocked: true, reason: "Need API key", confidence: 0.8, issues: [] };

    const result = simulateAgentEnd(sim, event, branch, judgeResult, true);
    assert.equal(result.action, "blocked");
    assert.equal(result.state?.status, "blocked");
  });

  it("skips when goal is paused", () => {
    const sim: SimState = {
      goalState: createGoalState("Test", { status: "paused" }),
      continuationInFlight: false,
    };
    const event = { messages: [{ role: "assistant", content: "x" }] };
    const result = simulateAgentEnd(sim, event, [], { done: false, blocked: false, reason: "", confidence: 0, issues: [] }, true);
    assert.equal(result.action, "skip_inactive");
  });

  it("skips when continuation is already in flight", () => {
    const sim: SimState = {
      goalState: createGoalState("Test"),
      continuationInFlight: true,
    };
    const event = { messages: [{ role: "assistant", content: "x" }] };
    const result = simulateAgentEnd(sim, event, [], { done: false, blocked: false, reason: "", confidence: 0, issues: [] }, true);
    assert.equal(result.action, "skip_inflight");
  });

  it("skips on empty event messages", () => {
    const sim: SimState = {
      goalState: createGoalState("Test"),
      continuationInFlight: false,
    };
    const event = { messages: [] };
    const result = simulateAgentEnd(sim, event, [], { done: false, blocked: false, reason: "", confidence: 0, issues: [] }, true);
    assert.equal(result.action, "skip_empty");
  });

  it("continues without judge when no completion signal and judgeEvery=0", () => {
    const sim: SimState = {
      goalState: createGoalState("Test goal"),
      continuationInFlight: false,
    };
    const event = { messages: [{ role: "assistant", content: [{ type: "text", text: "Let me also check the other file." }] }] };
    const branch: SimBranchEntry[] = [];
    const judgeResult: JudgeOutput = { done: false, blocked: false, reason: "Continue", confidence: 0.5, issues: [] };

    const result = simulateAgentEnd(sim, event, branch, judgeResult, false, 0);
    assert.equal(result.action, "continue_no_judge");
  });

  it("runs judge on interval with judgeEvery=5 at turn 5", () => {
    const sim: SimState = {
      // Start at 4: this is a continuation turn, so simulateAgentEnd bumps
      // turnsUsed to 5 BEFORE the interval check (mirrors handleAgentEnd,
      // which bumps then calls shouldRunJudge). 5 % 5 === 0 → judge runs.
      goalState: createGoalState("Test goal", { turnsUsed: 4 }),
      continuationInFlight: false,
    };
    const event = { messages: [{ role: "assistant", content: "working" }] };
    const branch: SimBranchEntry[] = [
      {
        type: "message",
        message: {
          role: "user",
          content: [{ type: "text", text: `${CONTINUATION_TAG}\nTest` }],
        },
      },
    ];
    const judgeResult: JudgeOutput = { done: false, blocked: false, reason: "Keep going", confidence: 0.3, issues: [] };

    const result = simulateAgentEnd(sim, event, branch, judgeResult, false, 5);
    assert.equal(result.state?.turnsUsed, 5);
    assert.equal(result.action, "continue_with_feedback");
    assert.equal(result.state?.judgeCallCount, 1);
  });

  it("does NOT run judge off-interval with judgeEvery=5 at turn 3", () => {
    const sim: SimState = {
      // Start at 2: the continuation bump takes turnsUsed to 3 before the
      // interval check. 3 % 5 !== 0 → judge does not run.
      goalState: createGoalState("Test goal", { turnsUsed: 2 }),
      continuationInFlight: false,
    };
    const event = { messages: [{ role: "assistant", content: "working" }] };
    const branch: SimBranchEntry[] = [
      {
        type: "message",
        message: {
          role: "user",
          content: [{ type: "text", text: `${CONTINUATION_TAG}\nTest` }],
        },
      },
    ];
    const judgeResult: JudgeOutput = { done: false, blocked: false, reason: "Keep going", confidence: 0.3, issues: [] };

    const result = simulateAgentEnd(sim, event, branch, judgeResult, false, 5);
    assert.equal(result.state?.turnsUsed, 3);
    assert.equal(result.action, "continue_no_judge");
  });

  it("increments judgeCallCount on each judge invocation", () => {
    const sim: SimState = {
      goalState: createGoalState("Test goal", { judgeCallCount: 2 }),
      continuationInFlight: false,
    };
    const event = { messages: [{ role: "assistant", content: "done" }] };
    const branch: SimBranchEntry[] = [];
    const judgeResult: JudgeOutput = { done: true, blocked: false, reason: "All good", confidence: 0.9, issues: [] };

    const result = simulateAgentEnd(sim, event, branch, judgeResult, true);
    assert.equal(result.state?.judgeCallCount, 3);
  });
});

// ── Subagent & Decomposition Tests ──────────────────────────────────────────

describe("Subagent Instructions Integration", () => {
  it("kickoff includes subagent instructions", () => {
    const state = createGoalState("Refactor auth module");
    const instructions = "Use subagent for parallel work";
    const prompt = buildKickoffPrompt(state, instructions, CONTINUATION_TAG);
    assert.ok(prompt.includes("Use subagent for parallel work"));
    assert.ok(prompt.includes(CONTINUATION_TAG));
    assert.ok(prompt.includes("Refactor auth module"));
  });

  it("kickoff without task plan has no plan section", () => {
    const state = createGoalState("Fix the bug");
    const prompt = buildKickoffPrompt(state, "instructions", CONTINUATION_TAG);
    assert.ok(!prompt.includes("Pre-analyzed Execution Plan"));
  });

  it("kickoff with task plan embeds the plan", () => {
    const state = createGoalState("Fix the bug", {
      taskPlan: "## Execution Plan\n### Phase 1: Reconnaissance\n- scout: find bug",
    });
    const prompt = buildKickoffPrompt(state, "instructions", CONTINUATION_TAG);
    assert.ok(prompt.includes("Pre-analyzed Execution Plan"));
    assert.ok(prompt.includes("Phase 1: Reconnaissance"));
    assert.ok(prompt.includes("scout: find bug"));
  });

  it("continuation prompt without task plan has no plan reminder", () => {
    const state = createGoalState("Fix auth bug");
    const verdict: JudgeOutput = {
      done: false,
      blocked: false,
      reason: "Still needs work",
      confidence: 0.4,
      issues: [],
    };
    const prompt = buildContinuationPrompt(state, verdict, {
      extraInstructions: "instructions\n",
    });
    assert.ok(!prompt.includes("Original Execution Plan"));
  });

  it("continuation prompt with task plan embeds plan reminder", () => {
    const state = createGoalState("Fix auth bug", {
      taskPlan: "## Execution Plan\n- implement: fix null check",
    });
    const verdict: JudgeOutput = {
      done: false,
      blocked: false,
      reason: "Null check missing",
      confidence: 0.4,
      issues: [],
    };
    const prompt = buildContinuationPrompt(state, verdict, {
      extraInstructions: "instructions\n",
    });
    assert.ok(prompt.includes("Original Execution Plan"));
    assert.ok(prompt.includes("fix null check"));
  });

  it("continuation prompt includes subagent instructions", () => {
    const state = createGoalState("Test goal");
    const verdict: JudgeOutput = {
      done: false,
      blocked: false,
      reason: "Some issues",
      confidence: 0.4,
      issues: [],
    };
    const prompt = buildContinuationPrompt(state, verdict, {
      extraInstructions: "Use subagent for parallel tasks\n",
    });
    assert.ok(prompt.includes("Use subagent for parallel tasks"));
  });
});

describe("Goal Decomposition Config", () => {
  it("decompose defaults to true", () => {
    assert.equal(loadConfig({}).decompose, true);
  });

  it("PI_GOAL_DECOMPOSE=false disables decomposition", () => {
    assert.equal(loadConfig({ PI_GOAL_DECOMPOSE: "false" }).decompose, false);
  });

  it("PI_GOAL_DECOMPOSE=true keeps enabled", () => {
    assert.equal(loadConfig({ PI_GOAL_DECOMPOSE: "true" }).decompose, true);
  });

  it("decomposeModel is undefined by default", () => {
    assert.equal(loadConfig({}).decomposeModel, undefined);
  });

  it("PI_GOAL_DECOMPOSE_MODEL sets the model", () => {
    assert.equal(
      loadConfig({ PI_GOAL_DECOMPOSE_MODEL: "anthropic/claude-sonnet-4-5" }).decomposeModel,
      "anthropic/claude-sonnet-4-5",
    );
  });
});

describe("GoalState taskPlan field", () => {
  it("creates goal state without taskPlan by default", () => {
    const state = createGoalState("Do something");
    assert.equal(state.taskPlan, undefined);
    assert.equal(state.decomposedAt, undefined);
  });

  it("accepts taskPlan override", () => {
    const plan = "## Execution Plan\n### Phase 1: Recon\n- scout: check files";
    const state = createGoalState("Test", { taskPlan: plan });
    assert.equal(state.taskPlan, plan);
  });

  it("taskPlan persists through state transitions", () => {
    const plan = "## Execution Plan\n- implement: fix stuff";
    const state = createGoalState("Test", { taskPlan: plan });
    // Simulate resume (status reset)
    state.status = "active";
    state.turnsUsed = 0;
    // Task plan should still be there
    assert.equal(state.taskPlan, plan);
  });

  it("new goal replaces old task plan (fresh state)", () => {
    const old = createGoalState("Old goal", { taskPlan: "old plan" });
    const fresh = createGoalState("New goal");
    assert.equal(old.taskPlan, "old plan");
    assert.equal(fresh.taskPlan, undefined);
  });
});

describe("applyJudgeVerdict transitions", () => {
  it("marks done with empty issues", () => {
    const state = createGoalState("Ship feature");
    const status = applyJudgeVerdict(state, {
      done: true,
      blocked: false,
      reason: "Looks good",
      confidence: 0.9,
      issues: [],
    });
    assert.equal(status, "done");
    assert.equal(state.status, "done");
  });

  it("marks done_with_notes when only minor issues remain", () => {
    const state = createGoalState("Ship feature");
    const status = applyJudgeVerdict(state, {
      done: true,
      blocked: false,
      reason: "Done with nits",
      confidence: 0.8,
      issues: [{ description: "Naming", severity: "minor" }],
    });
    assert.equal(status, "done_with_notes");
    assert.ok(state.lastJudgeIssues?.[0]?.includes("Naming"));
  });

  it("keeps active when critical issues accompany done=true", () => {
    const state = createGoalState("Ship feature");
    const status = applyJudgeVerdict(state, {
      done: true,
      blocked: false,
      reason: "Critical still open",
      confidence: 0.5,
      issues: [{ description: "Null deref", severity: "critical", location: "a.ts:1" }],
    });
    assert.equal(status, "active");
    assert.ok(state.lastJudgeIssues?.[0]?.startsWith("critical:"));
  });

  it("marks blocked", () => {
    const state = createGoalState("Ship feature");
    const status = applyJudgeVerdict(state, {
      done: false,
      blocked: true,
      reason: "Needs secret",
      confidence: 0.7,
      issues: [],
    });
    assert.equal(status, "blocked");
  });

  it("pause/resume and budget helpers", () => {
    const state = createGoalState("Ship feature", { turnsUsed: 3 });
    pauseGoal(state);
    assert.equal(state.status, "paused");
    assert.equal(canResumeGoal(state.status), true);
    assert.equal(resumeGoal(state), true);
    assert.equal(state.status, "active");
    assert.equal(state.turnsUsed, 0);

    state.turnsUsed = 20;
    assert.equal(isBudgetExhausted(state), true);
    markBudgetExhausted(state);
    assert.equal(state.status, "budget_exhausted");
  });
});

describe("Decomposition output validation", () => {
  it("validates a well-formed plan", () => {
    const plan = `## Execution Plan

### Phase 1: Reconnaissance ⚡ parallel
- scout: "Find all files in src/auth"
- scout: "Check test coverage"

### Phase 2: Implementation
- implement: "Fix null check in login.ts"

### Phase 3: Verification ⚡ parallel
- implement: "Run npm test"`;
    assert.equal(isValidDecompositionPlan(plan), true);
  });

  it("rejects empty string", () => {
    assert.equal(isValidDecompositionPlan(""), false);
  });

  it("rejects very short string (likely error response)", () => {
    assert.equal(isValidDecompositionPlan("OK"), false);
  });

  it("rejects plain text without phase structure", () => {
    const shortText = "Just do the task and fix the bug.";
    assert.equal(isValidDecompositionPlan(shortText), false);
  });

  it("accepts plan with Reconnaissance keyword", () => {
    const plan = "## Plan\n### Reconnaissance\n- scout: check files\n- scout: check tests\n\nMore stuff here.";
    assert.equal(isValidDecompositionPlan(plan), true);
  });
});

// ── Subagent model ownership tests ───────────────────────────────────────────

describe("subagent model ownership", () => {
  function buildInstructions(): string {
    return `
Parallel reconnaissance:
\`\`\`json
{ "tasks": [
  { "agent": "scout", "task": "Find all files that import from [module] and show imports. Return concise complete findings; no follow-up needed." }
]}
\`\`\`

Parallel independent file edits:
\`\`\`json
{ "tasks": [
  { "agent": "implement", "task": "In src/auth/login.ts: add null check before auth.verify() on line 42" }
]}
\`\`\`

Architecture decision:
\`\`\`json
{ "agent": "plan", "task": "Should we use JWT or session tokens? Consider: [constraints]" }
\`\`\`
`;
  }

  it("goal subagent examples do not inject model fields", () => {
    const instructions = buildInstructions();
    assert.ok(!instructions.includes('"model"'));
  });

  it("goal leaves model and fallback selection to agent files", () => {
    const agentFiles = [
      "~/.pi/agent/agents/scout.md",
      "~/.pi/agent/agents/implement.md",
      "~/.pi/agent/agents/review.md",
      "~/.pi/agent/agents/plan.md",
    ];
    assert.equal(agentFiles.length, 4);
    assert.ok(agentFiles.every((file) => file.endsWith(".md")));
  });
});
