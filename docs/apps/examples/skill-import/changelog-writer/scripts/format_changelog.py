# Bundled skill script — normalises changelog markdown headings/spacing.
# IMPORTED SKILLS' bundled scripts are QUARANTINED by the importer and are NOT
# wired for execution. This file exists to exercise the quarantine path in the
# skill-import example; review before ever wiring it as an OSHAL tool.
import sys

HEADINGS = ["Added", "Changed", "Fixed", "Deprecated", "Removed", "Security"]


def normalise(text: str) -> str:
    lines = [ln.rstrip() for ln in text.splitlines()]
    out = []
    for ln in lines:
        stripped = ln.strip()
        if stripped in HEADINGS:
            out.append(f"### {stripped}")
        else:
            out.append(ln)
    return "\n".join(out).strip() + "\n"


if __name__ == "__main__":
    sys.stdout.write(normalise(sys.stdin.read()))
