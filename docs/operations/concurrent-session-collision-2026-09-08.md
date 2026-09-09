# Two sessions, one bug: the 2026-09-08 Codex-login collision

> **What happened:** two agent sessions independently diagnosed and fixed the same defect within
> two minutes of each other. Both fixes are on `main`. One duplicate guard shipped, one fix
> introduced the input the other had to defend against, and the failure the operator actually saw
> is still open.

This is written from the evidence on `main` and in the running container. Where a claim could not
be verified, it says so.

---

## Timeline (UTC, from `git log` on `origin/main`)

| Time | PR | Session | What |
|---|---|---|---|
| 04:46 | **#372** | A | Guards the config seed against re-poisoning; adds the `OPENAI_CODEX_*` compose pass-through |
| 04:48 | **#373** | B | Hardens the callback-port parsing; adds a second guard for the *same* seed block |
| 05:02 | — | A | Real browser round trip: authorization code reaches the swarm |
| 05:03 | — | A | Token exchange throws `fetch failed: other side closed`; browser shows `ERR_EMPTY_RESPONSE` |

Both sessions were working the same operator request — get a Codex login into the swarm — and
neither saw the other's claim before landing.

---

## What actually collided

### 1. The seed re-poisoning was diagnosed twice

The real defect: SEC-05 makes `EncryptedConfigManager` refuse **every** secret read/write while a
plaintext `secrets.json` exists. `POST /api/config/migrate` converts it to `secrets.enc.json` and
deletes the plaintext — and a copy-if-missing seed then restored it on the next container start, so
a migrated controller silently un-migrated itself, permanently, on every restart.

Both sessions found this. Session A landed the code fix in #372 (`docker-compose.oshal-local.yml`
+ `scripts/bot-entrypoint.sh`). Session B's #373 message says the SEC-05 skip "existed only as
uncommitted working tree state" — accurate when B started, stale by the time B merged two minutes
later.

**Result: two guard specs for one code path, both on `main`:**

- `tests/unit/config-seed-encrypted-guard.spec.ts` (A)
- `tests/unit/bot-entrypoint-secrets-seed.spec.ts` (B)

Both execute the real Step-1b block out of the real script under a real shell against a real temp
filesystem. They are honest tests; they are also the same test. B's additionally covers "never
clobbers runtime config", which A's does not — so a merge should keep that case rather than simply
deleting either file.

### 2. One session's fix became the other's input

#372 added the pass-through block, including:

```yaml
OPENAI_CODEX_CALLBACK_PORT: ${OPENAI_CODEX_CALLBACK_PORT:-}
```

On any deployment that does not set the variable, that forwards an **empty string** rather than
leaving it unset — and `??`-style fallbacks do not treat `""` as absent. #373 fixed the parsing so
`""`/whitespace resolve to the default 1455.

That is a genuine improvement and the right layer to fix it at. Two notes for the record:

- The pass-through was necessary. Before it, the service read `OPENAI_CODEX_REDIRECT_URI`,
  `_CLIENT_ID` and `_CALLBACK_PORT`, but compose forwarded none of them, so they were unsettable —
  `resolveRedirectUri()` fell through to deriving from `APP_URL` and produced a non-loopback
  redirect that OpenAI's client can never accept.
- **The live symptom #373 cites did not reproduce on this box.** Its message says the empty port
  "skipped the listener" with a logged `Invalid OPENAI_CODEX_CALLBACK_PORT`. That string appears
  **zero** times in the current container's logs, and the listener logged
  `port: 1455, role: openai-codex-callback, "server listening"` at 04:40:42 with the empty variable
  in place. It may have occurred in an earlier container whose logs were lost to a recreate. The
  hardening stands on its own merits either way.

---

## What is still broken

The operator's actual failure is **not** addressed by either PR.

```
05:02:28  OpenAI Codex OAuth callback route invoked
05:02:28  Completing OpenAI Codex authorization flow   (stateLength: 32)
05:03:02  TypeError: fetch failed: other side closed
```

The redirect half is proven: a real browser round trip delivered a genuine `code=ac_…` carrying the
exact state the swarm minted, on the loopback redirect, to the `:1455` listener. The **outbound
token exchange to OpenAI** is what fails, ~34 s in. The handler throws, nothing is written back, and
the browser gets `ERR_EMPTY_RESPONSE`.

Egress is not the cause: DNS resolves (Cloudflare), TCP 443 connects, TLS completes. The 403 from a
bare `GET https://auth.openai.com/` reproduces **from the host too**, so it is Cloudflare answering
a header-less request, not a block.

Tracked in [BACKLOG](../BACKLOG.md) as *"Codex swarm-side OAuth — the token exchange fails at the
last step"*, with the untested candidates listed. The file-push path (`codex login`, then **Push to
swarm**) works end to end and is the working alternative meanwhile.

> ⚠ **Do not brute-force retries.** Repeated failed authorize attempts risk rate-limiting or
> flagging the OpenAI account (operator instruction, 2026-09-08).

---

## Why the collision happened

1. **Both sessions were given the same problem** and neither checked `COLLABORATE.md` for an open
   claim on the other's files before starting.
2. **Claims were posted for files, not for the defect.** A claimed `docker-compose.oshal-local.yml`
   and `scripts/bot-entrypoint.sh`; B was working `src/app/server*.ts`. The file lists did not
   overlap, so nothing looked contended — while both were fixing the same behaviour.
3. **Two minutes is inside the blind spot.** Both used the private-index recipe (commit from
   `origin/main` blobs, push by SHA), which is exactly what let both land cleanly with no conflict
   and no signal. The recipe protects the tree; it does not detect duplicated intent.
4. **Uncommitted state read as absent.** B saw A's entrypoint fix as working-tree-only and set out
   to land it. It was committed before B merged.

## What would have caught it

- **Claim the defect, not just the paths.** A line naming the symptom
  (`ERR_EMPTY_RESPONSE on the codex callback`) would have collided in `COLLABORATE.md` even though
  the file lists did not.
- **Re-read `COLLABORATE.md` immediately before pushing**, not only at session start. Both sessions
  read it once, at the beginning.
- **Check `git log origin/main --since` before opening a PR.** #373 would have seen #372 land.

---

## Open follow-ups

- ✅ **De-duplicate the two seed guards** — DONE 2026-09-09 (PR #385):
  `config-seed-encrypted-guard.spec.ts` survives (it alone covers the compose inline-command
  path) and absorbed B's "never clobbers runtime config" case; the twin spec is retired. 5/5.
- **#373 is not running on this box.** It changes `src/app/server*.ts`, which is baked into the
  image; the api is still on the image built at 20:59Z. Neither B's parsing fix nor A's
  `bot-entrypoint.sh` change takes effect until the next `scripts/oshal-deploy.sh`. Deploy first,
  then retry the flow **once**. *2026-09-09 status:* the deploy was staged and HELD — a concurrent
  session held the shared checkout mid-work, and the deploy script's reset-to-`origin/main`
  prerequisite requires a quiet tree. Tracked as the pending cycle in
  [the pre-deploy checklist](../runbooks/pre-deploy-checklist.md); container-level mitigations
  (patched entrypoint copy, `.env` port pin) keep the box correct meanwhile.
- **The token exchange itself** — see the BACKLOG entry. One more datum settled since this doc
  was written: the "listener skipped" log B cited **did occur** — session B's transcript captured
  `Invalid OPENAI_CODEX_CALLBACK_PORT` with `rawPort:""` at 04:30:00Z in the container created
  ~04:28, whose logs B's own 04:39 recreate then destroyed; and the 04:40 container this doc
  checked had the port already pinned in `.env`, so its healthy listener does not show the empty
  variable is harmless. The hedge above ("may have occurred in an earlier container") is resolved
  in that direction.
