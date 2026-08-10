# Partner-App Registration — Best Practices

> **The repeatable pattern for registering an OAuth/API app on any partner site
> (Google, Meta, Microsoft, LinkedIn, X, SmartThings, …) so OSHAL can act on a
> connected account.** When you ask *"how do I create the app on \<site\>?"*, the
> answer always follows the steps below — the only thing that changes per site is
> the appendix entry. Read this first; the appendix has the site-specific knobs.

This document is **as-built**: every connector named here is wired in
[`src/app/routes/connectors-routes.ts`](../src/app/routes/connectors-routes.ts).
Adding a connector = a registry entry there + an appendix entry here + the env vars.

---

## Rule 0 — Register every partner app under the **business email**

**Always use `maintainer@emeraldcoastsystemsgroup.com` as the developer/owner account when
you register an app on a partner site.** No personal Gmail, no throwaway address.

**Why:** the owner account receives the app-verification emails, security alerts,
quota-increase approvals, and (for Google/Meta) the app-review correspondence. If
those land in a personal inbox they get lost, and ownership can't be transferred
cleanly later. One business identity = one place every partner relationship lives,
and it matches the change-log author identity used across this repo.

**How to apply:** before clicking "Create app / Create project / New client" on any
developer console, confirm the top-right account is the business Google account
(`maintainer@emeraldcoastsystemsgroup.com`) — or, for non-Google consoles (Meta, Microsoft,
Amazon, SmartThings), that you signed in / created the developer account with that
business email. If a console only accepts a personal-looking address, create the
developer account *with the business email* anyway.

---

## The human part vs. the code part

OSHAL splits cleanly:

| Part | Who | What |
|---|---|---|
| **Code** | `maintainer@emeraldcoastsystemsgroup.com` | The connector (OAuth/token flow), encrypted per-user token store, and exact deterministic server operation that may consume the token. |
| **Human** | You | Register the app on the partner site, copy the credentials, paste them into `.env` (OAuth) or `/utilities` (token). That's it. |

You never write code. You register the app and hand me the credentials. This doc
tells you *exactly* which buttons to click and which values to copy.

> **Execution boundary:** registration or OAuth presence does not authorize an autonomous
> Cline/Claude Code/Codex/Gemini CLI. Unattended CLI execution is disabled pending an audited
> oshal-brokered sandbox. A per-user token may be resolved only inside an exact schema-bounded
> server operation; it never enters a prompt, model/CLI environment, generic bot request, or
> workspace. Hosted/BYO inference receives only the normalized/redacted operation result.

---

## Two connector shapes

A partner gives you **one of two** auth models. Pick the shape from the appendix.

### Shape A — OAuth app (redirect/consent flow)

The partner issues a **Client ID + Client Secret** and you register a **redirect
URI**. OSHAL sends the user to the partner's consent screen and stores the returned
refresh token. Used by: Google, Microsoft/Outlook, LinkedIn, X, GitHub, Dropbox,
Meta, **Google Nest (Home)**.

The repeatable steps (identical on every site):

1. **Sign in to the developer console with the business email** (Rule 0).
2. **Create an app / project / client.** Name it `OSHAL <provider>` (e.g. `OSHAL Google Nest`).
3. **Set the redirect URI** to exactly:
   ```
   https://oshal.example.com/api/connect/<provider>/callback
   ```
   The path is `/api/connect/<provider>/callback` — `<provider>` is the registry id
   (e.g. `google-home`, `linkedin`, `outlook`). It must match **character-for-character**
   or the partner returns `redirect_uri_mismatch`.
4. **Select the scopes / permissions** listed in the appendix entry (least-privilege:
   read-only unless the bot needs to act).
5. **Copy the Client ID and Client Secret.**
6. **Paste them into `.env`** under the variable names in the appendix, then restart
   the api container (`docker compose -f docker-compose.oshal-local.yml up -d --force-recreate oshal-api`).
7. **Connect** at `https://oshal.example.com/utilities` — the card flips to
   "Connect"; click it, approve on the partner's screen, done.

> **Why the redirect host is `oshal.example.com`, not `localhost`:** the OAuth
> apps are registered against the public host. `APP_URL` may point elsewhere
> (littlemonster.\*), so each connector sends its own `<PROVIDER>_REDIRECT_URI`
> override — see the existing `*_REDIRECT_URI` lines in `.env`.

### Shape B — Personal Access Token (paste, no app)

Some partners let you mint a token in account settings with no app registration,
redirect URI, or review. Use this only when OAuth is not available; SmartThings now
uses Shape A OAuth-In.

The repeatable steps:

1. **Sign in with the business email** (Rule 0) on the partner's account page.
2. **Generate a Personal Access Token**, selecting the scopes in the appendix.
3. **Copy the token** (you usually can't see it again — copy it now).
4. **Paste it on `/utilities`** — the connector card has a token field + Save. OSHAL
   validates it against the partner before storing it (encrypted, per-user). No `.env`,
   no restart.

---

## Where credentials live

- **OAuth client id/secret + redirect** → `.env`, named `<PROVIDER>_CLIENT_ID` /
  `_CLIENT_SECRET` / `_REDIRECT_URI` (see appendix for exact names; some predate this
  convention). `.env` is **gitignored** — never commit real secrets.
- **Pasted tokens** → encrypted at rest in Postgres `oshal_connections`
  (AES-256-GCM), keyed to the signed-in user's `sub`. Each user pastes their own.
- A connector card on `/utilities` shows **"Not configured"** until the OAuth client
  is in `.env` (Shape A) — token connectors (Shape B) are always ready to paste.

---

## Adding a brand-new connector (the template)

When a new partner is requested, fill this in (this is the "always the same pattern"):

```
Provider id (registry key): __________        # e.g. smartthings, google-home
Shape: A (OAuth) | B (token)
Developer console URL: __________
Owner account: maintainer@emeraldcoastsystemsgroup.com  # Rule 0 — always
Redirect URI (Shape A): https://oshal.example.com/api/connect/<id>/callback
Scopes / permissions: __________
Env vars (Shape A): <ID>_CLIENT_ID, <ID>_CLIENT_SECRET, <ID>_REDIRECT_URI
Account-lookup endpoint: __________            # how we label the connection
Exact server operation + downstream API: __________  # must be real and schema-bounded
```

> **No connectors to nowhere.** Only wire a connector whose token can actually *do*
> something via a usable API. (This is why Alexa is documented but not wired — see
> its appendix entry.) Mirrors the repo's no-mock rule.

---

# Appendix — Per-platform steps

## Smart-home bundle

### SmartThings - Shape A (OAuth), **wired, needs your OAuth-In app**
Broadest device coverage (lights, locks, plugs, switches, sensors, scenes) over a
clean REST API. This is the smart-home workhorse. OSHAL now uses SmartThings
OAuth-In so each signed-in user grants access to their own SmartThings data.

1. Install/sign in to the SmartThings CLI, then run:
   `smartthings apps:create`
   Or use the checked-in app definition:
   `smartthings apps:create -i docs/setup/smartthings-oauth-in-app.json --json`
2. Choose **OAuth-In App**.
3. Register the redirect URI:
   `https://oshal.example.com/api/connect/smartthings/callback`
   For local tunnel testing, use the tunnel host plus `/api/connect/smartthings/callback`.
4. Select scopes:
   - `r:devices:*`
   - `x:devices:*`
   - `r:scenes:*`
   - `x:scenes:*`
   - `r:locations:*`
5. Copy the OAuth client id/secret shown once into `.env`:
   - `SMARTTHINGS_CLIENT_ID`
   - `SMARTTHINGS_CLIENT_SECRET`
   - optional override: `SMARTTHINGS_REDIRECT_URI`
6. Restart the API, then open `/utilities` -> **Smart Home** -> **SmartThings** -> **Connect**.

The connector stores one SmartThings access/refresh token pair per signed-in oshal user. An exact
server operation may resolve that user's token for one bounded request; the home bot/model receives
only the normalized result.

### Google Nest (Home) — Shape A (OAuth), **wired, needs your registration**

⚠️ **Reality:** Google has **no** public API for generic "Works with Google Home"
devices. The only public control surface is the **Device Access / Smart Device
Management API**, which covers **Nest** gear only — thermostats, cameras, doorbells.
For everything else, use SmartThings.

Three things to create (all under the business email):

1. **Device Access project** ($5 one-time) at
   **https://console.nest.google.com/device-access** → *Create project*. Copy the
   **Project ID** → `.env` `GOOGLE_HOME_PROJECT_ID`.
2. **GCP OAuth client** at **https://console.cloud.google.com/apis/credentials**:
   - Enable the **Smart Device Management API**.
   - Configure the OAuth consent screen (External; add yourself as a test user).
   - *Create credentials → OAuth client ID → Web application.*
   - **Authorized redirect URI:**
     `https://oshal.example.com/api/connect/google-home/callback`
   - Copy **Client ID / Client secret** → `.env` `GOOGLE_HOME_CLIENT_ID` /
     `GOOGLE_HOME_CLIENT_SECRET`.
3. Link the Device Access project to that OAuth client (the Device Access console
   asks for the OAuth Client ID).

Scope: `https://www.googleapis.com/auth/sdm.service`. Restart the api, then **Connect**
on `/utilities → Smart Home → Google Nest`. OSHAL uses the project-scoped
`nestservices.google.com/partnerconnections/<project-id>/auth` authorize URL
automatically.

### Amazon Alexa — **documented, intentionally NOT wired (staged)**

⚠️ **Reality:** Amazon offers **no** public third-party REST API to control
Alexa-connected devices. Controlling devices requires building and **certifying a
Smart Home Skill** (an AWS Lambda + the Smart Home Skill API + an Amazon
certification review — a multi-week/-month process). A Login-with-Amazon OAuth
connector on its own would be a *connector to nowhere* — it would "connect" but
couldn't actuate anything, violating the no-mock rule.

**Decision:** Alexa is staged. **Mitigation that needs no Alexa skill:** most
Alexa-controllable devices are also reachable via **SmartThings** or **Matter**
(SmartThings acts as a Matter hub). Connect those devices in SmartThings and OSHAL
controls them through the SmartThings connector above. Revisit a dedicated Smart
Home Skill only if a device is Alexa-exclusive.

When we do build it, it's Shape A: Login with Amazon (developer.amazon.com, business
email), redirect `/api/connect/alexa/callback`, **plus** a certified skill — the
appendix entry will be expanded then.

---

## DevOps / Cloud bundle

### Google Cloud — GCP (`gcp`), Shape A (OAuth), **wired, needs your OAuth client**

The **click-to-login** counterpart to the `gcloud` operator CLI login (above). A
signed-in user connects their Google Cloud account on `/utilities`; the token drives
the Cloud Resource Manager / Compute / Billing REST APIs (e.g.
`GET cloudresourcemanager.googleapis.com/v1/projects`). Default scope is
**read-only**; expand `GCP_SCOPES` only after implementing an exact server-side write operation and
its approval gate. Never expand scopes merely to let an autonomous bot/CLI act.

Register its **own** OAuth client (NOT the login client — the consent screen must
authorize the cloud-platform scope):

1. At **https://console.cloud.google.com/apis/credentials** (signed in as
   `maintainer@emeraldcoastsystemsgroup.com`; Rule 0 has no connector-registration exception):
   - Enable the **Cloud Resource Manager API** (and any others a bot will call).
   - Configure the OAuth consent screen (add yourself as a test user).
   - *Create credentials → OAuth client ID → Web application.*
   - **Authorized redirect URI:** `https://oshal.example.com/api/connect/gcp/callback`
2. Copy **Client ID / Client secret** → `.env`:
   - `GCP_CLIENT_ID`
   - `GCP_CLIENT_SECRET`
   - optional: `GCP_SCOPES` (default `openid email .../cloud-platform.read-only`;
     set to `openid email https://www.googleapis.com/auth/cloud-platform` for write),
     `GCP_REDIRECT_URI` override.
3. Restart the api, then `/utilities → DevOps & Cloud → Google Cloud (GCP) → Connect`.

> `cloud-platform` is a Google **restricted** scope: it works immediately for the app
> owner + added test users, but non-owner end users need Google app verification first.

---

## Communications bundle

### Microsoft Outlook / M365 (`outlook`) — Shape A (OAuth), **wired, needs your Azure app registration**

The email swarm's second mail provider. The token can drive exact Microsoft Graph v1.0 operations:
`GET /me/messages`, `GET /me/messages/{id}`, `POST /me/sendMail`, and
`GET /me/calendarView`. Adding a provider means adding the connector plus closed server operation
schemas/handlers and their authorization/approval tests—not a generic model-visible
`scripts/oshal-<provider>.js` CLI.

Filled-in template:

```
Provider id (registry key): outlook
Shape: A (OAuth)
Developer console URL: https://portal.azure.com → Microsoft Entra ID → App registrations
Owner account: maintainer@emeraldcoastsystemsgroup.com  # Rule 0 — always
Redirect URI (Shape A): https://oshal.example.com/api/connect/outlook/callback
Scopes / permissions: offline_access, Mail.Read, Mail.Send, Calendars.Read (+ openid profile email)
Env vars (Shape A): AZURE_EMAIL_APPLICATION_ID, OUTLOOK_CLIENT_VALUE, AZURE_EMAIL_TENANT (optional)
Account-lookup endpoint: GET https://graph.microsoft.com/v1.0/me (mail / userPrincipalName)
Exact server operations: Microsoft Graph v1.0 /me/messages, /me/sendMail, /me/calendarView
```

The click-path (Azure wraps the standard Shape A steps in its own console names):

1. Sign in to **https://portal.azure.com** with a Microsoft account created with the
   **business email** (Rule 0). No Azure subscription is needed for an app
   registration — Entra ID app registrations are free.
2. **Microsoft Entra ID → App registrations → New registration.**
   - Name: `OSHAL Outlook`.
   - **Supported account types:** *Accounts in any organizational directory and
     personal Microsoft accounts* (this is what makes the `common` tenant endpoint
     work for both work/school and outlook.com mailboxes).
   - **Redirect URI:** platform **Web**, value exactly
     `https://oshal.example.com/api/connect/outlook/callback`.
3. On the app's **Overview**, copy the **Application (client) ID** → `.env`
   `AZURE_EMAIL_APPLICATION_ID`.
4. **Certificates & secrets → New client secret.** Copy the secret's **Value**
   (shown once — NOT the "Secret ID" GUID) → `.env` `OUTLOOK_CLIENT_VALUE`.
   Note the expiry (max 24 months) — re-mint and re-paste before it lapses.
5. **API permissions → Add a permission → Microsoft Graph → Delegated permissions**:
   add `Mail.Read`, `Mail.Send`, `Calendars.Read`, `offline_access` (openid/profile/
   email ride along automatically). These are NOT admin-restricted — each user
   consents on the Microsoft screen at connect time; no admin-consent button needed
   for personal/most-org accounts.
6. Optional: single-tenant lockdown via `.env` `AZURE_EMAIL_TENANT=<directory-id>`
   (default `common` = any account). Restart the api container.
7. **Connect** at `/utilities → Outlook / Microsoft 365` — approve on the Microsoft
   consent screen, done. The connection stores an encrypted refresh token per user. A bounded
   server operation may resolve a short-lived access token internally; the bot/model never receives
   `OSHAL_CRED_OUTLOOK` or another raw credential carrier.

> ⚠️ **Scope change 2026-07-15:** `Mail.Send` was added for the send leg. If the
> Azure app predates this, add the `Mail.Send` delegated permission (step 5) AND
> have each user **reconnect** on `/utilities` — an existing token without the scope
> gets a 403 `ErrorAccessDenied` from `POST /me/sendMail`.

### Microsoft Entra ID **login** (`MICROSOFT_LOGIN`) — same Azure app, different purpose (ADR-126)

Sign-in with Microsoft ([ADR-126](adr/126-multi-provider-oidc-login.md)) reuses this same app
registration — no second app, no second secret. It is NOT a connector: it adds **Web** redirect
URIs of the shape `https://<login host>/callback/microsoft` and the `MICROSOFT_OIDC_*` env
block. The complete procedure (URI list, probe verification, flag flip, rollback,
troubleshooting) is one runbook:
[docs/runbooks/microsoft-login-enable.md](runbooks/microsoft-login-enable.md).

---

## Media / Entertainment bundle

### Spotify (`spotify`) — Shape A (OAuth), **wired, needs your OAuth app**

Powers the **Music** concierge — search, now-playing, the user's playlists, and building a
playlist on their own account. Playback itself is a deep-link handoff (Premium + Web Playback
SDK, not driven by OSHAL).

1. At **https://developer.spotify.com/dashboard** (business email, Rule 0) → **Create app**.
2. **Redirect URI** (exact): `https://oshal.example.com/api/connect/spotify/callback`.
3. **APIs used:** check **Web API** only (NOT the Web Playback SDK — that's the Premium-gated
   in-app playback we deliberately don't use).
4. Copy **Client ID / Client Secret** → `.env`: `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`
   (optional: `SPOTIFY_SCOPES`, `SPOTIFY_REDIRECT_URI`, `SPOTIFY_MARKET`). Restart the api.
5. **Add users (required):** Dashboard → **User Management** → add each tester's **name + the
   email on their Spotify account** — **including your own**. The owner is NOT auto-allowed.

> ⚠️ **Dev-mode reality:** a non-published Spotify app is limited to **5 test users**, each
> must be **Premium**, and access is **approval-only** (you add each one). A non-allowlisted
> account still gets a token but every Web API call returns **403** (the surface shows an "add
> your account" banner). **Extended Quota Mode** — the only way past 5 — now requires a
> registered org + 250k MAU + a launched service (org-only applications since 2025-05), so it's
> **not attainable for a demo**. Treat Music as demo-grade (you + 4).

### TMDB (`tmdb`) — Shape B (token paste), **wired, free key**

Powers the **Movies & TV** concierge — search, where-it-streams, trailers, recommendations,
watchlist. Discovery is real; watch/ticket links are deep-link handoffs (JustWatch / Fandango).

1. At **https://www.themoviedb.org/settings/api** (business email) → request an API key (free,
   instant for personal use).
2. Either key works — the **v3 API key** *or* the **v4 Read Access Token** (a JWT). The client
   detects which by shape.
3. **Paste it on `/utilities` → Movies & TV → TMDB** (encrypted, per-user/shared), **or** set
   an env fallback: `TMDB_API_KEY` (also reads `THEMOVIEDB_API_READ_ACCESS_TOKEN` /
   `THEMOVIEDB_API_KEY`; optional `MOVIES_REGION`, default `US`). TMDB is a shared read-only
   catalog, so one key serves everyone — **no per-user gate**.

---

## Existing connectors (reference — already registered)

These are already done; listed so the pattern is visible and so you know the redirect
URIs that are already registered under the business email.

| Provider (id) | Shape | Redirect path | Env vars |
|---|---|---|---|
| Google / Gmail+Calendar (`google`) | A | `/api/connect/google/callback` | reuses `OIDC_CLIENT_ID/SECRET` |
| Google Cloud / GCP (`gcp`) | A | `/api/connect/gcp/callback` | `GCP_CLIENT_ID`, `GCP_CLIENT_SECRET`, opt `GCP_SCOPES` |
| Outlook / M365 (`outlook`) | A | `/api/connect/outlook/callback` | `AZURE_EMAIL_APPLICATION_ID`, `OUTLOOK_CLIENT_VALUE` |
| LinkedIn (`linkedin`) | A | `/api/connect/linkedin/callback` | `LINKEDIN_CLIENT_ID`, `LINKEDIN_PRIMARY_CLIENT_SECRET` |
| X / Twitter (`twitter`) | A (PKCE) | `/api/connect/twitter/callback` | `X_CLIENT_ID`, `X_CLIENT_SECRECT` |
| GitHub (`github`) | A | `/api/connect/github/callback` | `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` |
| Dropbox (`dropbox`) | A | `/api/connect/dropbox/callback` | `DROPBOX_APP_KEY`, `DROPBOX_APP_SECRET` |
| Facebook login (`facebook`) | A | `/auth/facebook/callback` | `FACEBOOK_APP_ID`, `FACEBOOK_APP_SECRET` |
| Facebook Pages (`meta-business`) | A | `/api/connect/meta-business/callback` | `META_APPID_OSHAL_BUSINESS`, `META_APPSECRET_OSHAL_BUSINESS` |
| Facebook bot Page auth | A | `/api/facebook-auth/callback` | deployment-managed `FACEBOOK_APP_ID`, `FACEBOOK_APP_SECRET`, and required `ENCRYPTION_KEY`; browser password/App-Secret write routes return 410 |
| SmartThings (`smartthings`) | A | `/api/connect/smartthings/callback` | `SMARTTHINGS_CLIENT_ID`, `SMARTTHINGS_CLIENT_SECRET` |
| Google Nest (`google-home`) | A | `/api/connect/google-home/callback` | `GOOGLE_HOME_CLIENT_ID/SECRET`, `GOOGLE_HOME_PROJECT_ID` |
| Spotify (`spotify`) — Music | A | `/api/connect/spotify/callback` | `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET` (dev-mode: 5 Premium users, allowlist) |
| TMDB (`tmdb`) — Movies & TV | B (token) | n/a (paste / env) | paste on `/utilities`, or `TMDB_API_KEY` / `THEMOVIEDB_*` env |

### Google (`google`) in Testing mode — the refresh token EXPIRES on you (read before a customer box)

The Google connector client is registered **External + Testing** with the operator as the sole
test user — correct for a single-operator admin connector, and app verification is not worth it
for one user. What the console does NOT tell you (INSTALLER-GAPS G14, learned live on the first
customer box):

- **Google applies a reauthentication policy to sensitive scopes on Testing-mode clients.**
  `gmail.send` qualifies. The stored refresh token can be silently invalidated **hours** after
  connecting — the next refresh gets HTTP 400 (`invalid_grant`) and every send on that grant
  fails from then on.
- **The failure lands on the FIRST thing a new admin does**: inviting their own employees. The
  invite flow now reports it distinctly ("your Google connection needs to be reconnected", not a
  generic no-transport message), but set the expectation up front: **reconnecting takes ~30
  seconds on the Connections screen**, and on a Testing-mode client it recurs.
- A `refresh 400 (google)` warning in the api container log is **never** "low priority, not in
  use" once any connector-rail feature (invites, notify, digests) is live — it is the exact
  signature of this failure.
- If a customer box needs the grant to survive long-term, the options are: move the client to
  **In production** (requires Google verification for sensitive scopes), or accept the periodic
  30-second reconnect as an operating procedure and write it into the customer runbook.

---

# DevOps / Operator CLI logins

> **A different shape from the connectors above.** Connectors (Shapes A/B) authorize
> OSHAL to act on an **end-user's** account via a per-user, encrypted token. A DevOps
> login is an **operator** authenticating a **CLI** on a workstation to manage cloud
> infrastructure (projects, IAM, billing, deploys). The credential lives in the
> operator's home directory — it is **not** stored in the OSHAL token store and is
> **not** per-end-user. Don't confuse the two: a DevOps login gives broad
> account-level control, so it stays on the operator's machine, never in the app.
> It is also not an oshal bot harness: never mount/copy this home into a bot container or treat the
> login as authority for unattended model work. Shape C commands are interactive operator actions.

## Shape C — Operator CLI login

The repeatable steps (identical across cloud CLIs — only the commands change):

1. **Install the vendor CLI** with a package manager (no manual unzip).
2. **Put the CLI on `PATH` permanently** (user scope), then **open a new shell** —
   a shell opened before install will never see the binary.
3. **Interactive login** — a browser OAuth flow. **Only the operator can do this**
   (password + 2FA); an agent cannot complete it headless.
4. **Select the working project / subscription / account.**
5. **(Optional) Application Default Credentials** — a separate login some SDKs /
   Terraform / client libraries use, distinct from the CLI's own auth.
6. **Verify** the active account and project before running anything that changes state.

### Account choice (Rule 0 applies, with a caveat)

Use the business identity `maintainer@emeraldcoastsystemsgroup.com` so IAM grants, billing, and audit
logs trace to the same maintained owner as partner applications. Do not create a new personal-owner
exception. Confirm `gcloud auth list` shows the business identity before acting.

### Where the credential lives

- **gcloud:** `~/.config/gcloud/` (`credentials.db` for the CLI token; ADC token in
  `application_default_credentials.json`). On Windows: `%APPDATA%\gcloud\`.
- These are **operator-machine-local**. Never commit them, never copy them into a
  container image, never paste them into `.env`. To revoke: `gcloud auth revoke`.

---

# Appendix — Per-platform DevOps logins

## Google Cloud Platform (`gcloud`) — operator login

Use `maintainer@emeraldcoastsystemsgroup.com`. If a legacy project is still owned by another
identity, transfer IAM/billing ownership through the provider before calling the registration
complete; do not copy that credential into this repository, a bot container, or documentation.

As-built procedure (this is exactly how the workstation was set up):

1. **Install** (Windows, PowerShell):
   ```powershell
   winget install Google.CloudSDK
   ```
   Installs to `%LOCALAPPDATA%\Google\Cloud SDK\google-cloud-sdk\bin`.
2. **PATH** — the installer adds the `bin` dir to the **user** `PATH`, but only new
   shells pick it up. If `gcloud` isn't recognized, **open a fresh terminal**. To add
   it manually (user scope, permanent):
   ```powershell
   [Environment]::SetEnvironmentVariable("Path",
     [Environment]::GetEnvironmentVariable("Path","User") +
     ";$env:LOCALAPPDATA\Google\Cloud SDK\google-cloud-sdk\bin", "User")
   ```
3. **Log in** (operator only — opens a browser):
   ```powershell
   gcloud auth login
   ```
4. **Set the working project:**
   ```powershell
   gcloud projects list          # find the id
   gcloud config set project <PROJECT_ID>
   ```
5. **(Optional) Application Default Credentials** — only if a tool needs ADC
   (Terraform, Google client libraries):
   ```powershell
   gcloud auth application-default login
   ```
6. **Verify:**
   ```powershell
   gcloud auth list                       # confirm the active account
   gcloud config get-value project        # confirm the project
   ```

> **Note:** `gcloud`, `gsutil`, and `bq` are operator-workstation tools. Use them only in an
> interactive/operator-owned automation context with a reviewed command and explicit target. They
> are not unattended oshal model harnesses, and their credential homes must never enter a bot.

## Template — adding another DevOps CLI (AWS, Azure, …)

```
Platform: __________                     # e.g. AWS, Azure, DigitalOcean
CLI + install: __________                # e.g. winget install Amazon.AWSCLI
PATH note: __________                    # where the binary lands
Login command: __________                # e.g. aws configure sso  /  az login
Project/account selector: __________     # e.g. aws configure set / az account set
ADC equivalent (if any): __________
Credential location on disk: __________  # e.g. ~/.aws/  ~/.azure/
Verify command: __________               # e.g. aws sts get-caller-identity
Owner account: maintainer@emeraldcoastsystemsgroup.com  # Rule 0 — business identity
```
