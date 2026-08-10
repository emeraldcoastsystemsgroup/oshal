# ADR-126: Multi-provider OIDC login (Google + Microsoft, per-provider flags)

Date: 2026-08-07
Status: Accepted

## Context

Interactive login has always been exactly one OIDC issuer per deployment: `OIDC_ISSUER_URL`
(Google on the live site) or the Keycloak realm construction, one `auth()` instance per login
host, callback fixed at `/callback`. The operator wants a second login method — Microsoft
Entra ID, reusing an Azure app registration that already exists — and wants login methods to
be configuration, not code: `GOOGLE_LOGIN=true`, `MICROSOFT_LOGIN=false|true`, extensible to
more providers later.

Constraints that shaped the design:

1. **The Google registration must not churn.** Fifteen `OIDC_BASE_URLS` hosts have
   `https://<host>/callback` registered in the Google console. Any design that moves the
   Google callback path re-registers all of them for zero benefit.
2. **Live sessions must survive the deploy.** The session rides the encrypted `appSession`
   cookie; renaming it logs every user out.
3. **`express-openid-connect` is one issuer per `auth()` instance.** Multi-provider means
   multiple instances on the same Express app, which means they must not fight over routes
   or cookies, and every request must be dispatched to exactly one instance.
4. **LOCAL_AUTH (ADR-117) replaces the whole middleware set** and is out of scope here.

## Decision

**A provider registry (`src/shared/middleware/oidc-providers.ts`) resolves an ordered list of
enabled providers from env; the OIDC middleware builds one `auth()` instance per login host ×
provider and dispatches every request to exactly one of them.**

- **The legacy config is the *primary* provider.** `OIDC_ISSUER_URL`/Keycloak keeps
  `/callback` and the default `appSession` cookie — registered redirect URIs and live
  sessions survive unchanged. The issuer URL is sniffed to a provider name
  (`accounts.google.com` → `google`, `login.microsoftonline.com` → `microsoft`, else
  `primary`) so its per-provider flag governs it and it is never duplicated as a secondary.
- **Secondaries get suffixed routes and cookies:** `/login/microsoft`,
  `/callback/microsoft`, session cookie `appSession_microsoft`. Adding a provider adds
  redirect URIs to *that provider's* app registration only.
- **Flags:** `GOOGLE_LOGIN` (default true when the primary is Google), `MICROSOFT_LOGIN`
  (default false) + `MICROSOFT_TENANT_ID` (or explicit `MICROSOFT_OIDC_ISSUER_URL`),
  `MICROSOFT_OIDC_CLIENT_ID/SECRET`. `GOOGLE_OIDC_CLIENT_ID/SECRET` exist for the inverse
  shape (non-Google primary + Google secondary). **Fail-closed** (ADR-117 doctrine): an
  enabled provider with incomplete credentials refuses to boot, as does disabling every
  provider. The Microsoft issuer must be tenant-specific — `common`/`organizations`
  advertise a templated issuer that fails strict OIDC issuer validation by construction.
- **Dispatch** (`selectRequestProvider`, pure and unit-guarded): provider login/callback
  paths match exactly; `/logout` and all other requests go to the provider whose session
  cookie (chunked `.0`/`.1` forms included) is on the request, primary winning ties; no
  cookie falls back to the primary. All instances share one session secret so dispatch, not
  crypto, decides ownership.
- **Bare `/login` renders a chooser page** ("Continue with Google / Microsoft") when more
  than one provider is enabled, carrying the sanitized `returnTo` through `/login/<name>`;
  with a single provider it starts that login directly (today's behavior). Starting a login
  with provider X expires sibling providers' session cookies — exactly one identity is
  active per browser, so `/logout` always finds the session the user means.
- **Recovery is provider-aware:** the guarded-callback retry and the state-mismatch restart
  map `/callback/<name>` back to `/login/<name>` so a failed Microsoft callback re-enters
  the Microsoft flow instead of the chooser.
- **Redirect-URI verification:** `scripts/check-oidc-redirect-uris.sh -p microsoft <host>`
  probes Entra with `prompt=none` — a 302 delivered to the probed URI is proof of
  registration; the inline error page means unregistered *or* wrong client id (Entra renders
  the identical page for both — live-verified), and the verdict names that ambiguity rather
  than ever reporting a false REGISTERED.

## Consequences

- The live Google flow is byte-identical in the default config (no flags set → one provider,
  same routes, same cookie); the unit suite pins this.
- Enabling Microsoft is env + Azure portal work, no deploy of new code: flip
  `MICROSOFT_LOGIN=true`, register `https://<host>/callback/microsoft` per login host,
  recreate the api container. The operator procedure (URI list, probe verification,
  browser proof, rollback, troubleshooting) is
  [docs/runbooks/microsoft-login-enable.md](../runbooks/microsoft-login-enable.md).
- **A provider is an identity namespace.** The same human signing in with Google and with
  Microsoft is two different `sub`s with separate per-user data. Operator status follows
  `OSHAL_OPERATOR_EMAILS` (email-based, covers both); anything keyed on
  `OSHAL_OPERATOR_SUBS` needs the new sub added deliberately. Cross-provider account linking
  is future work if ever wanted.
- Instance count is hosts × providers (15 × 2 = 30 today) — discovery is lazy and per-host
  behavior is unchanged, but a pathological provider list would multiply; the registry is a
  closed set by design.
- Guards: `tests/unit/oidc-login-providers.spec.ts` (fail-closed resolution, legacy-default
  equivalence, dispatch matrix incl. chunked/sibling cookies, chooser escaping).
