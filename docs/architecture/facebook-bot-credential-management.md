# Facebook Bot — Credential Management Spec

**Date:** 2026-04-19  
**Status:** Implementation-ready  
**Author:** oshal maintainers + Claude

---

## Problem

The Facebook bot has 6 working Graph API tools but no way to get or keep credentials. Tokens live in environment variables, die on restart, and require manual setup. The user wants to say "connect to my Facebook page" and have the bot handle everything from that point forward.

## Design Principle

**The bot manages its own credentials.** The user talks to the bot. The bot initiates OAuth, stores the tokens, refreshes them before expiry, and uses them transparently on every API call. The operator never touches an env var for Facebook auth.

This follows the Claude Code auth pattern already in the codebase: UI-initiated OAuth → callback → encrypted storage → bot consumption.

---

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│ Cockpit UI                                                │
│                                                           │
│  Settings > Integrations > Facebook > [Connect Page]      │
│                                                           │
│  1. Click "Connect" → GET /api/facebook-auth/start        │
│  2. Browser opens Facebook OAuth consent screen            │
│  3. User authorizes → Facebook redirects to callback       │
│  4. UI shows "Connected as: Page Name"                     │
└──────────┬───────────────────────────────────────────────┘
           │
           ▼
┌──────────────────────────────────────────────────────────┐
│ API Routes (oshal-api container)                           │
│                                                           │
│  GET  /api/facebook-auth/start                            │
│    → Build Facebook OAuth URL with scopes                  │
│    → Store state token in Redis (CSRF protection)          │
│    → Return { authUrl } to UI                              │
│                                                           │
│  GET  /api/facebook-auth/callback                         │
│    → Receive ?code=...&state=...                           │
│    → Verify state token from Redis                         │
│    → Exchange code for short-lived user token               │
│    → Exchange short-lived → long-lived user token           │
│    → Call /me/accounts to get page tokens                   │
│    → Store page token + metadata in encrypted config        │
│    → Broadcast credentials via Redis pubsub                 │
│    → Return success HTML (auto-close popup)                 │
│                                                           │
│  GET  /api/facebook-auth/status                           │
│    → Load from encrypted config                            │
│    → Validate token with Facebook /debug_token              │
│    → Return { connected, pageName, pageId, expiresAt }     │
│                                                           │
│  POST /api/facebook-auth/disconnect                       │
│    → Remove Facebook credentials from encrypted config      │
│    → Broadcast removal via Redis pubsub                     │
│    → Return { disconnected: true }                         │
│                                                           │
│  GET  /api/facebook-auth/pages                            │
│    → List all pages the user manages                       │
│    → Return pages array for selection UI                    │
└──────────┬───────────────────────────────────────────────┘
           │
           ▼
┌──────────────────────────────────────────────────────────┐
│ Encrypted Config Manager (existing)                       │
│                                                           │
│  Key: "facebookPageAccessToken"                           │
│    → Detected as secret by isSecretKey() (contains         │
│      "token" and "secret" patterns)                        │
│    → Stored in secrets.enc.json with AES-256-GCM           │
│                                                           │
│  Stored envelope:                                          │
│  {                                                         │
│    "facebookPageAccessToken": "EAABwz...",                  │
│    "facebookPageId": "109876543210987",                     │
│    "facebookPageName": "My Business Page",                  │
│    "facebookUserId": "123456789",                           │
│    "facebookAppId": "1234567890123456",                     │
│    "facebookTokenExpiresAt": 1750000000000,                 │
│    "facebookConnectedAt": 1713500000000                     │
│  }                                                         │
│                                                           │
│  App ID and App Secret remain in environment variables     │
│  (FACEBOOK_APP_ID, FACEBOOK_APP_SECRET) — these are        │
│  developer portal constants, not per-user credentials.     │
└──────────┬───────────────────────────────────────────────┘
           │
           ▼
┌──────────────────────────────────────────────────────────┐
│ Facebook Bot (bot-node container)                         │
│                                                           │
│  On startup:                                               │
│    → Load credentials from encrypted config                │
│    → If token exists and valid → ready                     │
│    → If token expired → attempt auto-refresh               │
│    → If no token → tools return "not connected" error      │
│                                                           │
│  On Redis pubsub "facebook.credentials.update":            │
│    → Hot-reload credentials without restart                 │
│                                                           │
│  On every tool call (facebook_post, facebook_read_feed):   │
│    → credentialGuard() checks token exists + not expired    │
│    → If within 7 days of expiry → background refresh       │
│    → If expired → attempt refresh, fail if impossible       │
│    → If no creds → return structured error:                 │
│      { error: "NOT_CONNECTED",                              │
│        action: "Connect Facebook via Settings > Facebook" } │
│                                                           │
│  New tools:                                                │
│    facebook_status  — check connection state                │
│    facebook_pages   — list available pages after OAuth      │
│    facebook_switch_page — change active page                │
└──────────────────────────────────────────────────────────┘
```

---

## Token Lifecycle

```
User clicks "Connect"
       │
       ▼
Facebook OAuth consent screen
       │
       ▼
Short-lived user token (1-2 hours)
       │
       ▼ exchangeForLongLivedToken()
Long-lived user token (60 days)
       │
       ▼ GET /me/accounts
Page access token (NEVER expires when derived from long-lived user token)
       │
       ▼ stored in encrypted config
Bot uses page token for all API calls
       │
       ▼ every 50 days (safety margin)
Auto-refresh: exchange current long-lived token → new long-lived token
       │
       ▼ GET /me/accounts again
New page token stored, old one replaced
```

**Key fact:** Page access tokens derived from long-lived user tokens do not expire. But the long-lived user token itself expires in 60 days. We refresh it at 50 days to maintain the chain.

---

## Credential Guard

Every Facebook tool wraps its execution in a credential guard:

```javascript
async function withCredentials(toolFn) {
  const creds = await loadFacebookCredentials();
  
  if (!creds || !creds.facebookPageAccessToken) {
    return {
      success: false,
      error: 'NOT_CONNECTED',
      message: 'Facebook is not connected. Ask the operator to connect via Settings > Integrations > Facebook, or tell me to "connect to Facebook" and I will provide the link.',
    };
  }

  // Inject credentials into the API client
  const client = new FacebookAPIClient({
    accessToken: creds.facebookPageAccessToken,
    pageId: creds.facebookPageId,
    appId: process.env.FACEBOOK_APP_ID,
    appSecret: process.env.FACEBOOK_APP_SECRET,
  });

  return toolFn(client);
}
```

---

## What Changes

### New files
| File | Purpose |
|------|---------|
| `src/app/routes/facebook-auth-routes.ts` | OAuth start, callback, status, disconnect, pages |
| `any-bot/server/services/tools/facebook/facebookCredentialStore.js` | Load/save/refresh credentials via encrypted config |

### Modified files
| File | Change |
|------|--------|
| `any-bot/server/services/tools/facebook/facebookTools.js` | Wrap all tools in `withCredentials()`, add `facebook_status` tool |
| ~~`any-bot/server/services/tools/facebook/facebookAuth.js`~~ | Superseded by `facebookCredentialStore.js` (the shipped credential path `facebookTools.js` actually loads) and **removed 2026-07-18** — the old in-memory `FacebookAuthManager` was never wired in and its `persistCredentials()` integration point was never implemented. |
| `src/app/extensions/swarm/swarm-bot-registry.ts` | Add facebook-bot entry |
| `docker-compose.oshal-local.yml` | Add facebook-bot service |
| `ai-lab/bot-personas/facebook-bot.yaml` | Add `facebook_status` tool, remove manual token env var requirement |
| `src/app/routes/index.ts` | Mount facebook-auth routes |

### Environment variables (developer portal constants only)
| Variable | Where | Purpose |
|----------|-------|---------|
| `FACEBOOK_APP_ID` | `.env` / docker-compose | Facebook App ID from developers.facebook.com |
| `FACEBOOK_APP_SECRET` | `.env` / docker-compose | Facebook App Secret |

`FACEBOOK_ACCESS_TOKEN` and `FACEBOOK_PAGE_ID` are **no longer env vars** — they come from the encrypted config after OAuth.

---

## Facebook App Prerequisites

Before the OAuth flow works, someone must create a Facebook App once:

1. Go to https://developers.facebook.com
2. Create App → select "Business" type
3. Add "Facebook Login" product
4. Set Valid OAuth Redirect URI: `http://localhost:35457/api/facebook-auth/callback`
5. Add permissions: `pages_manage_posts`, `pages_read_engagement`, `pages_manage_engagement`
6. Copy App ID and App Secret into `.env`

This is a one-time setup per deployment. The bot handles everything after that.

---

## Conversational Flow

What the user experiences:

```
User:  "Connect to my Facebook page"
Bot:   "I need Facebook authorization. Click this link to connect:
        [Connect to Facebook](http://localhost:35457/api/facebook-auth/start)
        After you authorize, I'll be ready to manage your page."

       --- user clicks, authorizes, popup closes ---

Bot:   "Connected to Facebook page 'My Business Page'. I can now
        post, read your feed, reply to comments, and manage content.
        What would you like me to do?"

User:  "Post 'Hello from the swarm!' to my page"
Bot:   "Posted successfully. Post ID: 123456789_987654321
        View it here: https://facebook.com/123456789_987654321"

User:  "What are the latest comments on my page?"
Bot:   [reads feed, gets comments, returns formatted list]
```

---

## Security Constraints

1. **App Secret never leaves the server.** It's in env vars on the API container only, never sent to the browser or stored in the UI.
2. **Page tokens are encrypted at rest** via the existing AES-256-GCM encrypted config manager.
3. **State parameter** prevents CSRF on the OAuth callback — random token stored in Redis with 10-minute TTL.
4. **Token validation** on every status check hits Facebook's `/debug_token` endpoint to confirm the token is still valid (not just checking expiry locally).
5. **Disconnect** removes credentials from encrypted storage and broadcasts removal to all bot nodes.
