# Headscale ACL Hardening — apply the deny-by-default policy

How to move the live Headscale overlay off the allow-all starter policy
(`src:["*"] dst:["*:*"]`) onto the staged deny-by-default, tag-segmented policy at
[infra/headscale/config/policy.hardened.hujson](../../infra/headscale/config/policy.hardened.hujson),
without bricking the edge agent. Companion to
[remote-swarm-node-enrollment.md](./remote-swarm-node-enrollment.md) (the worker-plane daemon)
and `scripts/headscale-enroll-worker.sh` (ephemeral worker keys).

## What the hardened policy says

- `tag:admin` → everything (`*:*`).
- `tag:worker` → controller only, on exactly the ports the edge agent uses today:
  **35457** (host-published API), **6379** (Redis), **5432** (Postgres), **8000** (ChromaDB).
  The three datastore ports are a documented trade-off: `scripts/start-local-agent.bat` still
  dials them directly over the tailnet; delete those rules once the edge agent is API-only
  (tracked in `docs/backlog/hardening.md` #15).
- `tag:controller` → `tag:worker:3099` (the edge agent's own API port), for dispatch-back.
- Everything else — worker↔worker, Arango, Docker socket, code-server — implicitly denied.
- Tag minting is owned by the `agentmesh` user (the one `scripts/headscale-setup.sh` creates).

A repo guard (`tests/unit/headscale-policy.spec.ts`) keeps the staged file apply-ready: it goes
red if a placeholder user/port comes back, if an allow-all rule appears, if the policy and the
edge agent's dialed ports drift apart, or if a plaintext pre-auth key is ever re-committed to
`start-local-agent.bat`.

## Apply steps (operator, on the swarm host)

All commands run against the local `oshal-headscale` container.

1. **Inventory the live nodes and decide roles.** Which machine is admin (your PC), which is
   the controller (the swarm host), which are workers — this is an operator call.

   ```bash
   docker exec oshal-headscale headscale nodes list
   ```

2. **Tag every live node.** Untagged nodes match no `src` rule under the hardened policy and
   lose all access the moment it applies — tag first, apply second.

   ```bash
   docker exec oshal-headscale headscale nodes tag -i <id> -t tag:admin        # your PC
   docker exec oshal-headscale headscale nodes tag -i <id> -t tag:controller   # swarm host
   docker exec oshal-headscale headscale nodes tag -i <id> -t tag:worker       # each worker
   ```

   Note: the swarm host usually enrolls itself via `headscale-setup.sh`; if the same physical
   machine is both admin and controller, `tag:admin` alone is sufficient (it grants `*:*`).

3. **Apply the staged policy.** The config directory is bind-mounted into the container, so the
   copy is visible at `/etc/headscale/` immediately:

   ```bash
   cd infra/headscale/config
   cp policy.hardened.hujson policy.hujson
   docker exec oshal-headscale headscale policy set -f /etc/headscale/policy.hujson
   ```

4. **Verify from a worker.** On a worker machine (or re-run `scripts/start-local-agent.bat`):
   the agent must still reach Redis/Postgres/Chroma over the VPN IP and the API on 35457, and
   must NOT be able to reach another worker or any un-listed port. Quick probes:

   ```powershell
   Test-NetConnection <controller-tailnet-ip> -Port 35457   # expect success
   Test-NetConnection <controller-tailnet-ip> -Port 6379    # expect success (until API-only)
   Test-NetConnection <other-worker-tailnet-ip> -Port 3099  # expect FAILURE (worker↔worker denied)
   ```

5. **Roll back if a worker is bricked:** re-apply the previous `policy.hujson` (or the starter
   allow-all) with the same `policy set` command, fix the tags/rules, try again.

## Pre-auth key hygiene

- **Workers:** mint keys ONLY with `bash scripts/headscale-enroll-worker.sh` — single-use,
  ephemeral, 1h expiry, pre-tagged `tag:worker`. The node record vanishes on disconnect.
- **Admin/controller:** non-ephemeral key from `scripts/headscale-setup.sh`, then tag by hand
  (step 2). Never enroll a controller ephemerally — it drops out of the mesh on disconnect.
- **Revoke old long-lived keys.** A reusable pre-auth key was historically committed to
  `scripts/start-local-agent.bat` (removed; the script now reads the key from the environment
  or `%USERPROFILE%\.oshal-headscale-authkey`). Any key that ever touched git must be treated
  as burned. List and expire every outstanding reusable key:

  ```bash
  docker exec oshal-headscale headscale preauthkeys list --user <user-id>
  docker exec oshal-headscale headscale preauthkeys expire --user <user-id> <key-prefix>
  ```

  Expiring a pre-auth key does not disconnect nodes that already joined with it — it only
  prevents new joins, which is exactly the goal.
