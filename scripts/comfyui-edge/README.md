# OSHAL ComfyUI edge-node (free video generation on a GPU box)

Turns a GPU machine (your wife's RTX 4060 box) into a **free** video-generation node for the
OSHAL Video Studio (ADR-070). ComfyUI's HTTP API **is** the control surface — OSHAL's
ComfyUI provider calls it directly over Tailscale. **No MCP needed for ComfyUI.**

## The honest setup (read this first)

- **There's no token I can hand you.** OSHAL has no built-in VPN control plane, so the box joins
  Tailscale with **your own Tailscale login** — which is what you want (it locks the box to *your*
  identity). Two boxes must be on the **same tailnet**: her box **and** the OSHAL controller box.
- **You do steps 1–3. I do step 4** once you send me the URL.

## On her computer (PowerShell as Administrator)

```powershell
git clone https://github.com/emeraldcoastsystemsgroup/open-shal.git
cd open-shal
powershell -ExecutionPolicy Bypass -File scripts\comfyui-edge\setup-comfyui.ps1
```

(If the repo's already synced: `git pull` first.)

The script: detects the GPU (your 4060 = NVIDIA, turnkey) → installs the official ComfyUI
portable + ComfyUI-Manager → writes a network-listening start script + a login auto-start
shortcut → installs Tailscale → launches ComfyUI.

## Steps you take

1. **Run the script** (above).
2. **Tailscale login as YOU** when it prompts (`tailscale up` → browser → your account). Do the
   same `tailscale up` **on the OSHAL controller box** so they share a tailnet.
3. **Send me two things:** the line the script prints — `http://<tailscale-ip>:8188` — and the
   GPU name it reports.

## What I do (step 4)

- Set `COMFYUI_URL` to your box's tailnet URL, push a **text-to-video workflow sized for 8 GB**
  (LTX-Video or AnimateDiff — the big models won't fit a 4060), and the swarm starts generating
  **free** on her box.

## Notes

- **8 GB VRAM:** stick to LTX-Video / AnimateDiff-SD1.5. I supply the workflow.
- Re-running the script is safe (skips work already done).
- This installs **free software only** — no OSHAL secrets, no remote-control agent. ComfyUI just
  listens on `:8188`.

## Beyond ComfyUI (Blender, screen/Flow automation) — next build

Controlling *other* software on the box (Blender renders, or driving Flow's free UI by recorded
clicks) needs an **MCP control server on the box + the OSHAL remote-MCP bridge**, reached **only by
the queue manager on a ticket** (the privilege rule). That's the edge-node build — separate from
this, and tracked in ADR-070 / BACKLOG. This ComfyUI path gets you free generation now without it.
