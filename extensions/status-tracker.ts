import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

let timerInterval: ReturnType<typeof setInterval> | null = null;
let agentStartedAt = 0;
let currentLabel = "Processing";

function formatDuration(ms: number): string {
	const seconds = Math.floor(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const mins = Math.floor(seconds / 60);
	const secs = seconds % 60;
	return `${mins}m ${secs}s`;
}

function getToolLabel(toolName: string): string {
	switch (toolName) {
		case "read":
			return "Reading";
		case "write":
			return "Writing";
		case "edit":
			return "Editing";
		case "bash":
			return "Bash";
		case "grep":
		case "find":
		case "ls":
			return "Searching";
		case "subagent":
			return "Subagent";
		default:
			return toolName;
	}
}

function updateWorkingMessage(ctx: any) {
	const elapsed = Date.now() - agentStartedAt;
	const timeStr = formatDuration(elapsed);
	ctx.ui.setWorkingMessage(`${currentLabel} [${timeStr}]`);
}

function startTracking(ctx: any) {
	if (timerInterval) clearInterval(timerInterval);
	agentStartedAt = Date.now();
	currentLabel = "Processing";
	timerInterval = setInterval(() => updateWorkingMessage(ctx), 1000);
	updateWorkingMessage(ctx);
}

function stopTracking(ctx: any) {
	if (timerInterval) {
		clearInterval(timerInterval);
		timerInterval = null;
	}
	ctx.ui.setWorkingMessage();
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		stopTracking(ctx);
		currentLabel = "Processing";
	});

	pi.on("agent_start", async (_event, ctx) => {
		startTracking(ctx);
	});

	pi.on("agent_end", async (_event, ctx) => {
		stopTracking(ctx);
	});

	pi.on("message_update", async (event, ctx) => {
		const msgEvent = (event as any).assistantMessageEvent;
		if (!msgEvent) return;

		if (msgEvent.type === "thinking_start") {
			currentLabel = "Thinking";
			updateWorkingMessage(ctx);
		} else if (msgEvent.type === "text_start") {
			currentLabel = "Responding";
			updateWorkingMessage(ctx);
		}
	});

	pi.on("tool_execution_start", async (event, ctx) => {
		currentLabel = getToolLabel(event.toolName);
		updateWorkingMessage(ctx);
	});

	pi.on("tool_execution_end", async (_event, ctx) => {
		currentLabel = "Processing";
		updateWorkingMessage(ctx);
	});

	pi.on("session_before_compact", async (_event, ctx) => {
		currentLabel = "Compacting";
		updateWorkingMessage(ctx);
	});

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName === "subagent") {
			currentLabel = "Subagent";
			updateWorkingMessage(ctx);
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		stopTracking(ctx);
	});
}
