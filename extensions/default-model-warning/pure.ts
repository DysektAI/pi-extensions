import { readFileSync } from "node:fs";
import { join } from "node:path";

interface Storage {
 withLock(scope: "global" | "project", fn: (current: string | undefined) => string | undefined): void;
}
interface Defaults {
 getDefaultProvider(): string | undefined;
 getDefaultModel(): string | undefined;
 drainErrors(): unknown[];
}
interface Context {
 cwd: string;
 hasUI: boolean;
 model?: {provider: string; id: string};
 isProjectTrusted(): boolean;
 sessionManager: { getSessionId(): string };
 ui: { notify(message: string, level: "warning"): void };
}

/** No mkdir, locks, migrations on disk, or writes; even accidental writes are rejected. */
export function readOnlySettingsStorage(cwd: string, agentDir: string): Storage {
 return {withLock(scope, fn) {
  let text: string | undefined;
  try { text = readFileSync(join(scope === "global" ? agentDir : join(cwd,".pi"),"settings.json"),"utf8"); }
  catch(error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (text !== undefined) {
   const parsed: unknown = JSON.parse(text.replace(/^\uFEFF/, ""));
   if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid settings object");
  }
  if (fn(text) !== undefined) throw new Error("Default-model check cannot write settings");
 }};
}

export function createDefaultModelCheck(
 agentDir: () => string,
 fromStorage: (storage: Storage, options: {projectTrusted: boolean}) => Defaults,
) {
 const checked = new Set<string>();
 return (event: {reason: string}, ctx: Context): void => {
  if ((event.reason !== "startup" && event.reason !== "new") || !ctx.hasUI) return;
  const sessionId = ctx.sessionManager.getSessionId();
  if (checked.has(sessionId)) return;
  checked.add(sessionId);
  try {
   const settings = fromStorage(readOnlySettingsStorage(ctx.cwd,agentDir()), {projectTrusted: ctx.isProjectTrusted()});
   if (settings.drainErrors().length) throw new Error("Settings unavailable");
   const provider = settings.getDefaultProvider(), id = settings.getDefaultModel();
   if (!provider || !id || typeof provider !== "string" || typeof id !== "string") return;
   const configured = `${provider}/${id}`;
   const active = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "(no active model)";
   if (active !== configured) ctx.ui.notify(`Active model ${active} differs from configured default ${configured}. This may reflect an intentional override or fallback.`, "warning");
  } catch {
   // Settings parser/I/O errors can quote sensitive fields; never echo them.
   ctx.ui.notify("Configured default-model check unavailable — settings could not be read", "warning");
  }
 };
}
