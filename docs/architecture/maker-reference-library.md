# The maker-reference library

*As-built, 2026-09-21.*

An open catalogue of builds other people have already solved mechanisms in, held in the
`maker-references` RAG collection so `animatronics-bot`, `small-motors-bot` and `robotics-bot`
can search it before answering a mechanism question and cite what they used.

Before this, that knowledge lived as persona prose with no sources: nothing could cite a build,
diff two approaches, or answer "has anyone solved this mechanism already". The survey behind
[ADR-156](../adr/156-animatronic-props-as-a-peripheral-kind.md) was recorded as a table in
[animatronic prop hardware](./animatronic-prop-hardware.md) §5 and stopped growing there.

## What a reference is

One document per build, with the same fields every time. A record missing any of them is refused
rather than written half-formed — a catalogue whose rows disagree about what they contain cannot
be diffed, and "what did this build use" is the question the bots ask of it.

| field | what it holds |
|---|---|
| `docId` | the citation id, `web:`-prefixed because the provenance is a public build (derived) |
| `title` | the build's name |
| `whatItIs` | one line: what the thing is |
| `mechanism` | the mechanism or subsystem worth reading it for |
| `actuators` | what moves it, named specifically (servo class, motor type, tendon) |
| `controller` | the board and how it is commanded |
| `licence` | as stated by the source, or the explicit `unknown` marker |
| `reuse` | `allowed` or `not-to-copy` (derived from the licence — never typed) |
| `sourceUrl` | where it lives |
| `takeaway` | what a reader takes from it |
| `addedOn` | when it was recorded |
| `licenceNote` | optional: what the licence actually constrains |

Records live in [`ai-lab/maker-references/`](../../ai-lab/maker-references) as one YAML file per
build. **Nothing from a build is vendored** — no code, no geometry, no copied prose. A record is
our own structured description plus the URL.

## Adding one

One command against a URL and a note:

```bash
node scripts/maker-reference.mjs add https://github.com/simplefoc/Arduino-FOC \
  --note "FOC is a library, not a board: a small motor gets smooth torque control from the MCU already running the rig." \
  --title "SimpleFOC (Arduino-FOC)" \
  --what "An open field-oriented-control library for brushless and stepper motors." \
  --mechanism "Closed-loop torque, velocity and position control of a BLDC, with a position sensor in the loop." \
  --actuators "BLDC gimbal and hobby outrunner motors,bipolar stepper motors" \
  --controller "Arduino-compatible MCU driving a DRV8302 or L6234 class gate driver" \
  --licence "MIT"
```

The `docId` is a pure function of the URL (scheme, `www.`, trailing slash and case are all
normalised away), and the record's filename is derived from the `docId` — so **running the same
command again updates that one record** instead of minting a second. `--licence-note` records what
a licence actually constrains; `--no-copy` tightens the posture for a build that is permissively
licensed but should still not be copied.

`node scripts/maker-reference.mjs list` prints the catalogue with each build's posture, and
`render <doc_id|url>` prints the exact document the collection holds.

## The licence rule

`reuse` is **derived from the licence text, never declared by the caller**. A non-commercial, a
no-derivatives, a proprietary or source-available licence, and an unknown or unstated one, all
produce `not-to-copy`; anything else produces `allowed`. A hand-edited record that claims
`allowed` under a licence that forbids it is refused at load, so the catalogue cannot silently
launder code. The unknown marker is deliberately in the refusing set: a build whose licence nobody
has established is treated exactly like one that forbids reuse until someone establishes it.

A `not-to-copy` build is still a first-class reference — cited, reasoned from, argued with. Its
rendered document leads with a **NOT TO COPY** banner naming the licence, and the personas are
required to say which posture a build carries when they cite it.

## Ingesting it

```bash
node scripts/maker-reference.mjs ingest            # rebuild the collection from the catalogue
node scripts/maker-reference.mjs ingest --dry-run  # print what would be ingested, touch nothing
```

`ingest` **drops the collection and rebuilds it** rather than appending. That is not tidiness:
`POST /api/rag/ingest` mints a timestamped chunk id per chunk, so ingesting the same build twice
leaves two copies in the store and a bot may cite the stale one. Rebuilding makes the collection a
pure function of the records on disk.

`OSHAL_API` selects the API (default `http://127.0.0.1:35457`). `/api/rag` is auth-gated, so a
run against a deployed box carries the operator's own session in `OSHAL_API_COOKIE` (or a bearer
token in `OSHAL_API_TOKEN`); an unauthenticated run reports the HTTP status rather than
pretending to have ingested.

## How the bots use it

All three personas carry the same block: search
`/api/rag/search?q=<terms>&collection=maker-references&topK=5` **before** answering a mechanism,
actuator-choice or control-scheme question; carry the hit's `web:`-prefixed `doc_id` in a citation
block for anything taken from it; say which reuse posture a cited build carries; and report an
empty search as empty — never invent a build, a URL or a licence.

**An uncited answer fails review.** That is enforced, not just asserted: each of the three
personas has a golden-task suite in [`ai-lab/persona-evals/`](../../ai-lab/persona-evals) whose
citation task carries a structural `citation-block` assertion on a `web:`-prefixed id, plus a
`not-regex` that fails any `doc_id` outside the catalogue's `web:` namespace.
`tests/unit/maker-reference-library.spec.ts` runs those real assertions from the real suites
against two answers that differ only in whether the provenance is present: the cited one passes
every structural assertion, the uncited one fails, and the test names `has-citation-block` as the
assertion that separates them.

## Guards

`tests/unit/maker-reference-library.spec.ts` covers the four things that rot silently:

- the catalogue's fixed field set — every committed record validates, and a record missing any one
  required field is refused;
- the reuse posture being derived — a caller cannot declare a CC BY-NC build copyable, and a
  hand-edited record that does is refused at load;
- ingest being a rebuild — driven over a real HTTP server speaking the two RAG endpoints, a second
  run still leaves one document per build, and the `DELETE` is observed to come first;
- the review — the three personas carry the search-and-cite block, their suites load, and an
  uncited answer fails their own citation assertions.

## What is not done here

The collection has not been ingested into the reference box's running RAG store. `/api/rag` is
auth-gated and an unattended lane holds no operator session; the command reports the HTTP status
it got rather than claiming a store it never wrote. Running `ingest` with `OSHAL_API_COOKIE` set
from an operator browser session is what closes that, and a Test Lab scenario that probes the
collection should be registered at the same time — a scenario that goes red because nobody has
ingested yet is a red gate nobody can act on.
