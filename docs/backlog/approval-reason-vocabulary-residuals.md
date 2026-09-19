# Two residuals from the approval-reason vocabulary (CKR-12)

Both found in review of the CKR-12 change, both **latent rather than live**, and both recorded here
rather than fixed there because neither is reachable from HTTP today.

## 1. The closed vocabulary is not actually closed

`APPROVAL_REQUIRED_REASONS` is described as a closed set, and every writer names a value from it.
But `updateStatus` does not validate what it is given:

```ts
await tickets.updateStatus(id, 'approval_required', { reason: 'totally made up free text' });
// stored verbatim
```

`nextAction` does fail closed — `approvalNextAction` returns `operator_review_required` for anything
it does not recognise — so an invented reason produces a *sane* next action with a *meaningless*
reason beside it. The badge problem CKR-12 solved does not come back, but the vocabulary's promise
is weaker than the word "closed" implies.

Not reachable from HTTP: `ticket-routes.ts` passes no transition metadata on either status route, so
every value that reaches this today comes from one of the five in-process writers. A guard covers
those. This is about the next writer, and about the word.

## 2. The same field lands under two different keys

On a **transition**, `buildTicketRowStatusMetadataPatch` writes the source as
`metadata.statusSource` (`ticket-status-row-metadata.ts`). On a **creation**, it is written straight
through as `metadata.source`.

So a consumer reading "which component put this ticket here" has to know which route the ticket took
to get there. Nothing reads it today, which is exactly why it is easy to leave wrong and expensive
to discover later.

## Done when

1. **`updateStatus` refuses a reason outside the vocabulary for `approval_required`**, or the
   documentation stops calling the set closed. Refusing is the smaller lie to maintain, but it is a
   behaviour change on a path the cockpit can reach — decide deliberately rather than by default.
   Proven by a case asserting an invented reason is rejected (or normalised), and by one asserting
   the five real ones still pass.
2. **One key for the source**, whichever it is, with the other mapped for anything already stored.
   Proven by a case that creates a ticket in the state and transitions another into it, then reads
   the same field name off both.
3. **`ApprovalRequiredReason` is what callers type against.** Today the metadata parameter is
   `TicketStatusMetadata = Record<string, unknown>`, so a typo in a reason is not a compile error —
   the source scan in `approval-required-reason.spec.ts` is the only thing that catches it, and it
   catches it by reading text. A typed metadata shape for this transition would move that check to
   the compiler, where it belongs.

## Scope note

Do not fold this into a change about something else. (1) alters what the service accepts and (2)
alters a stored key; both deserve to be the subject of their own diff, with their own guards, rather
than riding along in a PR whose title says something different.
