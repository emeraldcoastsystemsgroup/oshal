# DevOps + Vault — user guide (as-built)

Open **`/cockpit/?app=devops`** (the shield icon labeled *DevOps + Vault* on the ribbon — it is
this app's default screen). The console also answers directly at **`/api/devops/console`**. You
must be signed in to load the page, and the controls appear for a super-admin; everyone else gets
a padlock panel instead.

**This screen is switched off unless a deployment opts in.** The privileged-console capability is
governed by `OSHAL_DEV_CONSOLE_ENABLED`, which ships **false**; with it unset or false the padlock
is all anyone sees, including operators. Turning it on takes two settings — the flag, plus your
account on `OSHAL_SUPERADMIN_SUBS` / `OSHAL_SUPERADMIN_EMAILS` — and an API restart.

This screen is the operator's direct hand on the platform's HashiCorp Vault. You browse and edit
KV secrets, define a scope, mint a short-lived credential bound to that scope, check how long it
has left, and kill it — while a live terminal pane shows each action as it runs. The Vault token
itself stays on the server and is never shown to the browser.

## Before anything else: the access gate

If you are not a super-admin the page shows a 🔒 **Super-admin access required** card with the
reason:

| Message | What it means | Fix |
|---|---|---|
| *Developer Console is disabled on this deployment (OSHAL_DEV_CONSOLE_ENABLED is not set).* | The whole privileged-console capability is switched off for this install. Nobody qualifies. | An operator sets `OSHAL_DEV_CONSOLE_ENABLED=true` and restarts the API. |
| *Not authenticated.* | Your session isn't carrying a signed-in identity. | Sign in again. |
| *Caller is not on the super-admin allowlist…* | The capability is on, you're signed in, but your account isn't listed. | An operator adds your subject to `OSHAL_SUPERADMIN_SUBS` or your address to `OSHAL_SUPERADMIN_EMAILS`. |
| *Could not reach the server.* | The page loaded but the API didn't answer the access check. | Check that the stack is up, then reload. |

Being an operator is not enough — super-admin is a separate list. The card never reveals who *is*
on the allowlist.

## What you see

Everything below appears once the gate passes, top to bottom.

**Header.** The title, a status badge that mirrors the Vault connection light (see the next
panel), and a static *Premium tier* badge. The status badge starts as a green *● Live* placeholder
and is rewritten the instant the status check answers, so trust the Vault status panel below it
rather than a badge still reading *Live*.

**🗝️ Vault status.** Checked **once, when the page loads**. There is no refresh button and nothing
re-polls it, so after you unseal Vault or fix its address, reload the page to see the light change.
The pill on the right shows the Vault version (`v1.18.x`) — or, when no version came back, the
colour word `green` / `yellow` / `red`, or `—`. The line under it repeats the light, then the Vault
address, and — when the light is green — whether Vault is sealed, initialized, and on standby. Any
connection error text is appended in red.

| Light | Badge reads | Meaning |
|---|---|---|
| 🟢 | Working | Vault answered, is unsealed, and the server's token was accepted. Everything on this page will work. |
| 🟡 | Unreachable | Vault could not be contacted — network, DNS, or the container is down. The same yellow appears when Vault answers but the token check comes back with an unexpected failure. |
| 🔴 | Sealed | Vault is reachable but sealed, so it will refuse every request until it is unsealed. |
| 🔴 | Denied | Vault is reachable and unsealed, but the server's token was rejected or has expired. |

**🖥 Live process trace.** A terminal pane that posts one `· trace.connected — Live process trace
connected.` line as soon as the stream opens, then stays quiet until you act. The pill reads
`● connecting…`, then `● live` in green once the stream is open, or `● reconnecting…` in amber if
it drops. Each line is a local timestamp, a glyph, the action name, the thing it touched, and a
short summary.

| Glyph | Line type |
|---|---|
| ▶ | A change is starting. |
| ✓ | It finished. |
| ✗ | It failed — the summary carries the error text. |
| · | A read, or a notice such as *Live process trace connected.* |

Reads (`vault.kv.read`, `vault.kv.list`, `vault.broker.lookup`) post one `·` line. Changes
(`vault.kv.write`, `vault.kv.delete`, `vault.policy.set`, `vault.broker.issue`,
`vault.broker.revoke`, `vault.engine.setup-db`) post a `▶` line and then a `✓` or `✗`. The
summaries carry safe metadata — path, version, accessor, TTL, policy names, a count of keys — and
never a secret value or a minted token, even when the panel below is legitimately showing you one.
The pane keeps its last 300 lines and holds no history: it is live-only, so a reload starts it
empty again. The stream is scoped to you: it carries your own actions on this console, not another
admin's and not any bot's.

**📦 KV secrets.** One text box, *Path prefix (list) or path (read)*, drives three buttons:

- **List** — shows the keys under that prefix. Folders render as `📁` and drill in when clicked;
  leaf secrets render as `🔑` and, when clicked, load into the path box *and are read immediately*,
  plus a 🗑 to delete that one key. A prefix with nothing under it reads as *(no secrets here)*
  rather than an error.
- **Read** — fetches the secret at that exact path and prints its values and version metadata into
  the output block at the bottom of the panel.
- **Delete** — removes the secret at that path, after a confirm dialog that warns it destroys all
  versions. It refuses a path ending in `/`, and refuses an empty box, with *Enter a secret path
  (not a folder) to delete.* — so you cannot wipe a folder by accident. After a successful delete
  the box drops back to the parent folder and re-lists it.

Below that, *Write — data as JSON {key: value}* takes a flat JSON object, and **Write secret**
saves it at whatever path is in the box. Be aware of what happens next: it immediately re-lists
**that same path**, and the list result replaces the write result in the output block. Since a leaf
secret path has nothing under it, what you are usually left looking at is *(no secrets here)* — not
an error, and not a failed write. Press **Read** to confirm the values and the new version number.
Malformed JSON is rejected in the browser with *Data must be valid JSON.*

**🎯 Scope (ACL policy).** *Policy name* plus *Paths* as a JSON array of `{path, capabilities}`
entries, and a **Set scope** button that creates or replaces that policy in Vault. An entry with no
`capabilities` list is granted `read`. This is the least-privilege definition a brokered credential
gets bound to. The output block confirms the policy name and how many path grants it now holds; the
list must not be empty, and malformed JSON is rejected in the browser with *Paths must be valid
JSON.*

**♻️ Credential broker.** The panel restates the loop across the top: set scope → issue short-TTL
cred → bot/tool uses it → revoke. The *Mode* dropdown chooses what **Issue credential** mints:

| Mode | Fields shown | What comes back |
|---|---|---|
| Scoped token (bind a policy) | *Policy*, *TTL* (default `15m`) | A child token carrying the policy you named — and not Vault's default policy — plus its accessor, lifetime, and policy list. The token value is printed in the output block; the server does not keep a copy. |
| Dynamic secret (engine + role) | *Engine*, *Role* | A credential generated by that secrets engine — for the database engine, a real Postgres username and password — plus a lease id and lease duration. The lifetime comes from the Vault role, so the TTL box is hidden. |

After a scoped-token issue, the accessor is copied into the *Lease accessor* box for you.
**Lookup** reports remaining TTL, bound policies, and expiry for that accessor. **Revoke** asks you
to confirm, then kills the credential immediately.

**🐘 Database dynamic secrets.** One button, **Set up DB engine**, behind a confirm dialog. It
mounts Vault's postgresql secrets engine, points it at the application database using an admin URL
held on the server, and creates a role (`app-readonly` by default) whose issued logins are
read-only across the public schema, capped at five connections, with no superuser, create-database,
create-role or replication rights, valid 15 minutes and renewable to at most an hour. Pressing it
again is harmless. Afterwards, *Issue → Dynamic* with engine `database` and role `app-readonly`
hands out a live, self-expiring Postgres login.

**Roadmap line.** The grey text at the bottom of the page separates what is live today from what
is not yet built. Take it literally.

## What you can do

**Check the connection.** Load the page and read the light. Green is the precondition for every
other task here; a red or yellow light means nothing below will succeed. The light is taken once at
page load, so after you fix whatever it was complaining about, reload to re-check it.

**Store and retrieve a secret.**
1. Type a path such as `aws/prod` in the KV box.
2. Paste a flat JSON object into the write box, e.g. `{"api_key":"…","region":"us-east-1"}`.
3. Press **Write secret**. The panel then lists that path, which normally leaves *(no secrets here)*
   in the output block — that is the listing, not a failed write.
4. Press **Read** to see the stored values and the version number.

**Browse and clean up.** Press **List** with an empty box to see the top level, click into folders,
and use the 🗑 next to a leaf key — or **Delete** with the full path typed — to remove a secret and
all of its versions.

**Hand out a short-lived credential.**
1. In *Scope*, name a policy and give it the smallest path list the task needs, then **Set scope**.
2. In *Credential broker*, leave the mode on *Scoped token*, enter that policy name, set a TTL as
   short as the work allows, and press **Issue credential**.
3. Copy the token from the output block — this is your one chance to read it.
4. While the task runs, press **Lookup** to see the time left.
5. Press **Revoke** the moment the task is done. The credential is dead from that instant, before
   its TTL would have expired.

**Hand out a real database login.** Press **Set up DB engine** once, then switch the broker to
*Dynamic secret*, enter engine `database` and role `app-readonly`, and issue. You get a username
and password that Postgres itself will expire. On the bundled dev-mode Vault the mount does not
survive a container restart, so press the button again if issuing later says the engine is missing.

Every change you make is written to the platform's audit trail with your identity, the action, and
what it touched, and shows up live in the trace pane at the same time.

## What this screen does NOT do

- **No infrastructure actions.** There is no Terraform, Kubernetes, cloud-API, or remediation
  control on this page, and no way to run one. The credential broker is the shipped half; the
  workers that would consume those credentials are named in the roadmap line and are not built.
- **It does not configure Vault.** The address and the token come from the server environment
  (`VAULT_ADDR`, `VAULT_TOKEN`) — there are no fields for them and no connect-and-log-in flow. With
  `VAULT_TOKEN` unset, every panel answers `vault_not_configured` / *VAULT_TOKEN is not set on this
  deployment*, and the status line shows a yellow *Unreachable* with a blank address.
- **It cannot initialize or unseal Vault.** A sealed Vault shows red here and has to be unsealed
  outside this screen.
- **It mounts one engine.** The setup button mounts the postgresql engine. Issuing from `aws`,
  `kube`, or any other engine works if someone mounted and configured that engine in Vault
  elsewhere; this page will not create it.
- **Lookup and Revoke act on a token accessor.** A dynamic secret returns a lease id instead, which
  the accessor box does not accept — those credentials run out on their own TTL.
- **The trace is not a whole-system feed.** It carries your Vault actions from this console.
  Bot activity, remote nodes, and the page-load Vault status check do not appear in it.
- **It is single-admin, not multi-tenant.** Every super-admin acts through the same server-side
  Vault token, so the audit trail records who did what while Vault sees one identity. The
  per-session isolation that would make this safe for several privileged users at once is not
  built.
- **The bundled Vault is a development server, and it forgets.** The Vault container shipped with
  the local stack runs in dev mode: auto-unsealed, single root token, and **stored entirely in
  memory**. Every secret, policy, and database role you create is gone the moment that container
  restarts. It is fine for learning the screen and wrong for anything you need to keep — a real
  deployment points `VAULT_ADDR` at a properly initialized Vault with TLS and non-root auth.
- **There is no second-person approval.** The browser confirm dialogs plus the server's requirement
  that every change carry an explicit confirmation are the whole gate. A revoke or a delete happens
  as soon as you agree to it.
- **No chat window here, and no ticket queue.** With `?app=devops` the ribbon carries this console,
  with Operations and Settings at the foot of the rail. Tickets, Chat, Calendar, Address Book,
  Dashboard and Logs are all absent, so the console is the app's whole operating surface. To get
  the rest of the cockpit back, drop `?app=devops` from the URL.

## If something looks wrong

**"I get a padlock instead of the console."** You are authenticated but not a super-admin, or the
privileged-console capability is off for this deployment — which is the shipped default, so it is
the likelier of the two. The reason text on the card tells you which; the table at the top of this
guide says what has to change. Being an operator does not grant it.

**"The light is red, or everything answers with an error."** Read the badge word. *Sealed* means
Vault needs unsealing before anything on this page will work. *Denied* means the server's Vault
token is rejected or expired and needs replacing in the environment. *Unreachable* (yellow) means
the Vault service isn't answering at all — check that it is running and that the address on the
status line is the one you expect. A yellow light whose error word is `vault_not_configured`, with
no address beside it, is the different problem: no Vault token is configured at all, and any panel
you press will spell that out as *VAULT_TOKEN is not set on this deployment*.

**"I minted a token but it can't read the secret I meant to give it."** The KV panel and the Scope
panel take different path shapes. In the KV box you type the short path (`aws/prod`). In a policy
you write the full Vault API path — `secret/data/aws/prod` for reading a secret's values, and
`secret/metadata/aws/prod` for listing or deleting it. A policy naming the short path grants
nothing. Also check that you did not just revoke it, and that its TTL hasn't run out — **Lookup**
answers both.

**"The trace pane shows one line and nothing else, or I lost the token I just minted."** The pane
posts its *Live process trace connected.* line and then stays quiet by design until an action runs;
the page-load status check is not traced — press List or Read and lines will appear. The
minted token is deliberately absent from the trace and from the audit trail; it is printed once in
the broker output block and the server keeps no copy. If you navigated away without copying it,
revoke the accessor and issue a new one.

---

Design rationale, the security model, and what remains to be built:
[ADR-040](../adr/040-devops-vault-swarm.md) and the
[DevOps cockpit connectivity plan](../architecture/devops-cockpit-connectivity.md).
