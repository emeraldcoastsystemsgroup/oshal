# @oshal/chat — OSHAL Node

A local **desktop node** that joins the OSHAL swarm as an **A2A remote client** over
headscale. It is two things at once:

1. **A Jarvis-style assistant** — an orb you talk to (voice in/out, Chromium-native) or type
   to. Chat turns go to a swarm bot, which reasons and replies; cost is captured in `chat_tasks`
   (ADR-036). The app is a thin window onto an accountable swarm bot, not a second place LLM
   calls happen.
2. **A worker node** — the user's machine **materially participates** in the swarm. It pulls
   tasks the swarm dispatches (`GET /:id/tasks/next`), runs them **locally** with the user's own
   signed-in CLIs (codex, claude, …), and pushes results back (`POST /:id/tasks/:id/complete`).
   This solves the popup problem: codex/gcloud/aws/anthropic auth via a browser window that must
   run on the *user's* machine and drop creds in `~/.` — a headless swarm container can't do
   that, so the work runs here, where the user already logged in.

## Full Jarvis mode — the swarm cockpit on a satellite

The orb is deliberately thin. When a satellite should present the **complete** Jarvis experience —
task history, the app ribbon, dynamic visual responses, and (for allowlisted operators) the
super-admin tools — enable **Full Jarvis**. The node opens a dedicated window that loads the
**swarm-hosted** cockpit (`/cockpit/?app=jarvis` by default; configurable to `/cockpit/` for the
full framework ribbon) under a **verified OIDC session**:

- The window shares the sign-in session's cookie jar, so it authenticates as the *user*, not the
  machine. Super-admin visibility is enforced server-side per that identity — the shared-secret
  worker plane gains **no** new privileges from this mode.
- **Tunnel-hosted OIDC**: when the swarm's login runs behind a public tunnel, the IdP sets the
  session cookie on that public origin only — set **Cockpit / sign-in URL** (`cockpitBaseUrl`,
  env `OSHAL_COCKPIT_BASE_URL`) to the public URL; the worker plane keeps using the LAN
  control-plane URL. The app also presents a Chrome-like UA (Google rejects OAuth from
  user agents advertising Electron).
- Nothing is duplicated locally: Jarvis's brain, history, and the fact-locked visual renderer all
  stay on the controller. The window is a rendering surface, which is why it needs connectivity
  to the control plane (headscale or LAN). Offline, the node falls back to the orb + worker.
- **The installer bakes this in**: `install-node.ps1` seeds `OSHAL_FULL_JARVIS=true` by default,
  so a fresh satellite opens the cockpit (prompting sign-in) on first launch; pass `-OrbOnly`
  for an unattended worker-only box. Per-launch: the **◈ Full Jarvis** orb button. Persistent:
  Config → *Full Jarvis* (+ optional `OSHAL_COCKPIT_PATH`). If no session cookie is live, the
  standard sign-in window runs first. Config schema v2 makes Full Jarvis the default when that
  setting was never present, while preserving an explicit orb-only choice.
- The remote page is loaded with **no preload and no Node access** (sandboxed browser window);
  `window.open` children inherit the same hardening so connector OAuth popups complete in-app.

The local orb is hidden while the cockpit is open and returns only if the cockpit closes or cannot
open; the worker keeps pulling tasks regardless of which surface is in front.

## Native background wake word (page closed)

OSHAL Node can remain in the system tray and listen for one exact local phrase while the hosted
Jarvis page is closed. This is an explicit opt-in under **Config -> Background wake word** and
requires a verified swarm sign-in plus an OS microphone grant.

This is wake-only background mode, not an ambient recorder. With Jarvis closed, OSHAL Node does not
save speech, create a room transcript, or run the daily transcript review. The browser resumes
bounded command capture only after the wake event opens the authenticated Jarvis surface.

On Windows, the node uses the installed offline `System.Speech` recognizer with a constrained
`Hey <configured name>` grammar. The helper emits only a wake event and confidence; it does not
write audio, produce a free-form transcript, or call the network. On wake it releases the mic,
opens the existing OIDC-backed Jarvis window, and lets that page capture the command through its
normal `/api/voice/transcribe` -> `/api/jarvis/ask` flow. Pause, Turn off, Sign out, and Quit all
stop the helper. The tray and Settings always show whether it is off, starting, listening, paused,
triggered, unavailable, or in error.

The Windows code path, package build, automated lifecycle coverage, and in-memory synthetic grammar
smoke pass. Physical-microphone false-wake/sleep/network testing and a code-signed SmartScreen
installer are still release gates. macOS/Linux intentionally show `UNAVAILABLE` until their
signed/entitled offline helpers are selected; there is no cloud speech fallback. Architecture,
privacy invariants, tests, and the Windows acceptance procedure are documented in
[jarvis-native-background-wake.md](../../docs/architecture/jarvis-native-background-wake.md).

### Jarvis release evidence and limits (2026-07-10 cutoff)

- The final Jarvis baseline was 219 passing Vitest tests across 18 suites and 27 passing Playwright
  tests across the 3 rich-response, response-stage, and audio-lifecycle files.
- The OSHAL Node package build and in-memory Windows wake smoke passed. The smoke used synthesized
  “Hey Jarvis” audio, retained no raw audio, and did not open a physical microphone.
- Native wake is bounded phrase routing for the exact configured `Hey <name>` grammar. It is not
  free-form recognition, a general semantic router, or speaker authentication.
- Physical microphone/device, sleep/network/battery/false-wake, real assistive-technology and mobile
  device testing, Windows signing/SmartScreen, and speaker calibration remain open release gates.
- The downstream provider proof is narrower than the UI: the full live-weather Jarvis E2E passed
  for a named US location supplied directly and for a missing-location clarification followed by a
  city on the next turn, including deterministic provider execution, delayed SVG, plain-yes reveal,
  Discussion replay, and owner-only reads. Implicit device geolocation remains outside that proof. Gmail reads
  `newer_than:1d`, fetches at most 25 messages, and shows at most six priority rows; no seeded OSHAL
  Gmail E2E has run.
- NWS/Gmail records are trusted control-plane metadata, not cryptographic provider attestations.

## Worker node — how tasks run locally

The node exposes an allowlisted set of **local MCP tools** ([src/main/local-tools.ts](src/main/local-tools.ts)):
`codex.exec`, `claude.exec`, and `swarm.exec` (auto-picks whichever CLI is signed in). The swarm
invokes them with the `mcp.call-tool` intent; a plain swarm execution envelope routed to this node
is auto-converted to a `swarm.exec` call (see `toTaskEnvelope` in
[remote-client-routes.ts](../../src/app/routes/remote-client-routes.ts)). Only the named tools can
run — never arbitrary shell. Executors ([src/main/executors.ts](src/main/executors.ts)) spawn the
CLI against the user's **real** home so the local creds apply.

## Shared task workspace (scoped per-task sync)

The in-Docker bots share one folder per run via the `oshal_workspace` Docker volume mounted into
every container. The node is a **different machine**, so it can't mount that volume — but it joins
the *same* per-run folder by **scoped sync**, never the whole volume:

1. When the swarm routes run-work here, the task carries its `workspacePath` (the run's
   `workspaceFolderId`). See `toTaskEnvelope` in [remote-client-routes.ts](../../src/app/routes/remote-client-routes.ts).
2. On claim, the node pulls **only that folder** into a local mirror
   (`~/.oshal-node/workspaces/<id>`) via `GET /api/remote-clients/:id/tasks/:taskId/workspace`,
   runs the CLI/shell tools **in the mirror**, then pushes changes back — **before** marking the
   task complete. ([workspace-sync.ts](src/main/workspace-sync.ts))

The control plane is the gatekeeper. It mounts the full volume but only ever exposes the folder for a
task the node **currently holds** (`getInFlightTask`), so the node can't reach any other task's files.

**Three invariants** (enforced in code — don't break them):
- **Held-task gated** — a request for a task the client doesn't hold → `403`.
- **Path-scoped** — `workspace/file?path=…` rejects any `../` escape out of the folder (the security boundary).
- **Additive push, push-before-complete** — the node only writes its new/changed files (never deletes
  siblings, so other rounds' handovers + `.tokenchase` capture survive), and pushes before completing
  so the next bot never reads stale content.

> **Assumption:** this snapshot-sync model is correct because the swarm is **sequential handover**
> (one writer per round; RALF passes context via handover files). If rounds ever run **truly parallel
> on the same folder**, snapshot-sync would clobber concurrent edits — switch to a live scoped mount
> (per-task SMB/WebDAV rooted at the one `workspaceFolderId`) instead.

## System control (screen + shell + input) — opt-in, OFF by default

When **Config → "Allow this machine to be controlled"** is enabled, the node exposes four extra
gated tools so the swarm can drive the machine ("open Outlook and screenshot it", "search My
Documents for PDFs"): `screen.capture` (Electron `desktopCapturer` → PNG data URL), `shell.exec`
(PowerShell), `desktop.control` (mouse move/click/type), and `app.open` (launch an app). Input uses
the zero-dependency **PowerShell** path (`user32` P/Invoke + `SendKeys`), avoiding native Electron
ABI drift and the unpatched image-parser dependency chain previously pulled in by nut.js. All of this
lives in [src/main/system-tools.ts](src/main/system-tools.ts) and is refused unless the toggle is on
(threaded through `runLocalTool`'s gate). Desktop input and app launch are therefore Windows-only;
Electron-backed screen capture remains cross-platform. Every action shows in the worker activity log.

## Accounts on this machine

The **Config → Accounts** panel probes whether codex / claude / gcloud / aws are signed in (creds
in `~/.`) and offers a **Log in** button per tool that launches that CLI's own login in a terminal —
the browser popup runs here, on the user's computer ([src/main/auth-manager.ts](src/main/auth-manager.ts)).
A **Manage web connections** button opens the swarm's `/connections` hub for OAuth connectors
(Gmail, SmartThings, …). **Sign in to the swarm** captures a verified OIDC identity (`/api/user` sub)
so chat/task calls carry a real identity instead of an asserted one.

## How it connects

```
Electron app ──HTTP (headscale tailnet)──▶ /api/remote-clients/:id/chat ──▶ TaskOrchestrator ──▶ bot
     ▲                                                                                            │
     └──────────── poll GET /api/remote-clients/:id/swarm/next ◀── chat.reply enqueued ◀──────────┘
```

1. **Register** — `POST /api/remote-clients/register` (transport `headscale-http`).
2. **Heartbeat** — every 10s so the swarm shows the client online.
3. **Send** — `POST /api/remote-clients/:id/chat { text, taskId, correlationId }` → `202 Accepted`.
4. **Poll** — `GET /api/remote-clients/:id/swarm/next` until a `chat.reply` payload arrives.

The reply is delivered asynchronously over the existing swarm-message poll loop (no SSE),
so long LLM turns never hold a request open.

## Server prerequisites

On the OSHAL control plane (`src/app/server.ts`), set a shared secret so the headless app can
authenticate the remote-client routes:

```bash
# .env on the control plane
REMOTE_CLIENT_SHARED_SECRET=choose-a-strong-secret
# optional — defaults to x-remote-client-key
REMOTE_CLIENT_AUTH_HEADER=x-remote-client-key
```

The chat bridge is wired automatically: `createRemoteClientRoutes` receives `ctx.orchestrator`,
so `POST /:clientId/chat` reasons on the default chat agent (or the `targetAgentId` you set).

## Headscale

The control-plane URL you enter is reached over your private overlay. Bring your machine onto
the tailnet first (the app can do this for you if you fill in the headscale fields and click
**Connect VPN**, which shells the local `tailscale` CLI — same flow as
[`scripts/start-local-agent.bat`](../../scripts/start-local-agent.bat)):

```bash
tailscale up --login-server http://<headscale-host>:8085 --authkey <pre-auth-key> --accept-dns=false
```

Then set **Control-plane URL** to the swarm's tailnet address (e.g. `http://100.x.x.x:5000`).
If your machine is already on the tailnet, skip the headscale fields entirely.

## Agent CLIs (installed as part of setup)

The node runs swarm work with the user's own signed-in agent CLIs. Setup installs/updates
three of them globally — **OpenAI Codex** (`@openai/codex` → `codex`), **Claude Code**
(`@anthropic-ai/claude-code` → `claude`), and **Cline** (`cline` → `cline`) — via
[scripts/setup-clis.js](scripts/setup-clis.js). It runs automatically as the package
`postinstall` (so `npm install` / `npx` bootstraps them) and on demand:

```bash
npm run setup            # install/update codex + claude-code + cline to @latest
OSHAL_SKIP_CLI_SETUP=1 … # set to skip the CLI bootstrap entirely
```

It is idempotent and best-effort: a global-install failure (offline, perms) never fails the
node install. After install, sign each CLI in from **Config → Accounts** (`codex login`,
`claude /login`, `cline auth`).

## Run it

```bash
cd packages/oshal-chat
npm install        # also bootstraps the agent CLIs (postinstall)
npm start          # builds, then opens the desktop window
```

### Install on another computer via npx (same LAN, no Tailscale/headscale)

This package isn't on the public npm registry (`private: true`), so serve a tarball from
**this** machine and `npx` it on the other one — no publish, no VPN:

```bash
# On this machine (prepack builds dist/, produces oshal-chat-0.2.0.tgz):
cd packages/oshal-chat
npm pack
# Share the .tgz over the LAN (file copy, or: npx serve . then fetch the URL).

# On the OTHER computer (Node 22.12+ installed):
npx ./oshal-chat-0.2.0.tgz      # or:  npx http://<this-ip>:3000/oshal-chat-0.2.0.tgz
```

`npx` installs the package's runtime Electron dependency, runs the `postinstall` CLI bootstrap,
and opens the desktop window. First launch opens **Settings** — fill in:

- **Control-plane URL:** `http://<this-machine-LAN-ip>:35457` (the oshal-local API host port;
  it binds all interfaces, so it's LAN-reachable — open TCP 35457 in Windows Firewall).
- **Shared secret:** must match `REMOTE_CLIENT_SHARED_SECRET` on the control plane.
- **Auth header:** leave default `x-remote-client-key`.
- **Worker enabled:** on. **Allow this machine to be controlled:** on (for screen + cursor).
- Leave all **headscale/VPN** fields blank — on one LAN you don't need them.

**Save → Connect.** A stable `clientId` is minted and persisted under your OS userData dir.

### Build an installer (optional)

```bash
npm run dist       # electron-builder → release/
```

## Test system control end-to-end

Once a node is connected with "Allow this machine to be controlled" ON, fire a screenshot +
cursor move at it from any machine that can reach the control plane (acts as a stand-in bot):

```bash
SHARED_SECRET=<secret> node scripts/test-remote-control.mjs --url=http://<host-ip>:35457
# flags: --client=<clientId> (else auto-picks an online node), --x= --y=, --click, --out=shot.png
```

It enqueues `screen.capture` (saves the PNG to disk) then `desktop.control` (moves the cursor;
add `--click` to also click). Prints PASS/FAIL. **Coordinate note:** `screen.capture` is
downscaled, so a bot must scale click coords back to true resolution
(`realX = imgX * realScreenWidth / image.width`).

## Security / trust boundary

The remote-client surface authenticates with a **deployment-wide shared secret** — any holder of
that secret is fully trusted (this matches the existing remote-client/A2A model). Consequently:

- The optional **User sub** field is **caller-asserted**, not verified by OIDC. Treat the shared
  secret as a high-trust credential and only distribute it to trusted operators.
- This v1 does **not** thread per-user connector tokens (Gmail, SmartThings, …) into the bot. It
  is a conversational client; connector-backed tools that need a verified per-user identity are a
  follow-up (would require a verified identity, not a client-asserted sub). Plain chat and tools
  that don't need per-user creds work today.

## Files

| File | Role |
|---|---|
| `src/main/main.ts` | Electron main: window, IPC, client + worker lifecycle, OIDC sign-in window |
| `src/main/cockpit-window.ts` | Full-Jarvis mode: sandboxed window onto the swarm-hosted cockpit under the verified OIDC session |
| `src/main/preload.ts` | contextBridge `window.oshal` API |
| `src/main/mesh-client.ts` | A2A daemon: register / heartbeat / chat / poll (advertises worker capabilities) |
| `src/main/worker.ts` | worker loop: pull tasks → run locally → complete/fail |
| `src/main/local-tools.ts` | allowlisted local MCP tool registry (codex/claude/swarm.exec + gated system tools) |
| `src/main/executors.ts` | spawn codex/claude CLIs against the user's real `~/.` creds |
| `src/main/system-tools.ts` | gated screen/shell/input control (PowerShell P/Invoke) |
| `src/main/workspace-sync.ts` | scoped pull/additive-push of the held task's shared folder |
| `src/main/auth-manager.ts` | local-account status probes + browser-popup CLI login |
| `src/main/config.ts` | persisted settings (userData/config.json) |
| `src/main/vpn.ts` | optional headscale `tailscale up` helper |
| `src/renderer/*` | Jarvis orb + voice UI, config screen, worker activity log |
