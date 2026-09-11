# Government contracting CRM and contract management

Requested 2026-09-11. Status: planned application work. This expands the existing
[Capture CRM handover](capture-crm-plugin-open-work.md), with one durable record of the
relationship and process from opportunity intake through contract closeout.

Use the established Intelligent Sales interaction patterns for boards, record cards,
activities, assignments and follow-ups, adapted to capture and contract delivery. Detailed
package work belongs in the private application repository. The government-contracting
website is a view and intake channel over the same system, rather than another source of truth.

## Delivery scope

1. Reconcile existing capture, opportunity and sales packages before designing storage.
   Preserve identifiers, documents, ownership and process history. Record reuse and migration
   decisions; prove an idempotent dry-run before any live import.
2. Build shared organization/contact records for agencies, offices, buyers, primes, partners
   and subcontractors, with relationships, owners, activities and next actions.
3. Track intake, qualification, capture, bid/no-bid, proposal preparation, review, submission
   evidence, award/loss and debrief. Transitions record actor, time, evidence, decision and next
   owner. Configurable stage gates are enforced by the API.
4. Carry a won opportunity into a linked contract without losing capture history. Track task
   orders, modifications, funded/ceiling amounts, performance periods, options, deliverables,
   obligations, milestones and closeout.
5. Show upcoming decisions, deadlines, stalled work, missing evidence and obligations in a
   dashboard. Counts come from authorized records and link directly to them.
6. Register tagged Jarvis tools for authorized reads and drafts, with human approval for
   proposal submission, partner outreach, commitments and contract changes.
7. Import application permissions for capture, proposal, contract, finance and administration;
   own/team/organization scope, restricted pricing/documents and audited approvals.
8. Register AI Test Lab cases during installation: transitions, ownership, imports, dedupe,
   deadlines, approval refusal, audit and opportunity-to-contract continuity. Use synthetic
   opportunities/contracts, with no live submission or outreach.

## Done when

A synthetic opportunity travels from website intake through reviewed pursuit and award into
a managed contract, retaining relationships, activities, documents, decisions and obligations.
Two users prove different rights through screen, API and Jarvis. Restart/reinstallation
preserves records, repeated import creates no duplicates, and installed tests appear in AI
Test Lab with accurate runner status.

Phase one delivers relationship/capture management. Phase two adds post-award contract
management over the same records. Real-data migration, financial posting and external
submission/integration require separately scoped, reviewable work orders.
