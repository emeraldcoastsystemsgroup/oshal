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

The 2026-09-29 census of store main `fec688f4` finds **13 packages** declaring an `artifacts:`
block, all with `accepts:`: **14 actions**, because Little Monsters declares two. These are
manifest declarations, not a claim that every destination has an installed live receipt. Four
kernel built-ins register in code at boot (ADR-139 D1), separately from that manifest count.

| App | Action | Accepts | Mode | Endpoint |
|---|---|---|---|---|
| *kernel* | Email it… | `*/*` | overlay | `/api/artifacts/email-compose` |
| *kernel* | Save to OSHAL Storage | `*/*` | post | `/api/artifacts/builtin/save` |
| *kernel* | Ingest to RAG | pdf, `text/*`, docx | overlay | `/api/artifacts/rag-ingest` |
| *kernel* | Summarize with Jarvis | pdf, `text/*`, docx | overlay | `/api/artifacts/jarvis-summarize` |
| cad-studio | Open in CAD Studio | `model/stl`, `application/sla`, `application/vnd.ms-pki.stl`, `application/octet-stream` | open | — |
| career-hunter | Add to Career profile | documents | post | `/api/career-hunter/artifacts/import` |
| create | Add image layer in Create | png, jpeg, webp | open | — |
| dnd | Import as a D&D character | pdf, json | open | — |
| embodied | Fly it in Embodied | `application/vnd.oshal.embodied-scene+json` | post | `/api/embodied/world/scenes/import-artifact` |
| little-monsters | Ask the Tutor about it | `image/*`, pdf | open | — |
| little-monsters | File into a class | `image/*`, pdf | open | — |
| lora | Add to LoRA dataset | `image/*` | open | — |
| portrait-studio | Restyle in Portrait Studio | `image/*` | open | — |
| presentations | Open in AI Office | office types | open | — |
| print-ingest | File in the print inbox | documents | post | `/api/print-ingest/documents/import-artifact` |
| scan-to-print | Scan in Scan to Print | `image/*` | open | — |
| spaces | Reconstruct in Spaces | `video/*` | post | `/api/spaces/scans/import-artifact` |
| youtube-kids | Ingest into Kid Lens | json | post | `/api/youtube-kids/import-artifact` |

An `open` action navigates to the package surface with the owner-bound handle; it is not a
headless POST. LoRA's surface selects the named character before submitting the import below.

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

### LoRA — ingest built; portrait-gallery live receipt still owed

LoRA 1.7.3 declares `dataset-image` with `types: [image/*]` and `mode: open`.
`POST /api/lora/dataset/import` redeems the handle as the signed-in caller, stages the image
owner-scoped, and dispatches its import to the GPU worker's character-specific curated dataset.
The studio shows the import receipt; this is a built destination, not a missing HTTP route.

The recorded **2026-09-28 03:16 UTC inline-mode PASS** used LoRA 1.7.1 and the host script at
core `7f6ff07d`: the exact image/caption pair reached the worker in 3 seconds and cleanup completed.
That mode used an upload-minted handle and a bearer import, not the portrait gallery or rendered
LoRA page. On **2026-09-29**, `--gallery` against LoRA 1.7.3 returned **UNAVAILABLE** with
`portrait_cli_authorization_unavailable`; nothing was written. A successful portrait-gallery →
LoRA surface → worker receipt remains owed after an operator-selected usable image provider,
the installed packages and the GPU worker are available. See the separate mode receipts in the
[real-boundary audit](../governance/real-boundary-regression-audit.md).

### Deliberately out

- **RAG Center documents.** A retrieved corpus chunk is not a file, so what a handle would carry is
  an open product question, not a plumbing gap. Recorded in ADR-139 D4c.
- **Packages with no artifact surface.** Roughly half the store — a weather reader, a scoreboard, a
  game — genuinely has nothing to hand to another app. Absence here is correct, not debt.

## Continuing this

[artifact-exchange-continuation.md](../backlog/artifact-exchange-continuation.md) is the handover:
the mechanism in one pass, what was half-landed at handover (the Stage 4a picker and the Jarvis leg,
both since merged to `main` and deployed), the cheapest next moves, and the traps that make a naive
coverage count wrong.

## Done when

- The three untagged byte-serving sources carry the standard tag, one live dispatch each.
- The four adapter-shaped destinations either declare `accepts:` or are recorded here as
  deliberately out, with the reason.
- LoRA's owner-scoped ingest route and `image/*` acceptance are documented as built; the distinct
  portrait-gallery live proof remains tracked in BACKLOG, not inferred from the inline receipt.
- This page regenerates from the commands above and matches the tree.
