# Package test catalogs

Installing an active package registers its declared test inventory in the AI Test Lab. Registration
does not execute local tests or grant permission to run them. Existing `smoke:` probes remain valid.

Add a capability dependency so a core that cannot load the catalog rejects the package:

```yaml
uses: [test-catalog]
testing:
  version: 1
  catalog: tests/test-lab.yaml
```

Example `tests/test-lab.yaml`:

```yaml
version: 1
cases:
  - id: package-readiness
    name: Package readiness
    purpose: Verify the installed package responds with its real readiness marker.
    level: integration
    runner: { kind: smoke, smoke: package-readiness }
    expected: [The existing smoke assertions pass.]
    prerequisites: []
    sideEffects: none
    isolation: { mode: none }
    limits: { timeoutMs: 15000 }
    installation: safe-smoke
  - id: image-workflow
    name: Image workflow behavior
    purpose: Verify image validation and the saved result using disposable fixtures.
    level: unit
    runner:
      kind: vitest
      scope: package
      files: [tests/image-workflow.spec.ts]
    expected: [Valid images produce a saved result., Invalid input is refused.]
    prerequisites: [runner:vitest]
    sideEffects: fixture-write
    isolation:
      mode: disposable
      fixtures: [tests/fixtures/image.json]
      cleanup: The suite removes its temporary directory on success and failure.
    limits: { timeoutMs: 30000, maxMemoryMb: 512 }
    installation: never
```

Every field above except `isolation.fixtures`, `isolation.cleanup`, and `limits.maxMemoryMb` is required.
IDs are lower-case slugs of at most 64 characters; each ID must be unique. Levels are `unit`,
`integration`, `browser`, or `live`. Approved runner names are `smoke`, `vitest`, `node-test`,
`playwright`, and `external`; a runner name is metadata, not an installed executable.

Local runner `files` and `isolation.fixtures` must be exact, existing package-relative files. Globs,
absolute paths, parent traversal and symlink paths are rejected. The catalog is limited to 256 KiB
and 256 cases; referenced files are limited to 8 MiB each and 32 MiB total. Referenced source bytes
participate in the case revision. `timeoutMs` permits 100–300000 and `maxMemoryMb` permits 16–4096.
Local runner limits are requirements for a future runner, not a claim that one has executed.

`expected` records the case's assertions without interpreting them as code. Prerequisites are stable
IDs such as `runner:playwright`, `account:microsoft`, `ai:configured`, or `device:camera`. Side effects
are `none`, `fixture-write`, `external-write`, or `device-action`. Fixture writes require `disposable`
isolation and a cleanup description; external effects require `live` isolation. These declarations
never authorize external actions.

A smoke reference must use its existing smoke name as its case ID. It decorates that smoke's
existing `app:<app>:smoke:<name>` entry, retaining its assertions and avoiding duplicate execution.
Other cases use `app:<app>:test:<id>`. Existing smoke names are reserved. Only a non-AI GET/HEAD
smoke with no extra prerequisites or side effects may declare `installation: safe-smoke`.
This field reports eligibility; installation retains its existing verification workflow.

Shared core coverage uses an explicit pinned revision rather than a sibling source checkout:

```yaml
runner:
  kind: playwright
  scope: core
  revision: 3f04ce734a4f631a3c821648261462a5eca84b30
  files: [tests/unit/artifact-dispatch-browser.spec.ts]
```

Core references require a full 40-character commit and paths under `tests/`. Core source files are
not assumed present on an installed controller. Their availability and matching revision must be
verified by a future approved runner. The catalog registers them as pending, even when similarly
named files happen to exist in the current checkout.

Each visible case includes its app, installed version, source fingerprint, content revision, runner,
prerequisites, side effects and isolation requirements. Source fingerprints come from installer
provenance, or the canonical package directory for local packages; raw filesystem paths and
repository credentials are not exposed. Stable case IDs remain the same across updates, while the
source/version/content tuple identifies the exact installed definition. A selected stale tuple cannot
execute. The Lab browser submits an `expectedCases` map of case IDs to revisions for single and
bulk runs; callers that omit it select the current catalog at request time. Reload replaces cases
atomically; disable/uninstall retracts them; code-free groups refer to visible member cases without
copying them. Group-owned catalogs remain outside this contract.

Only the existing safe smoke verifier is executable in this implementation. Local, core, browser,
external-action and additional-prerequisite cases remain visibly pending. Persisted result history,
installation report linkage, local suite execution and shared-core revision verification are separate
work orders; catalog registration does not claim they are complete.
