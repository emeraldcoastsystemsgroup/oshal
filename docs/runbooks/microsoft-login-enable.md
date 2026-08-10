# Enable Microsoft (Entra ID) login next to Google — ADR-126

**As-built state (2026-08-07):** the multi-provider login code is merged (PR #149) and will be
on the next deployed image. `MICROSOFT_LOGIN=false` is staged in the operator `.env`, so
nothing changes for users until you complete this runbook. Google login is untouched either
way — with the flag off, behavior is byte-identical to before the change.

**What users see when it's on:** `/login` becomes a small chooser page — *Continue with
Google* / *Continue with Microsoft*. Google logins proceed exactly as today (same `/callback`,
same session cookie). Microsoft signs in against
`/login/microsoft` → `/callback/microsoft`. Only accounts in the company's Entra directory can
use the Microsoft button (tenant-specific issuer — see [Identity model](#identity-model)).

The decision record is [ADR-126](../adr/126-multi-provider-oidc-login.md); config reference is
in [deployment-models.md §3](../deployment-models.md) and `.env.example` ("Multi-provider
login"). Registration follows the standard partner-app rules
([partner-app-registration.md](../partner-app-registration.md) — business account, Rule 0).

---

## Prerequisites

- The running api image contains PR #149 (`git log origin/main -- src/shared/middleware/oidc-providers.ts`
  shows the feat(auth) commit; the deployed image must be built at or after it — deploy via
  `scripts/oshal-deploy.sh` as usual if the box predates it).
- The operator `.env` already carries the `MICROSOFT_*` block (tenant, client id, client
  secret) — it reuses the **same Azure app registration as the Outlook connector**, so there
  is no new app to create and no new secret to mint. If you would rather keep login and mail
  on separate registrations, create a second app per the Outlook click-path in
  [partner-app-registration.md](../partner-app-registration.md#microsoft-outlook--m365-outlook--shape-a-oauth-wired-needs-your-azure-app-registration)
  and point the `MICROSOFT_OIDC_*` vars at it instead.

## Step 1 — Register the login redirect URIs (Azure portal, human step)

Sign in to <https://portal.azure.com> with the business account (Rule 0) →
**Microsoft Entra ID → App registrations →** the app whose id matches `.env`
`MICROSOFT_OIDC_CLIENT_ID` → **Authentication**.

Under the **Web** platform (add the Web platform if only other types exist — NOT "Single-page
application"), add one redirect URI per login host. The rule: **every host in `OIDC_BASE_URLS`
that should offer Microsoft login gets `https://<host>/callback/microsoft`.** Current full
list:

```
https://oshal.agenticfederal.us/callback/microsoft
https://littlemonster.agenticfederal.us/callback/microsoft
https://dnd.oshal.ai/callback/microsoft
https://career.oshal.ai/callback/microsoft
https://finance.oshal.ai/callback/microsoft
https://social.oshal.ai/callback/microsoft
https://iot.oshal.ai/callback/microsoft
https://creative.oshal.ai/callback/microsoft
https://games.oshal.ai/callback/microsoft
https://life.oshal.ai/callback/microsoft
https://system.oshal.ai/callback/microsoft
https://office.oshal.ai/callback/microsoft
https://operations.oshal.ai/callback/microsoft
https://littlemonsters.oshal.ai/callback/microsoft
https://factor-crm.oshal.ai/callback/microsoft
```

Registering only the primary (`oshal.agenticfederal.us`) is fine to start — a host without a
registered URI simply fails Microsoft login on that host with AADSTS50011; Google there is
unaffected. Save. No new client secret, no new API permissions — `openid profile email` ride
along with any delegated permission set.

## Step 2 — Verify the registration (no portal round-trips)

```bash
bash scripts/check-oidc-redirect-uris.sh -p microsoft oshal.agenticfederal.us dnd.oshal.ai <hosts...>
```

Verdicts:

| Verdict | Meaning |
|---|---|
| `REGISTERED` | Proof — Entra 302-delivered to that exact URI. |
| `NOT-REGISTERED-OR-BAD-CLIENT` | The URI is not registered **or** the client id is wrong. Entra renders the identical error page for both and will not say which. |
| `ERROR:*` / `PROBE-FAILED:*` | The probe itself hit something unexpected — read the reason, fix, re-run. |

Two sanity checks when in doubt:

- **Probe self-check** (proves the probe + client id, using a URI you know is registered):
  `MS_PROBE_PATH=/api/connect/outlook/callback bash scripts/check-oidc-redirect-uris.sh -p microsoft oshal.agenticfederal.us`
  must print `REGISTERED`. If it doesn't, the client id/tenant in `.env` is wrong — fix that
  before touching the portal again.
- **Control host** (proves the probe can see a negative): probe a host you know is NOT
  registered and confirm it does not say `REGISTERED`.

## Step 3 — Flip the flag and recreate the api

In `.env`, set:

```env
MICROSOFT_LOGIN=true
```

(The rest of the block — `MICROSOFT_TENANT_ID`, `MICROSOFT_OIDC_CLIENT_ID`,
`MICROSOFT_OIDC_CLIENT_SECRET` — is already filled in. Compose passthroughs already exist.)

Apply — env changes need a container **recreate**, a restart is not enough:

```bash
docker compose -f docker-compose.oshal-local.yml up -d oshal-api
```

Boot is fail-closed: if the api exits immediately after this, the block is half-configured —
`docker logs oshal-api` names exactly which variable is missing.

## Step 4 — Prove it in a browser

1. Open `https://oshal.agenticfederal.us/login` in a fresh/private window → the chooser page
   with both buttons appears.
2. *Continue with Google* → normal Google login, lands where it always did.
3. *Continue with Microsoft* (fresh window again) → Microsoft sign-in for a directory account
   → lands logged in. First Microsoft login is a **new user** (fresh `sub`) — expected, see
   below.
4. Deep links survive: `https://oshal.agenticfederal.us/login?returnTo=%2Fcockpit%2F%3Fapp%3Ddnd`
   → either button → lands on the D&D cockpit, not the bare landing page.
5. `/logout` ends whichever session is active (Microsoft logout also round-trips Entra's
   end-session; Google's never did — it has no end-session endpoint — and still just clears
   the app session).

## Identity model

- **A provider is an identity namespace.** The same person via Google and via Microsoft is
  two different `sub`s with separate per-user data (connectors, memory, tickets). There is no
  cross-provider account linking; pick one per person for real use.
- **Operator status carries by email**: `OSHAL_OPERATOR_EMAILS` already lists
  `roger.murphy@emeraldcoastsystemsgroup.com`, so a Microsoft login with that account gets
  operator views. **Background/scheduled runs key on `OSHAL_OPERATOR_SUBS`** — that list only
  has the Google sub; if the Microsoft identity becomes a working identity, add its sub
  (visible at `/api/user` after logging in) or its scheduled work will be treated as
  non-operator (free-tier LLM routing legs included).
- **Tenant restriction is a feature**: the issuer is tenant-specific, so outside/personal
  Microsoft accounts get AADSTS50020 at Microsoft's screen and never reach the app.
  (`common` cannot be used — it advertises a templated issuer that fails strict OIDC issuer
  validation by construction.)
- Signing in with provider B while a provider-A session exists replaces the session — one
  active identity per browser, and `/logout` always finds it.

## Rollback

Set `MICROSOFT_LOGIN=false`, recreate the api (same command as Step 3). `/login` goes back to
redirecting straight to Google. Existing Microsoft sessions stop resolving on their next
request; their per-user rows remain (harmless, keyed by the Microsoft `sub`) unless you clean
them up deliberately.

## Troubleshooting

| Symptom | Cause → fix |
|---|---|
| Chooser doesn't appear; `/login` goes straight to Google | Container still has the old env — recreate (Step 3), don't restart. Confirm with `docker exec oshal-api printenv MICROSOFT_LOGIN`. |
| api exits at boot after the flip | Fail-closed config: a `MICROSOFT_*` var is missing/blank, or every provider ended up disabled. `docker logs oshal-api` names it. |
| Microsoft button → AADSTS50011 at Microsoft's page | That host's `/callback/microsoft` URI isn't registered (Step 1). Verify with the Step 2 probe. |
| Microsoft button → AADSTS50020 / "account doesn't exist in tenant" | Working as designed — the account isn't in the company directory. |
| Microsoft button → AADSTS7000215 (invalid client secret) | Secret expired or wrong (the portal shows the secret's **Value** once; the GUID "Secret ID" is not it). Mint a new one, paste into `.env`, recreate. |
| Probe says `NOT-REGISTERED-OR-BAD-CLIENT` on a URI you just added | Run the probe self-check (Step 2). Self-check green ⇒ the URI really isn't saved (check the exact host spelling, and that it's under the **Web** platform); self-check red ⇒ client id/tenant in `.env` is wrong. |
| Login dies at `/callback/microsoft` with "checks.state argument is missing" | Same cross-host cookie rule as Google: the host must be covered by `SESSION_COOKIE_DOMAIN` or get a host-only cookie, and must be listed in `OIDC_BASE_URLS`. See the per-host notes in `.env`. |
| Signed in with Microsoft but data/connectors are "gone" | You're on the Microsoft identity's fresh `sub` — the Google identity's data belongs to the Google `sub`. Expected; see [Identity model](#identity-model). |
