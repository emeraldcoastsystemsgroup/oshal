# Workspace isolation: which of the four, and by when

**DECIDED 2026-09-20: option 4 — accept it deliberately.** Per-ticket runtime assignment is the
control on this box; the container mount stays whole-volume. The reasoning, the two triggers that
reverse it, and the demonstration that the exposure is real are at the bottom of this entry, and the
decision is also recorded in [../BACKLOG.md](../BACKLOG.md) where ADR-060's four items are quoted
verbatim beside it.

The property below is measured and pinned. It was written while the decision was open, and is kept
as written.

## The property, measured 2026-09-19

Against the **resolved** `docker-compose.oshal-local.yml` (the mounts arrive through a `<<:` merge,
so a regex cannot see them):

```
services mounting oshal_workspace : 40
  of which :rw                    : 40
  of which carry a subpath        : 0
bot-anchor inheritors             : 39   (oshal-api is itself one)
mounting set                      : inheritors + code-server, exactly
```

Every container that runs bot work sees every ticket's and every owner's working directory as a
sibling on one read-write mount. `ADR-060` already records the consequence: *"a layout on a shared
read-write mount is not [a boundary]"*.

The TypeScript file tools cannot escape their directory. **`execute_command` can** — it runs an
arbitrary command with cwd set to the task directory and nothing below it, and
`runtimeToolMatchesCapabilities` short-circuits to `true` for anything in
`CORE_RUNTIME_TOOL_NAMES`, which contains `execute_command`. So a persona's declared capabilities do
not gate the shell, whatever the YAML says. `tests/unit/compose-workspace-mount-posture.spec.ts`
pins all of this, including that short-circuit, so a reader cannot repeat the belief that the YAML
is the control.

**Nothing observable has happened.** This is a property, not an incident, and the box is
single-operator today.

## The options, verbatim from ADR-060 item 3

> per-owner subpath mounts, per-owner volumes, or a filesystem jail per bot container.

And a fourth, which is **this backlog's addition and not ADR-060's**: accept the risk deliberately
for a single-operator deployment. ADR-060 supports tracking it as backlog rather than as a security
gap — *"Track it as backlog, not as a security gap"* — but "accept it" is not one of the three it
lists, so choosing it should be an explicit act rather than the default that happens by not
choosing.

| # | option | what it costs |
|---|---|---|
| 1 | per-owner **subpath mounts** | a compose change per bot; Docker Engine 26+ for `volume.subpath`; the smallest diff of the three real ones |
| 2 | per-owner **volumes** | volume lifecycle per owner — creation, cleanup, backup — and a bigger change to how workspaces are provisioned |
| 3 | a **filesystem jail** per bot container | the strongest, and the most work: it changes the container contract, not just the mount |
| 4 | **accept, deliberately** | nothing to build. Requires this entry to say so, with a date and a condition that would reopen it — "when a second human gets an account" is the obvious one |

## Done when

1. **One of the four is named here**, with the reasoning and — if it is option 4 — the condition
   that reopens it. This is the operator's decision and the only reason this entry is open.
2. **A two-container traversal proof** exists: a marker file in ticket A's workspace and a proof
   that ticket B cannot read it through `execute_command`. Note for whoever builds it:
   `ToolExecutorService` is constructed in the CONTROLLER (`app-runtime-factory.ts`), not on the
   bot-nodes, so the proof has to exercise the path that actually runs the shell. Under option 4
   this becomes the opposite proof — a recorded demonstration that it CAN, so the accepted risk is
   documented rather than assumed.
3. The posture spec is updated in the same change, deliberately. It currently asserts 40 `:rw`
   mounts with no subpath; options 1-3 all break that on purpose, and the assertion failing is the
   signal that the work landed.

## Scope note

Do not "fix" the posture spec by loosening it. It asserts today's reality so that a change is
visible; if it goes red, either the isolation work landed (update it, deliberately, in that change)
or something moved that nobody intended.


---

## The decision, 2026-09-20

**Option 4: accept, deliberately.** In the operator's own words, and the code matches every clause
of it: a bot is nothing until it is called; when it is called the kernel hands it a workspace bound
to the ticket; the mount is a set of folders, one per ticket; the workspace is not visible to end
users; bots reach it only by holding a ticket, and tickets are user-based.

**The one distinction this entry exists to record.** Assignment is per ticket and per run.
Containment is not: each of the forty bot services declares the same
`oshal_workspace:/app/workspace-shared:rw`, so the process can see sibling ticket folders even
though it is pointed at one.

**⛔ The two triggers that reverse it:** a second person with tickets on this box, or an installed
store package running its own bot. Either turns cross-ticket reach into something the operator has
not accepted.

## Done-when (2), in its inverted form

The entry itself anticipated this: *"Under option 4 this becomes the opposite proof — a recorded
demonstration that it CAN, so the accepted risk is documented rather than assumed."*

`tests/unit/workspace-cross-ticket-traversal.spec.ts` is that demonstration. It drives the REAL
`ToolExecutorService.handleExecuteCommand` — the path that actually runs the shell, and the one the
note above points at, since the service is constructed in the CONTROLLER rather than on the
bot-nodes. Five cases:

1. a self-check that the service really rooted itself where the case put it, so nothing below can
   pass for the wrong reason;
2. a shell pointed at ticket B reads ticket A's deliverable — the accepted risk, in one line;
3. the TypeScript `read_file` tool **cannot** do the same thing, which is the distinction the
   decision rests on: if that case ever goes red the containment guard has regressed and the posture
   is worse than this entry records, which is a different finding from the one being accepted;
4. runtime assignment IS the control — the shell starts in the ticket it was given;
5. the reach crosses a directory belonging to a different owner, which is what makes trigger 1 a
   measured fact rather than a prediction.

**What it deliberately does not assert:** that the containers share a mount.
`tests/unit/compose-workspace-mount-posture.spec.ts` proves that against the resolved compose. The
two halves together are the claim — one shared read-write mount, and a shell that traverses within
it — and neither is worth much alone.

Done-when (3) does not apply under option 4: the posture spec still asserts 40 `:rw` mounts with no
subpath, because that is still true. It is options 1-3 that break it on purpose.
