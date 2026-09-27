# Windows Desktop Computer Use Extension for Pi

Native, high-performance Windows GUI & desktop automation for **Pi Agent**. 

Unlike Codex's proprietary Computer Use (which burns expensive GPT-5 tokens on desktop frames), this extension works with **any vision-capable model** in Pi — including cost-effective, blazing fast models like **Gemini 2.5 Flash** (via Google AI Studio), **GLM-5.3 Flash**, or **Claude 3.5 Haiku**.

---

## Features

* **Model Agnostic:** Uses standard tool calling (`TypeBox`) and native Pi image blocks (`type: "image"` with `mimeType: "image/png"`). Works with any model that supports vision.
* **Ultra Fast & Low Overhead:** Uses `mss` and `PIL` for 10-20ms frame captures.
* **Per-Monitor DPI Aware:** Coordinates scale accurately across mixed DPI settings (100%, 125%, 150%, 200%).
* **Multi-Monitor Support:** Detects and captures primary or secondary monitors (e.g. `display=0`, `display=1`, `display=2`).
* **Desktop Session Resilient:** Automatically attaches to the user's interactive `Default` desktop station, ensuring commands execute reliably even when Pi is launched from background shells.
* **Full Keyboard & Mouse Control:** Unicode text typing, drag & drop, scrolling, and complex system hotkeys (`win+r`, `ctrl+s`, `alt+tab`, etc.).
* **Window Discovery & Focus:** Fast enumeration of visible application windows with titles, PIDs, and pixel bounds.

---

## Tools Exposed to Models

| Tool | Parameters | Description |
| :--- | :--- | :--- |
| `desktop_screenshot` | `display` (int, default 0), `max_dimension` (int, default 1920) | Captures desktop and injects the image directly into context. |
| `mouse_click` | `x` (int), `y` (int), `button` ("left"\|"right"\|"middle"), `clicks` (1 or 2) | Moves to coordinates and clicks (or double-clicks). |
| `mouse_move` | `x` (int), `y` (int) | Moves cursor without clicking (useful for hovering). |
| `mouse_drag` | `start_x`, `start_y`, `end_x`, `end_y`, `button` | Performs smooth drag-and-drop between points. |
| `mouse_scroll` | `clicks` (int, e.g. -5 for down, 5 for up), `x`, `y` | Scrolls the mouse wheel at the specified or current point. |
| `type_text` | `text` (str), `press_enter` (bool) | Types unicode text with virtual keystroke synthesis. |
| `press_hotkey` | `keys` (list of str, e.g. `["win", "r"]`) | Presses and releases key combinations in sequence. |
| `list_windows` | *none* | Lists all visible top-level windows with titles and coordinates. |
| `focus_window` | `target` (title substring or HWND) | Restores and brings the target window to the foreground. |
| `get_cursor` | *none* | Returns current `(x, y)` mouse coordinates. |

---

## Directory Structure

```
extensions/windows-desktop/
├── index.ts        # Pi extension registration & tool definitions
├── driver.py       # Win32 & DPI-aware OS driver (user32, mss, PIL)
└── README.md       # Documentation & API reference
```

---

## Quick Start / Testing

1. Start Pi with a vision model:
   ```bash
   pi -m google-aistudio/gemini-2.5-flash
   ```
2. Prompt Pi to inspect or interact with the desktop:
   * *"Take a screenshot of the desktop and tell me what windows are open."*
   * *"Press Win+R, type 'notepad', press enter, type 'Hello from Pi Agent', and take a screenshot."*
