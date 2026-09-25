import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateHead } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { ask, buildRequest, config, precheck } from "./client.js";

export default function typesafeExtension(pi: ExtensionAPI) {
  pi.registerCommand("jev", {
    description: "Show TypeSafe/Jev setup and automatic pre-check status (no network request)",
    handler: async (_args, ctx) => {
      let text: string;
      try {
        const settings = await config();
        text = `Jev is TypeSafe's judgment model, accessed through typesafe_ask, not a subagent.\n` +
          `Credential: ${settings.apiKey ? "configured" : "missing — add a `typesafe` entry to ~/.pi/agent/auth.json (or set TYPESAFE_API_KEY) and restart Pi"}.\n` +
          `Automatic prompt pre-check: ${settings.auto ? "on" : "off"}. Enable with TYPESAFE_AUTO=on; this sends eligible prompts to TypeSafe.\n` +
          `Endpoint: ${settings.baseUrl} (model ${settings.model}).\n` +
          `Skill: /skill:jev-judgments. Tool enabled: ${pi.getActiveTools().includes("typesafe_ask") ? "yes" : "no"}.`;
      } catch { text = "Invalid TypeSafe configuration. Check TYPESAFE_BASE_URL (HTTPS) and TYPESAFE_AUTO_THRESHOLD (0–1)."; }
      if (ctx.hasUI) ctx.ui.notify(text, "info");
      else pi.sendMessage({ customType: "typesafe-status", content: text, display: true }, { triggerTurn: false });
    },
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (!pi.getActiveTools().includes("typesafe_ask")) return;
    try {
      const p = await precheck(await config(), event.prompt, ctx.signal);
      if (p === undefined) return;
      return { message: {
        customType: "typesafe-auto", display: true,
        content: `Jev pre-check: estimated probability ${p.toFixed(2)} that calibrated judgment would help. ` +
          "Consider typesafe_ask for the important decisions using atomic noul/choice/score questions. This is advice, not verified fact or permission to act.",
      } };
    } catch { /* Invalid optional configuration must not block the agent. */ }
  });

  pi.registerTool({
    name: "typesafe_ask", label: "Ask Jev (TypeSafe)",
    description: "Ask Jev, TypeSafe's fast structured-judgment model, typed questions over supplied evidence; returns probabilities, not generated text. " +
      "Consider it for bounded semantic judgments: classify, triage, label, route, sort, rank, compare, verify, score, identify the best-fit option, or get an independent second opinion. " +
      "Noul: yes/no probability; choice: probability distribution over an option map; score: position on 2–10 ordered levels. " +
      "Requires a `typesafe` entry in ~/.pi/agent/auth.json (or TYPESAFE_API_KEY). Sends supplied state/questions to the configured TypeSafe endpoint. " +
      "Limits: 1–64 questions, 256 KiB request, output truncated to 50 KiB/2000 lines.",
    promptSnippet: "Ask Jev for fast structured judgments over supplied evidence (classify/triage/rank/verify/score/second opinion); returns probabilities, not text",
    promptGuidelines: [
      "Consider typesafe_ask (Jev) whenever a bounded semantic judgment would help — classification, triage, labeling, routing, ranking, comparison, verification, scoring, or an independent second opinion. Skip it for open-ended generation, multi-step reasoning, or deterministic work that belongs in code; gather missing context first, then judge the completed state.",
      "Send the smallest complete and relevant evidence set as neutral state: raw or faithfully normalized facts and context, never your own tentative conclusion. For a second opinion, omit your first answer and ask the same bounded question independently.",
      "Ask one coherent judgment per question (noul = yes/no probability, choice = distribution over defined options, score = ordered scale) and batch independent questions over the same state in one call. Do not send secrets.",
      "Treat returned probabilities as calibrated evidence and uncertainty signals, not proof or authorization. Low or split results mean gather better evidence, reason it through, ask the user, or escalate; choose thresholds per workflow, not universally. If no TypeSafe credential is configured, report the setup once rather than repeatedly retrying.",
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
      const settings = await config();
      const result = await ask(settings, buildRequest(params.state, params.questions, params.model ?? settings.model), signal);
      const output = truncateHead(JSON.stringify({ model: result.model, answers: result.answers }, null, 2));
      return {
        content: [{ type: "text", text: output.content + (output.truncated ? "\n[Output truncated. Ask fewer questions per call to retrieve all answers.]" : "") }],
        details: result,
      };
    },
  });
}
