# Local model serving (Ollama) — the `local-llm` profile

Ollama is a **provider, not a harness.** Bots reach it through the **Cline** harness, which resolves
`OLLAMA_HOST` (see `cline-config-builder.ts`). Nothing about the harness layer changes — only which
provider a bot points at.

Behind a compose profile, so the default stack is unchanged.

## Bring it up

```bash
docker compose -f docker-compose.oshal-local.yml --profile local-llm up -d oshal-ollama
docker compose -f docker-compose.oshal-local.yml --profile local-llm run --rm oshal-ollama-pull
```

The pull is a one-shot service that exits when the model is cached in the `oshal_ollama_models`
volume (pull once, survives stack recreation). Default model is `qwen2.5:0.5b` — small enough to
prove the path on a laptop. Override for real work:

```bash
OSHAL_OLLAMA_MODEL=llama3.1:8b docker compose -f docker-compose.oshal-local.yml \
  --profile local-llm run --rm oshal-ollama-pull
```

## Verify it actually answers

```bash
# from the host
curl -s http://127.0.0.1:11434/api/generate \
  -d '{"model":"qwen2.5:0.5b","prompt":"Reply with exactly: local swarm online","stream":false}'

# from inside the swarm network — this is the path the bots use
docker exec oshal-local-api sh -c \
  'curl -s http://oshal-ollama:11434/api/generate -d "{\"model\":\"qwen2.5:0.5b\",\"prompt\":\"hi\",\"stream\":false}"'
```

Both were verified live on 2026-07-08: the host call returned exactly `local swarm online`
(`eval_count: 4`), and the in-network call generated from `oshal-local-api`.

## Gotcha: an already-running container will NOT have `OLLAMA_HOST`

`OLLAMA_HOST` is declared on the shared bot env, but a container created *before* that declaration
keeps its old environment. Verified: `docker exec oshal-local-api sh -c 'echo $OLLAMA_HOST'` printed
nothing on the pre-existing container. `cline-config-builder.ts` then falls back to
`http://localhost:11434`, which inside a container points at the container itself — not Ollama.

Recreate the containers that need it (this bounces them, so pick your moment):

```bash
docker compose -f docker-compose.oshal-local.yml up -d --force-recreate --no-deps oshal-api
```

## Stop it without touching the rest of the stack

```bash
docker stop oshal-local-ollama          # `compose down` would take the WHOLE stack
```

## What this does and does not prove

- **Proven:** the service boots healthy, pulls a model, generates locally, and is reachable at
  `http://oshal-ollama:11434` — the hostname bots resolve.
- **Not yet:** a full swarm answering a real ticket with **zero cloud keys**, plus benchmarks. That
  needs a bot registered with provider `ollama` on the Cline harness and the containers recreated so
  they see `OLLAMA_HOST`. Tracked as Plan D in [BACKLOG.md](../BACKLOG.md); the site's
  "Packaged all-local profile" roadmap line stays on the roadmap until that is proven.
