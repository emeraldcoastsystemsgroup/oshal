# Antigravity CLI, node sizing, and how harnesses reach a bot

**Enhancement, not a defect.** Nothing is broken: `gemini-cli` runs today on the same Google key and
the same models, and the Antigravity harness is registered, typed and selectable — it refuses on this
image with a measured reason rather than failing mysteriously. This entry is the roadmap for turning
that refusal into a working harness, and for the larger question it exposed about what a bot node has
to carry.

Raised by the operator 2026-09-18 after the harness landed: *"we need to look at how large that
footprint is … we are specifically using small nodes so each bot can have its own container as a
micro service … we need to look at node sizing and dynamically loading and unloading unneeded api's
and tools or mounting api's in a shared folder — maybe that's a better approach."*

---

## 1. What blocks Antigravity today (measured 2026-09-18)

Google publishes **no musl build**. The installer detects musl and requests
`manifests/linux_amd64_musl.json`, which returns **404**. The `linux_amd64` artifact it would
otherwise fetch (55.9 MB tarball, v1.2.6) is a dynamically linked PIE against
`/lib64/ld-linux-x86-64.so.2`. Run in a throwaway `node:20-alpine` container with `gcompat`
installed, it fails to relocate:

```
Error relocating /tmp/agy/antigravity: __open: symbol not found
Error relocating /tmp/agy/antigravity: __lseek: symbol not found
Error relocating /tmp/agy/antigravity: __read: symbol not found
Error relocating /tmp/agy/antigravity: pvalloc: symbol not found
```

The binary ships as `antigravity` inside the tarball; the installer renames it to `agy`.

**So this is a base-image question, not an `apk add`.** And it is not a free one: this image installs
only the `gcompat` stub deliberately, because the glibc aliases a fuller install drops into `/lib`
are what let a Node process `dlopen` a glibc-only native addon it currently refuses — the segfault
class recorded in the `Dockerfile.oshal` comments. Moving the bot base to glibc has to be proven
against that, and against the cline 3.x binary that already depends on the current arrangement.

## 2. The footprint, with numbers

| measure | today |
|---|---|
| `oshal-bot:latest` | **7.05 GB** |
| global `node_modules` in the image | **1.2 GB** |
| `cline` | 417 MB |
| `@openai` (Codex CLI) | 354 MB |
| `@anthropic-ai` (Claude Code) | 216 MB |
| `@google` (Gemini CLI) | 97 MB |
| **four CLI harnesses, combined** | **~1.08 GB** |
| bot containers on the operator box | 36 |
| Antigravity artifact, if added | +55.9 MB |

Every bot container carries all four CLIs whether or not its bot is configured to use one. On a
single host that is a shared layer and costs disk once. **On the micro-service topology this project
is aiming at — one small node per bot — it is paid per node**, in pull time, disk and page cache,
for harnesses most of those bots will never invoke.

## 3. The question worth answering before adding a fifth CLI

Three shapes, and the operator named all three:

1. **Fatter base, all harnesses baked in.** Simplest, what we do now. Adding Antigravity means a
   glibc base *and* another ~56 MB, on every node.
2. **Dynamic load / unload.** A node fetches the harness it is configured for, on demand, and drops
   what it does not need. Smallest steady-state node; introduces a cold-start cost and a failure
   mode (a node that cannot fetch its harness at the moment it is asked to work) that the current
   fail-closed posture would have to cover.
3. **Shared mount.** The CLIs live in one volume that every bot container mounts read-only, so the
   bytes exist once per host rather than once per image. Cheapest change; keeps a single host's
   nodes coupled to that host, which is a real constraint for a fleet meant to spread.

No verdict here — that is the point of the entry. Option 3 looks cheapest for the topology we run
today and option 2 looks right for the one we are aiming at, and those are different answers.

## 4. The authentication question, which may change the whole calculation

The operator's read was right, and it is not what the harness currently assumes.

`agy` supports **interactive account login**, not just an API key:

- On a local machine it "automatically launches your local default web browser" to sign in.
- **Over SSH it prints a device-code style authorization URL**, you sign in, and paste an
  alphanumeric code back into the terminal.

That second flow is the one a container could use, and it is the same shape as the Codex and Claude
Code OAuth sessions this deployment already mounts read-only into bot nodes.

**Why it matters:** an account login may ride the Antigravity/Google AI entitlement rather than the
`GOOGLE_API_KEY` quota. The docs reference "AI Credits" separately from API keys but give no quota
comparison, so this is a question to settle by measurement, not by reading.

**And a caution to carry forward, because it has already misled this project once today:** Gemini
working is *not* evidence that it is on a paid tier. On 2026-09-18 a `429` named
`GenerateRequestsPerDayPerProjectPerModel-FreeTier`, and that was read as a hard 20/day wall; later
the same day 13 generation calls succeeded with zero `429`s and four `503 UNAVAILABLE`
("experiencing high demand"). Throughput and quota are different failures and were conflated.
Whatever tier the key is on has not been established.

## 5. Done when

This is deliberately staged, because item (a) is a decision and the rest depends on it.

**(a) DECISION — the operator picks a harness-delivery shape** from §3, recorded in this file with
the reason. "Keep baking all harnesses into one image" is a legitimate answer and closes (c) and (d).

**(b) The auth path is established by measurement, not reading.** Run `agy` once on a glibc host
with the SSH/device-code flow, and record: whether it authenticates without `GEMINI_API_KEY`, which
entitlement the run draws from, and whether the resulting credential is mountable into a container
the way the Codex and Claude Code sessions are. Attach the observed quota behaviour — a `429`'s
quota id, or a sustained call count with none — so the tier question stops being inferred.

**(c) A measured footprint per option.** For whichever of §3 is chosen: the image size, the per-node
delta against the 7.05 GB baseline, and the cold-start cost if the harness is fetched rather than
baked. A number per option, in this file.

**(d) Antigravity actually executes.** `agy --version` succeeds inside a bot container, and a real
ticket completes on `providerId: antigravity-cli` with a `chat_tasks` cost row — the same bar every
other harness is held to. Until then
`AntigravityCliHarnessAdapter.blockingReason()` must keep naming the 404 manifest, and
`tests/unit/antigravity-cli-harness.spec.ts` keeps that sentence pinned.

**(e) The glibc move, if chosen, is proven not to regress what depends on musl.** `cline --version`
and a real Cline-backed task both complete on the new base, and the native-addon segfault class the
`Dockerfile.oshal` comments describe is re-checked rather than assumed away.

## 6. Not in scope

Changing which provider the fleet runs on. That is already a row an administrator writes
(`oshal_bot_provider_switch`, migration 147 for the provider and 148 for the fallback order), settable
in the cockpit, with no code naming any provider. Antigravity becomes selectable the moment it can
execute; nothing about the selection mechanism is waiting on this entry.
