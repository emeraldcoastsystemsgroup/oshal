# Identity Hub — user guide (as-built)

Open **`/cockpit/?app=identity`** — the ribbon opens on the key icon labeled *Identity Hub*. The page
itself is served at **`/api/identity/`** and can be opened directly in a tab. **Identity Hub ships as
an installable app, not as part of the base cockpit** — if the ribbon entry and `/api/identity/` are
missing, the app has not been installed on your deployment yet (see
[What this screen does NOT do](#what-this-screen-does-not-do)).

This is a launcher over the accounts you have already authorized. It shows every provider oshal knows
about, which of them you are connected to and under which account, and gives you one click to jump
into a provider, re-run a login whose authorization has lapsed, or start a new one. It never shows,
copies, or hands you back a password, token, or API key.

## What you see

The page runs top to bottom in one column.

**Hero** — the eyebrow *Connected Account Launcher*, the title **Identity Hub**, a one-line summary,
and two buttons on the right:

| Button | What it does when clicked |
|---|---|
| **Manage connections** (gear icon) | Opens the Connections page (`/utilities`) in a new browser tab — that is where accounts are added, relabeled, made default, or removed. |
| **Access review** (shield icon) | Runs the optional review over your connections and prints it in a panel above the grid. The button greys out while it runs. |

**Summary tiles** — four counts, computed once when the page loads and taken over the **whole**
catalog. They do not change when you type in the search box or switch filters:

| Tile | What it counts |
|---|---|
| **Connected** | Providers where you have at least one account connected. |
| **Need attention** | Providers with an account whose sign-in has lapsed and cannot renew itself — the ones where clicking **Reconnect** is the only fix. Most connected accounts hold a renewal token and top themselves up silently (a Google sign-in does this every hour), so a healthy setup reads 0 here and that is the expected number. |
| **Ready to enable** | Providers whose sign-in flow is set up on this deployment, plus the ones you set up yourself by pasting a token or supplying your own endpoint. |
| **Categories** | How many purpose groups the whole catalog contains — not the number of headings currently on screen. |

**Search and filters** — a search box (*Search accounts, providers, or categories*) that matches on
the provider name, its internal id, its category, how it authenticates, and the labels of your
connected accounts (or an account's email address, when you never gave it a label). Next to it, four
filter buttons; the active one is highlighted:

| Filter | Shows |
|---|---|
| **All** | Everything in the catalog. |
| **Connected** | Providers you have at least one account on. |
| **Needs attention** | Providers you are connected to whose sign-in has lapsed and cannot renew itself, plus any whose sign-in flow is no longer set up on this deployment. Usually empty, because usually nothing is broken. |
| **Available** | Providers you have not connected. |

Typing and filtering redraw the grid immediately; nothing is sent to the server.

**The grid** — provider cards grouped by purpose. The groups the hub has a written-out heading for
come first, always in this order: *Sign-in & Identity*, *Email & Calendar*, *Social*, *Storage &
Code*, *Smart Home*, *Cloud & DevOps*, *Music*, *Movies & TV*, *AI / LLM*, *Other*. That list is not
the whole set: any other purpose group your catalog contains — *Finance*, *Payments*, *Travel* and
the like — appears **after** *Other*, headed by its raw category name with the first letter
capitalised. Any group with no matching card is skipped. Inside a group, connected providers come
first, and each of those two blocks is sorted alphabetically.

Each card carries an icon, the provider's name, a second line reading *category - how it
authenticates*, a status pill, your account lines (or *Not connected yet.*), and its action buttons.

**Footer line** — "*N* of *M* providers connected", counted over the whole catalog rather than the
cards currently on screen, plus a restatement that Open launches a provider in a new tab while
Reconnect and Connect run the consent flow.

## Card status pills

| Pill | Meaning |
|---|---|
| **Connected** (green) | You have at least one account on this provider and none of them is flagged expired. |
| **Reconnect** (red) | At least one of your accounts on this provider has lapsed and cannot renew itself. This is the one pill that asks you to act. |
| **Not connected** (grey) | You have no account on this provider. |

## Account lines

Under the pill, each connected account gets a line. Three markers can appear on it:

| Marker | Meaning |
|---|---|
| **★** | This is the default account for that provider — the one bots use when nothing else is specified. |
| **shared** | The account belongs to a household/tenant you are a member of, not to you personally. |
| **· expired** | That account's authorization has lapsed and there is no renewal token to revive it, so it will keep failing until you reconnect. An account whose short-lived token has merely gone stale is **not** marked — it renews itself. |

## Card buttons

Which buttons a card shows depends on the provider's state. Every one of them opens a new browser tab
— a consent flow cannot run inside the embedded page.

| Button | When it appears | What it does |
|---|---|---|
| **Open ↗** | You are connected and the hub knows a web destination for that provider | Opens that provider's site in a new tab. |
| **Reconnect** | You are connected, and the provider uses a redirect sign-in that is set up here | Re-runs the consent flow. Because you already hold an account there, Google and Microsoft sign-ins open on their **account chooser** — pick the same account to refresh it; picking a different one adds a second account instead of renewing the first. |
| **Connect** | You are not connected, and the provider's sign-in is set up here | Starts the consent flow. |
| **Manage** / **Set up** | The provider is set up by pasting a token, by supplying your own model endpoint (the *Bring Your Own LLM* card), or it is a redirect provider this deployment has not registered that accepts a pasted token instead | Opens the Connections page, where you paste it. *Manage* if you are already connected, *Set up* if not. |
| **Not configured** (greyed out, unclickable) | The provider needs a sign-in registration this deployment has not done | Nothing. The tooltip reads *This connector's OAuth client isn't configured yet* — an operator has to register the app before you can connect. |

Providers with an **Open** destination today: Google (goes to Gmail), Google Cloud, Facebook, Meta
Business Suite, LinkedIn, Outlook mail, X, GitHub, Dropbox, SmartThings, Google Home, Spotify, and
TMDB. A connected provider outside that set still shows its accounts and whichever of *Reconnect*,
*Manage* or *Not configured* applies to it — it just has no Open button.

## What you can do

**See every account you have connected.** Load the page. Scan the tiles for the totals, or use the
**Connected** filter to hide everything you have not connected. Search by an account's label if you
have several on one provider.

**Jump into a provider.** Find its card and click **Open ↗**. It opens in a new tab using whatever
session your browser already has with that provider — the hub does not sign you in for you and passes
nothing along.

**Reconnect a login that has lapsed.** Find the provider, click **Reconnect**, and complete the
provider's consent screen in the tab that opens. On a Google or Microsoft sign-in that screen starts
with the account chooser — pick the account you are refreshing, or you end up with a second account
on that card. Come back to the hub tab and reload it — the grid is drawn once at load and does not
refresh itself while you are away.

**Connect something new.** Click **Connect** on any card showing *Not connected*, and approve the
consent screen. The hub cannot give the new account a nickname — it arrives labelled with its own
account email, and you rename it on the Connections page if you keep several accounts on one
provider. For a provider whose card offers **Set up** instead, you paste a token on the Connections
page that opens.

**Run the access review.** Click **Access review**. A panel appears above the grid with a short,
practical read of your connections, in up to three sections:

| Section | What it contains |
|---|---|
| **Needs attention now** | Authorizations that have lapsed and cannot renew themselves, named by provider and account. The advisor is told which accounts can self-renew, so a stale-but-healthy sign-in is not reported here. |
| **Housekeeping** | Duplicate accounts on one provider, a provider with no default set, accounts that look stale. |
| **Worth adding** | Connectors you do not have that would round out your setup, when there is a genuinely useful one. |

A section with nothing to say is left out. If you have nothing connected at all, you get a short
"connect the ones you use most" message and no reasoning is run, so an empty hub costs nothing.

## What this screen does NOT do

- **It never reveals a secret.** No password, access token, refresh token, or API key is shown,
  copied, or handed back — not on a card, not in the review. oshal stores your authorization so your
  bots can act for you; this screen launches and re-links, and that is all. It is not a password
  wallet.
- **It does not disconnect, revoke, relabel, or change a default.** Those actions live on the
  Connections page behind **Manage connections** — see
  [Utilities & Connectors](cloud-and-connections.md).
- **The review acts on nothing.** The advisor observes and recommends; it cannot connect, reconnect,
  or revoke. It is handed metadata only — provider, account label, personal-or-shared, default flag,
  expiry — and never a token. Acting on its advice is still your click.
- **The review needs a working model.** On a deployment running with AI switched off
  (`OSHAL_NO_AI=true`), or with no provider configured for the advisor, **Access review** returns a
  *Review failed: …* message instead of a report. Nothing else on the page depends on it — the grid,
  the search box, the filters and every card button keep working.
- **It does not have its own list of providers.** The catalog and your connection state are read from
  your Connections list when the page loads, so a provider that is not in this deployment's
  connector catalog will not appear here.
- **A greyed-out *Not configured* card is not something you can fix.** It waits on an operator
  registering that provider's sign-in for the deployment.
- **The ribbon is trimmed while you are in this app.** With `?app=identity` in the URL, the framework
  entries Tickets, Chat, Calendar, Address book, Dashboard, Echo, Logs and Operations are hidden.
  Open plain `/cockpit/` to get them back.
- **The base cockpit does not mount it.** Identity Hub is a store app that has to be installed
  (`node scripts/oshal-app.js install identity`, or an install from the **Applications** catalog at
  `/applications`, which is operator-gated). Until then `/api/identity/` is not served and no ribbon
  entry exists.

## If something looks wrong

**"Need attention" reads 0 and no card shows the red *Reconnect* pill, but I expected one.** Zero is
usually the honest answer. Most connected accounts hold a renewal token and refresh themselves in
the background, so an account can be well past the expiry stamped on its short-lived token and still
be perfectly healthy — that is the normal state, not a problem, and it is deliberately not flagged.
Only a sign-in that has lapsed with nothing left to renew it lands here, because only that one needs
you. If a provider is genuinely refusing your account, the **Access review** and the Connections
page both show more detail, and **Reconnect** works on any card that offers it whether or not the
card is flagged.

**"Please sign in to see your connections."** Your session lapsed, or you opened `/api/identity/`
without signing in. Sign in and reload. Everything on this screen is scoped to your own account.

**I clicked Connect (or Reconnect) and the card still says the old thing.** The consent flow runs in
the new tab it opened; the hub does not poll for the result. Finish in that tab, then reload the hub.
If the tab never opened, your browser blocked the popup — allow popups for this site.

**"Couldn't load connections: …" or "Review failed: …".** The first means the connection list did not
come back — reload, and check you are still signed in. The second is the review specifically: the
message after the colon is what came back. *The advisor returned nothing — try again* means the
review ran but produced no text; clicking again is the right response.

**A provider I use is missing entirely.** Check the active filter first (*Connected* and *Available*
each hide half the catalog) and clear the search box — when nothing matches, the grid says *No
connections match this search or filter.* If it is still absent under the **All** filter with an
empty search box, that provider is not in this deployment's connector catalog.

Design rationale for packaging this surface as an installable app lives in
[ADR-085](../adr/085-remote-app-packages-and-registries.md).
