import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// Dependency-free HTTP client: also exercised without a Pi runtime or live credentials.
export interface Question {
  id?: string;
  type: "noul" | "choice" | "score";
  instructions: string;
  criteria?: unknown;
}
export interface Config {
  apiKey: string;
  baseUrl: string;
  model: string;
  auto: boolean;
  threshold: number;
}
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const rubric = (v: unknown): boolean => typeof v === "string" || record(v) || Array.isArray(v);
const probability = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;

export function readConfig(env: Record<string, string | undefined>, apiKey?: string): Config {
  const baseUrl = (env.TYPESAFE_BASE_URL?.trim() || "https://api.typesafe.ai/v1").replace(/\/+$/, "");
  const url = new URL(baseUrl);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("TYPESAFE_BASE_URL must be an HTTPS URL without credentials, query, or fragment.");
  }
  const threshold = Number(env.TYPESAFE_AUTO_THRESHOLD?.trim() || "0.5");
  if (!probability(threshold)) throw new Error("TYPESAFE_AUTO_THRESHOLD must be between 0 and 1.");
  return {
    apiKey: apiKey?.trim() || env.TYPESAFE_API_KEY?.trim() || "",
    baseUrl,
    model: env.TYPESAFE_MODEL?.trim() || "jev-latest",
    auto: env.TYPESAFE_AUTO === "on",
    threshold,
  };
}

/** Extracts one provider credential from a parsed Pi auth.json, accepting both the plain-string and typed forms. */
export function parseAuthKey(auth: unknown, provider: string): string | undefined {
  if (!record(auth)) return undefined;
  const entry = auth[provider];
  if (typeof entry === "string" && entry.trim()) return entry.trim();
  if (record(entry) && typeof entry.key === "string" && entry.key.trim()) return entry.key.trim();
  return undefined;
}

/**
 * Machine-private credential resolution: `~/.pi/agent/auth.json` first (persistent,
 * no env var needed), then TYPESAFE_API_KEY. Never throws.
 */
export async function resolveApiKey(env: Record<string, string | undefined> = process.env): Promise<string | undefined> {
  try {
    const dir = env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
    const key = parseAuthKey(JSON.parse(await readFile(join(dir, "auth.json"), "utf8")), "typesafe");
    if (key) return key;
  } catch { /* No auth.json entry; fall back to the environment. */ }
  return env.TYPESAFE_API_KEY?.trim() || undefined;
}

export async function config(env: Record<string, string | undefined> = process.env): Promise<Config> {
  return readConfig(env, await resolveApiKey(env));
}

export function buildRequest(stateText: string, questions: Question[], model: string) {
  if (!model.trim()) throw new Error("Model must not be empty.");
  if (questions.length < 1 || questions.length > 64) throw new Error("Provide 1–64 questions per call.");
  const mapped: Record<string, Omit<Question, "id">> = Object.create(null);
  for (const [index, q] of questions.entries()) {
    const id = q.id ?? `q${index + 1}`;
    if (!id.trim() || Object.hasOwn(mapped, id)) throw new Error("Question IDs must be nonempty and unique (including generated IDs).");
    if (!q.instructions.trim()) throw new Error("Question instructions must not be empty.");
    const c = q.criteria;
    if (q.type === "choice") {
      if (!record(c) || Object.keys(c).length < 1 || Object.keys(c).length > 255 || !Object.values(c).every(v => v === null || rubric(v))) {
        throw new Error("Choice requires a map of 1–255 options to descriptions or null.");
      }
    } else if (q.type === "score") {
      if (!Array.isArray(c) || c.length < 2 || c.length > 10 || !c.every(rubric)) throw new Error("Score requires 2–10 ordered level descriptions.");
    } else if (q.type === "noul") {
      if (c !== undefined && (!record(c) || !Object.entries(c).every(([k, v]) => ["true", "false"].includes(k) && rubric(v)))) {
        throw new Error("Noul criteria may contain only true/false descriptions.");
      }
    } else throw new Error("Unknown question type.");
    mapped[id] = { type: q.type, instructions: q.instructions, ...(c === undefined ? {} : { criteria: c }) };
  }
  let state: unknown = stateText;
  try {
    const parsed: unknown = JSON.parse(stateText);
    if (record(parsed) || Array.isArray(parsed) || typeof parsed === "string") state = parsed;
  } catch { /* Plain text is valid state. */ }
  const request = { state, model, questions: mapped };
  if (new TextEncoder().encode(JSON.stringify(request)).byteLength > 256 * 1024) throw new Error("TypeSafe request exceeds the extension's 256 KiB limit.");
  return request;
}

export interface Result {
  model: string;
  answers: Record<string, Record<string, unknown>>;
  usage: { input_tokens: number; output_tokens: number };
}
export function validateResponse(value: unknown, request: ReturnType<typeof buildRequest>): Result {
  const invalid = () => { throw new Error("TypeSafe returned an invalid or incomplete response."); };
  if (!record(value) || typeof value.model !== "string" || !record(value.answers) || !record(value.usage)) return invalid();
  for (const [id, q] of Object.entries(request.questions)) {
    const a = value.answers[id];
    if (!record(a) || a.type !== q.type) return invalid();
    if (q.type === "noul") {
      if (!probability(a.noul)) return invalid();
    } else {
      if (!probability(a.confidence) || !record(a.probabilities) || !Object.values(a.probabilities).every(probability)) return invalid();
      const keys = q.type === "choice" ? Object.keys(q.criteria as object) : (q.criteria as unknown[]).map((_, i) => String(i));
      if (Object.keys(a.probabilities).length !== keys.length || !keys.every(k => Object.hasOwn(a.probabilities as object, k))) return invalid();
      if (Math.abs(Object.values(a.probabilities).reduce<number>((sum, p) => sum + (p as number), 0) - 1) > 0.01) return invalid();
      if (q.type === "choice" && (typeof a.choice !== "string" || !keys.includes(a.choice))) return invalid();
      if (q.type === "score" && (typeof a.score !== "number" || !Number.isFinite(a.score) || a.score < 0 || a.score > keys.length - 1 || !record(a.legend))) return invalid();
    }
  }
  for (const key of ["input_tokens", "output_tokens"]) {
    const n = value.usage[key];
    if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0) return invalid();
  }
  return value as unknown as Result;
}

export async function ask(
  config: Config, request: ReturnType<typeof buildRequest>, signal?: AbortSignal,
  timeoutMs = 30_000, fetcher: typeof fetch = fetch,
): Promise<Result> {
  if (!config.apiKey) throw new Error("No TypeSafe credential. Add a `typesafe` entry to ~/.pi/agent/auth.json (or set TYPESAFE_API_KEY), then restart Pi. Jev is a tool, not a subagent.");
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  const timer = setTimeout(abort, timeoutMs);
  try {
    controller.signal.throwIfAborted();
    const response = await fetcher(`${config.baseUrl}/systemone`, {
      method: "POST", redirect: "error", signal: controller.signal,
      headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });
    if (!response.ok) {
      await response.body?.cancel();
      // Never echo upstream bodies: they can contain request state or credentials.
      throw new Error(`TypeSafe HTTP ${response.status}. Check credentials (401), question format (422), or retry later (429/529).`);
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error("TypeSafe returned an empty response.");
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 512 * 1024) {
          await reader.cancel();
          throw new Error("TypeSafe response exceeds the extension's 512 KiB limit.");
        }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    const body = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
    let payload: unknown;
    try { payload = JSON.parse(new TextDecoder().decode(body)); }
    catch { throw new Error("TypeSafe returned invalid JSON."); }
    return validateResponse(payload, request);
  } catch (error) {
    if (controller.signal.aborted) throw new Error(signal?.aborted ? "TypeSafe request cancelled." : "TypeSafe request timed out.");
    if (error instanceof Error && error.message.startsWith("TypeSafe ")) throw error;
    throw new Error("TypeSafe network request failed. Check the endpoint and network connection.");
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

export async function precheck(config: Config, prompt: string, signal?: AbortSignal, fetcher: typeof fetch = fetch): Promise<number | undefined> {
  if (!config.auto || !config.apiKey || prompt.trim().length < 15 || prompt.length > 16_000) return;
  try {
    const request = buildRequest(prompt, [{ id: "needs_jev", type: "noul", instructions:
      "Would this request benefit from calibrated judgment (classification, ranking, scoring, verification, or choosing between alternatives), rather than just mechanical editing or factual lookup?" }], config.model);
    const result = await ask(config, request, signal, 8_000, fetcher);
    const p = result.answers.needs_jev.noul as number;
    if (p >= config.threshold) return p;
  } catch { /* Optional advice must not prevent the main agent from working. */ }
}
