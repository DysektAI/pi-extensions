// Warm-LSP extension for pi.
// Keeps one language server per (language, project-root) alive for the whole
// session, so the agent gets type errors / references / hover without paying a
// cold tsc-style process start on every call.
//
// Servers are spawned lazily on first tool use (never in the factory, per docs)
// and killed on session_shutdown. Pure JSON-RPC over stdio, no npm deps.
//
// ponytail: hand-rolled minimal LSP client. add a real lib only if this falls short.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve, relative } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

// ---------------------------------------------------------------------------
// Language registry: extension -> server. command must be on PATH.
// markers are walked up from the file to find the project root.
// ---------------------------------------------------------------------------
export type Lang = {
  key: string;
  cmd: string;
  args: string[];
  languageId: string;
  markers: string[];
  extensions: string[];
  install: string;
};
export const LANGS: Lang[] = [
  { key: "typescript", cmd: "typescript-language-server", args: ["--stdio"], languageId: "typescript",
    markers: ["tsconfig.json", "package.json", "jsconfig.json"], extensions: ["ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts"],
    install: "npm i -g typescript-language-server typescript" },
  { key: "python", cmd: "pyright-langserver", args: ["--stdio"], languageId: "python",
    markers: ["pyproject.toml", "setup.py", "setup.cfg", "requirements.txt", "Pipfile"], extensions: ["py", "pyi"],
    install: "npm i -g pyright  (or pipx install pyright)" },
  { key: "rust", cmd: "rust-analyzer", args: [], languageId: "rust",
    markers: ["Cargo.toml"], extensions: ["rs"], install: "rustup component add rust-analyzer" },
  { key: "go", cmd: "gopls", args: [], languageId: "go",
    markers: ["go.mod", "go.work"], extensions: ["go"], install: "go install golang.org/x/tools/gopls@latest" },
  { key: "csharp", cmd: "csharp-ls", args: [], languageId: "csharp",
    markers: ["*.sln", "*.slnx", "global.json", "Directory.Build.props", "*.csproj"], extensions: ["cs"],
    install: "dotnet tool install --global csharp-ls" },
];
const EXT_TO_LANG: Record<string, Lang> = {};
for (const lang of LANGS) {
  for (const ext of lang.extensions) EXT_TO_LANG[ext] = lang;
}

export function langFor(file: string): Lang | null {
  const ext = file.split(".").pop()?.toLowerCase() ?? "";
  return EXT_TO_LANG[ext] ?? null;
}

export function supportedLanguages(): string {
  return "TS/JS, Python, Rust, Go, C#";
}

const isInstalled = (() => {
  const cache = new Map<string, boolean>();
  return (cmd: string) => {
    if (!cache.has(cmd)) {
      // cmd comes only from the static LANGS table above, so this is safe.
      const r = spawnSync("bash", ["-c", `command -v ${cmd}`], { encoding: "utf8" });
      cache.set(cmd, r.status === 0);
    }
    return cache.get(cmd)!;
  };
})();

function hasMarker(dir: string, marker: string): boolean {
  if (!marker.startsWith("*.")) return existsSync(join(dir, marker));
  try {
    const suffix = marker.slice(1).toLowerCase();
    return readdirSync(dir).some((entry) => entry.toLowerCase().endsWith(suffix));
  } catch {
    return false;
  }
}

export function findRoot(file: string, markers: string[], preferSolution = false): string {
  const fallback = dirname(resolve(file));
  const dirs: string[] = [];
  let dir = fallback;
  for (;;) {
    dirs.push(dir);
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  if (preferSolution) {
    // C# should load a solution containing the file's nearest project. Ignore
    // unrelated solution files above the first project/config boundary.
    const boundaryIndex = dirs.findIndex((candidate) =>
      markers.slice(2).some((marker) => hasMarker(candidate, marker))
    );
    const solutionSearchDirs = boundaryIndex >= 0 ? dirs.slice(0, boundaryIndex + 3) : dirs;
    for (const marker of markers.slice(0, 2)) {
      const match = solutionSearchDirs.find((candidate) => hasMarker(candidate, marker));
      if (match) return match;
    }
    if (boundaryIndex >= 0) return dirs[boundaryIndex];
    return fallback;
  }

  for (const candidate of dirs) {
    if (markers.some((marker) => hasMarker(candidate, marker))) return candidate;
  }
  return fallback;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
function withTimeout<T, S>(p: Promise<T>, ms: number, sentinel: S): Promise<T | S> {
  let t: NodeJS.Timeout;
  return Promise.race([p, new Promise<S>((r) => { t = setTimeout(() => r(sentinel), ms); })])
    .finally(() => clearTimeout(t)) as Promise<T | S>;
}

const SEV = ["", "error", "warning", "info", "hint"];

export function isServerRequest(msg: any): boolean {
  return msg.id !== undefined && typeof msg.method === "string";
}

// ---------------------------------------------------------------------------
// Minimal LSP client over stdio.
// ---------------------------------------------------------------------------
type Diagnostic = { range: any; severity?: number; message: string; source?: string; code?: any };

class LspClient {
  private proc: ChildProcess;
  private buf = Buffer.alloc(0);
  private id = 0;
  private pending = new Map<number, { resolve: (r: any) => void; timer: NodeJS.Timeout }>();
  private diagWaiters: Array<{ uri: string; resolve: (d: Diagnostic[]) => void }> = [];
  private latestDiags = new Map<string, Diagnostic[]>();
  private versions = new Map<string, number>();
  private opened = new Set<string>();
  private workspaceReady = Promise.resolve();
  private finishWorkspaceLoad: (() => void) | null = null;
  lastDiagAt = 0;
  ready: Promise<boolean>;
  readonly lang: Lang;
  readonly root: string;

  constructor(lang: Lang, root: string) {
    this.lang = lang;
    this.root = root;
    this.proc = spawn(lang.cmd, lang.args, { cwd: root, stdio: ["pipe", "pipe", "ignore"] });
    this.proc.on("error", () => {}); // surfaced via ready timeout / isInstalled check
    this.proc.stdout!.on("data", (d) => this.onData(d));
    this.ready = this.initialize();
  }

  private onData(d: Buffer) {
    this.buf = Buffer.concat([this.buf, d]);
    for (;;) {
      const sep = this.buf.indexOf("\r\n\r\n");
      if (sep < 0) return;
      const m = /Content-Length:\s*(\d+)/i.exec(this.buf.subarray(0, sep).toString("ascii"));
      if (!m) { this.buf = this.buf.subarray(sep + 4); continue; }
      const len = Number(m[1]);
      const start = sep + 4;
      if (this.buf.length < start + len) return;
      const body = this.buf.subarray(start, start + len).toString("utf8");
      this.buf = this.buf.subarray(start + len);
      let msg: any;
      try { msg = JSON.parse(body); } catch { continue; }
      this.dispatch(msg);
    }
  }

  private dispatch(msg: any) {
    // Server requests have their own id namespace. Check method first so a
    // server request whose id matches one of ours is not mistaken for a reply.
    if (isServerRequest(msg)) {
      let result: any = null;
      if (msg.method === "workspace/configuration") {
        result = (msg.params?.items ?? []).map(() => ({}));
      }
      this.send({ jsonrpc: "2.0", id: msg.id, result });
      return;
    }
    // response to our request
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const pending = this.pending.get(msg.id)!;
      clearTimeout(pending.timer);
      pending.resolve(msg.result);
      this.pending.delete(msg.id);
      return;
    }
    // notifications
    if (msg.method === "$/progress" && msg.params?.value?.kind === "end") {
      this.finishWorkspaceLoad?.();
      this.finishWorkspaceLoad = null;
      return;
    }
    if (msg.method === "window/logMessage" && msg.params?.type === 1) {
      this.finishWorkspaceLoad?.();
      this.finishWorkspaceLoad = null;
      return;
    }
    if (msg.method === "textDocument/publishDiagnostics") {
      const uri: string = msg.params.uri;
      const diags: Diagnostic[] = msg.params.diagnostics ?? [];
      this.latestDiags.set(uri, diags);
      this.lastDiagAt = performance.now();
      for (let i = this.diagWaiters.length - 1; i >= 0; i--) {
        if (this.diagWaiters[i].uri === uri) {
          this.diagWaiters[i].resolve(diags);
          this.diagWaiters.splice(i, 1);
        }
      }
    }
  }

  private send(obj: any) {
    const s = JSON.stringify(obj);
    this.proc.stdin!.write(`Content-Length: ${Buffer.byteLength(s)}\r\n\r\n${s}`);
  }
  private request<T = any>(method: string, params: any): Promise<T> {
    const id = ++this.id;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} request timed out`));
      }, method === "initialize" ? 25000 : 30000);
      this.pending.set(id, { resolve, timer });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }
  private notify(method: string, params: any) { this.send({ jsonrpc: "2.0", method, params }); }
  private nextDiag(uri: string) { return new Promise<Diagnostic[]>((res) => this.diagWaiters.push({ uri, resolve: res })); }
  private drainDiag(uri: string) { this.diagWaiters = this.diagWaiters.filter((w) => w.uri !== uri); }

  private async initialize(): Promise<boolean> {
    const rootUri = pathToFileURL(this.root).href;
    const init = await this.request("initialize", {
      processId: process.pid,
      rootPath: this.root,
      rootUri,
      workspaceFolders: [{ uri: rootUri, name: "root" }],
      capabilities: {
        textDocument: {
          synchronization: { dynamicRegistration: false, didSave: true },
          publishDiagnostics: { relatedInformation: true },
          hover: { contentFormat: ["markdown", "plaintext"] },
          definition: { dynamicRegistration: false },
          references: { dynamicRegistration: false },
        },
        workspace: { configuration: true, workspaceFolders: true },
        window: { workDoneProgress: true },
      },
      initializationOptions: {},
    }).catch(() => null);
    if (init === null) return false;
    if (this.lang.key === "csharp") {
      this.workspaceReady = new Promise<void>((resolve) => { this.finishWorkspaceLoad = resolve; });
      setTimeout(() => {
        this.finishWorkspaceLoad?.();
        this.finishWorkspaceLoad = null;
      }, 60000).unref();
    }
    this.notify("initialized", {});
    return true;
  }

  private async waitUntilWorkspaceReady(): Promise<void> {
    if (this.lang.key === "csharp") await this.workspaceReady;
  }

  /** Open (or re-open) a file with current disk content; returns the text. */
  openFresh(file: string): string {
    const abs = resolve(file);
    const uri = pathToFileURL(abs).href;
    const text = readFileSync(abs, "utf8");
    if (this.opened.has(uri)) { this.notify("textDocument/didClose", { textDocument: { uri } }); this.opened.delete(uri); }
    const version = (this.versions.get(uri) ?? 0) + 1;
    this.versions.set(uri, version);
    this.notify("textDocument/didOpen", { textDocument: { uri, languageId: this.lang.languageId, version, text } });
    this.opened.add(uri);
    return text;
  }

  /** Re-open and wait for the server to publish diagnostics; settle on the final report. */
  async diagnostics(file: string): Promise<{ diags: Diagnostic[]; timedOut: boolean }> {
    const uri = pathToFileURL(resolve(file)).href;
    if (this.lang.key === "csharp") {
      this.openFresh(file);
      await this.waitUntilWorkspaceReady();
      const report = await this.request<any>("textDocument/diagnostic", {
        textDocument: { uri },
      }).catch(() => null);
      if (report === null) return { diags: [], timedOut: true };
      return { diags: report.items ?? [], timedOut: false };
    }

    this.drainDiag(uri); // clear any leftover waiter from a prior timed-out call
    const waiter = this.nextDiag(uri);
    this.openFresh(file);
    let diags = await withTimeout(waiter, 12000, null);
    if (diags === null) return { diags: this.latestDiags.get(uri) ?? [], timedOut: true };
    // server emits a stale empty report on reopen, then syntactic, then semantic:
    // keep taking newer reports until quiet, so we settle on the real (last) one
    for (;;) {
      const more = await withTimeout(this.nextDiag(uri), 500, "DONE" as const);
      if (more === "DONE") break;
      diags = more;
    }
    return { diags, timedOut: false };
  }

  async hover(file: string, pos: { line: number; character: number }) {
    this.openFresh(file);
    await this.waitUntilWorkspaceReady();
    await sleep(150); // let the server index the freshly-opened doc
    return this.request("textDocument/hover", {
      textDocument: { uri: pathToFileURL(resolve(file)).href }, position: pos,
    }).catch(() => null);
  }
  async definition(file: string, pos: { line: number; character: number }) {
    this.openFresh(file);
    await this.waitUntilWorkspaceReady();
    await sleep(150);
    return this.request("textDocument/definition", {
      textDocument: { uri: pathToFileURL(resolve(file)).href }, position: pos,
    }).catch(() => null);
  }
  async references(file: string, pos: { line: number; character: number }) {
    this.openFresh(file);
    await this.waitUntilWorkspaceReady();
    await sleep(150);
    return this.request("textDocument/references", {
      textDocument: { uri: pathToFileURL(resolve(file)).href }, position: pos, context: { includeDeclaration: false },
    }).catch(() => null);
  }

  kill() {
    for (const pending of this.pending.values()) clearTimeout(pending.timer);
    this.pending.clear();
    try { this.proc.kill(); } catch {}
  }
}

// ---------------------------------------------------------------------------
// Helpers shared by the tools
// ---------------------------------------------------------------------------
/** Resolve a 0-based LSP position from explicit line/char (1-based) or a symbol name. */
function resolvePosition(text: string, params: { symbol?: string; line?: number; character?: number }): { line: number; character: number } | { error: string } {
  if (params.line != null) {
    return { line: Math.max(0, params.line - 1), character: Math.max(0, (params.character ?? 1) - 1) };
  }
  if (params.symbol) {
    const lines = text.split("\n");
    const re = new RegExp(`\\b${params.symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
    for (let i = 0; i < lines.length; i++) {
      const c = lines[i].search(re);
      if (c >= 0) return { line: i, character: c };
    }
    return { error: `symbol "${params.symbol}" not found in file` };
  }
  return { error: "provide either `symbol` or `line` (1-based)" };
}

function fmtLocation(loc: any): string {
  const uri = loc.uri ?? loc.targetUri;
  const range = loc.range ?? loc.targetSelectionRange ?? loc.targetRange;
  const p = fileURLToPath(uri);
  const rel = relative(process.cwd(), p);
  return `${rel.startsWith("..") ? p : rel}:${range.start.line + 1}:${range.start.character + 1}`;
}
function hoverText(h: any): string {
  if (!h || !h.contents) return "";
  const c = h.contents;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((x) => (typeof x === "string" ? x : x.value)).join("\n");
  return c.value ?? "";
}
const textResult = (text: string, details: Record<string, unknown> = {}, isError = false) =>
  ({ content: [{ type: "text" as const, text }], details, isError });

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------
export default function (pi: ExtensionAPI) {
  const pool = new Map<string, LspClient>(); // key: `${lang.key}::${root}`

  /** Get-or-spawn a warm server for this file. Returns client or an error string. */
  async function serverFor(file: string, ctx: ExtensionContext): Promise<LspClient | string> {
    const abs = resolve(file);
    if (!existsSync(abs)) return `file not found: ${file}`;
    const lang = langFor(abs);
    if (!lang) return `no language server configured for ${file} (supported: ${supportedLanguages()})`;
    if (!isInstalled(lang.cmd)) return `${lang.cmd} is not installed. Install with: ${lang.install}`;
    const root = findRoot(abs, lang.markers, lang.key === "csharp");
    const key = `${lang.key}::${root}`;
    let client = pool.get(key);
    if (!client) {
      client = new LspClient(lang, root);
      pool.set(key, client);
      ctx.ui.setStatus("lsp", `lsp: starting ${lang.cmd}…`);
    }
    const ok = await client.ready;
    if (!ok) { client.kill(); pool.delete(key); return `${lang.cmd} failed to initialize (timed out)`; }
    ctx.ui.setStatus("lsp", `lsp: ${pool.size} server${pool.size === 1 ? "" : "s"} warm`);
    return client;
  }

  pi.on("session_shutdown", async () => {
    for (const c of pool.values()) c.kill();
    pool.clear();
  });

  const posParams = {
    file: Type.String({ description: "Path to the source file." }),
    symbol: Type.Optional(Type.String({ description: "Symbol name to locate (first occurrence). Use this OR line/character." })),
    line: Type.Optional(Type.Number({ description: "1-based line number (overrides symbol)." })),
    character: Type.Optional(Type.Number({ description: "1-based column. Defaults to 1." })),
  };

  // ---- diagnostics ----
  pi.registerTool({
    name: "lsp_diagnostics",
    label: "LSP Diagnostics",
    description: "Get type/compiler errors and warnings for a file from a warm language server (TS/JS, Python, Rust, Go, C#). Faster and more accurate than running a full build; use after editing a file to check it still type-checks.",
    promptSnippet: "Get type errors/warnings for a file via a warm language server",
    promptGuidelines: ["Use lsp_diagnostics after editing a TS/JS/Python/Rust/Go/C# file to verify it type-checks, instead of running a full build for a quick check."],
    parameters: Type.Object({ file: Type.String({ description: "Path to the source file to check." }) }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const c = await serverFor(params.file, ctx);
      if (typeof c === "string") return textResult(c, {}, true);
      const { diags, timedOut } = await c.diagnostics(params.file);
      if (timedOut && diags.length === 0) return textResult(`No diagnostics received within timeout for ${params.file} (server may not push on open).`, { timedOut });
      if (diags.length === 0) return textResult(`No problems found in ${params.file}.`, { count: 0 });
      const lines = diags
        .sort((a, b) => (a.severity ?? 1) - (b.severity ?? 1) || a.range.start.line - b.range.start.line)
        .map((d) => {
          const code = d.code != null ? ` ${d.source ?? ""}${d.source ? "/" : ""}${d.code}` : d.source ? ` ${d.source}` : "";
          return `${d.range.start.line + 1}:${d.range.start.character + 1} ${SEV[d.severity ?? 1]}: ${d.message.replace(/\n/g, " ")}${code}`;
        });
      const errors = diags.filter((d) => (d.severity ?? 1) === 1).length;
      return textResult(`${params.file}\n${lines.join("\n")}`, { count: diags.length, errors });
    },
  });

  // ---- references ----
  pi.registerTool({
    name: "lsp_references",
    label: "LSP Find References",
    description: "Find all references to a symbol using semantic analysis (real call sites, not text matches). More precise than grep for renaming or impact analysis. Give a symbol name or an exact line/column.",
    promptSnippet: "Find semantic references to a symbol (more precise than grep)",
    promptGuidelines: ["Prefer lsp_references over grep when you need exact call sites of a symbol in TS/JS/Python/Rust/Go/C# code (e.g. before renaming or assessing impact)."],
    parameters: Type.Object(posParams),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const c = await serverFor(params.file, ctx);
      if (typeof c === "string") return textResult(c, {}, true);
      const text = c.openFresh(params.file);
      const pos = resolvePosition(text, params);
      if ("error" in pos) return textResult(pos.error, {}, true);
      const res = await c.references(params.file, pos);
      if (res === null) return textResult("references request timed out", {}, true);
      const locs = (res as any[]) ?? [];
      if (locs.length === 0) return textResult("No references found.", { count: 0 });
      return textResult(`${locs.length} reference(s):\n${locs.map(fmtLocation).join("\n")}`, { count: locs.length });
    },
  });

  // ---- definition ----
  pi.registerTool({
    name: "lsp_definition",
    label: "LSP Go to Definition",
    description: "Jump to where a symbol is defined using semantic analysis. Give a symbol name or an exact line/column.",
    promptSnippet: "Find where a symbol is defined (semantic go-to-definition)",
    parameters: Type.Object(posParams),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const c = await serverFor(params.file, ctx);
      if (typeof c === "string") return textResult(c, {}, true);
      const text = c.openFresh(params.file);
      const pos = resolvePosition(text, params);
      if ("error" in pos) return textResult(pos.error, {}, true);
      const res = await c.definition(params.file, pos);
      if (res === null) return textResult("definition request timed out", {}, true);
      const locs = Array.isArray(res) ? res : res ? [res] : [];
      if (locs.length === 0) return textResult("No definition found.", { count: 0 });
      return textResult(locs.map(fmtLocation).join("\n"), { count: locs.length });
    },
  });

  // ---- hover ----
  pi.registerTool({
    name: "lsp_hover",
    label: "LSP Hover",
    description: "Get the type signature and documentation for a symbol (hover info). Give a symbol name or an exact line/column.",
    promptSnippet: "Get type signature + docs for a symbol (hover)",
    parameters: Type.Object(posParams),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const c = await serverFor(params.file, ctx);
      if (typeof c === "string") return textResult(c, {}, true);
      const text = c.openFresh(params.file);
      const pos = resolvePosition(text, params);
      if ("error" in pos) return textResult(pos.error, {}, true);
      const res = await c.hover(params.file, pos);
      if (res === null) return textResult("hover request timed out", {}, true);
      const t = hoverText(res);
      return t ? textResult(t, {}) : textResult("No hover info at that position.", {});
    },
  });

  // ---- /lsp status command ----
  pi.registerCommand("lsp", {
    description: "Show language-server status (installed servers and warm sessions)",
    handler: async (_args, ctx) => {
      const lines = ["Language servers:"];
      for (const l of LANGS) {
        const warm = [...pool.values()].filter((c) => c.lang.key === l.key).map((c) => relative(process.cwd(), c.root) || ".");
        const state = !isInstalled(l.cmd) ? "not installed" : warm.length ? `warm: ${warm.join(", ")}` : "available";
        lines.push(`  ${l.cmd.padEnd(28)} (${l.key}) — ${state}`);
      }
      lines.push("", "Tools: lsp_diagnostics, lsp_references, lsp_definition, lsp_hover");
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
