# Operator Connector Action List

Generated: 2026-06-23 10:28:28 -05:00

This is the list of connector setup work that belongs to the OSHAL operator/admin, not to a normal end user.

Sources:
- `src/app/routes/connectors-routes.ts`
- `scripts/connectors/assisted-provider-onboarding.ts`
- `docs/partner-app-registration.md`
- `docs/adr/067-connector-marketplace-and-dynamic-tool-loading.md`
- Local `.env` presence scan on 2026-06-23. Secret values were not printed or copied.

Status key:
- `Complete` = required env var pair/key is present locally. Still run the OAuth consent + smoke proof.
- `Partial` = runtime has a fallback credential path, but provider-side redirect/scope setup still needs verification.
- `Needed` = required system/operator credential was not detected locally.
- `Verify in /utilities` = credential may live in encrypted `oshal_connections`; local `.env` could not prove it.
- `Optional/user-self-serve` = users can bring this credential; operator only needs it for a curated demo tenant.

## Rule

Normal users should not create redirect URIs or provider apps. They should browse the connector catalog, click Connect, consent, or paste their own API key/token.

The operator does:

1. Register OAuth apps once per provider.
2. Put provider client IDs/secrets in `.env`.
3. Configure public callback URLs for the deployment host.
4. Provide shared platform keys only for product surfaces that should work without every user bringing a key.
5. Keep high-risk/write-capable connectors sandboxed until tested.

## Current Catalog Reality

The marketplace includes a large imported catalog. The latest local cache groups it as:

| Onboarding mode | Count | Meaning |
|---|---:|---|
| `oauth-app` | 415 | Needs provider app if promoted to real use. Do not register all at once. |
| `user-key` | 674 | User/API-key self-serve. Operator only needs a demo/shared key when productized. |
| `basic-auth` | 49 | User-owned username/password or token pair. |
| `no-auth` | 168 | No credential required. |

Do not try to open hundreds of signup pages. Only register the providers below that back real product surfaces.

## A. OAuth Apps The Operator Should Register

Use the deployment public base URL plus the callback path. For local tunnel/stage, the redirect must match that tunnel/stage host exactly.

| Priority | Status | Provider | Why | Redirect path | Env vars to fill / detected |
|---|---|---|---|---|---|
| P0 | Complete | Google / Gmail + Calendar | Email, calendar, Google Workspace context, user identity adjacency | `/api/connect/google/callback` | Detected reusable `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`; optional dedicated `GOOGLE_CONNECT_*` not set |
| P0 | Complete | GitHub OAuth App | Code/repo storage, build workflows, webhook-backed proof | `/api/connect/github/callback` | `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` |
| P0 | Complete | Slack App | Communications feed, user channels/DMs | `/api/connect/slack/callback` | `SLACK_CLIENT_SECRET` plus tolerated `SLACK_CLINET_ID`; recommended cleanup: also add canonical `SLACK_CLIENT_ID` |
| P0 | Complete | Microsoft Outlook / M365 | Email/calendar alternative to Google | `/api/connect/outlook/callback` | `OUTLOOK_CLIENT_VALUE`, tenant vars, plus tolerated `AZURE_EMAIL_APPLICCATION_ID`; recommended cleanup: also add canonical `AZURE_EMAIL_APPLICATION_ID` |
| P1 | Complete | Dropbox App | User file-space backend and storage demos | `/api/connect/dropbox/callback` | `DROPBOX_APP_KEY`, `DROPBOX_APP_SECRET` |
| P1 | Complete | LinkedIn Developer App | Social/content publishing | `/api/connect/linkedin/callback` | `LINKEDIN_CLIENT_ID`, `LINKEDIN_PRIMARY_CLIENT_SECRET` |
| P1 | Complete | X / Twitter Developer App | Social read/post proof | `/api/connect/twitter/callback` | `X_CLIENT_ID`, tolerated `X_CLIENT_SECRECT`; recommended cleanup: also add canonical `X_CLIENT_SECRET` |
| P1 | Complete | Meta Login App | Facebook identity/profile connector | `/auth/facebook/callback` | `FACEBOOK_APP_ID`, `FACEBOOK_APP_SECRET` |
| P1 | Complete | Meta Business / Pages App | Facebook page publishing | `/api/connect/meta-business/callback` | `META_APPID_OSHAL_BUSINESS`, `META_APPSECRET_OSHAL_BUSINESS` |
| P1 | Complete | SmartThings OAuth-In | Smart home device control | `/api/connect/smartthings/callback` | `SMARTTHINGS_CLIENT_ID`, `SMARTTHINGS_CLIENT_SECRET` |
| P1 | Complete | Google Nest Device Access | Nest thermostat/camera/doorbell control | `/api/connect/google-home/callback` | `GOOGLE_HOME_CLIENT_ID`, `GOOGLE_HOME_CLIENT_SECRET`, `GOOGLE_HOME_PROJECT_ID` |
| P1 | Complete | Spotify App | Music concierge, playlists, now-playing | `/api/connect/spotify/callback` | `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`; `SPOTIFY_MARKET` optional and not set |
| P1 | Needed | Square Developer App | Payment acceptance sandbox/live merchant flow | `/api/connect/square/callback` | Need `SQUARE_CLIENT_ID` or `SQUARE_APPLICATION_ID`, plus `SQUARE_CLIENT_SECRET`; optional `SQUARE_ENV`, `SQUARE_VERSION` |
| P1 | Needed | PayPal Developer App | Invoice/payment sandbox/live merchant flow | `/api/connect/paypal/callback` | Need `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`; optional `PAYPAL_ENV` |
| P2 | Partial | Google Cloud / GCP | DevOps/cloud ops connector | `/api/connect/gcp/callback` | Runtime can reuse `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`; verify GCP callback and cloud scope consent. Dedicated `GCP_CLIENT_ID`, `GCP_CLIENT_SECRET`, `GCP_SCOPES` not set |

Notes:
- Google restricted/sensitive scopes may work for test users but need verification before public users.
- Spotify dev mode requires allowlisting tester accounts and has strict limits.
- Meta Pages publishing and LinkedIn posting may require app review.
- Square/PayPal default to sandbox unless the env says production.

## B. Shared Platform Keys / Tokens The Operator Should Get

These are product/default keys where a user should not have to bring their own credential just to see the app work.

| Priority | Status | Provider | Why | Where it goes |
|---|---|---|---|---|
| P0 | Complete | TMDB | Movies & TV catalog/search/trailers/where-to-watch | Detected `.env` `THEMOVIEDB_API_READ_ACCESS_TOKEN` / `THEMOVIEDB_API_KEY`; `TMDB_API_KEY` optional alias not set |
| P0 | Complete | Duffel | Real flight search for Travel | Detected `.env` `DUFFEL_ACCESS_TOKEN` |
| P0 | Verify in /utilities | Walmart affiliate/marketplace config | Shopping/procurement search and deep-link handoff | Not detected in `.env`; check `/utilities` shared/tenant Walmart connection |
| P0 | Verify in /utilities | Uber Eats affiliate/config | Eats search/order assembly and deep-link handoff | Not detected in `.env`; check `/utilities` Uber Eats connection/config |
| P0 | Verify in /utilities | Uber Rides app/config | Rides deep-link handoff | Not detected in `.env`; check `/utilities` Uber Rides connection/config |
| P1 | Needed | Google Maps Platform or equivalent map/geocoding provider | Rides/Eats/Shopping need real map tiles, current-location UX, address autocomplete, distance, route preview, and local search | Recommended: enable Maps JavaScript API, Places API, Geocoding API, and Routes/Directions API. Add restricted `GOOGLE_MAPS_BROWSER_KEY` for embedded maps and optional `GOOGLE_MAPS_SERVER_KEY` for server geocoding. No shared `GOOGLE_MAPS_*`, `MAPBOX_*`, `GEOAPIFY_API_KEY`, `HERE_API_KEY`, `LOCATIONIQ_API_KEY`, `TOMTOM_API_KEY`, `OPENCAGE_API_KEY`, or `MAPQUEST_API_KEY` detected |
| P1 | Needed | Weather provider | Home/travel/daily assistant should answer weather without user setup | No shared `OPENWEATHERMAP_API_KEY` or `WEATHERAPI_KEY` detected |

Current implementation note: Uber Rides can geocode with OpenStreetMap Nominatim without a key and currently renders a styled fallback map. A polished SaaS surface should use a controlled map provider key/rate plan so Rides, Eats, Shopping, and local discovery share autocomplete, distance, map tiles, and route previews.

## C. Token/PAT Connectors A Demo Admin Can Set Up, But Users Can Self-Serve

These do not require redirect URI setup. For a polished demo tenant, the operator can create sandbox/business tokens and paste them. For real users, the user should bring their own credential.

| Status | Provider | Setup page / intent |
|---|---|---|
| Verify in /utilities | Jira | Atlassian email + API token |
| Optional/user-self-serve | GitLab | Personal access token |
| Optional/user-self-serve | Zoom | Marketplace/app credential |
| Optional/user-self-serve | Calendly | API token/webhooks |
| Optional/user-self-serve | HubSpot | Private app token |
| Optional/user-self-serve | Asana | Personal token or app token |
| Optional/user-self-serve | Airtable | PAT |
| Optional/user-self-serve | Stripe | Test API key first |
| Optional/user-self-serve | SendGrid | Restricted API key |
| Optional/user-self-serve | OpenAI | BYOK LLM key |
| Optional/user-self-serve | Sentry | Auth token |
| Optional/user-self-serve | Vercel | PAT |
| Optional/user-self-serve | Netlify | PAT |
| Optional/user-self-serve | Figma | PAT |
| Optional/user-self-serve | Todoist | Developer token |
| Optional/user-self-serve | Pinterest | App/token path |
| Optional/user-self-serve | Shippo | API token |
| Optional/user-self-serve | Raindrop.io | Integration token |
| Optional/user-self-serve | Monzo | Developer token |
| Optional/user-self-serve | Buttondown | API token |
| Optional/user-self-serve | Postmark | Server/account token |
| Optional/user-self-serve | Unsplash | App/access key |
| Optional/user-self-serve | Oura | PAT |
| Optional/user-self-serve | Fitbit | Developer app/token |
| Optional/user-self-serve | WHOOP | Developer app/token |
| Optional/user-self-serve | Strava | Developer app/token |

## D. What Not To Do

- Do not register every imported OAuth connector now. Promote one connector into a real surface, then register that provider app.
- Do not open many provider signup pages at once. Use `scripts/connectors/assisted-provider-onboarding.ts` in guided mode with a small batch.
- Do not store personal passwords or MFA secrets in `.env`.
- Do not put user-owned tokens in `.env` unless it is an intentional shared platform default.
- Do not make a connector card look connected unless a smoke test can read real provider data or the handoff behavior is explicitly documented.

## Safe Execution Order

1. Smoke-test P0 OAuth apps already configured: Google, GitHub, Slack, Outlook.
2. Verify `/utilities` token/config connections for Walmart, Uber Eats, Uber Rides, and Jira.
3. Get missing P1 payment OAuth apps: Square and PayPal.
4. Add one shared map/geocoding provider and one shared weather provider for consumer polish.
5. Smoke-test P1 OAuth apps already configured: LinkedIn, X, Meta, SmartThings, Google Nest, Spotify.
6. Verify GCP callback/scope setup if cloud-ops is part of the demo.
7. Paste demo PATs for the C-list only where they support an actual demo path.
8. Run connector smoke tests and save evidence after each provider, one at a time.

## Existing Helper

The guided opener is:

```powershell
npm run connectors:assisted-onboarding -- --mode guided --batch-size 1 --providers google,github,slack,outlook
```

Use `--target registration` for provider consoles and `--target oshal-connect` for OSHAL connect URLs after `.env` is filled and the API is restarted.
