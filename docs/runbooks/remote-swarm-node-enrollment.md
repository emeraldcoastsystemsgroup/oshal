# Remote Swarm Node Enrollment

Use this when a newly stood-up computer needs to join OSHAL as a remote swarm node for a signed-in user. The current shipped path is the `remote-client` daemon: the node registers through `/api/remote-clients`, heartbeats into the runtime registry, polls work, and executes local MCP tools over stdio.

## Current Contract

Enrollment has **two halves**, and they answer different questions.

**Who owns this computer** — `POST /api/join/enroll` (`requiresAuth`, **not** operator-gated). Any
signed-in user enrolls their own machine and receives a short-lived (default 60 min, clamped 5 min –
24 h), revocable, per-user `oshal_pat_…` token bound to their OIDC sub. The node exchanges it once at
startup via `GET /api/cli-tokens/whoami`, persists the **server-verified** sub, and clears the token —
so `ownerSub` is proven by possession of a token minted for that user, never asserted by the node.
Revoke any time from the same `/api/cli-tokens` list. **This binding is not cosmetic:** dispatch is
owner-scoped ([device-access.ts](../../src/features/remote-client/services/device-access.ts)), so an
UNOWNED node will not receive its own user's work unless they are an operator or the deployment still
sets `OSHAL_ALLOW_LEGACY_UNOWNED=true`.

**How the node reaches the worker plane** — still `REMOTE_CLIENT_SHARED_SECRET`, delivered by the
operator-minted `OSJOIN1.<payload>` join code from `GET /api/join/code` (payload is
`base64url(controlPlaneUrl|REMOTE_CLIENT_SHARED_SECRET)`). That endpoint and the `/api/join/` surface
are **operator-only** even though the mount is not, because the code embeds a swarm-wide secret in
plaintext and never expires — treat it exactly like the secret itself: anyone holding it can register
a worker node until the secret is rotated.

So a **brand-new** machine needs both: a join code (from an operator) and an enrollment code (which
the user mints for themselves). An **already-installed** node needs only the enrollment code —
set `OSHAL_ENROLLMENT_TOKEN` and relaunch. Retiring the shared secret in favour of per-node token
auth is tracked in [BACKLOG.md](../BACKLOG.md) ("Node-token auth for the remote-client plane").

- Off-LAN enrollment is planned as `OSJOIN2` from `installer\lib\install-swarm.ps1 -OffLan`; that path must mint a Headscale preauth key on the swarm host. The controller route deliberately does not shell out to Headscale from inside the API container.

### Enroll a computer to yourself

```bash
# As the signed-in user (browser session or an oshal_pat_ token), from any account — not just an operator.
curl -fsS -X POST "http://<swarm-host>:35457/api/join/enroll" \
  -b "$OSHAL_COOKIE_JAR" -H 'content-type: application/json' \
  -d '{"computerName":"my laptop","ttlMinutes":60}' | jq '.enrollment | {expiresAt, ttlMinutes}'
```

Then on the target machine, with the token in `OSHAL_ENROLLMENT_TOKEN`:

```powershell
installer\lib\install-node.ps1 -JoinCode OSJOIN1.xxxxx -EnrollmentToken oshal_pat_...
```

The node logs `enrolled: this computer is registered to <you>` on first launch. An expired or revoked
token is **not** fatal — the node comes up UNOWNED rather than guessing an identity, and the reason is
logged. Enroll again to fix it.

## Prerequisites

On the OSHAL control-plane machine:

- OSHAL stack is running and reachable from the remote machine.
- `REMOTE_CLIENT_SHARED_SECRET` is set in the controller environment.
- The signed-in operator can open `/api/join/` or call `/api/join/code`.
- The remote node's owner user is known as an OIDC subject when session-bound ownership matters. Machine-secret registration may assert `ownerSub`; browser-session registration binds to the session user.

On the remote computer:

- Linux host with `systemd` for the command sequence below. Windows/macOS can run the same daemon manually, but service setup differs.
- `git`, `node`, and `npm` available. Node 20+ is the expected baseline for the TypeScript runtime.
- The MCP server command you want OSHAL to drive is installed and works locally.
- For GUI automation MCPs, OS-level permissions are already granted. macOS requires Accessibility/Input Monitoring; Windows may require an interactive user session; Linux GUI MCPs generally need the right `DISPLAY`/Wayland session.

## Network and Security Requirements

- The remote node initiates outbound HTTP(S) calls to the control plane. No inbound port is required on the remote node for the current polling daemon.
- LAN join codes must point at a non-loopback control-plane URL. If `/api/join/code` warns that the code points at `localhost`, open Cockpit through the swarm machine's LAN hostname/IP and regenerate it.
- Off-LAN nodes should use the Headscale overlay path. Join the tailnet first, then set `REMOTE_CLIENT_CONTROL_PLANE_URL` to the control-plane URL reachable over that overlay.
- Protect the join code, `/etc/oshal/remote-client.env`, shell history, journal output, and deployment automation as secrets.
- Rotate `REMOTE_CLIENT_SHARED_SECRET` after suspected exposure. Every remote node must then be redeployed with the new secret.

## Generate or Retrieve the Enrollment Code

Browser path:

1. Sign in to OSHAL as an operator.
2. Open `http://<swarm-host>:35457/api/join/`.
3. Click `Generate join code`.
4. Copy the `OSJOIN1...` code.

CLI path from an authenticated operator shell:

```bash
curl -fsS -b "$OSHAL_COOKIE_JAR" "http://<swarm-host>:35457/api/join/code" | jq -r '.joinCode'
```

If you are on the control-plane host and need a manual code, read the existing secret without printing it in shared logs, then encode locally:

```bash
CONTROL_PLANE_URL="http://<swarm-host>:35457"
SECRET="$(grep -E '^REMOTE_CLIENT_SHARED_SECRET=' .env | tail -1 | cut -d= -f2-)"
printf 'OSJOIN1.%s\n' "$(printf '%s|%s' "$CONTROL_PLANE_URL" "$SECRET" | node -e "process.stdin.on('data', d => process.stdout.write(Buffer.from(String(d)).toString('base64url')))")"
unset SECRET
```

## Ready-To-Run Linux Install

Run this on the remote machine. Replace the first four values before execution.

```bash
set -euo pipefail

JOIN_CODE='OSJOIN1.REPLACE_ME'
NODE_ID="$(hostname -s | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9-')-remote"
NODE_NAME="$(hostname -s) remote node"
INSTALL_DIR='/opt/oshal/open-shal'
SERVICE_USER='oshal-remote'
MCP_COMMAND='mcp-server-macos-use'
MCP_ARGS='[]'
MCP_CWD=''

sudo useradd --system --create-home --home-dir /var/lib/oshal-remote --shell /usr/sbin/nologin "$SERVICE_USER" 2>/dev/null || true
sudo mkdir -p /opt/oshal /etc/oshal

PAYLOAD="${JOIN_CODE#OSJOIN1.}"
DECODED="$(node -e "const p=process.argv[1]; process.stdout.write(Buffer.from(p, 'base64url').toString('utf8'))" "$PAYLOAD")"
CONTROL_PLANE_URL="${DECODED%%|*}"
REMOTE_SECRET="${DECODED#*|}"

if [ "$CONTROL_PLANE_URL" = "$REMOTE_SECRET" ] || [ -z "$CONTROL_PLANE_URL" ] || [ -z "$REMOTE_SECRET" ]; then
  echo "Invalid OSJOIN1 code" >&2
  exit 1
fi

if [ ! -d "$INSTALL_DIR/.git" ]; then
  sudo git clone https://github.com/emeraldcoastsystemsgroup/open-shal.git "$INSTALL_DIR"
fi

sudo git -C "$INSTALL_DIR" pull --ff-only
sudo npm --prefix "$INSTALL_DIR" install --include=dev
sudo chown -R "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR" /var/lib/oshal-remote

sudo install -m 0600 -o root -g root /dev/null /etc/oshal/remote-client.env
sudo tee /etc/oshal/remote-client.env >/dev/null <<EOF
REMOTE_CLIENT_ID=$NODE_ID
REMOTE_CLIENT_NAME=$NODE_NAME
REMOTE_CLIENT_CONTROL_PLANE_URL=$CONTROL_PLANE_URL
REMOTE_CLIENT_SHARED_SECRET=$REMOTE_SECRET
REMOTE_CLIENT_AUTH_HEADER=x-remote-client-key
REMOTE_CLIENT_PLATFORM=linux
REMOTE_CLIENT_TRANSPORT=headscale-http
REMOTE_CLIENT_TAILNET_HOSTNAME=$(hostname -f 2>/dev/null || hostname)
REMOTE_CLIENT_AGENT_ID=$NODE_ID
REMOTE_CLIENT_MCP_COMMAND=$MCP_COMMAND
REMOTE_CLIENT_MCP_ARGS=$MCP_ARGS
REMOTE_CLIENT_MCP_CWD=$MCP_CWD
REMOTE_CLIENT_HEARTBEAT_INTERVAL_MS=10000
REMOTE_CLIENT_POLL_INTERVAL_MS=2500
EOF

sudo tee /etc/systemd/system/oshal-remote-client.service >/dev/null <<EOF
[Unit]
Description=OSHAL remote swarm node
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SERVICE_USER
WorkingDirectory=$INSTALL_DIR
EnvironmentFile=/etc/oshal/remote-client.env
ExecStart=/usr/bin/npm run remote-client:start
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=false

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now oshal-remote-client.service
sudo systemctl status --no-pager oshal-remote-client.service
```

If the MCP requires a project directory, set `MCP_CWD` before running the installer. If the MCP args are easier as comma-separated values than JSON, the daemon accepts both forms.

Bind the registered node to the signed-in user's subject from the control-plane host or an operator-authenticated shell:

```bash
REMOTE_SECRET="$(grep -E '^REMOTE_CLIENT_SHARED_SECRET=' .env | tail -1 | cut -d= -f2-)"
NODE_ID='<node-id>'
OWNER_SUB='<signed-in-user-oidc-sub>'

curl -fsS -X POST "http://127.0.0.1:35457/api/remote-clients/$NODE_ID/owner" \
  -H "content-type: application/json" \
  -H "x-remote-client-key: $REMOTE_SECRET" \
  -d "{\"ownerSub\":\"$OWNER_SUB\"}" | jq '.client | {clientId, ownerSub}'

unset REMOTE_SECRET
```

## Labels and Capability Registration

The daemon discovers the local MCP server tools during startup and registers:

- `clientId`: `REMOTE_CLIENT_ID`
- `agentId`: `REMOTE_CLIENT_AGENT_ID`, or the client id when unset
- `name`: `REMOTE_CLIENT_NAME`
- `transport`: `REMOTE_CLIENT_TRANSPORT`
- `platform`: `REMOTE_CLIENT_PLATFORM`
- `tailnetHostname`: `REMOTE_CLIENT_TAILNET_HOSTNAME`
- `capabilities`: discovered MCP tool names, falling back to `mcp.list-tools` and `mcp.call-tool`
- `tags`: `remote-client`, `mcp`, and the platform value

To change labels/capabilities, change the MCP command/args/CWD or the `REMOTE_CLIENT_*` environment values, then restart:

```bash
sudo systemctl restart oshal-remote-client.service
```

## Health Checks

On the remote node:

```bash
systemctl is-active oshal-remote-client.service
journalctl -u oshal-remote-client.service -n 80 --no-pager
```

From an operator-authenticated control-plane session:

```bash
curl -fsS -b "$OSHAL_COOKIE_JAR" "http://<swarm-host>:35457/api/remote-clients" | jq '.clients[] | {clientId, agentId, status, healthy, platform, capabilities, tags, lastHeartbeatAt}'
```

From the control-plane host with the machine secret:

```bash
REMOTE_SECRET="$(grep -E '^REMOTE_CLIENT_SHARED_SECRET=' .env | tail -1 | cut -d= -f2-)"
curl -fsS -H "x-remote-client-key: $REMOTE_SECRET" "http://127.0.0.1:35457/api/remote-clients" \
  | jq '.clients[] | select(.clientId=="<node-id>")'
unset REMOTE_SECRET
```

Expected result: the node appears with `status: "online"`, `healthy: true`, recent `lastHeartbeatAt`, and the expected MCP capabilities.

## Smoke Test

Queue an MCP tool-list task and read the result:

```bash
REMOTE_SECRET="$(grep -E '^REMOTE_CLIENT_SHARED_SECRET=' .env | tail -1 | cut -d= -f2-)"
NODE_ID='<node-id>'
TASK_ID="smoke-$(date +%s)"

curl -fsS -X POST "http://127.0.0.1:35457/api/remote-clients/$NODE_ID/tasks" \
  -H "content-type: application/json" \
  -H "x-remote-client-key: $REMOTE_SECRET" \
  -d "{
    \"taskId\":\"$TASK_ID\",
    \"correlationId\":\"$TASK_ID\",
    \"fromAgentId\":\"operator-smoke\",
    \"toAgentId\":\"$NODE_ID\",
    \"intent\":\"mcp.list-tools\",
    \"input\":{},
    \"createdAt\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"
  }"

sleep 5

curl -fsS "http://127.0.0.1:35457/api/remote-clients/$NODE_ID/tasks/$TASK_ID/result" \
  -H "x-remote-client-key: $REMOTE_SECRET" | jq .

unset REMOTE_SECRET
```

Pass criteria:

- POST returns `201`.
- Result returns `status: "completed"`.
- Output includes the local MCP tool list.
- Remote journal shows the task was claimed and completed.

## Troubleshooting

- `401 Unauthorized`: the join code carried the wrong secret, the controller secret rotated, or `REMOTE_CLIENT_AUTH_HEADER` does not match the controller's configured header.
- `403 Forbidden` on a device action: a browser/session caller is not the owner/operator for that device. Machine-secret calls bypass ownership because they are the node/control-plane trust path.
- `403 Forbidden` on `GET /api/join/code` or `/api/join/`: those are operator-only (they carry the swarm-wide shared secret). `POST /api/join/enroll` is the endpoint an ordinary user calls.
- `403 Forbidden` re-registering an existing device: adopting an already-registered but **unbound** device is operator-only — it was an ownership-takeover primitive. A genuine first-time enrollment registers a NEW `clientId`.
- **"My work never reaches my computer."** Check `ownerSub` on the device (`GET /api/remote-clients` as a machine caller). `null` means the node was installed without an enrollment code: dispatch is owner-scoped, so it is skipped for everyone except operators. Enroll it and relaunch.
- The registry is **in-memory**: every controller recreate wipes it and nodes re-register. A node whose `userSub` came from an enrollment exchange re-asserts its owner automatically; one that was bound only by `POST /:clientId/owner` loses the binding.
- `409 no_shared_secret` from `/api/join/code`: set `REMOTE_CLIENT_SHARED_SECRET` in the swarm `.env` and restart the controller.
- Node never appears: check that the control-plane URL is reachable from the remote host and is not `localhost` unless the remote daemon runs on the same machine.
- Capabilities are only `mcp.list-tools`/`mcp.call-tool`: the MCP server did not initialize or did not return tool names. Check the MCP command, args, CWD, and OS permissions.
- Off-LAN node cannot reach the control plane: join the Headscale tailnet first and use the tailnet-reachable control-plane URL. `OSJOIN1` alone does not provision overlay credentials.
