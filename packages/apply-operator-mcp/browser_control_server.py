"""
Browser-Control MCP server — the apply-operator's hands on the worker desktop.

A stdio FastMCP server (same shape as unreal-mcp/Python/unreal_mcp_server.py) that the OSHAL
remote-client launches on the screen-control worker PC. It exposes the deterministic OS-input
primitives from the swarm-apply spec (§4) so the apply-operator bot can drive the operator's
REAL, logged-in foreground Chrome the way a person does: mouse, keyboard, clipboard, native file
picker, and screenshots — NEVER injected JavaScript, a debug port, or CDP (those are fingerprinted
and blocked). The bot supplies judgement; this tool supplies the hands.

Mirrors the proven primitives in the job-hunter `_autoapply/driver.py`: PowerShell for screenshots
and clipboard, pywinauto for OS mouse/keyboard, monitor-1-relative coordinates.

Deploy (on the worker): registered in config-seed/claude-code-mcp.json; the remote-client daemon
runs it via `uv --directory ./packages/apply-operator-mcp run browser_control_server.py`. Requires
Windows + pywinauto. Tune the monitor offset with APPLY_MON1_X / APPLY_MON1_Y for a multi-monitor
desktop (Monitor-1-relative clicks). The pinned Chrome window title is matched by APPLY_CHROME_TITLE.

This file is the worker-side tool; the live submission runs on that box. It is intentionally
self-contained (no OSHAL imports) so it ships to the worker on its own.
"""
from __future__ import annotations

import base64
import os
import subprocess
import tempfile
import time

from mcp.server.fastmcp import FastMCP, Image

mcp = FastMCP("apply-operator-browser-control")

# Monitor-1-relative offset: clicks are (APPLY_MON1_X + x, APPLY_MON1_Y + y) so the bot can reason
# in the screenshot's own pixel space even when Chrome lives on a secondary monitor.
MON1_X = int(os.environ.get("APPLY_MON1_X", "0"))
MON1_Y = int(os.environ.get("APPLY_MON1_Y", "0"))
SETTLE = float(os.environ.get("APPLY_SETTLE_SECS", "0.4"))


def _ps(script: str) -> str:
    """Run a PowerShell snippet and return stdout (used for screenshot + clipboard, like driver.py)."""
    r = subprocess.run(["powershell", "-NoProfile", "-Command", script],
                       capture_output=True, text=True, timeout=30)
    return (r.stdout or "").strip()


def _set_clipboard(text: str) -> None:
    # Set-Clipboard via stdin avoids quoting hell with arbitrary text.
    subprocess.run(["powershell", "-NoProfile", "-Command", "$input | Set-Clipboard"],
                   input=text, text=True, timeout=15)


def _kbd():
    from pywinauto import keyboard
    return keyboard


def _mouse():
    from pywinauto import mouse
    return mouse


def _screenshot_png() -> bytes:
    """Capture the full virtual screen to a PNG and return its bytes (PowerShell System.Drawing)."""
    path = os.path.join(tempfile.gettempdir(), f"apply-shot-{int(time.time()*1000)}.png")
    _ps(
        "Add-Type -AssemblyName System.Windows.Forms,System.Drawing;"
        "$b=[System.Windows.Forms.SystemInformation]::VirtualScreen;"
        "$bmp=New-Object System.Drawing.Bitmap($b.Width,$b.Height);"
        "$g=[System.Drawing.Graphics]::FromImage($bmp);"
        "$g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size);"
        f"$bmp.Save('{path}');$g.Dispose();$bmp.Dispose()"
    )
    with open(path, "rb") as fh:
        data = fh.read()
    try:
        os.remove(path)
    except OSError:
        pass
    return data


@mcp.tool()
def shot(label: str = "") -> Image:
    """Screenshot the worker desktop and return the PNG so the agent can read the screen.
    `label` is a human note for the trace; the image is what the agent reasons over."""
    return Image(data=_screenshot_png(), format="png")


@mcp.tool()
def click(x: int, y: int, double: bool = False) -> str:
    """Real OS mouse click at monitor-1-relative (x, y). Set double=true for a double-click."""
    m = _mouse()
    pt = (MON1_X + int(x), MON1_Y + int(y))
    m.click(button="left", coords=pt)
    if double:
        m.click(button="left", coords=pt)
    time.sleep(SETTLE)
    return f"clicked {'double ' if double else ''}at {pt}"


@mcp.tool()
def type_text(text: str) -> str:
    """Type real keystrokes into the focused field. Use `paste` for phone numbers / long text."""
    _kbd().send_keys(text, with_spaces=True, pause=0.01)
    time.sleep(SETTLE)
    return f"typed {len(text)} chars"


@mcp.tool()
def paste(text: str) -> str:
    """Clipboard paste into the focused field (required for +1... phones and long text)."""
    _set_clipboard(text)
    time.sleep(0.15)
    _kbd().send_keys("^v")
    time.sleep(SETTLE)
    return f"pasted {len(text)} chars"


@mcp.tool()
def key(name: str) -> str:
    """Press a named key or chord (e.g. 'TAB', 'ENTER', 'DOWN', '^a'). pywinauto syntax."""
    token = name if name.startswith(("{", "^", "+", "%")) else "{" + name.upper() + "}"
    _kbd().send_keys(token)
    time.sleep(SETTLE)
    return f"key {name}"


@mcp.tool()
def nav(url: str) -> str:
    """Open a URL in the pinned, logged-in Chrome window: focus the omnibox, clear, paste, Enter."""
    kbd = _kbd()
    kbd.send_keys("^l")          # focus the address bar
    time.sleep(0.2)
    kbd.send_keys("^a")          # select existing
    _set_clipboard(url)
    time.sleep(0.15)
    kbd.send_keys("^v")
    time.sleep(0.2)
    kbd.send_keys("{ENTER}")
    time.sleep(float(os.environ.get("APPLY_NAV_WAIT", "4")))
    return f"navigated to {url}"


@mcp.tool()
def upload(abs_path: str) -> str:
    """Drive the native file picker: paste the absolute path into the File-name box, Enter.
    Assumes the OS Open dialog is already open (you clicked the form's Choose-file button first)."""
    if not os.path.isabs(abs_path):
        return f"refused: not an absolute path: {abs_path}"
    kbd = _kbd()
    time.sleep(0.6)              # let the dialog appear
    _set_clipboard(abs_path)
    time.sleep(0.15)
    kbd.send_keys("^v")
    time.sleep(0.3)
    kbd.send_keys("{ENTER}")
    time.sleep(SETTLE)
    return f"uploaded {abs_path}"


@mcp.tool()
def pick_place(query: str) -> str:
    """Google-Places autocomplete helper for the Location field: type, wait, Down, Enter."""
    kbd = _kbd()
    kbd.send_keys(query, with_spaces=True, pause=0.02)
    time.sleep(1.0)             # let suggestions render
    kbd.send_keys("{DOWN}")
    time.sleep(0.3)
    kbd.send_keys("{ENTER}")
    time.sleep(SETTLE)
    return f"picked place for '{query}'"


@mcp.tool()
def preflight() -> str:
    """Self-check before working the queue (spec §4): confirm screen control, typing, clipboard.
    Returns a short report; the agent should also `shot` and confirm the right desktop is shown."""
    checks = []
    try:
        _ = _screenshot_png(); checks.append("screenshot OK")
    except Exception as e:  # noqa: BLE001
        checks.append(f"screenshot FAIL: {e}")
    try:
        _set_clipboard("oshal-preflight")
        got = _ps("Get-Clipboard")
        checks.append("clipboard OK" if "oshal-preflight" in got else "clipboard FAIL")
    except Exception as e:  # noqa: BLE001
        checks.append(f"clipboard FAIL: {e}")
    try:
        import pywinauto  # noqa: F401
        checks.append("pywinauto OK")
    except Exception as e:  # noqa: BLE001
        checks.append(f"pywinauto FAIL: {e} (install pywinauto on the worker)")
    checks.append(f"monitor-1 offset = ({MON1_X},{MON1_Y})")
    return " | ".join(checks)


if __name__ == "__main__":
    mcp.run(transport="stdio")
