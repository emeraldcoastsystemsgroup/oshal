# Swarm Agent Connector Onboarding

This runbook captures the repeatable process for connecting a swarm agent to a
new external provider account through OSHAL's connector hub.

Use this whenever we add a provider such as Outlook, Gmail, LinkedIn, Facebook,
X/Twitter, Yahoo, Slack, or another account-backed service.

## Goal

The pattern is:

```text
provider developer app
  -> OSHAL connector OAuth flow
  -> encrypted per-user token row
  -> provider CLI/API helper
  -> swarm agent/tool
  -> queue or app workflow
```

The user should connect an account once from OSHAL. After that, a bot can use the
provider on behalf of that same signed-in user without ever seeing a password,
browser cookie, or manually pasted access token.

## Core Rules

- Use provider OAuth, not passwords or browser automation.
- Store tokens in `oshal_connections`, keyed by the signed-in user's OIDC `user_sub`.
- Use `getValidAccessToken(pool, userSub, provider)` when a bot/tool needs a token.
- Request the smallest useful scopes first.
- Keep each provider's OAuth app credentials in `.env` or the encrypted config path.
- Use exact redirect URIs. Provider consoles are strict.
- Build a CLI/helper or service boundary so the bot does not contain provider-specific token plumbing.
- Add a setup guide and smoke test for every connector-backed agent.

Reference isolation model: [../connectors-tenant-isolation.md](../architecture/connectors-tenant-isolation.md)

## Connector Onboarding Checklist

### 1. Define The Agent Use Case

Write down what the swarm agent needs to do.

Examples:

- read Outlook email notifications for LinkedIn activity
- publish a LinkedIn post after approval
- read Gmail newsletters for article candidates
- send notification email from the email bot
- list Facebook pages for a social-posting workflow
- publish a user-approved X/Twitter post

Record:

- provider name
- bot or swarm app that will use it
- read actions
- write actions
- required scopes
- blocked actions
- approval gates

### 2. Create The Provider Developer App

In the provider's developer/admin portal:

1. Create a new app registration.
2. Choose the supported account/audience type.
3. Add the OSHAL redirect URI.
4. Add required OAuth scopes or API permissions.
5. Create a client secret if the provider requires one.
6. Copy the client ID and client secret immediately.
7. Note any app review, publisher verification, or test-user requirement.

Local redirect URI, when accepted by the provider:

```text
http://localhost:35457/api/connect/<provider>/callback
```

Production redirect URI:

```text
https://oshal.example.com/api/connect/<provider>/callback
```

### 3. Add Environment Variables

Use provider-prefixed names:

```env
<PROVIDER>_CLIENT_ID=
<PROVIDER>_CLIENT_SECRET=
<PROVIDER>_REDIRECT_URI=
<PROVIDER>_SCOPES=
```

For Microsoft/Outlook, also use:

```env
OUTLOOK_TENANT_ID=common
```

### 4. Register The Connector In OSHAL

Update [../../src/app/routes/connectors-routes.ts](../../src/app/routes/connectors-routes.ts).

Add the provider to `PROVIDERS`:

```ts
outlook: {
  label: 'Outlook Email',
  authUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
  tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
  scopes: (process.env.OUTLOOK_SCOPES || 'openid profile email offline_access https://outlook.office.com/IMAP.AccessAsUser.All')
    .split(/[\s,]+/)
    .filter(Boolean),
  authParams: {},
  flavor: 'outlook',
  scopeSep: ' ',
  redirectPath: '/api/connect/outlook/callback',
}
```

Then update:

- `ProviderDef.flavor`
- `providerCreds(provider)`
- `fetchAccount(provider, accessToken)` or token-response parsing
- refresh behavior if the provider has special rules
- revoke behavior if the provider has a revoke endpoint

### 5. Add A Provider Helper

Create a script or service that accepts the connected user's token and performs
provider-specific work.

Examples:

- `scripts/oshal-gmail.js`
- `scripts/oshal-outlook.js`
- `scripts/oshal-linkedin.js`

The helper should:

- fail closed when no matching connection exists
- never choose a random or newest account silently
- accept account/user context explicitly
- return structured JSON
- redact sensitive data in logs
- support small smoke-test operations

### 6. Attach The Agent

Update the relevant persona, tool, or swarm app manifest.

For a bot persona:

- list the connector-backed capability
- state what it can and cannot do
- tell it which helper to call
- tell it how to behave when the account is not connected

For a swarm app:

- add or update `bots[]`
- add a connector-aware tool if needed
- add `ticketType` and `workflow` if this becomes a queue-managed workflow
- add UI entries if the user needs a connect/review surface

### 7. Add User-Facing Connect Surface

The Utilities/Connections UI should show:

- provider name
- configured/not configured state
- connected/not connected state
- connected account label
- connect button
- disconnect button
- reconnect action if token refresh fails

The connect button should start:

```text
/api/connect/<provider>/start
```

The callback should land at:

```text
/api/connect/<provider>/callback
```

### 8. Smoke Test

Before calling it done:

1. Start OSHAL with the provider env vars present.
2. Open the Utilities/Connections page.
3. Confirm the provider shows as configured.
4. Click connect.
5. Complete provider consent.
6. Confirm OSHAL stores the connection.
7. Run the provider helper with a read-only test.
8. Run the bot/tool path that consumes the helper.
9. Disconnect and confirm token deletion.
10. Reconnect and confirm refresh works.

## Outlook App Registration Walkthrough

Use this for the Outlook email connector.

### Create The App

1. Open [https://portal.azure.com](https://portal.azure.com).
2. Open **Microsoft Entra ID**.
3. Go to **App registrations**.
4. Click **New registration**.
5. Name the app:

```text
OSHAL Outlook Email Connector
```

6. Supported account types:

```text
Any Entra ID tenant + Personal Microsoft accounts
```

7. Redirect URI:

```text
Platform: Web
URI: https://oshal.example.com/api/connect/outlook/callback
```

8. Click **Register**.

### Copy IDs And Secret

From **Overview**, copy:

```text
Application (client) ID
```

From **Certificates & secrets**:

1. Click **New client secret**.
2. Description:

```text
oshal-outlook-prod
```

3. Choose an expiration.
4. Click **Add**.
5. Copy the secret **Value** immediately.

Do not use the Secret ID as the app password.

### Outlook Env Vars

```env
OUTLOOK_CLIENT_ID=<Application client ID>
OUTLOOK_CLIENT_SECRET=<client secret Value>
OUTLOOK_TENANT_ID=common
OUTLOOK_REDIRECT_URI=https://oshal.example.com/api/connect/outlook/callback
OUTLOOK_SCOPES=openid profile email offline_access https://outlook.office.com/IMAP.AccessAsUser.All
```

If SMTP send is approved later:

```env
OUTLOOK_SCOPES=openid profile email offline_access https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send
```

### Outlook OAuth Endpoints

```text
Authorize:
https://login.microsoftonline.com/common/oauth2/v2.0/authorize

Token:
https://login.microsoftonline.com/common/oauth2/v2.0/token
```

### Outlook Mail Protocol

This connector can use Outlook/Exchange IMAP/SMTP OAuth scopes instead of Microsoft
Graph mail APIs.

IMAP:

```text
Host: outlook.office365.com
Port: 993
Security: SSL/TLS
Auth: XOAUTH2 bearer token
Scope: https://outlook.office.com/IMAP.AccessAsUser.All
```

SMTP, if sending is enabled:

```text
Host: smtp.office365.com
Port: 587
Security: STARTTLS
Auth: XOAUTH2 bearer token
Scope: https://outlook.office.com/SMTP.Send
```

## X/Twitter App Registration Walkthrough

Use this for a social posting connector that publishes only user-approved posts
to the authenticated user's X account.

### Create The Developer App

1. Open [https://developer.x.com/en/portal/dashboard](https://developer.x.com/en/portal/dashboard).
2. Create or open a project.
3. Create a client application.
4. Use this application name:

```text
OSHAL Twitter Connector
```

5. Use the development environment first:

```text
Development
```

If X asks for a developer agreement use-case description, use conservative,
human-approved wording:

```text
This application is for OSHAL, a private workflow tool used by authenticated users to manage their own social publishing. Users connect their own X account using OAuth 2.0. The application may read the authenticated user profile and publish posts only when the user has explicitly reviewed and approved the final text.

The application will not scrape X, collect public X data at scale, resell X data, create datasets, automate engagement, send bulk posts, send direct messages, or perform unsolicited interactions. It is intended for first-party account connection and human-approved posting only.
```

### Configure App Info

Use:

```text
Callback URI / Redirect URL:
https://oshal.example.com/api/connect/twitter/callback
```

```text
Website URL:
https://oshal.example.com
```

```text
Organization name:
Agentic Federal
```

```text
Organization URL:
https://example.com
```

```text
Terms of Service:
https://oshal.example.com/terms
```

```text
Privacy Policy:
https://oshal.example.com/privacy
```

If X rejects the organization name or URL pairing, use:

```text
Organization name:
OSHAL

Organization URL:
https://oshal.example.com
```

### Select The Active App

In the X developer portal, use the active app under the paid/project area when
there are both pay-per-use and standalone apps.

For the current OSHAL setup, the active app label used during onboarding was:

```text
OSHAL_Connector
```

### X/Twitter Scopes

Start with only posting and identity scopes:

```text
tweet.read
users.read
tweet.write
offline.access
```

Do not add direct-message, follow, like, or broad read scopes for the first
version.

### X/Twitter Env Vars

Use the OAuth 2.0 Client ID and Client Secret, not OAuth 1.0a API Key/Secret.

```env
TWITTER_CLIENT_ID=<OAuth 2.0 Client ID>
TWITTER_CLIENT_SECRET=<OAuth 2.0 Client Secret>
TWITTER_REDIRECT_URI=https://oshal.example.com/api/connect/twitter/callback
TWITTER_SCOPES=tweet.read users.read tweet.write offline.access
```

### X/Twitter OAuth Endpoints

```text
Authorize:
https://twitter.com/i/oauth2/authorize

Token:
https://api.twitter.com/2/oauth2/token
```

### X/Twitter Safety Boundary

- publish only final text the user explicitly approved
- do not scrape X
- do not collect X data at scale
- do not send direct messages
- do not automate follows, likes, replies, or unsolicited engagement
- keep generated-draft language internal until the user approves a final post

## Next Connector Candidates

### Yahoo

Choose Yahoo next if the priority is strengthening the email swarm. Yahoo is a
mailbox connector candidate that fits the LinkedIn notification workflow because
it can provide email signals, newsletters, and article links.

Target callback:

```text
https://oshal.example.com/api/connect/yahoo/callback
```

Target env shape:

```env
YAHOO_CLIENT_ID=
YAHOO_CLIENT_SECRET=
YAHOO_REDIRECT_URI=https://oshal.example.com/api/connect/yahoo/callback
YAHOO_SCOPES=openid email profile
```

Important: Yahoo mail access may require IMAP/SMTP OAuth behavior rather than a
rich provider mail API. Verify the available Yahoo app permissions before
promising read/write mailbox features.

Official starting points:

- [Yahoo OAuth 2.0 guide](https://developer.yahoo.com/oauth2/guide/)
- [Sign In with Yahoo](https://developer.yahoo.com/sign-in-with-yahoo/)
- [Yahoo/AOL IMAP/SMTP OAuth notes](https://senders.yahooinc.com/developer/documentation/)

### Meta Platform Expansion

Choose Meta next if the priority is social publishing beyond Facebook.

Likely products:

- Instagram Graph API for Instagram professional accounts
- Threads API for Threads publishing
- WhatsApp Business Platform only if the app needs customer messaging

Important: Meta platform expansion often depends on account type, page/business
ownership, app review, and business verification. Treat each Meta product as a
separate connector capability even if it lives inside one Meta app.

Official starting points:

- [Instagram APIs](https://developers.facebook.com/products/instagram/apis/)
- [Instagram Platform](https://developers.facebook.com/docs/instagram-platform/)
- [Threads API](https://developers.facebook.com/docs/threads/)

## What Done Means

A connector-backed swarm agent is done when:

- provider developer app exists
- redirect URI is configured for the active OSHAL host
- env vars are present
- connector appears on Utilities/Connections
- user can complete OAuth
- token is stored encrypted in `oshal_connections`
- helper script/service can perform a real read-only operation
- bot can call the helper with the requesting user's account context
- disconnect removes the token
- docs include provider setup and smoke test steps

## Troubleshooting

### Provider says redirect URI is invalid

Check:

- scheme is `https` for production
- local dev uses exactly `http://localhost:<port>`
- route path matches OSHAL exactly
- no trailing spaces
- app platform is `Web` when using a server callback

### OAuth succeeds but bot says not connected

Check:

- the signed-in OSHAL user is the same user who connected the provider
- `oshal_connections.provider` matches the provider id
- token row has `status = connected`
- helper is using `getValidAccessToken(pool, userSub, provider)`

### Token refresh fails

Check:

- `offline_access` or provider equivalent was requested
- a refresh token was returned and stored
- client secret has not expired
- provider app was not rotated/deleted
- user has not revoked consent

### Another user cannot consent

Check:

- supported account type/audience
- provider app review requirements
- Microsoft verified publisher requirements for broad multitenant use
- whether admin consent is required by that user's organization
