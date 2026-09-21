import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateHead } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { ask, buildRequest, precheck, readConfig } from "./client.js";

export default function typesafeExtension(pi: ExtensionAPI) {
  pi.registerCommand("jev", {
    description: "Show TypeSafe/Jev setup and automatic pre-check status (no network request)",
    handler: async (_args, ctx) => {
      let text: string;
      try {
        const config = readConfig(process.env);
        text = `Jev is TypeSafe's decision model, accessed through typesafe_ask, not a subagent.\n` +
          `API key: ${config.apiKey ? "configured" : "missing — set TYPESAFE_API_KEY and restart Pi"}.\n` +
          `Automatic prompt pre-check: ${config.auto ? "on" : "off"}. Enable with TYPESAFE_AUTO=on; this sends eligible prompts to TypeSafe.\n` +
          `Skill: /skill:typesafe-ai. Tool enabled: ${pi.getActiveTools().includes("typesafe_ask") ? "yes" : "no"}.`;
      } catch { text = "Invalid TypeSafe configuration. Check TYPESAFE_BASE_URL (HTTPS) and TYPESAFE_AUTO_THRESHOLD (0–1)."; }
      if (ctx.hasUI) ctx.ui.notify(text, "info");
      else pi.sendMessage({ customType: "typesafe-status", content: text, display: true }, { triggerTurn: false });
    },
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (!pi.getActiveTools().includes("typesafe_ask")) return;
    try {
      const p = await precheck(readConfig(process.env), event.prompt, ctx.signal);
      if (p === undefined) return;
      return { message: {
        customType: "typesafe-auto", display: true,
        content: `Jev pre-check: estimated probability ${p.toFixed(2)} that calibrated judgment would help. ` +
          "Consider typesafe_ask for the important decisions using atomic noul/choice/score questions. This is advice, not verified fact or permission to act.",
      } };
    } catch { /* Invalid optional configuration must not block the agent. */ }
  });

  pi.registerTool({
    name: "typesafe_ask", label: "TypeSafe Ask (Jev)",
    description: "Ask TypeSafe's Jev decision model typed questions about a state. Returns probabilities, not generated text. " +
      "Requires TYPESAFE_API_KEY. Sends supplied state/questions to the configured TypeSafe endpoint. " +
      "Noul: yes/no probability; choice: select from an option map; score: rate on 2–10 ordered levels. " +
      "Limits: 1–64 questions, 256 KiB request, output truncated to 50 KiB/2000 lines.",
    promptSnippet: "Consult Jev for typed, probability-backed judgments (not a chat model or subagent)",
    promptGuidelines: [
      "Use typesafe_ask proactively when calibrated classification, ranking, verification, or comparison would help; keep mechanical work in code. If TYPESAFE_API_KEY is missing, report setup once rather than repeatedly retrying.",
      "With typesafe_ask, ask atomic noul/choice/score questions together over the minimum necessary state. Do not send secrets. Treat probabilities as evidence, not proof or authorization.",
    ],
    parameters: Type.Object({
      state: Type.String({ description: "Plain text or a JSON-encoded object/array to evaluate." }),
      questions: Type.Array(Type.Object({
        id: Type.Optional(Type.String({ minLength: 1, description: "Unique ID; defaults to q1, q2, etc." })),
        type: StringEnum(["noul", "choice", "score"] as const),
        instructions: Type.String({ minLength: 1, description: "One specific judgment to evaluate." }),
        criteria: Type.Optional(Type.Unknown({ description: "Noul: optional true/false descriptions. Choice: option map. Score: ordered array of 2–10 descriptions." })),
      }), { minItems: 1, maxItems: 64 }),
      model: Type.Optional(Type.String({ minLength: 1, description: "Override TYPESAFE_MODEL (default jev-latest)." })),
    }),
    async execute(_id, params, signal) {
      const config = readConfig(process.env);
      const result = await ask(config, buildRequest(params.state, params.questions, params.model ?? config.model), signal);
      const output = truncateHead(JSON.stringify({ model: result.model, answers: result.answers }, null, 2));
      return {
        content: [{ type: "text", text: output.content + (output.truncated ? "\n[Output truncated. Ask fewer questions per call to retrieve all answers.]" : "") }],
        details: result,
      };
    },
  });
}
