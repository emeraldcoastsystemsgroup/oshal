# Jarvis calling setup (configuration only)

Jarvis calling is **off by default**. A Twilio connection in Utilities does not grant Jarvis permission to use it. The calling application must select one connection and receive a separate owner opt-in. The live call-control service is not installed yet, so even a saved, opted-in configuration has `effectiveEnabled: false` and places no calls.

1. Sign in as the person whose Jarvis will handle the claim. Open [Connections](/utilities) and connect Twilio there if it is not already connected. Keep credentials in that connection flow, not in chat, a ticket, or this file.
2. Open Jarvis → Options → **Calling setup** (or `/api/jarvis/calling/settings`). Select the exact connected Twilio account. The picker shows personal and accessible shared connections by label; it never chooses an account automatically. A deployment-wide service account is **not** silently substituted for a user's connection.
3. Enter the phone to ring on human handoff in international `+` format, choose maximum minutes and estimated cost per call, and save. To opt in, also check the application enablement and charge/approval acknowledgement. Every future live call will still require separate per-call approval.
4. Review the status on the page. The selected account may be configured while effective live calling remains off. If the connection is revoked, disconnected, or the user loses shared access, the page reports it unavailable. Select a new connection deliberately; there is no fallback.

The backing API is `GET`/`PUT /api/jarvis/calling/config`, scoped to the authenticated user. The `PUT` requires same-origin JSON and `X-Oshal-Calling-Config: 1`. It stores only a connection ID, transfer phone, limits, and consent timestamp in `jarvis_calling_settings`; no Twilio secret or provider phone number is hardcoded into the application. The connection selector is checked against current access on every read and write. The JSON explicitly reports `effectiveEnabled: false` and `live_calling_not_installed` until the separately gated live service is built and verified.

The future deployment-owned/swarm-service mode needs the credential-owner and execution-actor metadata work recorded in [BACKLOG.md](../BACKLOG.md). This screen does not grant a personal account to all users or change the existing notification transport's deployment credentials.
