#!/usr/bin/env python3
"""Drive the REAL `swarm-cli chat` REPL on a pseudo-terminal (with a proper 80x24 window
size, without which readline cannot render) and physically press the TAB key.
Proves the readline completer is wired end-to-end in the shipped CLI."""
import os, pty, time, select, sys, fcntl, termios, struct

env = dict(os.environ, OSHAL_CLI_STATE_DIR="/tmp/cli-tab", TERM="xterm-256color")
pid, fd = pty.fork()
if pid == 0:
    os.execvpe("node", ["node", "/app/scripts/swarm-cli.js", "chat", "--quiet", "--no-banner"], env)

# A PTY with no winsize (rows=0) leaves readline unable to render — set 24x80 like a real terminal.
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 80, 0, 0))

def drain(seconds):
    buf = b""
    end = time.time() + seconds
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.2)
        if r:
            try:
                d = os.read(fd, 8192)
            except OSError:
                break
            if not d:
                break
            buf += d
    return buf

startup = drain(3.0)
print("### the REPL prompt (rendered on the PTY):")
print(repr(startup.decode(errors="replace")[-40:]))

print("\n### CASE 1 — type '/c' then press TAB  (ambiguous: /catalog vs /clear)")
os.write(fd, b"/c")
drain(0.4)
os.write(fd, b"\t")          # <-- the actual TAB keypress
out1 = drain(1.5)
print(out1.decode(errors="replace"))

os.write(fd, b"\x15")        # ctrl-U — clear the line
drain(0.4)

print("### CASE 2 — type '/wh' then press TAB  (unique: must complete to /whoami)")
os.write(fd, b"/wh")
drain(0.4)
os.write(fd, b"\t")          # <-- the actual TAB keypress
out2 = drain(1.5)
print(out2.decode(errors="replace"))

os.write(fd, b"\x15")
os.write(fd, b"/exit\n")
drain(1.0)
try:
    os.kill(pid, 9)
except OSError:
    pass

t1 = out1.decode(errors="replace")
t2 = out2.decode(errors="replace")
print("### VERDICT")
print("  '/c' + TAB listed /catalog : %s" % ("PASS" if "/catalog" in t1 else "FAIL"))
print("  '/c' + TAB listed /clear   : %s" % ("PASS" if "/clear" in t1 else "FAIL"))
print("  '/wh' + TAB -> /whoami     : %s" % ("PASS" if "/whoami" in t2 else "FAIL"))
