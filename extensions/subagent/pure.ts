/**
 * Pure helpers for agent discovery and configuration.
 *
 * Free of file I/O and Pi runtime imports so tests can run without a live Pi
 * environment.
 */

export type AgentScope = "user" | "project" | "both";
export type AgentSystemPromptMode = "append" | "replace";

export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	fallbackModels?: string[];
	systemPrompt: string;
	/** How to apply `systemPrompt`: append to the default Pi prompt or replace it entirely. */
	systemPromptMode?: AgentSystemPromptMode;
	/** Keep the normal Pi skill catalog in the child session. Defaults to true for compatibility. */
	inheritSkills?: boolean;
	source: "user" | "project";
	filePath: string;
}

function toString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function splitList(value: unknown): string[] | undefined {
	const str = toString(value);
	if (!str) return undefined;
	const list = str.split(",").map((s) => s.trim()).filter(Boolean);
	return list.length > 0 ? list : undefined;
}

export function parseAgentFrontmatter(
	frontmatter: Record<string, unknown>,
	body: string,
	source: "user" | "project",
	filePath: string,
): AgentConfig | null {
	const name = toString(frontmatter.name);
	const description = toString(frontmatter.description);
	if (!name || !description) {
		return null;
	}

	return {
		name,
		description,
		tools: splitList(frontmatter.tools),
		model: toString(frontmatter.model),
		fallbackModels: splitList(frontmatter.fallbackModels),
		systemPrompt: body,
		systemPromptMode: String(frontmatter.systemPromptMode ?? "append").toLowerCase() === "replace" ? "replace" : "append",
		inheritSkills: String(frontmatter.inheritSkills ?? true).toLowerCase() !== "false",
		source,
		filePath,
	};
}
