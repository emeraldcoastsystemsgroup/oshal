# Bot Forge edit-in-place

This is the Forge half of the backlog entry "Strategy Studio and Bot Forge conversational parity".
The Studio half was proven live on 2026-09-06; see
[trading/studio-parity-proof.md](trading/studio-parity-proof.md). This page records what the Forge
does when a pack is edited, the guard that holds it, a recorded run of that guard, and the automated
live case that checks it on an installed box.

**Status:** built and guarded. The automated live case is built and unit-tested. It has **not** been
run against an installed box yet.

## What happens when a pack is edited

The Packs panel (`/api/swarm/packs/studio`, the Forge's "Deploy to swarm" button) posts to
`POST /api/swarm/packs/<slug>/deploy` ([swarm-pack-routes.ts](../../src/app/routes/swarm-pack-routes.ts)).
When the pack has been deployed before, its emitted manifest `deployed-apps/<slug>.yaml` already
exists. The deploy then re-emits the same pack instead of standing a second one up:

- every bot the manifest already names keeps the agentId the swarm registered it under. Only a bot
  name the pack never had gets a new id;
- the ticketType stays the queue the first deploy created. A ticketType changed in `pack.json` is
  not followed, because following it would fork a second queue away from the existing tickets;
- the version moves one patch (`1.0.0` → `1.0.1`);
- the one manifest is overwritten and loaded again from the same path;
- the response carries `edited: true`, `version` and `agentIds`, and the panel says
  "Updated in place" instead of "Deployed".

Two related rules hold on the same route. A slug another user already deployed is refused with 409,
so their identities and queue are not inherited. The manifest is loaded as the caller, so the install
owner cannot adopt it. The packer persona (`ai-lab/bot-personas/codex-packer.yaml`, "Phase 1b") tells
the Forge chat to re-emit an existing pack under the same slug, agent ids and ticketType.

## The guard and a recorded run

[tests/unit/forge-pack-edit-in-place.spec.ts](../../tests/unit/forge-pack-edit-in-place.spec.ts)
drives the real pack router over HTTP against a real on-disk pack tree. Only `loadApp` is a double;
it records the path and the scope each deploy loads. The spec deploys a pack, edits it (new brief, an
added bot, a drifted descriptor ticketType), deploys again and reads the emitted manifest and persona.

Recorded run, 2026-10-01, on core `main` at `ce998b00`:

```
npx vitest run tests/unit/forge-pack-edit-in-place.spec.ts --reporter=verbose
 Test Files  1 passed (1)
      Tests  5 passed (5)
```

### Does it guard the behaviour?

Each mutation below was applied alone to `src/app/routes/swarm-pack-routes.ts`, the spec was run,
and the file was restored byte for byte (checked by sha256).

| Mutation | What breaks | Spec on `ce998b00` | Spec after this change |
|---|---|---|---|
| M1 | a carried-over bot gets a new agentId | red (2 failed) | red (2 failed) |
| M2 | the drifted descriptor ticketType is followed | red | red |
| M3 | the version stays `1.0.0` | red | red |
| M4 | the version moves two patches | red | red |
| M5 | the edit writes `<slug>-2.yaml` and loads it | red (2 failed) | red (2 failed) |
| M5b | the one manifest is rewritten and a copy appears beside it | red | red |
| M5c | the edit is loaded from another manifest path | **green** | red |
| M6 | the edit is reported `edited: false` | red | red |
| M7 | the prior emission is never read (every deploy is a first deploy) | red (2 failed) | red (2 failed) |

M5c showed a hole. The check meant to prove "the same path reloaded" compared `loaded[0]` with
`loaded[1]`. Those were the edit's two loads when the spec was written. Since `bd2b60e5`, an earlier
case in the same file also deploys, so the check compared that case's load with the edit's first
load and never looked at the edit's reload. The check now takes the edit case's own two loads and
requires both to be `deployed-apps/<slug>.yaml`. Under M5c it fails with
`the edit was loaded from a manifest path other than the one manifest`. Unmutated, the spec passes
`Tests 5 passed (5)`.

## The live case

`node scripts/operations/live-acceptance.js forge-edit` runs the case
[live-acceptance-forge-edit.js](../../scripts/lib/live-acceptance-forge-edit.js) as the operator
automation identity (`OSHAL_VERIFY_OPERATOR_PAT`, read by name, never printed). The case:

1. checks, before it writes anything, that the caller is an operator (the cleanup routes are
   operator-only) and that `GET /api/swarm/packs` answers;
2. writes a two-bot pack tagged `testlab-live-forge-edit-<8 hex>` into the caller's own packs
   directory, through the in-container helper. The tag is the bots' only routing keyword;
3. deploys it through `POST /api/swarm/packs/<tag>/deploy`;
4. edits the pack: new briefs, a new description, and a descriptor ticketType changed to
   `<tag>-drift`;
5. opens the Packs panel in headless Chromium, presses the tagged pack's "Deploy to swarm" and
   accepts its confirm;
6. requires that:
   - both agentIds are unchanged, in the response and in the loaded app;
   - the ticketType is still `<tag>`;
   - the version moved exactly one patch, and the response says `edited: true`;
   - there is one manifest: `deployed-apps` holds exactly `<tag>.yaml`, the swarm loaded the edit
     from the path it loaded first, it lists one app for the tag, and that app carries the edited
     description;
   - the panel says "Updated in place";
7. cleans up. It removes the pack, the manifest and the personas first, so nothing on disk can load
   the app again. Then it unloads the app (`DELETE /api/swarm/apps/<tag>`) and deletes both agents
   (`DELETE /api/swarm/agents/<id>`; their config rows cascade). It proves each one gone by a 404.
   Anything left is a red result.

The receipt lists two things as **kept**. App registration writes an `oshal_authorization_applications`
row and one or more `oshal_authorization_catalogs` snapshots for the tag
([store.ts](../../src/features/application-authorization/store.ts)). No route removes either, and
both tables sit under the operator-only control-plane policy (migrations 127 and 173).

The same case runs from the Test Lab as the explicit-only card `live-acceptance-forge-edit`. The Lab
has no Chromium, so there the edit is deployed through the route and the panel step is reported as a
gap naming the host command. From the Lab the card is degraded, never pass.

[tests/unit/live-acceptance-forge-edit.spec.ts](../../tests/unit/live-acceptance-forge-edit.spec.ts)
proves the case's logic. In one half, a doubled route, swarm and panel make each broken fact fail by
name. In the other, the fixture port writes real files that the real pack router deploys over
loopback HTTP; the case holds there, and goes red when the edit loses its prior emission. Each of
thirteen mutations to the case, the fixture port and the runner's port turns that spec red.

## Still owed

A run of `node scripts/operations/live-acceptance.js forge-edit` against an installed box, with its
receipt (`outstanding 0; errors 0`) recorded here.
