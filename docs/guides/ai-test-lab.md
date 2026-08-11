# AI Test Lab — user guide (as-built)

Click the beaker icon labeled **AI Test Lab** in the cockpit's left ribbon, under the
**Optimization** group; it opens the surface embedded in the cockpit. (The rail hover-expands to
show labels — pin it from the toggle at its top-right if you want the names to stay put.) The same
page is served directly at **`/api/test-lab/app`** if you prefer a full browser tab. You must be
signed in: the lab runs every scenario with *your* session, so what you see reflects your own
accounts, connections and permissions.

This screen is a black-box check on the instance in front of you. It fires real requests at the
live endpoints — the same ones you would hit by clicking around the cockpit — and reports what came
back. Nothing is mocked and no result is smoothed over: a step is **pass**, **degraded**, **gap**
or **fail**, and the amber and purple states are as much the point as the green ones.

## What you see

### Header

The eyebrow **Operational Proof**, the title **AI Test Lab**, a one-line description, and three
controls:

| Control | What clicking it does |
|---|---|
| **Run all** | Runs every scenario in the catalog, in one request, and paints the results as they come back. The button disables itself and reads **Running...** until the whole batch returns. |
| **Refresh** | Reloads the scenario catalog from the server and resets every card to `idle`. Use it after someone deploys a change, or if the page loaded before the instance was ready. |
| **Eval Wall** | Opens the Eval Wall — the running history of graded nightly runs. It is a different screen, not a view of what you just ran here, and it opens *in place*: the lab navigates away and the results on screen are gone. It also has its own ribbon item, **Eval Wall**, in the same **Optimization** group. |

### Summary tiles

Six counters across the top, recalculated after every run:

| Tile | Meaning |
|---|---|
| **Catalog** | How many scenarios are registered on this instance. It does not change when you run things. |
| **Passed** | Scenarios whose every step came back clean. |
| **Degraded** | Scenarios that are alive but held back — an account isn't connected, an optional dependency isn't configured, or the work was accepted and is still running. |
| **Gaps** | Scenarios where a capability is not there at all: nothing answered at that address. This is a finding, not an error. |
| **Failed** | Scenarios that errored — a server error, or a result that broke the contract the lab asserts. |
| **Running** | Scenarios currently in flight. |

### Status line

The single line under the tiles is the lab's running commentary: `Loading catalog.` while it fetches,
then `Ready.` with how many scenarios loaded and how many live apps it saw, then one line per action
(`Running scenario.`, `Scenario complete.`, `Running all scenarios.`, `All scenarios complete.`, or
the matching failure line). If the catalog itself cannot be read it says `Unavailable.` and the body
shows **Test Lab unavailable** with the reason.

### Scenario groups

Scenario cards are grouped, always in this order:

**Rich visuals — rendered on demand.** One card per visual kind the assistant can draw. Today that
is Weather, Priority inbox, Table, Chart, Summary, Timeline, Diagram, Product gallery, Map / route,
Gauges / progress, Checklist / status, Agenda / day, Comparison, Profile / contact, and Image (on
the fly); the group grows as new kinds ship.
Each card renders a canned sample through the same drawing code the assistant uses, then shows you
the actual picture. These need no connected account and no bot node, so they answer "can this
instance still draw a chart?" on its own. The one exception is **Image (on the fly)**: real pictures
are embedded only from a verified workspace file, and the lab supplies none, so that card draws an
honest image *placeholder* rather than a photo — a pass there means the image layout rendered, not
that a picture was produced.

**Individual tools.** One card per built-in surface the lab currently covers, each hitting that
surface's main read endpoint once. It is not a card per surface in the cockpit, and the list moves:
surfaces that leave the platform for the app store lose their card. Today's cards are:

| Card | What a pass means |
|---|---|
| **Content Studio — signals** | The inbox-fed content signals read answered. Note that this answers — and passes — even when email scanning is switched off and no Google account is connected; it comes back with an empty list. A pass here is "the surface is up", not "your mail is wired up". |
| **RAG — collections** | The knowledge collections list answered. |
| **Personal Graph — stats** | The personal knowledge-graph stats answered. **This surface is off by default** — it exists only when the instance sets `PERSONAL_GRAPH_ROUTES=on`. Without it there is no endpoint to answer, so the card reports `gap`, not `degraded`. |
| **Memory — knowledge summary** | The swarm memory summary answered. |
| **Global search** | A cross-app search ran and returned. |
| **Security Center — findings** | Live security findings were readable. This one is operator-gated and fail-closed: unless your login is listed in `OSHAL_OPERATOR_SUBS` / `OSHAL_OPERATOR_EMAILS`, the surface answers "operator privilege required" and the card reports `degraded`. On an instance where no operator is configured at all, *everyone* sees `degraded` here. |
| **Workflow Studio — runs** | The authored workflow runs list answered. |
| **Connector Marketplace — catalog** | Intended to read the connector catalog. On current builds this card reports **`gap`**: the catalog moved under a different path and the card still asks for the old one, so nothing answers. Treat it as a known stale check, not as evidence that your connectors are broken — read the real catalog from the Connections group in the ribbon. |

**Jarvis routing + live visual delivery.** Two cards that talk to your assistant for real:

- *Jarvis routing — does it understand each ask?* sends plain-language asks ("What are my top job
  opportunities right now?", "Search flights from JFK to London next month.", "Find a Lego set I
  could buy as a gift.") and checks that each one is understood — answered, or dispatched as work.
- *Jarvis rich delivery — ask, then SEE the image* asks for the provider-bound visuals and insists
  on a real picture coming back, not just words:

  | Ask | Expected picture |
  |---|---|
  | "What's the weather in Destin, Florida right now?" | a weather visual |
  | "What are my most important unread emails?" | a priority-inbox visual |
  | "Search Walmart for lego star wars sets" | a product gallery |

  An answer that arrives *without* a picture is marked `degraded` on purpose — that is the exact
  signal that rich delivery has regressed or the provider was unavailable.

  Both Jarvis cards need AI to be enabled on the deployment. On an instance installed without a
  model (`OSHAL_NO_AI=true`), the assistant refuses the ask outright and both cards come back
  `fail` with `ask failed HTTP 503.` — that is the deployment's posture, not a regression.

**Coupled multi-app workflows.** *Daily briefing — signals + work queue* runs several steps in
order and passes what each one produced to the next: it reads your inbox-fed content signals, reads
your open ticket queue, then confirms the pieces compose into one brief and tells you the counts it
had to work with.

### A scenario card

Each card carries the scenario title, its one-line description, a state badge (starting at `idle`),
a **Run** button, and one row per step. A step row shows a state chip on the left, then the step's
label and a detail line explaining the result — an HTTP status, a count, a reason, or the assistant's
first words. Before a run, a tool card's step is labelled with the raw request it is going to make
(for example `GET /api/rag/collections`); after the run it repaints with the friendly step name.
When a step produced a picture, its thumbnail appears under the detail; click it to open the
full-size image in a new tab.

## What you can do

### Run a single scenario

Click **Run** on its card. The badge goes to `run`, the card's buttons disable, and when the result
lands the badge and every step row repaint. This is the fast loop when you are chasing one surface.

### Run everything

Click **Run all**. Every card goes to `run` at once and the whole batch is executed server-side in a
single request; the status line warns you it may take a few minutes, mostly because the assistant
steps have to be waited on. Leave the tab open — the request has to come back to this page to paint.
If the batch itself fails (a dropped connection, for example), every scenario still marked `run` is
painted `fail` with that message rather than left spinning.

### See what the assistant would draw

Run any card in **Rich visuals**. The drawing happens on the spot, with the byte size and dimensions
in the detail line, and the result appears as a thumbnail (**Image (on the fly)** draws its
placeholder, as noted above). Nothing here calls a provider or touches your data.

### Check whether your accounts are actually wired up

Run the cards in **Individual tools** — there is no run-the-group button, so click **Run** on each,
or use **Run all** — and read the degraded rows. A surface that was stopped by authentication or a
missing scope says so in its detail line. It is a fast first pass, not a
complete connection audit: several surfaces answer normally with nothing connected and still show
`pass`, so use the Connections group in the ribbon for the authoritative picture.

## Reading the results

Every step, and every scenario, lands in one of four states. A scenario takes the worst state of any
of its steps.

| State | Meaning |
|---|---|
| **pass** | It worked, and the result matched what the lab asserted. |
| **degraded** | Alive but not fully green: it needs a connected account or a scope, an optional dependency is not configured, the input was rejected, or the work was accepted and hadn't finished in time. Worth reading, not necessarily worth fixing. |
| **gap** | Nothing answered at that address — the capability is missing, has moved, or is behind a flag that is off on this instance. A finding. |
| **fail** | A server error, or a response that broke the contract (for example, a picture that turned out not to be a real image). |

Two more values appear on the badge before a result exists: `idle` (never run since the page loaded)
and `run` (in flight).

The detail line tells you *why* a step landed where it did:

| What you see | What happened |
|---|---|
| `OK` | A clean answer. |
| `Dispatched (async).` — `degraded` | The request was accepted and handed off; there is no finished result to check yet. |
| `Reachable, but rejected the smoke input` | The surface answered but did not like the lab's sample input. It is up; the check is not conclusive. |
| `Needs a connected account, scope, or active session` | Authentication or permission stopped it — connect the account, or ask an operator if the surface is gated. |
| `Optional dependency not configured` | A part of the stack this surface can use is absent on this instance. |
| `No endpoint at ... — capability missing or route moved.` | Marked `gap`. |
| `Server error HTTP 5xx` | Marked `fail`. |
| `N signal(s)` / `N ticket(s)` | On the **Daily briefing** card: the surface worked and this is how much it had to work with. Zero is a normal pass. |
| `ask failed HTTP 503.` | The assistant refused the ask — usually a deployment installed without AI. Marked `fail`. |
| `still pending after 24s` / `after 48s` | The assistant accepted the ask but no result arrived in the polling window. Usually means long-running work or no live bot node. |
| `answered WITHOUT a visual` | The assistant replied in text where a picture was required. |
| `visual url is not an owner-scoped artifact URL` / `artifact is not a real SVG` | The picture came back, but not in the form the cockpit trusts. Marked `fail`. |

## What this screen does NOT do

- **It keeps no history.** Results live in the page. Reload, or click **Refresh**, and every card is
  back to `idle`. The running record of graded runs is the **Eval Wall**, linked in the header.
- **It does not grade quality.** This screen asks "did it work?", never "was the answer good?".
  Scoring complicated requests against an expected output is the nightly golden loop's job — that
  runs headless on a schedule and needs `SWARM_SERVICE_SECRET` and `TEST_LAB_OWNER_SUB` configured
  on the box; there is no button for it here.
- **It does not cover apps you installed from the store.** The scenario list covers the built-in
  surfaces. Installed packages bring their own routes and their own tests, so a store app you use
  every day will not appear as a card.
- **The rich-visual cards are not your data.** They render fixed sample facts (a Destin forecast,
  three made-up LEGO listings, a sample inbox) so the drawing code can be proven without an account.
  They are never a real deliverable and never leave this screen.
- **It fixes nothing and proposes nothing.** There is no remediation button. A gap or a failure here
  is information for you to act on.
- **It does not run unattended from this screen.** Every run starts with your click, under your
  session.
- **Assistant steps do real work.** The two Jarvis cards send genuine asks to your assistant, which
  may dispatch real tasks to your apps. The other groups read.

## If something looks wrong

**The body says "Test Lab unavailable" and the status line says `Unavailable.`**
The catalog could not be read. The usual causes are a signed-out session (sign in again and reopen
the surface) or an instance still starting up. Click **Refresh** once it is up.

**Nearly everything is amber.**
Degraded is the honest answer for "up, but not connected". Read the detail lines: they will name
authentication, an unconnected account or an unconfigured optional dependency. **Security Center —
findings** in particular reports degraded unless your login is on the operator allowlist
(`OSHAL_OPERATOR_SUBS` / `OSHAL_OPERATOR_EMAILS`), and that is expected.

**A card is purple — `gap`.**
Something the lab asked for is not there. Before treating it as a regression, check whether it is
one of the known off-by-default or stale checks: **Personal Graph — stats** is a `gap` on any
instance that has not set `PERSONAL_GRAPH_ROUTES=on`, and **Connector Marketplace — catalog** is a
`gap` on current builds because the card still asks for a path the catalog no longer uses.

**Both Jarvis cards failed with `ask failed HTTP 503.`**
The assistant is switched off on this deployment (`OSHAL_NO_AI=true`). Everything else on the
screen still runs; the two Jarvis cards cannot until a model is connected.

**The Jarvis steps sat there and came back "still pending".**
The assistant accepted the ask but nothing finished inside the polling window — up to about 24
seconds for a routing ask and about 48 seconds for a picture ask. That normally means no worker bot
node is running, or the work is genuinely long. Check that the swarm's bots are up, then re-run just
that card.

**A Jarvis step says it "answered WITHOUT a visual".**
The assistant replied in words where the check required a picture. Either the provider behind that
ask was unavailable at that moment, or rich delivery has regressed. Run the matching card in **Rich
visuals** to tell the two apart: if the sample still draws, the drawing code is fine and the problem
is on the live-answer side.

**My results disappeared.**
Reloading the surface — including the cockpit reloading the embedded frame — clears the run. Re-run
the card you care about, and use the Eval Wall when you need results that persist.

---

For the design rationale behind the lab, the nightly golden loop and the Eval Wall, see
[ADR-063](../adr/063-ai-test-lab.md); the feature-level notes and the nightly runner's setup are in
[test-lab.md](../test-lab.md).
