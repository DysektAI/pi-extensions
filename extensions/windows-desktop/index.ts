/**
 * Windows Desktop Computer Use Extension for Pi Agent
 *
 * Provides native Windows GUI & desktop automation tools for ANY vision-capable model:
 *   - desktop_screenshot : Capture DPI-aware full screen or monitor view as image
 *   - mouse_click        : Click coordinates with left, right, or middle button
 *   - mouse_move         : Move cursor to coordinates (for hovering)
 *   - mouse_drag         : Drag and drop from start coordinate to end coordinate
 *   - mouse_scroll       : Scroll mouse wheel up or down
 *   - type_text          : Type unicode text into active window
 *   - press_hotkey       : Execute keyboard shortcuts (Win, Ctrl, Alt, Enter, etc.)
 *   - list_windows       : Enumerate active visible top-level windows
 *   - focus_window       : Bring a window to foreground by title or HWND
 *   - get_cursor         : Read current mouse pointer coordinates
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

// Resolve driver script path relative to this extension file
const currentDir = typeof __dirname !== "undefined" 
  ? __dirname 
  : dirname(fileURLToPath(import.meta.url));

import { existsSync } from "node:fs";

const DRIVER_SCRIPT = existsSync(join(currentDir, "driver.py"))
  ? join(currentDir, "driver.py")
  : join(currentDir, "windows-desktop", "driver.py");

async function runDriver(args: string[]): Promise<any> {
  const { stdout, stderr } = await execFileAsync("python", [DRIVER_SCRIPT, ...args], {
    maxBuffer: 50 * 1024 * 1024, // 50MB buffer for base64 PNGs
    encoding: "utf-8",
  });
  
  if (!stdout && stderr) {
    throw new Error(`Windows desktop driver error: ${stderr}`);
  }
  
  try {
    return JSON.parse(stdout);
  } catch (err) {
    throw new Error(`Failed to parse driver output: ${stdout}\nStderr: ${stderr}`);
  }
}

export default function (pi: ExtensionAPI) {
  // Inject instructions into system prompt so the model knows it has desktop capabilities
  pi.on("before_agent_run", async (event) => {
    const promptDirective =
      "\n\n[Windows Desktop Automation Tools Available]\n" +
      "You have direct access to the Windows desktop via native tools:\n" +
      "- 'desktop_screenshot': View the screen. Call this to inspect the desktop state before and after actions.\n" +
      "- 'mouse_click' / 'mouse_drag' / 'mouse_scroll': Interact with GUI buttons, scrollbars, and elements.\n" +
      "- 'type_text' / 'press_hotkey': Enter text and press system shortcuts (e.g. ['win', 'r'], ['ctrl', 's']).\n" +
      "- 'list_windows' / 'focus_window': Inspect running applications and bring target windows to the foreground.\n" +
      "Always verify state visually using 'desktop_screenshot' after significant actions.";

    return { systemPrompt: event.systemPrompt + promptDirective };
  });

  // ─── Tool: desktop_screenshot ─────────────────────────────────────────────
  pi.registerTool({
    name: "desktop_screenshot",
    label: "Desktop Screenshot",
    description:
      "Captures a screenshot of the Windows desktop screen and returns the image directly to the model. " +
      "Also returns screen resolution, display bounds, and cursor coordinates. " +
      "Use this to visually inspect the screen before or after taking actions.",
    promptSnippet: "Capture a screenshot of the Windows desktop",
    promptGuidelines: [
      "Always call desktop_screenshot when you need to see what is currently on the screen.",
      "Use display 0 for the primary monitor. If the user has multiple monitors, you can specify display 1, 2, etc.",
      "To save tokens and speed up response, you can optionally set max_dimension (e.g. 1920 or 1280)."
    ],
    parameters: Type.Object({
      display: Type.Optional(Type.Integer({ description: "Monitor index: 0 for primary (default), 1, 2, etc." })),
      max_dimension: Type.Optional(Type.Integer({ description: "Max dimension in pixels to downscale image (e.g. 1920, 1280). Default: 1920" }))
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      ctx.ui.setStatus("windows-desktop", "📸 Capturing desktop...");
      
      const args = ["screenshot"];
      if (typeof params.display === "number") {
        args.push("--display", String(params.display));
      }
      const maxDim = params.max_dimension ?? 1920;
      args.push("--max-dim", String(maxDim));

      try {
        const res = await runDriver(args);
        ctx.ui.setStatus("windows-desktop", `📸 Captured (${res.width}x${res.height})`);

        const summaryText =
          `Desktop Screenshot captured: ${res.width}x${res.height} ` +
          `(Original Display: ${res.display_bounds.width}x${res.display_bounds.height} at [${res.display_bounds.left}, ${res.display_bounds.top}]). ` +
          `Current cursor at (${res.cursor.x}, ${res.cursor.y}). Scale: ${res.scale}.`;

        return {
          content: [
            { type: "image", data: res.image_b64, mimeType: "image/png" },
            { type: "text", text: summaryText }
          ],
          details: {
            width: res.width,
            height: res.height,
            original_width: res.original_width,
            original_height: res.original_height,
            scale: res.scale,
            cursor: res.cursor,
            bounds: res.display_bounds
          }
        };
      } catch (err: any) {
        ctx.ui.setStatus("windows-desktop", "📸 Error");
        throw err;
      }
    },
    renderCall(args) {
      return new Text(`desktop_screenshot(display=${args.display ?? 0})`);
    }
  });

  // ─── Tool: mouse_click ───────────────────────────────────────────────────
  pi.registerTool({
    name: "mouse_click",
    label: "Mouse Click",
    description:
      "Moves mouse cursor to (x, y) coordinates and performs a click. " +
      "Button can be 'left' (default), 'right', or 'middle'. Set clicks to 2 for a double-click.",
    promptSnippet: "Click at specific screen coordinates",
    promptGuidelines: [
      "Specify x and y coordinates matching the screen or screenshot image.",
      "Set button='right' for context menus, or clicks=2 to open files/folders."
    ],
    parameters: Type.Object({
      x: Type.Integer({ description: "X coordinate (horizontal pixel)" }),
      y: Type.Integer({ description: "Y coordinate (vertical pixel)" }),
      button: Type.Optional(Type.String({ description: "'left', 'right', or 'middle'. Default: 'left'" })),
      clicks: Type.Optional(Type.Integer({ description: "Number of clicks: 1 for single, 2 for double. Default: 1" }))
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const button = params.button ?? "left";
      const clicks = params.clicks ?? 1;
      ctx.ui.setStatus("windows-desktop", `🖱️ ${clicks > 1 ? "Double-clicking" : "Clicking"} (${params.x}, ${params.y})`);

      const args = ["click", String(params.x), String(params.y), "--button", button, "--clicks", String(clicks)];
      const res = await runDriver(args);

      return {
        content: [{ type: "text", text: `Mouse ${button} clicked at (${params.x}, ${params.y}) ${clicks} time(s).` }],
        details: res
      };
    },
    renderCall(args) {
      return new Text(`mouse_click(${args.x}, ${args.y}, button=${args.button ?? "left"})`);
    }
  });

  // ─── Tool: mouse_move ────────────────────────────────────────────────────
  pi.registerTool({
    name: "mouse_move",
    label: "Mouse Move",
    description: "Moves mouse cursor to (x, y) coordinates without clicking (useful for hovers and tooltips).",
    promptSnippet: "Move mouse cursor to coordinates",
    parameters: Type.Object({
      x: Type.Integer({ description: "X coordinate" }),
      y: Type.Integer({ description: "Y coordinate" })
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      ctx.ui.setStatus("windows-desktop", `🖱️ Moving to (${params.x}, ${params.y})`);
      const res = await runDriver(["move", String(params.x), String(params.y)]);
      return {
        content: [{ type: "text", text: `Mouse cursor moved to (${params.x}, ${params.y}).` }],
        details: res
      };
    },
    renderCall(args) {
      return new Text(`mouse_move(${args.x}, ${args.y})`);
    }
  });

  // ─── Tool: mouse_drag ────────────────────────────────────────────────────
  pi.registerTool({
    name: "mouse_drag",
    label: "Mouse Drag",
    description: "Drags from (start_x, start_y) to (end_x, end_y) using the specified mouse button.",
    promptSnippet: "Drag and drop between coordinates",
    parameters: Type.Object({
      start_x: Type.Integer({ description: "Start X coordinate" }),
      start_y: Type.Integer({ description: "Start Y coordinate" }),
      end_x: Type.Integer({ description: "End X coordinate" }),
      end_y: Type.Integer({ description: "End Y coordinate" }),
      button: Type.Optional(Type.String({ description: "'left' (default) or 'right'" }))
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const button = params.button ?? "left";
      ctx.ui.setStatus("windows-desktop", `🖱️ Dragging from (${params.start_x}, ${params.start_y}) to (${params.end_x}, ${params.end_y})`);
      const args = ["drag", String(params.start_x), String(params.start_y), String(params.end_x), String(params.end_y), "--button", button];
      const res = await runDriver(args);
      return {
        content: [{ type: "text", text: `Mouse dragged from (${params.start_x}, ${params.start_y}) to (${params.end_x}, ${params.end_y}).` }],
        details: res
      };
    },
    renderCall(args) {
      return new Text(`mouse_drag(from=[${args.start_x}, ${args.start_y}], to=[${args.end_x}, ${args.end_y}])`);
    }
  });

  // ─── Tool: mouse_scroll ──────────────────────────────────────────────────
  pi.registerTool({
    name: "mouse_scroll",
    label: "Mouse Scroll",
    description: "Scrolls mouse wheel up (positive number) or down (negative number). Optional x and y coordinates to scroll at a specific spot.",
    promptSnippet: "Scroll mouse wheel",
    parameters: Type.Object({
      clicks: Type.Integer({ description: "Positive integer to scroll UP, negative integer to scroll DOWN (e.g. -5 to scroll down)" }),
      x: Type.Optional(Type.Integer({ description: "Optional X coordinate to scroll at" })),
      y: Type.Optional(Type.Integer({ description: "Optional Y coordinate to scroll at" }))
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      ctx.ui.setStatus("windows-desktop", `🖱️ Scrolling (${params.clicks > 0 ? "Up" : "Down"} ${Math.abs(params.clicks)})`);
      const args = ["scroll", String(params.clicks)];
      if (typeof params.x === "number" && typeof params.y === "number") {
        args.push("--x", String(params.x), "--y", String(params.y));
      }
      const res = await runDriver(args);
      return {
        content: [{ type: "text", text: `Scrolled mouse wheel ${params.clicks} clicks.` }],
        details: res
      };
    },
    renderCall(args) {
      return new Text(`mouse_scroll(${args.clicks > 0 ? "+" : ""}${args.clicks})`);
    }
  });

  // ─── Tool: type_text ─────────────────────────────────────────────────────
  pi.registerTool({
    name: "type_text",
    label: "Type Text",
    description: "Types unicode text into the currently active/focused window. Optionally presses Enter after typing.",
    promptSnippet: "Type text into focused element",
    parameters: Type.Object({
      text: Type.String({ description: "Text string to type" }),
      press_enter: Type.Optional(Type.Boolean({ description: "If true, sends an Enter keypress after typing. Default: false" }))
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      ctx.ui.setStatus("windows-desktop", `⌨️ Typing text (${params.text.length} chars)`);
      const args = ["type", params.text];
      if (params.press_enter) {
        args.push("--enter");
      }
      const res = await runDriver(args);
      return {
        content: [{ type: "text", text: `Typed: "${params.text}"${params.press_enter ? " [Enter]" : ""}` }],
        details: res
      };
    },
    renderCall(args) {
      const preview = args.text.length > 20 ? args.text.slice(0, 17) + "..." : args.text;
      return new Text(`type_text("${preview}"${args.press_enter ? ", enter=true" : ""})`);
    }
  });

  // ─── Tool: press_hotkey ──────────────────────────────────────────────────
  pi.registerTool({
    name: "press_hotkey",
    label: "Press Hotkey",
    description:
      "Presses a combination of keys together (e.g. ['win', 'r'], ['ctrl', 's'], ['alt', 'f4'], ['enter']). " +
      "Supported keys: win, ctrl, alt, shift, enter, tab, space, backspace, delete, escape, up, down, left, right, home, end, pageup, pagedown, f1-f12, and any single letter/number.",
    promptSnippet: "Press key combination or shortcut",
    parameters: Type.Object({
      keys: Type.Array(Type.String(), { description: "Array of key names, e.g. ['ctrl', 'shift', 'esc'] or ['win', 'r']" })
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const keysStr = params.keys.join("+");
      ctx.ui.setStatus("windows-desktop", `⌨️ Hotkey: ${keysStr}`);
      const args = ["hotkey", ...params.keys];
      const res = await runDriver(args);
      return {
        content: [{ type: "text", text: `Pressed hotkey: [${keysStr}]` }],
        details: res
      };
    },
    renderCall(args) {
      return new Text(`press_hotkey([${args.keys.join(", ")}])`);
    }
  });

  // ─── Tool: list_windows ──────────────────────────────────────────────────
  pi.registerTool({
    name: "list_windows",
    label: "List Windows",
    description: "Returns all currently visible top-level windows on the Windows desktop with their HWNDs, window titles, and bounding box coordinates.",
    promptSnippet: "List open windows and applications",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      ctx.ui.setStatus("windows-desktop", "🪟 Scanning windows...");
      const res = await runDriver(["list-windows"]);
      const windows: Array<{ hwnd: number; title: string; bounds: number[]; size: number[] }> = res.windows ?? [];

      if (windows.length === 0) {
        return {
          content: [{ type: "text", text: "No visible application windows found." }],
          details: res
        };
      }

      const lines = ["Open Windows on Desktop:\n"];
      for (const w of windows) {
        lines.push(`- [HWND ${w.hwnd}] "${w.title}" (Size: ${w.size[0]}x${w.size[1]}, Bounds: [${w.bounds.join(", ")}])`);
      }

      ctx.ui.setStatus("windows-desktop", `🪟 ${windows.length} windows`);
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: res
      };
    },
    renderCall() {
      return new Text("list_windows()");
    }
  });

  // ─── Tool: focus_window ──────────────────────────────────────────────────
  pi.registerTool({
    name: "focus_window",
    label: "Focus Window",
    description: "Brings an application window to the foreground by matching a substring of its title or passing its HWND directly.",
    promptSnippet: "Bring an application window to front",
    parameters: Type.Object({
      target: Type.String({ description: "Window title substring (e.g. 'Notepad', 'Chrome') or numeric HWND" })
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      ctx.ui.setStatus("windows-desktop", `🪟 Focusing "${params.target}"`);
      const res = await runDriver(["focus-window", params.target]);
      if (res.status !== "ok") {
        throw new Error(res.message ?? `Failed to focus window: ${params.target}`);
      }
      return {
        content: [{ type: "text", text: res.message }],
        details: res
      };
    },
    renderCall(args) {
      return new Text(`focus_window("${args.target}")`);
    }
  });

  // ─── Tool: get_cursor ────────────────────────────────────────────────────
  pi.registerTool({
    name: "get_cursor",
    label: "Get Cursor",
    description: "Returns the current (x, y) coordinates of the mouse cursor on the Windows desktop.",
    promptSnippet: "Get current mouse coordinates",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const res = await runDriver(["cursor"]);
      return {
        content: [{ type: "text", text: `Mouse cursor is at (${res.cursor.x}, ${res.cursor.y}).` }],
        details: res
      };
    },
    renderCall() {
      return new Text("get_cursor()");
    }
  });
}
