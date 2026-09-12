# Government contracting CRM and contract management

Requested 2026-09-11. Status: integrated CRM release installed on localhost;
the source-to-contract workflow has passing isolated acceptance. The application includes the mature CRM's
interconnected pages and permissions, in addition to its capture pipeline. This expands the existing
[Capture CRM handover](capture-crm-plugin-open-work.md), with one durable record of the
relationship and process from opportunity intake through contract closeout.

Use the established Intelligent Sales interaction patterns for boards, record cards,
activities, assignments and follow-ups, adapted to capture and contract delivery. Detailed
package work belongs in the private application repository. The government-contracting
website must use the same system for its views and intake channel.

The clarified scope includes a separately registered Federal CRM application with its own
focused `/?app=...` entry and theme, discoverable in the default application overview.
Preserve contacts/accounts, relationships, activities/calendar, search, saved views, imports,
reports/targets, documents, communication integrations, settings, administration and delegated
coverage. Reuse the existing CRM runtime; keep workspace data and settings isolated from
the original installation. The package's feature matrix and executable evidence are maintained
in its private repository.

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

The installed release includes a dedicated themed application, its default Home card and 20
connected destinations. It reuses the existing CRM runtime and carries source intake through
human qualification, canonical opportunities, retained proposal versions, reviewed award and
contract delivery. Synthetic HTTP/PostgreSQL and browser cases cover record continuity,
deduplication, evidence gates, exact ownership, workspace membership, current reader restrictions
and typed tools through the actual core registration and execution path.

Installation imports the named role catalog and registers the package's unit, integration and
browser suites. Every shipped CRM suite and the historical CRM baseline have explicit Lab
registration; browser/live prerequisites remain visible and do not execute during installation.
The private repository holds the feature matrix and detailed executable evidence.

Initial installed acceptance verified the default Home card, focused entry/theme, Users and
the imported Access catalog. It also confirmed that swarm administration alone did not grant
CRM business access. Later acceptance applied application roles through Access Administration
and completed a reviewed import of existing capture records and documents. Read-only checks
verified original source preservation, exact ownership, document hashes and duplicate-safe
recognition of the imported records. These are separate checkpoints from isolated workflow tests.

The linked-record historical deadline increment is implemented in source and has passing
isolated API, PostgreSQL and browser evidence; installed native acceptance is pending. A user
reviews an explicit future date/time before creating one follow-up task for an imported history
record linked to a canonical opportunity and organization. Current source, record and activity
permissions apply. Repeated confirmation reuses the same task, which appears in Activities and
Calendar and supports completion and reopening. Historical dates, source evidence and task
lineage are retained; general rescheduling and deletion/undo are not part of this increment.

## Remaining acceptance and integration

- Prove website-origin intake through the installed workflow. Source-import fixtures do not
  establish that website boundary.
- Complete installed native acceptance of the reviewed linked-record deadline workflow.
  Intake and no-bid histories without canonical linkage remain visibly unavailable for task
  conversion; their broader linkage and conversion workflow remains open. No historical date
  becomes a current task automatically.
- Add the unified view of upcoming decisions, deadlines and contract obligations; the linked
  tasks in Activities and Calendar do not complete that dashboard.
- Enable background email filing only with exact workspace and principal scheduling; it remains
  disabled for this application.
- Scope additional source adapters and mappings separately. Financial posting, external
  submission, outreach and live coordinator execution require their own reviewable work orders;
  they are not gaps in the implemented internal proposal, award or contract record lifecycle.
