# Artifact exchange — per-application coverage

The ADR-139 "Send to…" rollout ran wave by wave, wiring whichever surfaces were in front of us.
This is the audit that was never done: **every** installed application, what artifact types it
registers, what it can be sent to, and which API endpoints do not exist yet.

Companion to [ADR-139](../adr/139-artifact-exchange-send-to-registry.md). The open work is tracked
in [BACKLOG.md](../BACKLOG.md) under the `ADR-139` entries; this page is the inventory those
entries point at, so nobody has to re-derive it.

## How this was measured, and where the measurement lies

Counts here are derived from the store checkout, not typed by hand. Regenerate before trusting a
number — packages move.

```bash
# destinations: packages declaring an artifacts: block
grep -l "^artifacts:" */oshal-app.yaml | wc -l
# sources: packages carrying the standard tag
grep -rl "data-artifact-source\|data-artifact-blob" */tools/*.html | cut -d/ -f1 | sort -u
```

**Two heuristics that over-count, recorded because they cost a pass each.** A naive
`res.sendFile|res.download|Content-Disposition` scan reports ~26 packages "serving artifacts"; almost
all of those are the shared `serveFile(surfaceDir, fileName)` helper handing back the package's own
tool HTML. And `type="file"` in a surface proves an upload control, not an exchange gap — the
packages that have one are already wired. Filter `sendFile` to arguments that are neither a literal
`.html` nor `surfaceDir`/`assetRoot`, and the real figure is **three**.

## Destinations — what each app accepts today

Eight packages declare an `artifacts:` block. Four kernel built-ins register the same way in code at
boot (ADR-139 D1), so they are not manifest-declared and never appear in the grep above.

| App | Action | Accepts | Mode | Endpoint |
|---|---|---|---|---|
| *kernel* | Email it… | `*/*` | overlay | `/api/artifacts/email-compose` |
| *kernel* | Save to OSHAL Storage | `*/*` | post | `/api/artifacts/builtin/save` |
| *kernel* | Ingest to RAG | pdf, `text/*`, docx | overlay | `/api/artifacts/rag-ingest` |
| *kernel* | Summarize with Jarvis | pdf, `text/*`, docx | overlay | `/api/artifacts/jarvis-summarize` |
| career-hunter | Add to Career profile | documents | post | `/api/career-hunter/artifacts/import` |
| dnd | Import as a D&D character | pdf, json | open | — |
| little-monsters | Ask the Tutor about it | `image/*`, pdf | open | — |
| portrait-studio | Restyle in Portrait Studio | `image/*` | open | — |
| presentations | Open in AI Office | office types | open | — |
| print-ingest | File in the print inbox | documents | post | `/api/print-ingest/documents/import-artifact` |
| spaces | Reconstruct in Spaces | `video/*` | post | `/api/spaces/scans/import-artifact` |
| youtube-kids | Ingest into Kid Lens | json | post | `/api/youtube-kids/import-artifact` |

**The destination side is in better shape than it looks.** Every package that already had a way to
take a file in is wired. The remaining destination work is not "wire up the stragglers" — it is
packages that need an ingest route built first, which is a package feature, not an exchange gap.

## Sources — what each app can send

Five packages carry the standard tag, plus the kernel files browser and (since ADR-139 Amendment D)
the task-explorer Files tab.

| App | Tagged surface | Produces |
|---|---|---|
| *kernel* | files browser | anything in the user's store |
| *kernel* | task-explorer Files tab | workspace text files (via mint-with-bytes) |
| career-hunter | board resume/cover, submission screenshots | pdf, docx, images |
| little-monsters | class materials, saved lecture audio | pdf, images, audio |
| presentations | My files | office types |
| venture-plan | exports | office types |
| video | cards | `video/*` |

## The gaps, named

### Sources that serve real bytes and are not tagged

Three, confirmed by reading the route rather than by grep count:

| App | The route | What it serves |
|---|---|---|
| storage | `res.download(path.join(LOCAL_ROOT, userKey(sub), dir, name), name)` | the user's own stored files, already owner-scoped |
| aero-lab | `res.download(path.join(record.dir, file), file)` | run artifacts |
| payroll | `Content-Disposition: attachment; filename="W2REPORT-<year>.txt"` (and a sibling) | generated payroll documents |

Each is the standard tag over a URL that already exists and is already owner-scoped. No new
endpoint, no new auth.

### Destinations that need a route built first

Four packages have an import route that was written for their own UI and could back an
`artifacts: accepts:` block with a small adapter — the `redeemArtifactViaRelay` shape that makes a
destination roughly thirty lines:

| App | Existing route | Would accept |
|---|---|---|
| marketing-engine | `/ingest`, `/campaigns/import` | documents, csv |
| payroll | `/returns/import` | documents |
| switchboard | `/import` | documents |
| video | `/shows/import` | `video/*` |

One package needs a route that does not exist at all:

| App | Missing | Why |
|---|---|---|
| lora | an owner-scoped image-ingest route | nothing accepts an image over HTTP; the dataset lives as a `<name>.png/.txt` folder on the GPU box (`LORA_BOX_DATASET`) |

### Deliberately out

- **RAG Center documents.** A retrieved corpus chunk is not a file, so what a handle would carry is
  an open product question, not a plumbing gap. Recorded in ADR-139 D4c.
- **Packages with no artifact surface.** Roughly half the store — a weather reader, a scoreboard, a
  game — genuinely has nothing to hand to another app. Absence here is correct, not debt.

## Done when

- The three untagged byte-serving sources carry the standard tag, one live dispatch each.
- The four adapter-shaped destinations either declare `accepts:` or are recorded here as
  deliberately out, with the reason.
- LoRA either has its ingest route and declares `accepts: [image/*]`, or the entry says why not.
- This page regenerates from the commands above and matches the tree.
