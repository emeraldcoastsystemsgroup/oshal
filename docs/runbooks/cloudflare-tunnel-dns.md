# Cloudflare Tunnel + DNS Recovery Runbook

How the public site (`oshal.example.com`, `littlemonster.example.com`)
reaches the local stack, and how to recover the two failure modes that have taken
it down. Both were hit on 2026-06-17; both are now resolved and the path is
operational.

## Quick health check (do this first)

One probe localizes the break — no login needed. A **`302` is healthy** (it's just
redirecting an unauthenticated request to Google sign-in):

```
curl -sS -o /dev/null -w "%{http_code} %{time_total}s\n" --max-time 15 https://oshal.agenticfederal.us/cockpit/
```

| Result | Meaning | First action |
|---|---|---|
| `302` (fast, ~0.5s) | **Up** — redirecting to sign-in. Nothing to do. | — |
| `502` / `503` / `504` | Connector up, **origin down** (`oshal-api`). | `docker compose -f docker-compose.oshal-local.yml up -d oshal-api`; confirm `curl 127.0.0.1:35457/` → 302. Then Failure mode 1 if the tunnel still can't reach it. |
| `1033` / `530` / `523` (Cloudflare error page) | **Tunnel/connector down** (`cloudflared`). | Restart the `oshal-local-cloudflared` container; read `docker logs oshal-local-cloudflared`. |
| NXDOMAIN / "can't be found" | **DNS record gone.** | Failure mode 2 (re-add the proxied CNAME). |
| Hang / timeout | Edge can't reach the connector, or the origin is wedged. | Check `cloudflared` logs, then the origin container. |

A brief `502` right after a deploy is **expected**: the live site runs the prebuilt
`oshal-bot:latest` image, so recreating `oshal-api` cycles the container for ~10–30s,
then recovers on its own. Only chase it if `302` doesn't return within a minute.

## The path (as-built)

```
browser → public DNS (CNAME, agenticfederal.us zone, Cloudflare)
        → Cloudflare edge
        → cloudflared tunnel  "little-monster"  (<your-tunnel-id>)
        → ingress rule (managed in the Zero Trust dashboard)
        → http://oshal-api:5000   (the oshal-local-api container, host port 35457)
```

Key facts:
- The `oshal-local-cloudflared` container runs a **remote-managed** named tunnel
  (`command: tunnel run` + `TUNNEL_TOKEN`). **Its ingress rules live in the
  Cloudflare Zero Trust dashboard, not in any repo file** — `grep` will not find them.
- **One tunnel, `little-monster`, serves BOTH hostnames** (oshal + littlemonster),
  each via an ingress rule pointing at `http://oshal-api:5000`. The tunnel name is
  legacy; don't be thrown by it — it's "which tunnel," not "which app."
- DNS records for the hostnames live in the **`agenticfederal.us`** zone as proxied
  CNAMEs → `<tunnel-id>.cfargotunnel.com`.
- Account tag: `56f6f1aca3f9b1330b230d5343803b65`. Confirm the container's tunnel ID
  by decoding `CLOUDFLARE_TUNNEL_TOKEN` (base64 JSON → field `t`).

## Failure mode 1 — public 502 (Bad Gateway), origin unreachable

**Symptom:** every public request 502s. `docker logs oshal-local-cloudflared` shows
`dial tcp: lookup <name> on 127.0.0.11:53: no such host  originService=http://<name>:5000`.
Local origin is fine (`curl 127.0.0.1:35457/` → 302).

**Cause:** the tunnel ingress origin points at a container/service name that no
longer resolves on the docker network — e.g. after a service rename, the ingress
still names the retired service instead of `http://oshal-api:5000`.

**Fix:** Zero Trust → Networks → Tunnels → little-monster → **Public Hostname** tab.
**Edit each hostname's Service** to the current origin (`http://oshal-api:5000`).
- Ingress is **first-match-wins**. If you *add* a new rule above/below a stale one
  for the same hostname, the stale one still wins — you must remove or edit it.
- **EDIT in place** rather than add-new-then-delete-old (see failure mode 2 for why).

## Failure mode 2 — public NXDOMAIN ("can't be found"), DNS record gone

**Symptom:** the hostname returns "Non-existent domain" from public resolvers
(`nslookup oshal.example.com 1.1.1.1` → NXDOMAIN) while the apex
(`nslookup agenticfederal.us 1.1.1.1`) and other subdomains resolve fine.

**Cause:** the proxied DNS CNAME for the hostname was deleted. This happens when
two public-hostname entries **share one hostname** (e.g. a retired origin + oshal-api both
on `oshal.example.com`) and you delete one — they share a single DNS record,
so deleting either removes it, orphaning the survivor with no DNS.

**Fix (dashboard — the reliable path):** Cloudflare DNS app for `agenticfederal.us`
→ **Add record**:
- Type **CNAME**, Name `oshal` (becomes `oshal.example.com`),
  Target `<your-tunnel-id>.cfargotunnel.com`, **Proxied** (orange
  cloud ON), TTL Auto. Repeat for `littlemonster`.
- It will display as a **Tunnel / Proxied** row, like the other tunnel hostnames.
- Resolves within ~1 min. Verify: `nslookup oshal.example.com 1.1.1.1` →
  Cloudflare IPs (172.67.x / 104.21.x).

**⚠️ Do NOT use `cloudflared tunnel route dns` for this zone.** The host's
`~/.cloudflared/cert.pem` is scoped to the **`emeraldcoastsystemsgroup.com`** zone,
not `agenticfederal.us`. `cloudflared tunnel route dns <tunnel> oshal.example.com`
will silently create a junk record `oshal.example.com.emeraldcoastsystemsgroup.com`
in the wrong zone. Use the dashboard, or a credential scoped to `agenticfederal.us`.

## Not-the-tunnel red herrings (rule these out first)

- **Local laptop can't resolve but the world can:** `1.1.1.1` resolves the name but
  the system resolver (router `192.168.1.1`) returns NXDOMAIN → the **Headscale/VPN
  DNS forwarder is dead**, not the site. Verify the site is actually up from the
  laptop with `curl --resolve oshal.example.com:443:172.67.153.219 https://oshal.example.com/`
  (bypasses local DNS). Fix locally by pointing the NIC at `1.1.1.1` (needs Admin) or
  restoring Headscale.
- **API "healthy" but `127.0.0.1:35457` dead (HTTP 000):** docker forward wedge after
  a reboot, not a tunnel/DNS issue → `bash scripts/api-bounce.sh`.

## Diagnostics cheat-sheet

```bash
docker logs oshal-local-cloudflared --since 2m | grep -iE "no such host|Updated to new configuration"
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:35457/           # origin health (302 = ok)
nslookup oshal.example.com 1.1.1.1                                    # public DNS (NXDOMAIN = record gone)
nslookup agenticfederal.us 1.1.1.1                                          # zone health (apex should resolve)
curl --resolve oshal.example.com:443:172.67.153.219 https://oshal.example.com/   # end-to-end, bypassing local DNS
```
