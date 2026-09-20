# Workspace isolation: which of the four, and by when

**This entry exists to record a decision that has not been made.** The property below is measured
and pinned; what to do about it is the operator's call, and CKR-20's done-when (1) is not met until
one of the four options is named here.

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
