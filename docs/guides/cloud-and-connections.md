# Utilities & Connectors — user guide (as-built)

Open **`/utilities`**. Inside the cockpit, click the gear icon labeled *Settings* at the foot of the
ribbon and choose the **Connections** tab — it embeds the same page. (The plug icon labeled
*Connectors*, further down the same ribbon, is a **different** screen — a catalog for browsing and
enabling connectors. The page described here is the one under Settings → Connections.) You must be
signed in. Every button on this screen acts on your own account, with one exception called out
below: the *LLM providers* block is the deployment's shared configuration. A connector result in
global search opens `/utilities?connector=<provider>`, which scrolls to that connector's card and
outlines it.

This is where you grant access. Two different kinds of access live here: **AI provider logins**,
which give chat and bots something to think with, and **data connectors**, which let bots read or
act on an account you own (your mail, your chat workspace, your brokerage, your smart-home hub).
Connecting anything here is a separate, explicit consent — it never changes how you sign in to
oshal, and each connection can be removed on its own.

## AI provider login vs data connector

| | AI provider login | Data connector |
|---|---|---|
| What it grants | permission to run reasoning turns (chat, Jarvis, and bot work the deployment allows — see the gate below) | access to one account at one outside service |
| Where on this page | *Bot LLM access*, *Free model lanes*, *LLM providers* | *Your accounts* |
| What you supply | a login, an API key, or an OpenAI-compatible endpoint | a consent redirect, or a Personal Access Token you paste |
| Who it belongs to | the Claude Code and Gemini tiles are the deployment's shared logins; your own free lanes and your own endpoint are yours | always yours, or a household you belong to |
| What it means when it breaks | turns fall through to the next available brain | the specific feature that needed that account stops, and the card says *needs reconnect* |

The practical difference: an AI provider decides *who does the thinking*. A data connector decides
*what the thinking is allowed to touch*. Connecting Gmail does not give you a brain; choosing a
default brain does not give bots your mail.

## What you see

The page runs top to bottom in one column.

**Banner** (only after something happened) — green *✓ Connected \<provider>.* when you come back
from a consent flow, or red *Could not connect: \<reason>* when it failed. A red banner also
appears on load when a live check finds a stored login the provider will no longer honor.

**Your account** — your name and email, and **Sign out**. If the session has lapsed, the card
reads *Not signed in* and offers **Sign in**.

**Bot LLM access** — these cards:

- **My default brain** — radio buttons for which provider runs your work. The line under the title
  restates your current choice. Options you cannot use yet stay visible but greyed out and
  unclickable, so you can see what connecting something would unlock. Picking one saves
  immediately: *Saved. New conversations use it right away.*
- **Claude Code (Anthropic)** — status plus, when disconnected, **Connect**. Connect opens
  Anthropic's authorization page in a new tab and reveals a paste box; paste the code Anthropic
  shows you and press **Submit code**. When it is already connected the button reads
  **Sign out (shared)** and is deliberately disabled — this is a shared credential the operator
  manages, and signing it out would stop every user's bots.
- **OpenAI Codex (ChatGPT)** — status plus **Connect** (or **Re-import** and **Sign out** once
  connected). Connect reveals an import box, because the browser sign-in redirect completes only on
  the machine the Codex CLI runs on. Choose the `auth.json` the CLI already wrote, or paste its
  contents, and press **Import credentials**.
- **Gemini (Google)** — status and a **How to connect** button. There is no browser sign-in here:
  the Google login hands the credential back to the host PC, so the help panel gives the host-side
  steps (double-click `Connect-AI.bat` in the install folder, or run `gemini` once on the host and
  choose *Login with Google*, or put a `GEMINI_API_KEY` in the deployment's `.env` and restart).
  While disconnected the tile re-checks every 8 seconds and flips to Connected on its own.

**A gate these three tiles do not mention.** Their status text reads "bots can run on Claude / Codex
/ Gemini", and that overstates what the platform currently permits. Unattended command-line harness
execution (Claude Code, Codex, Cline, Gemini CLI) is **refused by default** — a bot job that resolves
to one of them fails closed rather than launching it. The single exception: a deployment running with
`DEMO_MODE` enabled will run Claude Code or Codex for a request owned by a subject listed in
`OSHAL_OPERATOR_SUBS`. Connecting these logins is still worth doing — the status is real, and it is
what makes the matching *My default brain* options selectable — but on an ordinary deployment it does
not turn ticket-running bots onto that subscription.

**Free model lanes** — free-tier AI keys you bring yourself, rotated across. The summary line
counts what you have connected, how many are active, cooling down, never used, or not picked in a
day; **Full walkthrough →** opens `/free-models`. A note states the honest scope: these power your
chat and Jarvis turns, while tool-running bot work (tickets, file and shell actions) runs on the
harness logins above. Below that, one line for the **shared platform lane** (see the table further
down), then a card per provider with **Get a key ↗**, **Connect**, and — once connected —
**Disconnect**.

**LLM providers** — the deployment's built-in provider roster. Each row shows the provider name, a
kind badge (`🖥️ local`, `🔐 login`, or `🔑 key`), its state (`★ default`, `✓ configured`, or
`not set`), and **Configure ▾**. Expanding gives an API-key field (key-based providers only —
login-based and local ones say so instead), a model dropdown, **Save**, and **Use as default**. On
the provider that is already the default, that last control is not a button: it reads
*Current default ★*. Anything you save here is the deployment's shared configuration, not a personal
setting — the first provider configured becomes the default for the whole box.

**Your accounts** — the data connectors:

- **Connecting as** — a dropdown: *Personal (just me)*, or any household you belong to (its name
  and your role). Whatever is selected here is who the next connection belongs to.
  **+ New household** asks for a name, creates it, and makes you its admin.
- **Summary tiles** — accounts, connected, need reconnect (shown only when there is at least one),
  ready, needs setup.
- **Search connectors** and a status dropdown (*All status* / *Connected* / *Ready* /
  *Needs setup*) that filter the list live.
- **The connector cards**, grouped under category headings in this order: Bring Your Own LLM,
  Sign-in & Identity, Social Media, Messaging, Email & Calendar, Storage, IoT, DevOps & Cloud,
  Shopping, Food Delivery, Transportation, Music, Movies & TV, Travel, Trading & Brokerage, Other.
  A heading appears only when something in it matches your search and filter. Those headings are
  also the whole of what this page draws: a connector filed under a category that has no heading
  here — the payment-acceptance connectors, Square and PayPal, are the current case — does not
  appear on this screen at all, and searching for it finds nothing.

Each card carries an icon, the connector's name, and a status pill. Under that, one row per
connected account — `✓ label · account · Personal` or `🏠 <household>`, marked `default` when it is
the one a bare request resolves to — with the links **rename**, **make default** (absent on the row
that already is the default) and **disconnect** (drawn on personal rows only). Then the way in: a
**Connect** button (it reads **Add account** once you already have one there), or a token field, or
a note saying the connector is not configured on this deployment.

A few connectors add a launcher once connected: Slack gets **Open Slack Feed →** and Duffel gets
**Open Travel →**.

**More providers planned** — Yahoo Mail, Instagram, Mastodon and Databricks as plain chips. They
are labels, not buttons.

## Status pills and tiles

| Pill on a connector card | What it means |
|---|---|
| `N connected` | you have N accounts stored for this connector, and the last live check did not find the grant dead |
| `needs reconnect` | you have a connection, but the provider refused a real token refresh — it will not honor it, so reconnect |
| `ready` | it can be connected right now: either its OAuth client is registered on this deployment, or it takes a token you paste, or a shared key already covers it |
| `needs setup` | nothing on this deployment can connect it yet — its OAuth client has not been registered |

| Summary tile | What it counts |
|---|---|
| accounts | every connected account across every connector, including household ones |
| connected | connectors with at least one working account (ones needing reconnect are excluded) |
| need reconnect | connectors whose live check says the provider rejected the stored grant |
| ready | every connector this deployment is able to connect — this counts the ones you have already connected too, so it is always the larger number |
| needs setup | connectors that need operator setup first |

| Free-lane pill | What it means |
|---|---|
| `connected` | in the rotation and eligible to be picked |
| `cooling down` | the provider refused it recently; the row says when it comes back |
| `not picked in a day` | connected and eligible, but rotation has not chosen it in over a day |

| Shared platform lane state | What it means |
|---|---|
| `not configured` | no `OPENROUTER_API_KEY` on this box, so the shared free default is off and every turn uses your own lanes or the bot's own provider |
| `live` | the shared lane answered on the named model |
| `quota-walled` | every free model was refused; requests fall through to the bot's own provider |
| `not probed recently` | this API process has no cached verdict — checking costs real quota, so the panel will not guess |

## What you can do

**Connect an account with a sign-in redirect.** Pick who it belongs to in *Connecting as*, type an
optional label on the card (for example `work email`), and press **Connect**. You land on the
provider's consent screen; approving brings you back here with a green banner and the account
listed on the card.

**Connect an account by pasting a token.** Some connectors have no sign-in redirect and take a
Personal Access Token instead. Where the connector publishes one, the card links **(get a token)**.
Paste it, add an optional label, press **Save**. The token is checked against the provider before
anything is stored, so a bad paste fails immediately rather than looking connected. A few
connectors need a second value alongside the token — an Atlassian account email, a Twilio Account
SID, or a Kalshi API Key ID. Where the secret is itself a multi-line private key (Kalshi), the
field is a text area so your paste is not cut at the first line break. Paste every line, BEGIN
through END.

**Add a second account of the same connector.** On a sign-in connector you have already connected,
the button reads **Add account** rather than Connect. For Google and Microsoft accounts, pressing it
forces the provider's own account chooser, so the second sign-in becomes a new labeled connection
rather than a silent re-authorization of the first. Other providers have no chooser parameter to
send, so they show their normal consent screen — whichever account your browser is signed into there
is the one you will get. Token connectors have no **Add account** button at all: paste the second
token with a different label and press **Save**.

**Say which account is the default.** With more than one account on a connector, click **make
default** on the row you want bots to use when nothing more specific is asked for. **rename** gives
a row a friendlier label; the label is also how a request can ask for that specific account.

**Disconnect an account.** Click **disconnect** on the row and confirm. Where the provider offers a
revoke endpoint, the stored refresh token is revoked there first; then the row is deleted. If you
disconnect the default of two accounts, the remaining one is promoted.

**Reconnect a login the provider stopped honoring.** When the live check gets a refusal, the card
grows a red line — *⚠ \<provider> will no longer honor this connection* — and the pill turns to
*needs reconnect*. Go through the provider's consent screen again from that same card. Because the
card already has an account on it, the button you press is labeled **Add account**, not Connect —
approve the *same* account and it refreshes the existing connection instead of adding one. It takes
about thirty seconds. If you had given that account a custom label, type it into the card's label
box before you go: a reconnect with the label box left blank re-labels the row with the account
address.

**Connect on behalf of a household.** Choose the household in *Connecting as* before you press
Connect. The resulting connection shows `🏠 <household>` on its row and is usable by every member,
so one person's hub credential serves everyone in it.

**Bring your own model endpoint.** The *Bring Your Own LLM* card takes any OpenAI-compatible
endpoint: an optional label, the base URL, a model, and a key. **List models** asks the endpoint
what it serves and fills the model dropdown. **Test** does a live round-trip and reports the reply,
latency and model. **Save & validate** stores it only after the endpoint answers; the key is
encrypted. Leaving the key blank on a re-save keeps the existing one.

**Connect a free lane.** Press **Connect** on a provider under *Free model lanes*, paste the key
(**Get a key ↗** opens the provider's page), and **Save**. It is validated with a real test call
before it joins the rotation. Where a provider supports it — OpenRouter today — **Connect** is a
one-click sign-in instead of a pasted key, and returns you to this page afterwards.

**Choose the brain that runs your work.**

| Option | What it does | When it is selectable |
|---|---|---|
| Automatic | uses the best available: your own key first, then whatever this deployment offers | always |
| Claude Code (this machine's login) | runs on the Claude Code subscription signed in on this machine | only when the deployment runs with `DEMO_MODE` on and you are its operator |
| OpenAI Codex (this machine's login) | runs on the Codex/ChatGPT login signed in on this machine | same condition as above |
| My own endpoint | your saved OpenAI-compatible endpoint | after you save one on this page |
| My free tiers | rotates across your connected free lanes | once at least one lane is connected and not cooling down |

Choosing is a preference, not a grant: the list offers what you can already use, and if a choice
stops working at run time the turn falls through to the next available option instead of failing.

## What a connector token can and cannot do

- **The permissions are the connector's, not yours to tune here.** Each connector asks the provider
  for a fixed set of scopes. Google, for example, is configured for reading mail and calendar,
  sending mail, and per-file Drive access limited to files oshal itself creates — it cannot read
  your existing Drive contents.
- **Permissions are frozen at connect time.** When a connector's permission set is widened later,
  your existing connection keeps what it was granted until you reconnect. That is why a feature can
  report a missing permission on an account that looks connected.
- **Tokens are encrypted where they are stored,** and the list this page draws carries account
  labels, emails and status only — never a token.
- **Disconnect ends it at your end, and at the provider's when the provider supports revocation.**
  Where the provider offers no revoke endpoint, the local record is still removed; you can also
  remove the app from the provider's own connected-apps settings.
- **A connection is scoped to you.** Personal connections resolve for your account and nothing
  else; household connections resolve for members of that household. Another signed-in user does
  not see your accounts on their copy of this screen and cannot act through them.

## What this screen does NOT do

- **It does not set which model an individual bot runs on.** Per-bot provider and model settings
  live in the cockpit's Settings, under *Bot Settings*. This screen is authorization — the place
  you grant access to an account.
- **You cannot sign out the shared AI logins from here.** The Claude Code button is present but
  disabled and labeled *(shared)*, and the Gemini tile has no sign-out control at all. The operator
  manages both on the host. Codex is the exception — its **Sign out** button works.
- **Gemini cannot be signed in from the browser.** The tile reports status and polls; the login
  itself happens on the host PC.
- **The two "this machine's login" default-brain options stay disabled** unless the deployment runs
  with `DEMO_MODE` enabled and you are its operator. They remain visible so you can see they exist.
- **The shared free lane is off** when `OPENROUTER_API_KEY` is not set on the box; the platform-lane
  row says so in plain words rather than hiding it.
- **Free lanes do not run tool-using bot work.** They serve chat and Jarvis turns. Tickets, file and
  shell actions want the harness logins in *Bot LLM access* — which, on a deployment that is not
  running `DEMO_MODE` for its configured operator, are themselves refused for unattended work. Free
  lanes are not the missing piece there.
- **A household connection cannot be removed here.** The disconnect link is drawn for personal
  connections only; removing a shared one is a household-admin action that is not on this screen.
  Adding people to a household is not on this screen either — **+ New household** creates one and
  makes you its admin, and nothing more.
- **A connector marked *Not configured* cannot be fixed from this page.** It reads *needs an OAuth
  client + the redirect URI registered*, which is operator work on the provider's developer console
  plus the deployment's environment.
- **The *More providers planned* chips do nothing.** They are labels for connectors that do not
  exist yet.
- **Saving a connection requires the deployment's `SESSION_SECRET` to be set.** Without it the
  encryption of stored credentials fails by design rather than falling back to a weak key, and
  connect attempts error out.

## If something looks wrong

**The card says *needs reconnect* but the account works elsewhere.** The badge comes from a real
token refresh against the provider, not from the presence of a saved row — the provider actively
refused. Reconnect on that card. The result is cached for up to fifteen minutes, so after you fix
it the badge can lag; reload the page a little later if it has not caught up.

**A card says *connected* and a feature still says it needs access.** Almost always a permission
added after you connected. Run consent again from that card — the button reads **Add account** once
an account is listed — approving the same account picks up the current permission set; nothing else
about the connection changes.

**I added a second account and it looks like it replaced the first.** Give the second one its own
label before you press **Add account**. On Google and Microsoft that button also forces the
provider's account chooser; if the chooser appears but shows one account, sign into the other account
at that provider in your browser first, then try again. On a provider with no chooser, sign out of
the first account at the provider (or use a second browser profile) before connecting — otherwise
the consent screen silently re-approves the account already signed in.

**A pasted token was rejected.** Nothing is stored unless the provider confirms it, so *token
rejected by provider* means the value did not work, not that it saved badly. Check you copied the
whole value; for a connector that also asks for an account id (Atlassian email, Twilio SID, Kalshi
key id) fill that field too; for a multi-line private key paste every line including the BEGIN and
END markers.

**The Gemini tile never turns green.** It is a status display. Finish the Google sign-in on the host
PC as the help panel describes; the tile checks every 8 seconds and flips itself once the login
lands.

---

Design rationale for per-user and per-household connector isolation is in
[ADR-042](../adr/042-iot-connector-tenancy.md); the default-brain choice is
[ADR-127](../adr/127-demo-mode-cli-brain-and-user-provider-preference.md).
