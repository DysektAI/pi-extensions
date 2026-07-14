/**
 * Task Tracker Extension — Claude/Codex-style structured task tracking for Pi
 *
 * Provides:
 *   Tools: TaskCreate, TaskUpdate, TaskList, TaskGet, update_plan
 *   Commands: /tasks, /task-clear, /task-export
 *   UI: Live widget showing progress, custom tool renderers
 *
 * State is stored in tool result details for branch-aware reconstruction.
 * On session resume the full task map is rebuilt from the session branch.
 */

import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
	Theme,
} from "@earendil-works/pi-coding-agent";
import { matchesKey, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";

// ─── Types ───────────────────────────────────────────────────────────────────

// NOTE: kept as a hand-written literal union (not derived from TaskStatusEnum
// via Static<>) on purpose: the StringEnum TUnsafe wrapper defeats TS switch
// exhaustiveness analysis, which makes taskIcon()/render() report spurious
// "missing return" / "used before assigned" errors. The enum below must stay
// in sync with this union (only four states; changes are rare).
type TaskStatus = "pending" | "in_progress" | "completed" | "deleted";

interface Task {
	id: string;
	sessionId: string;
	subject: string;
	description?: string;
	activeForm?: string;
	status: TaskStatus;
	parentId?: string;
	owner: string;
	blockedBy: string[];
	blocks: string[];
	metadata: Record<string, unknown>;
	createdAt: string;
	updatedAt: string;
	completedAt?: string;
}

/** Snapshot stored in every tool result details for branch-aware reconstruction */
interface TaskStoreSnapshot {
	tasks: Task[];
	sessionId: string;
}

// ─── Schemas ─────────────────────────────────────────────────────────────────

// Mirror of the TaskStatus union above (kept separate — see note there).
const TaskStatusEnum = StringEnum([
	"pending",
	"in_progress",
	"completed",
	"deleted",
] as const);

const TaskCreateParams = Type.Object({
	subject: Type.String({
		description: "Short, concrete, verifiable task title",
	}),
	description: Type.Optional(
		Type.String({ description: "Longer description" }),
	),
	activeForm: Type.Optional(
		Type.String({
			description: "Present-tense verb phrase for the currently active task",
		}),
	),
	parentId: Type.Optional(
		Type.String({ description: "Parent task ID for subtasks" }),
	),
	owner: Type.Optional(
		Type.String({ description: "Owner identifier. Defaults to 'agent'" }),
	),
	metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});

const TaskUpdateParams = Type.Object({
	taskId: Type.String({ description: "ID of the task to update" }),
	status: Type.Optional(TaskStatusEnum),
	subject: Type.Optional(Type.String()),
	description: Type.Optional(Type.String()),
	activeForm: Type.Optional(Type.String()),
	owner: Type.Optional(Type.String()),
	addBlockedBy: Type.Optional(Type.Array(Type.String())),
	removeBlockedBy: Type.Optional(Type.Array(Type.String())),
	addBlocks: Type.Optional(Type.Array(Type.String())),
	removeBlocks: Type.Optional(Type.Array(Type.String())),
	metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});

const TaskListParams = Type.Object({
	status: Type.Optional(Type.Array(TaskStatusEnum)),
	owner: Type.Optional(Type.String()),
	includeDeleted: Type.Optional(
		Type.Boolean({ description: "Include deleted tasks" }),
	),
});

const TaskGetParams = Type.Object({
	taskId: Type.String({ description: "ID of the task to retrieve" }),
});

const UpdatePlanParams = Type.Object({
	plan: Type.Array(
		Type.Object({
			step: Type.String({ description: "Step description" }),
			status: StringEnum(["pending", "in_progress", "completed"] as const),
		}),
	),
});

// ─── Extension ───────────────────────────────────────────────────────────────

// ponytail: cheap heuristic, not an NLP parse. Flags prompts that look like
// multi-step work (numbered/bulleted lists, "step by step", chained "then")
// so the cold-start nudge can escalate from a soft note to a direct
// instruction. Tuned to under-fire on short, chatty single asks.
function looksMultiStep(prompt: string): boolean {
	const p = (prompt || "").trim();
	if (!p) return false;
	// Explicit structure is a plan at any length:
	if (/\bstep[-\s]?by[-\s]?step\b|\bworkflow\b|\bmulti[-\s]?step\b/i.test(p))
		return true;
	// 2+ numbered items: "1." / "1)" at line starts
	if ((p.match(/^\s*\d+[.)]\s+\S/gm) || []).length >= 2) return true;
	// 3+ bullet lines: "- " / "* " / "• "
	if ((p.match(/^\s*[-*•]\s+\S/gm) || []).length >= 3) return true;
	// Chained prose ("do x then y then z") is the noisy signal — gate it on some
	// length so a short "what does x do then return?" doesn't trip the nudge.
	if (
		p.length >= 40 &&
		(p.match(/\b(then|after that|afterwards|finally|next,)\b/gi) || []).length >= 2
	)
		return true;
	return false;
}

export default function taskTrackerExtension(pi: ExtensionAPI) {
	// In-memory task store
	let tasks: Map<string, Task> = new Map();
	let sessionId: string = randomUUID();
	// Track plan-step-to-task mapping for update_plan reconciliation
	let planTaskIds: string[] = [];
	// Track whether all tasks were already completed on the previous turn,
	// so we can show the completed state once and then hide the widget.
	let allCompletedLastTurn: boolean = false;

	// ─── Helpers ───────────────────────────────────────────────────────────

	const now = () => new Date().toISOString();

	const snapshot = (): TaskStoreSnapshot => ({
		tasks: Array.from(tasks.values()),
		sessionId,
	});

	const getVisibleTasks = (includeDeleted = false): Task[] => {
		const all = Array.from(tasks.values());
		return includeDeleted ? all : all.filter((t) => t.status !== "deleted");
	};

	const getInProgressByOwner = (owner: string): Task | undefined => {
		for (const t of tasks.values()) {
			if (t.owner === owner && t.status === "in_progress") return t;
		}
		return undefined;
	};

	const enforceOneInProgress = (owner: string, newTaskId: string) => {
		const existing = getInProgressByOwner(owner);
		if (existing && existing.id !== newTaskId) {
			// Demote existing in_progress to pending
			existing.status = "pending";
			existing.updatedAt = now();
		}
	};

	const isBlocked = (task: Task): boolean => {
		if (task.blockedBy.length === 0) return false;
		for (const depId of task.blockedBy) {
			const dep = tasks.get(depId);
			if (dep && dep.status !== "completed" && dep.status !== "deleted")
				return true;
		}
		return false;
	};

	const completedCount = (): number => {
		let n = 0;
		for (const t of tasks.values()) {
			if (t.status === "completed") n++;
		}
		return n;
	};

	const totalVisible = (): number => {
		let n = 0;
		for (const t of tasks.values()) {
			if (t.status !== "deleted") n++;
		}
		return n;
	};

	// ─── State reconstruction ──────────────────────────────────────────────

	const reconstructState = (ctx: ExtensionContext) => {
		tasks = new Map();
		planTaskIds = [];

		for (const entry of ctx.sessionManager.getBranch()) {
			if (
				entry.type === "custom" &&
				entry.customType === "task-tracker-plan-ids"
			) {
				const data = entry.data as { planTaskIds: string[] } | undefined;
				if (data?.planTaskIds) {
					planTaskIds = data.planTaskIds;
				}
			}

			if (entry.type !== "message") continue;
			const msg = entry.message;
			if (msg.role !== "toolResult") continue;

			// Recognize any of our tool names
			const ourTools = [
				"TaskCreate",
				"TaskUpdate",
				"TaskList",
				"TaskGet",
				"update_plan",
			];
			if (!ourTools.includes(msg.toolName ?? "")) continue;

			const details = msg.details as TaskStoreSnapshot | undefined;
			if (details?.tasks) {
				tasks = new Map();
				for (const t of details.tasks) {
					tasks.set(t.id, t);
				}
				if (details.sessionId) {
					sessionId = details.sessionId;
				}
			}
		}

		updateWidget(ctx);
	};

	// ─── Widget ────────────────────────────────────────────────────────────

	const updateWidget = (ctx: ExtensionContext) => {
		const visible = getVisibleTasks();
		if (visible.length === 0) {
			allCompletedLastTurn = false;
			ctx.ui.setWidget("task-tracker", undefined);
			return;
		}

		const done = completedCount();
		const total = totalVisible();
		const allCompleted = done === total && total > 0;

		if (allCompleted && allCompletedLastTurn) {
			// Already showed the all-completed state on the previous turn;
			// hide the widget so it doesn't linger forever.
			ctx.ui.setWidget("task-tracker", undefined);
			return;
		}

		allCompletedLastTurn = allCompleted;

		const theme = ctx.ui.theme;

		const lines: string[] = [];

		// Header with progress
		const progressBar = buildProgressBar(done, total, theme);
		lines.push(
			`${theme.fg("accent", theme.bold("Tasks"))} ${theme.fg("muted", `${done}/${total}`)} ${progressBar}`,
		);

		// Task list
		for (const task of visible) {
			const icon = taskIcon(task, theme);
			const label =
				task.status === "in_progress"
					? (task.activeForm ?? task.subject)
					: task.subject;
			const text =
				task.status === "completed"
					? theme.fg("dim", label)
					: task.status === "in_progress"
						? theme.fg("text", label)
						: theme.fg("muted", label);

			lines.push(`  ${icon} ${text}`);
		}

		ctx.ui.setWidget("task-tracker", lines);
	};

	const taskIcon = (task: Task, theme: Theme): string => {
		if (isBlocked(task)) return theme.fg("warning", "⊘");
		switch (task.status) {
			case "pending":
				return theme.fg("dim", "○");
			case "in_progress":
				return theme.fg("accent", "●");
			case "completed":
				return theme.fg("success", "✓");
			case "deleted":
				return theme.fg("dim", "✕");
		}
	};

	const buildProgressBar = (
		done: number,
		total: number,
		theme: Theme,
	): string => {
		if (total === 0) return "";
		const width = 12;
		const filled = Math.round((done / total) * width);
		const empty = width - filled;
		return (
			theme.fg("dim", "[") +
			theme.fg("success", "█".repeat(filled)) +
			theme.fg("dim", "░".repeat(empty)) +
			theme.fg("dim", "]")
		);
	};

	// ─── Lifecycle events ──────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		reconstructState(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		reconstructState(ctx);
	});

	// Update widget after each turn in case tasks changed
	pi.on("turn_end", async (_event, ctx) => {
		updateWidget(ctx);
	});

	// ─── Tool: TaskCreate ──────────────────────────────────────────────────

	pi.registerTool({
		name: "TaskCreate",
		label: "Create Task",
		description:
			"Create a new task for tracking multi-step work. Returns the task with its generated ID.",
		promptSnippet: "Create a task to track progress on multi-step work",
		promptGuidelines: [
			"When a request involves 3+ distinct steps, or the user gives a step-by-step plan or workflow, call update_plan (or TaskCreate) to lay out the steps BEFORE starting the work — don't track multi-step work only in your head.",
			"Use TaskCreate only for non-trivial multi-step work (3–7 tasks for normal coding work).",
			"Each task created with TaskCreate should be outcome-oriented and independently verifiable.",
			"Before starting work on a task, use TaskUpdate to mark it in_progress.",
			"Do not create tasks with TaskCreate for trivial single-step requests.",
		],
		parameters: TaskCreateParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const task: Task = {
				id: randomUUID().slice(0, 8),
				sessionId,
				subject: params.subject,
				description: params.description,
				activeForm: params.activeForm,
				status: "pending",
				parentId: params.parentId,
				owner: params.owner ?? "agent",
				blockedBy: [],
				blocks: [],
				metadata: params.metadata ?? {},
				createdAt: now(),
				updatedAt: now(),
			};

			tasks.set(task.id, task);
			// Reset the latch so the widget shows for newly created tasks
			allCompletedLastTurn = false;
			updateWidget(ctx);

			return {
				content: [
					{
						type: "text",
						text: `Created task ${task.id}: ${task.subject}`,
					},
				],
				details: snapshot(),
			};
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("TaskCreate "));
			text += theme.fg("muted", args.subject ?? "");
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme) {
			const details = result.details as TaskStoreSnapshot | undefined;
			if (!details) {
				const t = result.content[0];
				return new Text(t?.type === "text" ? t.text : "", 0, 0);
			}
			const newest = details.tasks[details.tasks.length - 1];
			if (!newest) return new Text(theme.fg("dim", "No task"), 0, 0);
			return new Text(
				theme.fg("success", "✓ Created ") +
					theme.fg("accent", `#${newest.id}`) +
					" " +
					theme.fg("muted", newest.subject),
				0,
				0,
			);
		},
	});

	// ─── Tool: TaskUpdate ──────────────────────────────────────────────────

	pi.registerTool({
		name: "TaskUpdate",
		label: "Update Task",
		description:
			"Update a task's status, subject, description, dependencies, or metadata.",
		promptSnippet: "Update a task's status or properties",
		promptGuidelines: [
			"Use TaskUpdate to mark a task in_progress before starting work on it.",
			"Use TaskUpdate to mark a task completed immediately when finished.",
			"Keep exactly one in_progress task per owner when using TaskUpdate.",
			"Use TaskUpdate to mark tasks as deleted (not silently dropped) if they become irrelevant.",
			"Before giving a final response, ensure no stale in_progress task remains — use TaskUpdate to complete or revert them.",
		],
		parameters: TaskUpdateParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const task = tasks.get(params.taskId);
			if (!task) {
				throw new Error(`Task not found: ${params.taskId}`);
			}

			if (params.subject !== undefined) task.subject = params.subject;
			if (params.description !== undefined)
				task.description = params.description;
			if (params.activeForm !== undefined) task.activeForm = params.activeForm;
			if (params.owner !== undefined) task.owner = params.owner;
			if (params.metadata !== undefined) {
				task.metadata = { ...task.metadata, ...params.metadata };
			}

			// Dependency management
			if (params.addBlockedBy) {
				for (const id of params.addBlockedBy) {
					if (!task.blockedBy.includes(id)) task.blockedBy.push(id);
				}
			}
			if (params.removeBlockedBy) {
				task.blockedBy = task.blockedBy.filter(
					(id) => !params.removeBlockedBy?.includes(id),
				);
			}
			if (params.addBlocks) {
				for (const id of params.addBlocks) {
					if (!task.blocks.includes(id)) task.blocks.push(id);
					// Also add reverse relationship
					const target = tasks.get(id);
					if (target && !target.blockedBy.includes(task.id)) {
						target.blockedBy.push(task.id);
						target.updatedAt = now();
					}
				}
			}
			if (params.removeBlocks) {
				task.blocks = task.blocks.filter(
					(id) => !params.removeBlocks?.includes(id),
				);
				for (const id of params.removeBlocks) {
					const target = tasks.get(id);
					if (target) {
						target.blockedBy = target.blockedBy.filter(
							(bid) => bid !== task.id,
						);
						target.updatedAt = now();
					}
				}
			}

			// Status transition
			if (params.status !== undefined && params.status !== task.status) {
				if (params.status === "in_progress") {
					enforceOneInProgress(task.owner, task.id);
				}
				task.status = params.status;
				if (params.status === "completed") {
					task.completedAt = now();
				}
			}

			task.updatedAt = now();
			updateWidget(ctx);

			return {
				content: [
					{
						type: "text",
						text: `Updated task ${task.id}: status=${task.status}`,
					},
				],
				details: snapshot(),
			};
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("TaskUpdate "));
			text += theme.fg("accent", `#${args.taskId ?? "?"}`);
			if (args.status) text += ` → ${theme.fg("muted", args.status)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme) {
			const details = result.details as TaskStoreSnapshot | undefined;
			if (!details) {
				const t = result.content[0];
				return new Text(t?.type === "text" ? t.text : "", 0, 0);
			}
			const content = result.content[0];
			const msg = content?.type === "text" ? content.text : "";
			return new Text(theme.fg("success", "✓ ") + theme.fg("muted", msg), 0, 0);
		},
	});

	// ─── Tool: TaskList ────────────────────────────────────────────────────

	pi.registerTool({
		name: "TaskList",
		label: "List Tasks",
		description:
			"List tasks, optionally filtered by status or owner. Deleted tasks are hidden unless includeDeleted is true.",
		promptSnippet: "List current tasks with status filters",
		parameters: TaskListParams,

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			let filtered = Array.from(tasks.values());

			// Filter by status
			if (params.status && params.status.length > 0) {
				const statuses = new Set(params.status);
				filtered = filtered.filter((t) => statuses.has(t.status));
			} else if (!params.includeDeleted) {
				filtered = filtered.filter((t) => t.status !== "deleted");
			}

			// Filter by owner
			if (params.owner) {
				filtered = filtered.filter((t) => t.owner === params.owner);
			}

			const lines = filtered.map((t) => {
				const icon =
					t.status === "completed"
						? "✓"
						: t.status === "in_progress"
							? "●"
							: t.status === "deleted"
								? "✕"
								: isBlocked(t)
									? "⊘"
									: "○";
				return `[${icon}] #${t.id}: ${t.subject} (${t.status})`;
			});

			return {
				content: [
					{
						type: "text",
						text: filtered.length > 0 ? lines.join("\n") : "No tasks found",
					},
				],
				details: snapshot(),
			};
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("TaskList"));
			if (args.status)
				text += ` ${theme.fg("dim", `[${args.status.join(",")}]`)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details as TaskStoreSnapshot | undefined;
			if (!details) {
				const t = result.content[0];
				return new Text(t?.type === "text" ? t.text : "", 0, 0);
			}

			const visible = details.tasks.filter((t) => t.status !== "deleted");
			if (visible.length === 0) {
				return new Text(theme.fg("dim", "No tasks"), 0, 0);
			}

			const done = visible.filter((t) => t.status === "completed").length;
			let text = theme.fg("muted", `${done}/${visible.length} completed`);

			const display = expanded ? visible : visible.slice(0, 8);
			for (const t of display) {
				const icon =
					t.status === "completed"
						? theme.fg("success", "✓")
						: t.status === "in_progress"
							? theme.fg("accent", "●")
							: isBlocked(t)
								? theme.fg("warning", "⊘")
								: theme.fg("dim", "○");
				const label =
					t.status === "completed"
						? theme.fg("dim", t.subject)
						: theme.fg("muted", t.subject);
				text += `\n  ${icon} ${theme.fg("accent", `#${t.id}`)} ${label}`;
			}
			if (!expanded && visible.length > 8) {
				text += `\n  ${theme.fg("dim", `... ${visible.length - 8} more`)}`;
			}
			return new Text(text, 0, 0);
		},
	});

	// ─── Tool: TaskGet ─────────────────────────────────────────────────────

	pi.registerTool({
		name: "TaskGet",
		label: "Get Task",
		description: "Retrieve a single task by ID with full details.",
		promptSnippet: "Retrieve a single task by ID",
		parameters: TaskGetParams,

		async execute(_toolCallId, params) {
			const task = tasks.get(params.taskId);
			if (!task) {
				throw new Error(`Task not found: ${params.taskId}`);
			}

			return {
				content: [
					{
						type: "text",
						text: JSON.stringify(task, null, 2),
					},
				],
				details: snapshot(),
			};
		},

		renderCall(args, theme) {
			return new Text(
				theme.fg("toolTitle", theme.bold("TaskGet ")) +
					theme.fg("accent", `#${args.taskId ?? "?"}`),
				0,
				0,
			);
		},

		renderResult(result, _options, theme) {
			const details = result.details as TaskStoreSnapshot | undefined;
			if (!details) {
				return new Text(theme.fg("dim", "Not found"), 0, 0);
			}
			// Show the requested task's info compactly
			const content = result.content[0];
			if (content?.type === "text") {
				try {
					const t = JSON.parse(content.text) as Task;
					const icon =
						t.status === "completed"
							? theme.fg("success", "✓")
							: t.status === "in_progress"
								? theme.fg("accent", "●")
								: theme.fg("dim", "○");
					return new Text(
						`${icon} ${theme.fg("accent", `#${t.id}`)} ${theme.fg("muted", t.subject)} (${t.status})`,
						0,
						0,
					);
				} catch {
					return new Text(content.text, 0, 0);
				}
			}
			return new Text(theme.fg("dim", "No task"), 0, 0);
		},
	});

	// ─── Tool: update_plan (Codex compatibility) ───────────────────────────

	pi.registerTool({
		name: "update_plan",
		label: "Update Plan",
		description:
			"Codex-style plan update. On first call, converts plan steps into tasks. On subsequent calls, reconciles by position (the plan array order must stay stable). Internally uses the same task store.",
		promptSnippet:
			"Set or update a step-by-step plan (Codex-style compatibility)",
		promptGuidelines: [
			"Use update_plan for a quick checklist-style plan. For fine-grained control prefer TaskCreate/TaskUpdate.",
			"When using update_plan, keep the plan array in stable order — don't shuffle steps between calls.",
		],
		parameters: UpdatePlanParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const isFirstCall = planTaskIds.length === 0;

			if (isFirstCall) {
				// Create tasks from plan steps
				const newIds: string[] = [];
				for (const step of params.plan) {
					const task: Task = {
						id: randomUUID().slice(0, 8),
						sessionId,
						subject: step.step,
						status: step.status,
						owner: "agent",
						blockedBy: [],
						blocks: [],
						metadata: { source: "update_plan" },
						createdAt: now(),
						updatedAt: now(),
					};
					if (step.status === "completed") task.completedAt = now();
					if (step.status === "in_progress") {
						enforceOneInProgress("agent", task.id);
					}
					tasks.set(task.id, task);
					newIds.push(task.id);
				}
				planTaskIds = newIds;
			} else {
				// Reconcile: match by position, extend or trim as needed
				const newIds: string[] = [];

				for (let i = 0; i < params.plan.length; i++) {
					const step = params.plan[i];
					let taskId: string | undefined;

					if (i < planTaskIds.length) {
						taskId = planTaskIds[i];
					}

					if (taskId && tasks.has(taskId)) {
						// Update existing task
						const task = tasks.get(taskId)!;
						task.subject = step.step;
						if (
							step.status === "in_progress" &&
							task.status !== "in_progress"
						) {
							enforceOneInProgress(task.owner, task.id);
						}
						task.status = step.status;
						if (step.status === "completed") {
							if (!task.completedAt) task.completedAt = now();
						} else {
							// Left the completed state on a later reconcile — drop the
							// stale timestamp so it can't read as still-completed.
							delete task.completedAt;
						}
						task.updatedAt = now();
						newIds.push(taskId);
					} else {
						// New step — create task
						const task: Task = {
							id: randomUUID().slice(0, 8),
							sessionId,
							subject: step.step,
							status: step.status,
							owner: "agent",
							blockedBy: [],
							blocks: [],
							metadata: { source: "update_plan" },
							createdAt: now(),
							updatedAt: now(),
						};
						if (step.status === "completed") task.completedAt = now();
						if (step.status === "in_progress") {
							enforceOneInProgress("agent", task.id);
						}
						tasks.set(task.id, task);
						newIds.push(task.id);
					}
				}

				// Mark excess old plan tasks as deleted
				for (let i = params.plan.length; i < planTaskIds.length; i++) {
					const oldId = planTaskIds[i];
					const oldTask = tasks.get(oldId);
					if (oldTask && oldTask.status !== "deleted") {
						oldTask.status = "deleted";
						oldTask.updatedAt = now();
					}
				}

				planTaskIds = newIds;
			}

			// Persist plan-task mapping
			pi.appendEntry("task-tracker-plan-ids", {
				planTaskIds: [...planTaskIds],
			});

			// Reset the latch so the widget shows for newly created plan tasks
			allCompletedLastTurn = false;
			updateWidget(ctx);

			const visible = getVisibleTasks();
			const done = visible.filter((t) => t.status === "completed").length;
			const lines = visible.map((t) => {
				const icon =
					t.status === "completed"
						? "✓"
						: t.status === "in_progress"
							? "●"
							: "○";
				return `[${icon}] ${t.subject}`;
			});

			return {
				content: [
					{
						type: "text",
						text: `Plan updated: ${done}/${visible.length} completed\n${lines.join("\n")}`,
					},
				],
				details: snapshot(),
			};
		},

		renderCall(args, theme) {
			const count = args.plan?.length ?? 0;
			return new Text(
				theme.fg("toolTitle", theme.bold("update_plan ")) +
					theme.fg("muted", `${count} step(s)`),
				0,
				0,
			);
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details as TaskStoreSnapshot | undefined;
			if (!details) {
				const t = result.content[0];
				return new Text(t?.type === "text" ? t.text : "", 0, 0);
			}

			const visible = details.tasks.filter((t) => t.status !== "deleted");
			const done = visible.filter((t) => t.status === "completed").length;
			let text =
				theme.fg("accent", theme.bold("Plan ")) +
				theme.fg("muted", `${done}/${visible.length}`);

			const display = expanded ? visible : visible.slice(0, 10);
			for (const t of display) {
				const icon =
					t.status === "completed"
						? theme.fg("success", "✓")
						: t.status === "in_progress"
							? theme.fg("accent", "●")
							: theme.fg("dim", "○");
				const label =
					t.status === "completed"
						? theme.fg("dim", t.subject)
						: theme.fg("muted", t.subject);
				text += `\n  ${icon} ${label}`;
			}
			if (!expanded && visible.length > 10) {
				text += `\n  ${theme.fg("dim", `... ${visible.length - 10} more`)}`;
			}
			return new Text(text, 0, 0);
		},
	});

	// ─── Command: /tasks ───────────────────────────────────────────────────

	pi.registerCommand("tasks", {
		description: "Show current task state",
		handler: async (_args, ctx) => {
			const visible = getVisibleTasks();
			if (visible.length === 0) {
				ctx.ui.notify("No tasks in this session", "info");
				return;
			}

			if (!ctx.hasUI) {
				// Print mode fallback
				const done = completedCount();
				const total = totalVisible();
				ctx.ui.notify(
					`Tasks: ${done}/${total} completed\n` +
						visible
							.map((t) => {
								const icon =
									t.status === "completed"
										? "✓"
										: t.status === "in_progress"
											? "●"
											: "○";
								return `  [${icon}] #${t.id}: ${t.subject}`;
							})
							.join("\n"),
					"info",
				);
				return;
			}

			// Interactive TUI component
			await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
				return new TaskListComponent(visible, theme, isBlocked, () => done());
			});
		},
	});

	// ─── Command: /task-clear ──────────────────────────────────────────────

	pi.registerCommand("task-clear", {
		description: "Clear all tasks in the current session",
		handler: async (_args, ctx) => {
			if (tasks.size === 0) {
				ctx.ui.notify("No tasks to clear", "info");
				return;
			}

			const ok = await ctx.ui.confirm(
				"Clear Tasks",
				`Delete all ${tasks.size} task(s)?`,
			);
			if (!ok) return;

			// Mark all as deleted rather than truly dropping them
			for (const task of tasks.values()) {
				task.status = "deleted";
				task.updatedAt = now();
			}
			planTaskIds = [];
			pi.appendEntry("task-tracker-plan-ids", { planTaskIds: [] });

			updateWidget(ctx);
			ctx.ui.notify("All tasks cleared", "info");
		},
	});

	// ─── Command: /task-export ─────────────────────────────────────────────

	pi.registerCommand("task-export", {
		description: "Export tasks to .pi/TODO.md",
		handler: async (_args, ctx) => {
			const visible = getVisibleTasks();
			if (visible.length === 0) {
				ctx.ui.notify("No tasks to export", "info");
				return;
			}

			const done = completedCount();
			const total = totalVisible();

			let md = `# Tasks (${done}/${total} completed)\n\n`;
			md += `_Exported: ${now()}_\n\n`;

			for (const t of visible) {
				const checkbox = t.status === "completed" ? "[x]" : "[ ]";
				const status =
					t.status === "in_progress"
						? " 🔄"
						: t.status === "completed"
							? ""
							: "";
				md += `- ${checkbox} **${t.subject}**${status}`;
				if (t.description) md += `\n  ${t.description}`;
				md += `\n  _ID: ${t.id} | Owner: ${t.owner} | Status: ${t.status}_\n`;
			}

			const exportPath = join(ctx.cwd, ".pi", "TODO.md");
			await mkdir(join(ctx.cwd, ".pi"), { recursive: true });
			await writeFile(exportPath, md, "utf-8");
			ctx.ui.notify(
				`Exported ${visible.length} task(s) to .pi/TODO.md`,
				"info",
			);
		},
	});

	// ─── System prompt injection ───────────────────────────────────────────

	pi.on("before_agent_start", async (event, _ctx) => {
		const visible = getVisibleTasks();
		if (visible.length === 0) {
			// ponytail: cold-start nudge. The state reminder below only fires once
			// tasks exist, so a fresh multi-step ask slipped through untracked. When
			// the prompt actually looks like a plan, escalate from a soft note to a
			// direct instruction — a vague always-on note just gets banner-blindness.
			const multiStep = looksMultiStep((event as any)?.prompt ?? "");
			const content = multiStep
				? "\n\nThis request looks like multi-step work (a list / workflow / " +
					"several phases). Before doing anything else, call update_plan (or " +
					"TaskCreate) to lay out the steps, then mark each in_progress / " +
					"completed as you go. Do this now — don't track the plan only in your head."
				: "\n\nNo tasks tracked yet. If this turn is non-trivial multi-step work " +
					"(3+ distinct steps) or the user gave a step-by-step plan, call update_plan " +
					"or TaskCreate to lay out the steps BEFORE doing the work. Skip for simple one-step requests.";
			return {
				message: {
					customType: "task-tracker-context",
					content,
					display: false,
				},
			};
		}

		const done = completedCount();
		const total = totalVisible();
		const inProgress = visible.find((t) => t.status === "in_progress");

		let status = `\n\n## Current Task State (${done}/${total} completed)\n`;
		for (const t of visible) {
			const icon =
				t.status === "completed"
					? "✓"
					: t.status === "in_progress"
						? "●"
						: isBlocked(t)
							? "⊘"
							: "○";
			status += `[${icon}] #${t.id}: ${t.subject} (${t.status})\n`;
		}
		if (inProgress) {
			status += `\nCurrently working on: #${inProgress.id} — ${inProgress.activeForm ?? inProgress.subject}\n`;
		}

		return {
			message: {
				customType: "task-tracker-context",
				content: status,
				display: false,
			},
		};
	});
}

// ─── TUI Component ─────────────────────────────────────────────────────────

class TaskListComponent {
	private tasks: Task[];
	private theme: Theme;
	private isBlocked: (t: Task) => boolean;
	private onClose: () => void;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(
		tasks: Task[],
		theme: Theme,
		isBlocked: (t: Task) => boolean,
		onClose: () => void,
	) {
		this.tasks = tasks;
		this.theme = theme;
		this.isBlocked = isBlocked;
		this.onClose = onClose;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.onClose();
		}
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) {
			return this.cachedLines;
		}

		const lines: string[] = [];
		const th = this.theme;

		lines.push("");
		const title = th.fg("accent", " Tasks ");
		const headerLine =
			th.fg("borderMuted", "─".repeat(3)) +
			title +
			th.fg("borderMuted", "─".repeat(Math.max(0, width - 10)));
		lines.push(truncateToWidth(headerLine, width));
		lines.push("");

		const done = this.tasks.filter((t) => t.status === "completed").length;
		const total = this.tasks.length;
		lines.push(
			truncateToWidth(
				`  ${th.fg("muted", `${done}/${total} completed`)}`,
				width,
			),
		);
		lines.push("");

		for (const task of this.tasks) {
			const blocked = this.isBlocked(task);
			let icon: string;
			if (blocked) {
				icon = th.fg("warning", "⊘");
			} else {
				switch (task.status) {
					case "pending":
						icon = th.fg("dim", "○");
						break;
					case "in_progress":
						icon = th.fg("accent", "●");
						break;
					case "completed":
						icon = th.fg("success", "✓");
						break;
					case "deleted":
						icon = th.fg("dim", "✕");
						break;
				}
			}

			const id = th.fg("accent", `#${task.id}`);
			const label =
				task.status === "completed"
					? th.fg("dim", task.subject)
					: task.status === "in_progress"
						? th.fg("text", task.activeForm ?? task.subject)
						: th.fg("muted", task.subject);
			const owner = th.fg("dim", `[${task.owner}]`);

			lines.push(truncateToWidth(`  ${icon} ${id} ${label} ${owner}`, width));

			if (task.description) {
				lines.push(
					truncateToWidth(`      ${th.fg("dim", task.description)}`, width),
				);
			}
		}

		lines.push("");
		lines.push(
			truncateToWidth(`  ${th.fg("dim", "Press Escape to close")}`, width),
		);
		lines.push("");

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}
