#!/usr/bin/env python3
"""
Windows Desktop Automation Driver for Pi Agent
Provides Win32 OS interaction:
  - DPI-aware multi-monitor screenshot capture (mss + PIL)
  - Mouse movement, clicking, dragging, scrolling (SendInput)
  - Unicode text input & special hotkeys (SendInput)
  - Window enumeration and focus management (user32)
"""

import sys, os, io, json, base64, time, argparse, ctypes, ctypes.wintypes
import mss
from PIL import Image

# ─── Windows Desktop Connection ───────────────────────────────────────────────
user32 = ctypes.windll.user32
kernel32 = ctypes.windll.kernel32

# Attach current thread to interactive 'Default' desktop (crucial for background processes)
try:
    h_default = user32.OpenDesktopW('Default', 0, False, 0x10000000) # GENERIC_ALL
    if h_default:
        user32.SetThreadDesktop(h_default)
except Exception:
    pass

# Enable Per-Monitor DPI Awareness
try:
    ctypes.windll.shcore.SetProcessDpiAwareness(2) # PROCESS_PER_MONITOR_DPI_AWARE
except Exception:
    try:
        user32.SetProcessDPIAware()
    except Exception:
        pass

# ─── Win32 Input Structures ───────────────────────────────────────────────────
class MOUSEINPUT(ctypes.Structure):
    _fields_ = [
        ('dx', ctypes.wintypes.LONG),
        ('dy', ctypes.wintypes.LONG),
        ('mouseData', ctypes.wintypes.DWORD),
        ('dwFlags', ctypes.wintypes.DWORD),
        ('time', ctypes.wintypes.DWORD),
        ('dwExtraInfo', ctypes.POINTER(ctypes.wintypes.ULONG))
    ]

class KEYBDINPUT(ctypes.Structure):
    _fields_ = [
        ('wVk', ctypes.wintypes.WORD),
        ('wScan', ctypes.wintypes.WORD),
        ('dwFlags', ctypes.wintypes.DWORD),
        ('time', ctypes.wintypes.DWORD),
        ('dwExtraInfo', ctypes.POINTER(ctypes.wintypes.ULONG))
    ]

class HARDWAREINPUT(ctypes.Structure):
    _fields_ = [
        ('uMsg', ctypes.wintypes.DWORD),
        ('wParamL', ctypes.wintypes.WORD),
        ('wParamH', ctypes.wintypes.WORD)
    ]

class INPUT_UNION(ctypes.Union):
    _fields_ = [('mi', MOUSEINPUT), ('ki', KEYBDINPUT), ('hi', HARDWAREINPUT)]

class INPUT(ctypes.Structure):
    _fields_ = [('type', ctypes.wintypes.DWORD), ('u', INPUT_UNION)]

INPUT_MOUSE = 0
INPUT_KEYBOARD = 1

MOUSEEVENTF_MOVE = 0x0001
MOUSEEVENTF_LEFTDOWN = 0x0002
MOUSEEVENTF_LEFTUP = 0x0004
MOUSEEVENTF_RIGHTDOWN = 0x0008
MOUSEEVENTF_RIGHTUP = 0x0010
MOUSEEVENTF_MIDDLEDOWN = 0x0020
MOUSEEVENTF_MIDDLEUP = 0x0040
MOUSEEVENTF_WHEEL = 0x0800
MOUSEEVENTF_ABSOLUTE = 0x8000

KEYEVENTF_KEYUP = 0x0002
KEYEVENTF_UNICODE = 0x0004

VK_MAP = {
    'enter': 0x0D, 'return': 0x0D, '\n': 0x0D,
    'tab': 0x09, '\t': 0x09,
    'space': 0x20, ' ': 0x20,
    'backspace': 0x08,
    'delete': 0x2E, 'del': 0x2E,
    'escape': 0x1B, 'esc': 0x1B,
    'win': 0x5B, 'windows': 0x5B, 'lwin': 0x5B, 'rwin': 0x5C,
    'ctrl': 0x11, 'control': 0x11, 'lctrl': 0xA2, 'rctrl': 0xA3,
    'alt': 0x12, 'lalt': 0xA4, 'ralt': 0xA5,
    'shift': 0x10, 'lshift': 0xA0, 'rshift': 0xA1,
    'capslock': 0x14,
    'up': 0x26, 'down': 0x28, 'left': 0x25, 'right': 0x27,
    'home': 0x24, 'end': 0x23, 'pageup': 0x21, 'pagedown': 0x22, 'pgup': 0x21, 'pgdn': 0x22,
    'insert': 0x2D, 'ins': 0x2D,
    'f1': 0x70, 'f2': 0x71, 'f3': 0x72, 'f4': 0x73, 'f5': 0x74, 'f6': 0x75,
    'f7': 0x76, 'f8': 0x77, 'f9': 0x78, 'f10': 0x79, 'f11': 0x7A, 'f12': 0x7B
}

def send_inputs(inputs):
    n = len(inputs)
    arr = (INPUT * n)(*inputs)
    user32.SendInput(n, arr, ctypes.sizeof(INPUT))

# ─── Desktop Actions ──────────────────────────────────────────────────────────

def get_cursor_position():
    class POINT(ctypes.Structure):
        _fields_ = [('x', ctypes.c_long), ('y', ctypes.c_long)]
    pt = POINT()
    user32.GetCursorPos(ctypes.byref(pt))
    return pt.x, pt.y

def set_cursor_position(x, y):
    user32.SetCursorPos(int(x), int(y))

def mouse_click(x, y, button='left', clicks=1):
    set_cursor_position(x, y)
    time.sleep(0.05)
    
    down_flag = MOUSEEVENTF_LEFTDOWN
    up_flag = MOUSEEVENTF_LEFTUP
    if button.lower() == 'right':
        down_flag, up_flag = MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP
    elif button.lower() == 'middle':
        down_flag, up_flag = MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP

    for _ in range(clicks):
        inp_down = INPUT(type=INPUT_MOUSE)
        inp_down.u.mi.dwFlags = down_flag
        inp_up = INPUT(type=INPUT_MOUSE)
        inp_up.u.mi.dwFlags = up_flag
        send_inputs([inp_down, inp_up])
        time.sleep(0.05)

def mouse_drag(start_x, start_y, end_x, end_y, button='left'):
    set_cursor_position(start_x, start_y)
    time.sleep(0.05)
    
    down_flag = MOUSEEVENTF_LEFTDOWN
    up_flag = MOUSEEVENTF_LEFTUP
    if button.lower() == 'right':
        down_flag, up_flag = MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP

    inp_down = INPUT(type=INPUT_MOUSE)
    inp_down.u.mi.dwFlags = down_flag
    send_inputs([inp_down])
    time.sleep(0.05)

    # Smooth movement interpolation
    steps = 20
    for i in range(1, steps + 1):
        cx = int(start_x + (end_x - start_x) * (i / steps))
        cy = int(start_y + (end_y - start_y) * (i / steps))
        set_cursor_position(cx, cy)
        time.sleep(0.01)

    time.sleep(0.05)
    inp_up = INPUT(type=INPUT_MOUSE)
    inp_up.u.mi.dwFlags = up_flag
    send_inputs([inp_up])

def mouse_scroll(delta_clicks, x=None, y=None):
    if x is not None and y is not None:
        set_cursor_position(x, y)
        time.sleep(0.05)
    inp = INPUT(type=INPUT_MOUSE)
    inp.u.mi.dwFlags = MOUSEEVENTF_WHEEL
    # In Windows, 1 click = 120 units
    inp.u.mi.mouseData = int(delta_clicks * 120)
    send_inputs([inp])

def type_text(text, press_enter=False):
    for char in text:
        code = ord(char)
        inp_down = INPUT(type=INPUT_KEYBOARD)
        inp_down.u.ki.wScan = code
        inp_down.u.ki.dwFlags = KEYEVENTF_UNICODE
        inp_up = INPUT(type=INPUT_KEYBOARD)
        inp_up.u.ki.wScan = code
        inp_up.u.ki.dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP
        send_inputs([inp_down, inp_up])
        time.sleep(0.01)
    
    if press_enter:
        time.sleep(0.05)
        press_hotkeys(['enter'])

def press_hotkeys(keys):
    down_inputs = []
    up_inputs = []
    
    for k in keys:
        k_lower = k.lower().strip()
        vk = VK_MAP.get(k_lower)
        if not vk:
            if len(k_lower) == 1 and k_lower.isalnum():
                vk = ord(k_lower.upper())
            else:
                continue
        
        inp_down = INPUT(type=INPUT_KEYBOARD)
        inp_down.u.ki.wVk = vk
        down_inputs.append(inp_down)
        
        inp_up = INPUT(type=INPUT_KEYBOARD)
        inp_up.u.ki.wVk = vk
        inp_up.u.ki.dwFlags = KEYEVENTF_KEYUP
        up_inputs.insert(0, inp_up) # release in reverse order
        
    if down_inputs:
        send_inputs(down_inputs)
        time.sleep(0.05)
        send_inputs(up_inputs)

# ─── Window Management ────────────────────────────────────────────────────────

def list_windows():
    windows = []
    
    @ctypes.WINFUNCTYPE(ctypes.wintypes.BOOL, ctypes.wintypes.HWND, ctypes.wintypes.LPARAM)
    def enum_proc(hwnd, lparam):
        if user32.IsWindowVisible(hwnd):
            length = user32.GetWindowTextLengthW(hwnd)
            if length > 0:
                buff = ctypes.create_unicode_buffer(length + 1)
                user32.GetWindowTextW(hwnd, buff, length + 1)
                title = buff.value
                rect = ctypes.wintypes.RECT()
                user32.GetWindowRect(hwnd, ctypes.byref(rect))
                w = rect.right - rect.left
                h = rect.bottom - rect.top
                if w > 60 and h > 60:
                    windows.append({
                        'hwnd': hwnd,
                        'title': title,
                        'bounds': [rect.left, rect.top, rect.right, rect.bottom],
                        'size': [w, h]
                    })
        return True

    user32.EnumWindows(enum_proc, 0)
    return windows

def focus_window(target):
    hwnd_target = None
    if isinstance(target, int) or (isinstance(target, str) and target.isdigit()):
        hwnd_target = int(target)
    else:
        target_str = str(target).lower().strip()
        windows = list_windows()
        for w in windows:
            if target_str in w['title'].lower():
                hwnd_target = w['hwnd']
                break
                
    if not hwnd_target:
        return False, "Window not found matching: " + str(target)
        
    SW_RESTORE = 9
    user32.ShowWindow(hwnd_target, SW_RESTORE)
    time.sleep(0.05)
    user32.SetForegroundWindow(hwnd_target)
    return True, f"Focused window hwnd {hwnd_target}"

# ─── Screenshot Capture ───────────────────────────────────────────────────────

def capture_screenshot(display_idx=0, max_dimension=None):
    with mss.mss() as sct:
        monitors = sct.monitors
        # monitors[0] is all monitors combined, monitors[1] is primary
        target_monitor = None
        if display_idx == 0 or display_idx == 1:
            target_monitor = monitors[1]
        elif display_idx < len(monitors):
            target_monitor = monitors[display_idx]
        else:
            target_monitor = monitors[1]

        shot = sct.grab(target_monitor)
        img = Image.frombytes('RGB', shot.size, shot.bgra, 'raw', 'BGRX')
        
        orig_w, orig_h = img.width, img.height
        scale = 1.0
        
        if max_dimension and (orig_w > max_dimension or orig_h > max_dimension):
            scale = max_dimension / max(orig_w, orig_h)
            new_w = int(orig_w * scale)
            new_h = int(orig_h * scale)
            img = img.resize((new_w, new_h), Image.Resampling.LANCZOS)

        buf = io.BytesIO()
        img.save(buf, format='PNG', optimize=True)
        b64 = base64.b64encode(buf.getvalue()).decode('ascii')
        
        cur_x, cur_y = get_cursor_position()

        return {
            'image_b64': b64,
            'width': img.width,
            'height': img.height,
            'original_width': orig_w,
            'original_height': orig_h,
            'scale': scale,
            'cursor': {'x': cur_x, 'y': cur_y},
            'display_bounds': {
                'left': target_monitor['left'],
                'top': target_monitor['top'],
                'width': target_monitor['width'],
                'height': target_monitor['height']
            }
        }

# ─── CLI Dispatcher ───────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Windows Desktop Driver for Pi")
    subparsers = parser.add_subparsers(dest="command")

    # screenshot
    p_shot = subparsers.add_parser("screenshot")
    p_shot.add_argument("--display", type=int, default=0)
    p_shot.add_argument("--max-dim", type=int, default=None)

    # click
    p_click = subparsers.add_parser("click")
    p_click.add_argument("x", type=int)
    p_click.add_argument("y", type=int)
    p_click.add_argument("--button", default="left")
    p_click.add_argument("--clicks", type=int, default=1)

    # move
    p_move = subparsers.add_parser("move")
    p_move.add_argument("x", type=int)
    p_move.add_argument("y", type=int)

    # drag
    p_drag = subparsers.add_parser("drag")
    p_drag.add_argument("start_x", type=int)
    p_drag.add_argument("start_y", type=int)
    p_drag.add_argument("end_x", type=int)
    p_drag.add_argument("end_y", type=int)
    p_drag.add_argument("--button", default="left")

    # scroll
    p_scroll = subparsers.add_parser("scroll")
    p_scroll.add_argument("clicks", type=int)
    p_scroll.add_argument("--x", type=int, default=None)
    p_scroll.add_argument("--y", type=int, default=None)

    # type
    p_type = subparsers.add_parser("type")
    p_type.add_argument("text")
    p_type.add_argument("--enter", action="store_true")

    # hotkey
    p_hotkey = subparsers.add_parser("hotkey")
    p_hotkey.add_argument("keys", nargs="+")

    # list-windows
    subparsers.add_parser("list-windows")

    # focus-window
    p_focus = subparsers.add_parser("focus-window")
    p_focus.add_argument("target")

    # cursor
    subparsers.add_parser("cursor")

    args = parser.parse_args()

    if args.command == "screenshot":
        res = capture_screenshot(args.display, args.max_dim)
        print(json.dumps(res))
    elif args.command == "click":
        mouse_click(args.x, args.y, args.button, args.clicks)
        print(json.dumps({"status": "ok", "action": "click", "x": args.x, "y": args.y, "button": args.button, "clicks": args.clicks}))
    elif args.command == "move":
        set_cursor_position(args.x, args.y)
        print(json.dumps({"status": "ok", "action": "move", "x": args.x, "y": args.y}))
    elif args.command == "drag":
        mouse_drag(args.start_x, args.start_y, args.end_x, args.end_y, args.button)
        print(json.dumps({"status": "ok", "action": "drag", "from": [args.start_x, args.start_y], "to": [args.end_x, args.end_y]}))
    elif args.command == "scroll":
        mouse_scroll(args.clicks, args.x, args.y)
        print(json.dumps({"status": "ok", "action": "scroll", "clicks": args.clicks}))
    elif args.command == "type":
        type_text(args.text, args.enter)
        print(json.dumps({"status": "ok", "action": "type", "text": args.text, "enter": args.enter}))
    elif args.command == "hotkey":
        press_hotkeys(args.keys)
        print(json.dumps({"status": "ok", "action": "hotkey", "keys": args.keys}))
    elif args.command == "list-windows":
        wins = list_windows()
        print(json.dumps({"status": "ok", "windows": wins}))
    elif args.command == "focus-window":
        ok, msg = focus_window(args.target)
        print(json.dumps({"status": "ok" if ok else "error", "message": msg}))
    elif args.command == "cursor":
        cx, cy = get_cursor_position()
        print(json.dumps({"status": "ok", "cursor": {"x": cx, "y": cy}}))
    else:
        parser.print_help()

if __name__ == "__main__":
    main()
