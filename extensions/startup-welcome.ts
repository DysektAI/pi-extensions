/**
 * startup-welcome.ts
 *
 * Dysekt AI startup experience. Replaces Pi's built-in startup header with a
 * single, branded Dysekt AI surface via `ctx.ui.setHeader()`.
 *
 * Because this is registered as the header (not a chat message), `Ctrl+O`
 * (app.tools.expand) toggles its collapsed/expanded state through Pi's own
 * expansion machinery — the same key that expands tool output and the
 * built-in header. There is no second static welcome block.
 *
 *   Collapsed  →  logo + identity line + quick keys + compact status.
 *   Expanded   →  full keybindings, skills, prompts, extensions, themes.
 *
 * Pi's own duplicate resource listing ([Skills]/[Prompts]/[Extensions]/
 * [Themes]) and built-in header are suppressed via the `quietStartup`
 * setting so Dysekt AI is the only startup surface.
 */

import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { VERSION } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

// ═══════════════════════════════════════════════════════════════════════════
// Dysekt AI ASCII art (ANSI Shadow / Big block style)
// ═══════════════════════════════════════════════════════════════════════════

const DYSEKT_LOGO: string[] = [
  "██████╗ ██╗   ██╗███████╗███████╗██╗  ██╗████████╗     █████╗ ██╗",
  "██╔══██╗╚██╗ ██╔╝██╔════╝██╔════╝██║ ██╔╝╚══██╔══╝    ██╔══██╗██║",
  "██║  ██║ ╚████╔╝ ███████╗█████╗  █████╔╝    ██║       ███████║██║",
  "██║  ██║  ╚██╔╝  ╚════██║██╔══╝  ██╔═██╗    ██║       ██╔══██║██║",
  "██████╔╝   ██║   ███████║███████╗██║  ██╗   ██║       ██║  ██║██║",
  "╚═════╝    ╚═╝   ╚══════╝╚══════╝╚═╝  ╚═╝   ╚═╝       ╚═╝  ╚═╝╚═╝",
];

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Resolve Pi's version from the canonical exported constant. Returns undefined
 * for any unusable value so callers can omit the version segment entirely
 * rather than ever rendering "vunknown"/"undefined"/"null".
 */
function getPiVersion(): string | undefined {
  const v = typeof VERSION === "string" ? VERSION.trim() : "";
  if (!v) return undefined;
  const lowered = v.toLowerCase();
  if (lowered === "unknown" || lowered === "undefined" || lowered === "null") {
    return undefined;
  }
  if (v === "0.0.0") return undefined;
  return v;
}

function ansiPad(s: string, width: number): string {
  const w = visibleWidth(s);
  return s + " ".repeat(Math.max(0, width - w));
}

// ═════════════════════════════════════════════════════════════════════════════════════
// Gradient helpers — true vertical fade for the logo
//
// The Theme API only exposes fixed named tokens via `fg()`, which is why the
// old banner could only ever do a hard "split" (accent rows on top, dim rows
// below). To get a real fade we emit our own ANSI color escapes, interpolating
// RGB across the logo rows. On truecolor terminals this is a smooth 24-bit
// gradient; on 256-color terminals we down-quantize to the xterm cube so it
// still fades instead of banding to two colors.
// ═════════════════════════════════════════════════════════════════════════════════════

interface Rgb {
  r: number;
  g: number;
  b: number;
}

function hexToRgb(hex: string): Rgb {
  const h = hex.replace(/^#/, "");
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

function lerp(a: number, b: number, t: number): number {
  return Math.round(a + (b - a) * t);
}

function lerpRgb(a: Rgb, b: Rgb, t: number): Rgb {
  return { r: lerp(a.r, b.r, t), g: lerp(a.g, b.g, t), b: lerp(a.b, b.b, t) };
}

/** Map a 0-255 channel to the 0-5 xterm cube axis. */
function cubeAxis(v: number): number {
  if (v < 48) return 0;
  if (v < 115) return 1;
  return Math.min(5, Math.round((v - 35) / 40));
}

/** Nearest xterm-256 color index for an RGB triple (6×6×6 cube). */
function rgbToAnsi256(c: Rgb): number {
  return 16 + 36 * cubeAxis(c.r) + 6 * cubeAxis(c.g) + cubeAxis(c.b);
}

/** Wrap text in a foreground color escape matched to the terminal color mode. */
function colorize(c: Rgb, mode: string, text: string): string {
  const open =
    mode === "truecolor"
      ? `\x1b[38;2;${c.r};${c.g};${c.b}m`
      : `\x1b[38;5;${rgbToAnsi256(c)}m`;
  return `${open}${text}\x1b[39m`;
}

// Gradient endpoints: warm Dysekt gold fading to a cool slate grey. Tuned to
// sit on top of the dysekt-matte palette (accent #D4C97E → muted slate).
const GRADIENT_TOP = hexToRgb("#E6D98A");
const GRADIENT_BOTTOM = hexToRgb("#6E767C");

/** Colorize the logo rows as a smooth top-to-bottom fade. */
function renderLogoGradient(mode: string): string[] {
  const n = DYSEKT_LOGO.length;
  return DYSEKT_LOGO.map((line, i) => {
    const t = n > 1 ? i / (n - 1) : 0;
    const c = lerpRgb(GRADIENT_TOP, GRADIENT_BOTTOM, t);
    return "  " + colorize(c, mode, line);
  });
}

/** Build a column-major grid with truncated cells. */
function buildGrid(
  items: string[],
  cols: number,
  colWidth: number,
  render: (item: string) => string
): string[][] {
  if (items.length === 0) return [];
  const rows = Math.ceil(items.length / cols);
  const grid: string[][] = Array.from({ length: rows }, () => new Array(cols).fill(""));

  for (let i = 0; i < items.length; i++) {
    const row = i % rows;
    const col = Math.floor(i / rows);
    grid[row]![col] = render(items[i]!);
  }

  return grid.map((row) =>
    row.map((cell) => truncateToWidth(ansiPad(cell, colWidth), colWidth))
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Panel data
// ═══════════════════════════════════════════════════════════════════════════

/** Static resources discovered once at startup. */
interface ResourceData {
  skills: string[];
  prompts: string[];
  extensions: string[];
  themes: string[];
}

/** Live session state, read fresh on every render so it never goes stale. */
interface LiveState {
  modelId: string;
  provider: string;
  thinkLevel: string;
}

type PanelData = ResourceData & LiveState;

// ═══════════════════════════════════════════════════════════════════════════
// Render helpers — bound to the active theme
// ═══════════════════════════════════════════════════════════════════════════

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
const THINKING_LEVELS: readonly ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

interface Palette {
  acc: (s: string) => string;
  dim: (s: string) => string;
  txt: (s: string) => string;
  mut: (s: string) => string;
  think: (level: string, s: string) => string;
  mode: string;
}

function makePalette(theme: Theme): Palette {
  return {
    acc: (s) => theme.fg("accent", s),
    dim: (s) => theme.fg("dim", s),
    txt: (s) => theme.fg("text", s),
    mut: (s) => theme.fg("muted", s),
    // Match the input bar: each thinking level maps to its dedicated theme
    // token via getThinkingBorderColor, so the banner stays consistent with the
    // editor border color as the level changes (Ctrl+T / settings).
    think: (level, s) => {
      const lvl = (THINKING_LEVELS as readonly string[]).includes(level)
        ? (level as ThinkingLevel)
        : "off";
      return theme.getThinkingBorderColor(lvl)(s);
    },
    mode: theme.getColorMode(),
  };
}

/** Logo + identity line, shared by collapsed and expanded views. */
function renderBanner(data: PanelData, p: Palette): string[] {
  const lines: string[] = [];
  lines.push(...renderLogoGradient(p.mode));

  const version = getPiVersion();
  const idParts = [
    version ? p.dim(`pi v${version}`) : undefined,
    p.acc(data.modelId),
    p.dim("thinking: ") + p.think(data.thinkLevel, data.thinkLevel),
  ].filter((s): s is string => Boolean(s));
  lines.push("  " + idParts.join(p.mut(" · ")));
  return lines;
}

/** Compact provider/status — provider name only, never credentials or tokens. */
function renderStatus(data: PanelData, p: Palette): string {
  return "  " + p.dim("provider: ") + p.txt(data.provider);
}

function renderQuickKeys(p: Palette, contentW: number): string[] {
  const lines: string[] = [];
  lines.push("  " + p.acc("Quick Keys"));
  const keys: [string, string, string, string][] = [
    ["Esc", "interrupt", "!", "bash mode"],
    ["/", "commands", "Ctrl+O", "help & resources"],
    ["Ctrl+Shift+Tab", "model selector", "Ctrl+D", "clear / exit"],
  ];
  // Key columns must be wide enough for the longest key in each column, plus a
  // guaranteed gap before the label. Otherwise long keys like "Ctrl+Shift+Tab"
  // collide with their description (padEnd never shrinks an already-long key).
  const leftKeyW = Math.max(...keys.map(([k]) => k.length)) + 2;
  const rightKeyW = Math.max(...keys.map(([, , k]) => k.length)) + 2;
  const halfW = Math.floor(contentW / 2);
  for (const [k1, v1, k2, v2] of keys) {
    const left = p.acc(k1.padEnd(leftKeyW)) + p.dim(v1);
    const right = p.acc(k2.padEnd(rightKeyW)) + p.dim(v2);
    lines.push("  " + ansiPad(left, halfW - 1) + ansiPad(right, contentW - halfW));
  }
  return lines;
}

function renderResourceSection(
  title: string,
  items: string[],
  p: Palette,
  contentW: number,
  maxCols: number,
  maxColWidth: number
): string[] {
  if (items.length === 0) return [];
  const lines: string[] = [];
  lines.push("  " + p.acc(title) + p.dim(` (${items.length})`));

  let cols = 1;
  for (let c = maxCols; c >= 1; c--) {
    if (items.length >= c) {
      cols = c;
      break;
    }
  }
  const colWidth = Math.min(Math.floor((contentW - 4) / cols), maxColWidth);
  const grid = buildGrid(items, cols, colWidth, (s) => p.dim("· ") + p.txt(s));
  for (const row of grid) {
    lines.push("  " + row.join("  ").replace(/\s+$/, ""));
  }
  return lines;
}

// ═══════════════════════════════════════════════════════════════════════════
// Collapsed / expanded views
// ═══════════════════════════════════════════════════════════════════════════

function renderCollapsed(data: PanelData, p: Palette, width: number): string[] {
  const contentW = Math.max(20, width - 2);
  const lines: string[] = [""];
  lines.push(...renderBanner(data, p));
  lines.push(renderStatus(data, p));
  lines.push("");
  lines.push(...renderQuickKeys(p, contentW));
  lines.push("");
  lines.push("  " + p.dim(`Press Ctrl+O for full help, skills, prompts, extensions & themes.`));
  lines.push("");
  return lines;
}

function renderExpanded(data: PanelData, p: Palette, width: number): string[] {
  const contentW = Math.max(20, width - 2);
  const lines: string[] = [""];
  lines.push(...renderBanner(data, p));
  lines.push(renderStatus(data, p));
  lines.push("");
  lines.push(...renderQuickKeys(p, contentW));
  lines.push("");

  const sections: [string, string[], number, number][] = [
    ["Skills", data.skills, 4, 20],
    ["Prompts", data.prompts, 3, 24],
    ["Extensions", data.extensions, 3, 20],
    ["Themes", data.themes, 3, 18],
  ];
  for (const [title, items, maxCols, maxColW] of sections) {
    const section = renderResourceSection(title, items, p, contentW, maxCols, maxColW);
    if (section.length > 0) {
      lines.push(...section);
      lines.push("");
    }
  }

  lines.push("  " + p.dim(`Press Ctrl+O to collapse. Ask Pi how to use or extend any of the above.`));
  lines.push("");
  return lines;
}

// ═══════════════════════════════════════════════════════════════════════════
// Extension
// ═══════════════════════════════════════════════════════════════════════════

export default function (pi: ExtensionAPI) {
  // Backward compatibility: older builds injected the welcome as a persisted
  // `startup-welcome` custom message. Neutralize those legacy entries on resume
  // so they render as nothing instead of a broken/placeholder block.
  pi.registerMessageRenderer("startup-welcome", () => ({
    render: () => [],
    invalidate() {},
  }));

  pi.on("session_start", async (event, ctx) => {
    if (event.reason !== "startup") return;
    if (!ctx.hasUI) return;

    const commands = pi.getCommands();

    const skills = commands
      .filter((c) => c.source === "skill")
      .map((c) => c.name.replace(/^skill:/, ""))
      .sort((a, b) => a.localeCompare(b));

    const prompts = commands
      .filter((c) => c.source === "prompt")
      .map((c) => `/${c.name}`)
      .sort((a, b) => a.localeCompare(b));

    // Public source metadata provides a best-effort inventory. Extensions with
    // only event handlers cannot be enumerated through the upstream API.
    const extensions = [...new Set([
      ...pi.getAllTools(),
      ...commands.filter((command) => command.source === "extension"),
    ].flatMap((resource) => {
      const path = resource.sourceInfo?.path;
      // Synthetic sources (<builtin:bash>, <inline:...>) are not extension files.
      if (!path || path.startsWith("<") || path.startsWith("builtin:")) return [];
      const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
      const name = (parts.pop() ?? "").replace(/\.[^.]+$/, "");
      if (name !== "index") return [name];
      // index.ts names its directory; package layouts use the package dir (pi-lsp/src/index.ts).
      let dir = parts.pop() ?? name;
      if (["src", "dist", "lib"].includes(dir)) dir = parts.pop() ?? dir;
      return [dir];
    }))].sort((a, b) => a.localeCompare(b));

    const themes = ctx.ui
      .getAllThemes()
      .map((t) => t.name)
      .filter((n): n is string => Boolean(n))
      .sort((a, b) => a.localeCompare(b));

    const resources: ResourceData = {
      skills,
      prompts,
      extensions,
      themes,
    };

    // Live session state, seeded now and updated by model/thinking events so the
    // header reflects Ctrl+P / Ctrl+T changes made after startup.
    const liveState: LiveState = {
      modelId: ctx.model?.id ?? "no model",
      provider: ctx.model?.provider ?? "none",
      thinkLevel: pi.getThinkingLevel(),
    };

    let invalidateHeader: (() => void) | undefined;
    let requestRender: (() => void) | undefined;

    ctx.ui.setHeader((tui, theme) => {
      requestRender = () => tui.requestRender();
      let expanded = false;
      let cachedLines: string[] | undefined;
      let cachedWidth: number | undefined;
      let cachedExpanded: boolean | undefined;
      let cachedStateKey: string | undefined;

      const clearCache = () => {
        cachedLines = undefined;
        cachedWidth = undefined;
        cachedExpanded = undefined;
        cachedStateKey = undefined;
      };
      invalidateHeader = clearCache;

      return {
        render(width: number): string[] {
          const stateKey = `${liveState.modelId}|${liveState.provider}|${liveState.thinkLevel}`;
          if (
            cachedLines &&
            cachedWidth === width &&
            cachedExpanded === expanded &&
            cachedStateKey === stateKey
          ) {
            return cachedLines;
          }
          const p = makePalette(theme);
          const data: PanelData = { ...resources, ...liveState };
          cachedLines = (expanded
            ? renderExpanded(data, p, width)
            : renderCollapsed(data, p, width)
          ).map((line) => truncateToWidth(line, Math.max(0, width)));
          cachedWidth = width;
          cachedExpanded = expanded;
          cachedStateKey = stateKey;
          return cachedLines;
        },
        setExpanded(value: boolean) {
          expanded = value;
          cachedLines = undefined;
        },
        invalidate() {
          clearCache();
        },
      };
    });

    // Refresh the header when model or thinking level changes after startup.
    // The events carry the new values, so update liveState before re-rendering.
    const refresh = () => {
      invalidateHeader?.();
      requestRender?.();
    };
    pi.on("model_select", async (e) => {
      liveState.modelId = e.model?.id ?? "no model";
      liveState.provider = e.model?.provider ?? "none";
      refresh();
    });
    pi.on("thinking_level_select", async (e) => {
      liveState.thinkLevel = e.level;
      refresh();
    });
  });
}
