# Simple chat: one plain text screen, opt-in everywhere

**Status:** Phase 1 built 2026-10-01 (the kit, `/simple`, OSHAL Node Simple chat). Phases 2 and 3 are planned, not built.

## What was asked

Make the remote client (OSHAL Node, `packages/oshal-chat`) a plain text bot: the box you type in sits at
the bottom of the screen, the conversation history sits above it, and the first visit gives a little help
that then gets out of the way. Then assess every text screen in the platform and the applications against
the same pattern, and integrate it **without changing any existing screen for people who do not choose it**.

## The simple chat contract

A screen meets the contract when it has all six:

1. **Box at the bottom.** A multi-line box pinned to the bottom of the window. Enter sends, Shift+Enter
   starts a new line, and the box is disabled while a reply is pending.
2. **History above.** A scrolling history with the oldest turn at the top and the newest just above the box.
   It scrolls to the newest turn on load and after every reply.
3. **History survives a reload** when the backend already keeps one (the Jarvis thread, a chat task). A
   screen whose backend keeps none says so and does not fake it.
4. **Help the first time, then out of the way.** When there is no history yet and help has not been
   dismissed on this device, a short card explains what the assistant does and offers three example
   prompts that fill the box. It disappears after the first message or "Got it", and a Help button brings
   it back.
5. **Honest waiting and failure.** A "Thinking…" row while the reply is pending. A refusal or error is shown
   as a row in the history with the server's own message, and no figure or answer is invented.
6. **Nothing else on screen.** A slim header (title, Help, a link to the full screen), the history and the
   box. No orb, no pickers, no side panels, and voice is off.

Replies render as escape-first markdown: bold, italics, inline code, lists, paragraphs, and links. A link
must be same-origin or `https://`, and an absolute link opens in a new tab. An answer that carries an
application handoff, a file or a visual shows it as a link ("Open Finance ↗", "↓ report.pdf",
"Open Jarvis to see the picture") instead of dropping it.

## Assessment: the text screens today

The columns are the contract's first four points plus how much else competes for the screen (clutter). The
inventory was taken from the tree on 2026-10-01.

### Platform screens (default, not opt-in)

| Screen | Box at bottom | History above | Survives reload | First-run help | Clutter |
|---|---|---|---|---|---|
| `/chat` standalone chat | yes | yes | no (fresh task id per load) | gear-menu hint | high |
| Cockpit right-hand chat panel (`/swarmbot/chat?embed=cockpit`, the chat for every app that declares `chatBot:`) | yes | yes | same tab only | "This bot is ready…" | medium |
| `/swarmbot/chat` full window | yes | yes | yes (task id in the URL) | yes | high (up to 9 toolbar buttons, 5 modals) |
| Jarvis page `/api/jarvis/` (ribbon Jarvis tile, `?app=jarvis`, the orb panel, the OSHAL Node Full Jarvis window) | **no**: near the top, under the orb | **no**: latest exchange only; the transcript is in a drawer | no (the current thread is not re-rendered) | starter chips | high (about 20 controls, 2 canvases) |
| Cockpit Home Jarvis panel | as the Jarvis page | as the Jarvis page | as the Jarvis page | as the Jarvis page | medium |
| Workflow Studio "Talk to build" | yes, behind a floating button | yes | no | greeting | high (around it) |
| `/haven` | yes | yes | no (browser memory) | yes, 4 chips | low |
| Create Ticket "Intake Assistant" tab | yes, inside a modal | yes | no | assistant speaks first | low |
| Ticket detail feed reply | yes | newest first | yes | empty state | medium |
| Jarvis phone remote `/api/jarvis/remote` | yes | no (latest answer only) | no | no | low |
| `/swarm-control` (legacy, unlinked) | yes | yes | no | no | medium |

### Opt-in experience shells (ADR-164)

All six read the Jarvis thread on load (`GET /api/jarvis/history`), so their history survives a reload.

| Shell | Box | History |
|---|---|---|
| `/studio` | bottom of the centre column | above the box |
| `/jarvis` | middle of the page | above the box, when the thread has turns |
| `/orbit` | inside an "Ask Jarvis" dialog | below the box |
| `/commons` | bottom of the room conversation | above the box |
| `/nexus` | centred, then a short follow-up box | no scrolling transcript |
| `/homebase` presets | a one-line box at the end of the main column | the latest reply; the last 4 turns in a dialog |

### Application screens (store and private packages)

22 own-screen chats in 21 packages, 3 of them in the private repository. 29 more packages have no chat
screen of their own and use the cockpit chat panel through `chatBot:`.

- **Box at the bottom:** every one of the 22 already puts the box at the bottom of its panel.
- **History above:** 19 show a scrolling history; 3 show only the latest reply (Home, Career "Talk to this
  job", Pumpkin).
- **Survives reload:** only 5 bring the conversation back after a reload (Movies, Spotify, Drone, D&D and
  one private planning clerk). Purchasing, Eats, Rides and Travel already have a working
  `GET /conversation` route that their page never calls.
- **First-run help:** most have a greeting or chips; Drone, Sat Ops and one private planning clerk have
  none.
- **Clutter:** most embed the chat as one panel in a busy application screen. 12 to 40 other controls
  compete with it in Purchasing, Eats, Rides, Drone, Sat Ops, Camera, Aero Lab, Presentations and D&D.

### What the assessment says

- **The pattern is mostly there.** Box at the bottom and history above is already the norm. The two real
  gaps are history that disappears on reload and screens where the chat is one small panel among many.
- **The worst case is the remote client.** The OSHAL Node's local window shows only the latest exchange
  and hides typing behind a "⌨ Type" button, and its Full Jarvis window opens the Jarvis page, which has
  the box near the top, only the latest exchange, and about 20 controls.
- **Changing the default screens is ruled out.** Their current layout is what their users know. The fix
  has to be an alternative presentation that a person chooses.

## Design: an opt-in simple chat over unchanged backends

This follows the ADR-164 rule that the default screens are untouched and a different presentation is
something a person opts into ([ADR-164](../adr/164-configurable-experience-skins-and-application-views.md),
[experience-shells.md](./experience-shells.md)).

- **One kit.** `src/shared/ui/js/simple-chat.js` and `src/shared/ui/css/simple-chat.css` (served at
  `/shared/ui/...`) draw the contract above from an adapter the page supplies: a `send(text)` that
  resolves to the reply, an optional `history()` and the help text. The kit owns layout, help, rendering and
  waiting. It owns no endpoint, so it adds no route and no permission.
- **The hosted simple chat: `/simple`.** A new page (`src/experience/simple.html`) that uses the kit over the
  **Jarvis thread**, with the same endpoints the shells already use: `POST /api/jarvis/ask`, then
  `GET /api/jarvis/ask/result`, and `GET /api/jarvis/history` on load. It shares the device's
  `jarvisSessionId`, so it is the same conversation as the Jarvis page and the shells. It is served behind
  `requiresAuth` like every experience page. The Jarvis page itself is not edited.
- **The remote client.** OSHAL Node gets one setting, **Window: Voice orb (default) / Simple chat**
  (`viewMode`, seedable as `OSHAL_VIEW=chat`). Simple chat changes two things:
  - The node's own window shows a local simple chat instead of the orb. It uses the node's existing chat
    route (`POST /api/remote-clients/:id/chat`, reply on the poll) and keeps its history on this machine,
    because that route has no history read.
  - The Full Jarvis window opens `/simple` instead of the Jarvis cockpit.

  The orb, the voice controls, the worker log, Config and every other setting stay exactly as they are.
  A node that never selects Simple chat behaves exactly as before.
- **How people find it.** "Simple chat" is added as one more entry in the cockpit's Experiences menu and in
  the shells' experience picker. Nothing else in those menus moves.

### Why not the alternatives

| Option | Gain | Cost |
|---|---|---|
| Restyle the Jarvis page and the chat panel for everyone | One look everywhere | Changes the default for every user; ruled out by the request |
| A `?layout=simple` switch inside the 2,743-line Jarvis page | No new route | Touches the busiest page in the platform for an opt-in mode; a new page carries no such risk |
| **A new `/simple` page plus the kit (chosen)** | Zero change to existing screens; the kit is reusable for Phases 2 and 3 | One new route and one menu entry |

## Phases

### Phase 1: the remote client and `/simple` (this build)

- The kit, `/simple`, the Experiences menu entry and the picker entry.
- OSHAL Node's Simple chat setting, its local simple chat window, and `/simple` for its Full Jarvis window.
- **Done when:**
  - a headless browser spec drives `/simple` through the real static routes: first-run help, an example
    prompt, a sent turn, a rendered answer with its links, history restored on reload, a refusal shown as a
    row, the expired-session retry, and 401 without sign-in;
  - a headless spec drives the Node's real renderer with its desktop bridge stubbed: the orb is unchanged
    by default, Simple chat shows the local view, and turns, replies, errors and history work there too;
  - the config spec proves the `viewMode` default, `OSHAL_VIEW` and the Full Jarvis path;
  - the deployed box serves `/simple` to a signed-in user, and a live ask round-trips through it.

### Phase 2: the platform's shared chat screens (planned)

- `/swarmbot/chat?layout=simple`, over the screen's own task history (`GET /api/:taskId/messages`). This
  covers every app that declares `chatBot:` and the cockpit chat panel.
- A per-device "Simple chat" switch in the cockpit that opens the chat panel and the orb panel in the
  simple layout.
- `/chat?layout=simple`.
- **Done when:** each has a browser spec for its default layout unchanged and its simple layout meeting the
  contract, and is live-checked on the box.

### Phase 3: application screens (planned)

- The 22 own-screen chats adopt the kit under `?layout=simple`, in batches, the same way the audience views
  were rolled out. Each package keeps its full page by default.
- Where a history route already exists (Purchasing, Eats, Rides, Travel, Movies, Spotify, Drone, D&D), the
  simple layout restores the conversation on load.
- **Done when:** each package ships a contract test, a browser fixture and a version bump, passes the store
  gate, and is live-checked in its simple layout.

### Not planned

- Workflow Studio "Talk to build": it draws a workflow graph, and the graph is the point.
- The Intake Assistant modal and the ticket feed.
- `/swarm-control` and the orphaned `/chat-assets/chat.html`.
