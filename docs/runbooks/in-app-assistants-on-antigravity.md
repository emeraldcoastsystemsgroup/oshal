# In-app assistants on the operator's Antigravity login

Each installed app has its own chat assistant: the bot behind the app's right-rail chat and the
cockpit chat. This runbook covers making those assistants answer the deployment operator on the
operator's own Antigravity login (`antigravity-cli`), checking that they do, and what each failure
means. The routing rules and security boundary are in
[remote application execution](../security/remote-application-execution.md#concierge-node-for-inline-application-bots).

## Where an assistant's turn runs

- **A bot with its own node** (its own compose service, from a manifest `container:` or a core
  registry entry) answers from that node.
- **An app bot without its own node** ("inline") runs on the shared concierge node, provided the
  conditions in the security doc hold. In short: the caller is the deployment operator under the
  operator carve, their brain is `antigravity-cli`, the node is healthy, and the bot is either
  package-governed or on the reviewed static list
  (`src/app/extensions/swarm/concierge-static-app-bots.ts`).
- **Anything else stays inline in the controller.** The controller never runs a CLI login
  (SEC-05), so with no hosted lane configured the turn answers 422 `NO_HOSTED_BRAIN`.

## Switch on the concierge node

1. In the deployment `.env`, add `concierge-node` to `COMPOSE_PROFILES`, and set
   `OSHAL_CONCIERGE_NODE_URL=http://concierge-bot:5000`. Compose passes the URL to `oshal-api`.
2. Deploy as usual (`scripts/oshal-deploy.sh`). That starts `oshal-local-concierge-bot` and gives the
   api the URL.
3. The node mounts only the Antigravity login, with no workspace. A long turn is allowed
   `CONCIERGE_AGY_TIMEOUT_MS` (default 1800000 ms).

To switch it off, blank `OSHAL_CONCIERGE_NODE_URL` and recreate `oshal-api`: inline app bots go
back to the controller path.

## Check it

```bash
# The api can reach the node (expect 200).
docker exec oshal-local-api curl -s -o /dev/null -w '%{http_code}\n' --max-time 3 http://concierge-bot:5000/api/health
# The node took its configuration from the controller on this boot.
docker logs oshal-local-concierge-bot 2>&1 | grep 'authoritative controller record applied'
```

The second check prints nothing when the controller has no record for the node yet: the node then
logs `no authoritative record yet` at info level and resolves its settings from its env. That is a
fallback, not an error.

Then, as the operator, send one message in an app's right-rail chat. The reply must stream into
the panel without a reload. The `POST /api/send-message` response must name `antigravity-cli` as
its provider and carry an `applicationExecutionId` (a protected turn).

## When an assistant does not answer

| What the operator sees | What the api log shows for that agent id | Cause | Fix |
| --- | --- | --- | --- |
| 422 `NO_HOSTED_BRAIN`, body `detail: "concierge_node_unavailable"` | — | The concierge node is down or its health check took over 2 s | `docker restart oshal-local-concierge-bot`, then run the checks above |
| 422 `NO_HOSTED_BRAIN` within about 2 s | `Agent not found in bot registry` just before the refusal | The bot is not registered because its app is installed but inactive. Opt-in packages ship `status: inactive` in their manifest | The operator turns the app on: `PATCH /api/swarm/apps/<name>/toggle` with body `{"active": true}`. The choice survives reloads and restarts |
| 422 `NO_HOSTED_BRAIN`, bot registered | `hosted-brain resolution: nothing on the ladder`, with no `Agent not found` line | The bot is a core registry entry that is not on the reviewed static list, or the caller is outside the operator carve | Adding a bot to the reviewed list is a reviewed core change |
| 500 `authorization_operation_unbound` | — | The app's authorization catalog does not bind the bot | The package binds it in `bindings.bots`: see [package tools](../apps/package-tools.md#bots-in-an-adopted-package) |
| 500 `Failed to process message` within about 2 s | `message-routes` fails with `authorization_app_admin_required` | The app has no authorization catalog, and the caller lacks its `@app-admin` grant | Grant `@app-admin` through `/access`, if the operator wants that person to have the app |
| The assistant answers, but its tools fail with 401 | — | The tool is route-backed (`executorType: api`) | Convert it to a package tool |
| The assistant answers, but says it has no tools | — | Its tool grants are not installed | `PUT /api/agents/<agentId>/tools/groups/<group>` with `{"groupName": "<group>", "authMode": "auto"}` |
| A newly added node falls back to its env seed on its first boot | `controller unreachable` in the node's log during a deploy | Its first configuration pull ran while the deploy was recreating the bots | `docker restart` that one node, then look for `authoritative controller record applied` |
