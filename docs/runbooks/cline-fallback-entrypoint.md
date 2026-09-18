# Cline fallback entrypoint — why the fleet's fallback brain could not start, and how to prove it can

The JS `ProviderFailoverProvider` hands every Codex refusal (usage limit, runtime banner) to
`cline-cli`, backed by each container's persisted `/app/output/global-config.json`
(`actModeApiProvider` / `actModeApiModelId`). That is the only settings-driven brain the fleet has
for tickets, schedules and agentic runs; chat alone has the ADR-127 hosted-brain retry. When the
fallback cannot start, every ticket that fails over lands in `escalated` with
`manifest_worker_dispatch_failed`.

## What was measured (2026-09-17)

On a real ticket dispatched to `oshal-local-general-bot` at 22:57Z:

```
Codex CLI error ... You've hit your usage limit ... try again at Sep 20th, 2026 5:15 AM
Provider failover failed (provider_runtime_failure). primary=openai-codex; fallback=cline-cli
spawnSync /usr/local/lib/node_modules/cline/bin/.cline ENOENT
Cline CLI exited with code 1
```

The file the launcher reports as missing exists:

```
$ docker exec oshal-local-general-bot ls -la /usr/local/lib/node_modules/cline/bin/
-rwxr-xr-x  .cline   151320896   (ELF 64-bit, PT_INTERP /lib64/ld-linux-x86-64.so.2)
$ docker exec oshal-local-general-bot ls /lib64/ld-linux-x86-64.so.2
ls: /lib64/ld-linux-x86-64.so.2: No such file or directory
$ docker exec oshal-local-general-bot cat /etc/os-release | head -1
NAME="Alpine Linux"
```

`cline@latest` floated from the pure-JS 2.x line (`bin: dist/cli.mjs`, node >= 20) onto 3.x
(published 2026-05-12), whose npm package resolves to `@cline/cli-linux-x64` — a Bun-compiled
**glibc** executable. There is no musl build. On `node:20-alpine` the kernel cannot find the program
interpreter named in the ELF header and reports that as `ENOENT` on the binary itself, which the
launcher prints verbatim. Nothing in the build or the deploy ran the launcher, so no gate went red.

With the binary starting (see the hot-fix below) the first failed-over ticket at 23:16:33Z died a
second way:

```
[ClineCLI] Using model (via -m flag): gpt-5.5
[ClineCLI]   config.json: provider=gemini, model=gemini-3.8-flash
models/gpt-5.5 is not found for API version v1beta
```

`ClineProvider` was constructed with the fleet default (`LLM_MODEL`, the Codex primary's model)
and passed it to `-m` while the wrapper had already resolved the backing provider to gemini. Both
defects are fixed in the same change; see the change logs in `Dockerfile.oshal` and
`any-bot/server/services/llm/ClineProvider.js`.

## The fix, and what proves it

- `Dockerfile.oshal` pins cline (`ARG CLINE_VERSION`) and installs the `gcompat` loader stub
  **confined** to the glibc executable: only `/lib64/ld-linux-x86-64.so.2` and
  `/lib/libgcompat.so.0` stay. The glibc aliases `apk` drops into `/lib` (`libc.so.6`,
  `libm.so.6`, `libpthread.so.0`, ...) are removed, because they let a node process `dlopen`
  glibc-only native addons it correctly refuses today (the SEGFAULT class the onnxruntime note in
  the Dockerfile warns about). Measured on the shipped image: with the aliases present,
  `@msgpackr-extract/.../node.napi.glibc.node` LOADS in node; with only the stub in `/lib64` it is
  refused exactly as before, and `cline --version` still starts.
- The same layer asserts, inside the build, that no alias survived and that `cline --version`
  prints the pinned version through the real launcher. It uses no heredoc (a heredoc silently
  no-ops on the classic builder).
- `scripts/check-cline-entrypoint.mjs` runs the launcher inside an artifact and names the shape it
  finds. `scripts/oshal-deploy.sh` refuses an image that fails it, next to the kernel-skills probe,
  before any container is touched.

Run it by hand against the image that would ship, or against a running container:

```bash
node scripts/check-cline-entrypoint.mjs --image oshal-bot:latest
node scripts/check-cline-entrypoint.mjs --container oshal-local-general-bot
```

Exit 0 = the fallback starts. Exit 1 = it does not, and the line says why
(`glibc-binary-no-loader`, `binary-missing`, `glibc-symbols-unresolved`,
`unconfined-glibc-aliases` for an image that starts cline by polluting `/lib`, or the exit code and
first output line). Exit 2 = the probe could not run at all, which the deploy treats as a failure,
not a skip.

Measured against real artifacts the day this landed:

```
$ node scripts/check-cline-entrypoint.mjs --image oshal-bot:latest
cline entrypoint probe [image oshal-bot:latest] FAIL (glibc-binary-no-loader): the launcher reports
ENOENT on /usr/local/lib/node_modules/cline/bin/.cline, which EXISTS: it is a glibc executable and
/lib64/ld-linux-x86-64.so.2 is absent on this musl base ...
$ node scripts/check-cline-entrypoint.mjs --container cline-probe-tmp   # throwaway container carrying the new layer
cline entrypoint probe [container cline-probe-tmp] PASS (starts): cline 3.0.62 starts (confined gcompat loader)
```

## Operator hot-fix on a running box (until the next image deploy)

The running containers only change with an image deploy. Until then, the fallback can be made to
start in place, per container, without a restart. Apply the confined shape (same as the Dockerfile
layer); it survives until the container is recreated:

```bash
for c in $(MSYS_NO_PATHCONV=1 docker ps --filter ancestor=oshal-bot:latest --format '{{.Names}}'); do
  MSYS_NO_PATHCONV=1 docker exec "$c" sh -c '
    apk add --no-cache gcompat >/dev/null 2>&1 &&
    for a in libc.so.6 libm.so.6 libpthread.so.0 libresolv.so.2 librt.so.1 libutil.so.1 libcrypt.so.1; do rm -f "/lib/$a"; done &&
    rm -f /lib64/ld-linux-x86-64.so.2 && mv /lib/ld-linux-x86-64.so.2 /lib64/ld-linux-x86-64.so.2 &&
    cline --version' && echo "$c: ok" || echo "$c: FAILED"
done
```

Then prove it: `node scripts/check-cline-entrypoint.mjs --container <name>` for a sample. On
2026-09-17 a real Gemini task (`cline -P gemini -m gemini-3.8-flash --json -y --act ...`) completed
in a throwaway container carrying exactly this shape.

The second defect (the `-m` model) is source in `any-bot/server`, which is NOT bind-mounted into
the bot containers (checked with `docker inspect oshal-local-general-bot` on 2026-09-17: no
`any-bot` mount). It changes only with the image deploy. Until then a hot-fixed container still
sends the fleet model to the backing provider, so the hot-fix alone restores the binary, not the
tickets.

## What this does NOT prove

- That cline 3.x honours everything the wrapper writes to `~/.cline/data/globalState.json` and
  `~/.cline/config.json`: 3.x keeps its own `~/.cline/data/settings/providers.json` (observed on
  the box with `tokenSource: "migration"`, provider gemini, model `gpt-5.5` after the failed run).
  In the measured runs the provider was gemini and the model was whatever `-m` carried; the
  migration path itself is not exercised by any test here.
- That the loader stub keeps working across a cline bump: bump `CLINE_VERSION` deliberately and let
  the build assert tell you.
