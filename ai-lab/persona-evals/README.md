# Persona regression evals (golden-task gate)

Personas (`ai-lab/bot-personas/*.yaml`) ARE the swarm's quality gate — but a persona edit used
to ship untested. Each `<persona>.yaml` in this directory is a **golden-task suite**: fixture
prompts fired at the persona *as deployed* (same `loadPersonaFromFile` lookup the bot nodes
use), with tiered assertions over the output.

## Running

```bash
# Noop lane (free, no LLM): proves the eval plumbing + runs the structural tier.
npx ts-node -r tsconfig-paths/register scripts/persona-eval.ts --persona email-summarizer

# All suites, full JSON report:
npx ts-node -r tsconfig-paths/register scripts/persona-eval.ts --persona all --json

# Real lane (the gate proper): same provider resolution as the runtime.
FORCE_LLM_PROVIDER=claude-code npx ts-node -r tsconfig-paths/register scripts/persona-eval.ts --persona career-advisor
```

Or via the operator-gated API on a running controller: `POST /api/persona-evals/run`
(`{"persona": "email-summarizer" | "all"}`, async — poll `GET /api/persona-evals/run/:runId`),
history at `GET /api/persona-evals/results`. Reports persist to `results/` here.

Exit codes: `0` all suites passed · `1` a suite failed/errored or a suite file is broken ·
`2` usage/config error.

## Honesty rules (read before authoring)

- **Structural** assertions are mechanically checkable NOW and run in every lane.
- **Semantic** (`rubric`) assertions need an LLM judge. Under the noop lane they are
  **skipped with notice** — never silently passed. A noop run proves plumbing, not quality,
  and the report's `laneNotice` says so.
- `artifact-exists` only evaluates when the lane captured a workspace (`--workspace <dir>`);
  otherwise it skips with notice.
- An all-skipped run is **not** a pass. An unparseable judge reply is an **error**, not a pass.
- No assertion may be authored so it trivially passes (e.g. matching text the fixture itself
  injects) — assertions encode the persona's *output contract*.

## Suite format

```yaml
persona: email-summarizer        # persona file name in ai-lab/bot-personas
description: one line on what this suite gates
tasks:
  - id: unique-task-id
    title: short human title
    prompt: |
      The fixture-ticket text sent to the persona.
    fixture: { any: structured-data }   # appended as an explicit FIXTURE DATA block
    assertions:
      - id: unique-assertion-id
        tier: structural            # or semantic
        type: contains              # see the vocabulary below
        value: "Thursday"
        description: WHY this encodes the persona's contract
      - id: quality
        tier: semantic
        type: rubric
        minScore: 75                # default 70
        rubric: >
          What a correct response looks like, for the judge.
```

Structural types: `contains` / `not-contains` (`value`, optional `caseInsensitive: false`),
`regex` / `not-regex` (`pattern`, optional `flags`), `json-parses`, `json-keys` (`keys`),
`citation-block` (doc_id provenance; optional `pattern` override), `artifact-exists` (`path`
relative to the workspace), `max-lines` (`max`), `min-words` (`min`).

Suites are validated strictly at load — a malformed assertion fails the run visibly instead
of executing as a weakened gate. Add a suite = add the YAML file here; it is auto-discovered.

Implementation: `src/features/persona-evals/` (runner, assertion engine, judge, results store);
routes in `src/app/routes/persona-eval-routes.ts`; unit tests in
`tests/unit/persona-eval-assertions.spec.ts`. Prior art: ADR-063 (AI Test Lab / golden loop) —
this gate is the persona-level sibling of that ticket-level loop.
