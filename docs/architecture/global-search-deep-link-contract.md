# Global search: the per-source deep-link contract, and what the trigram indexes actually bought

`/api/search` fans one caller-scoped query out to seven adapters and rank-merges the results. This
document is the contract for the two things a result row owes its reader: **what kind of thing it
is**, and **a URL that opens that exact record**.

Code: [`src/features/global-search/`](../../src/features/global-search/) ·
route [`src/app/routes/global-search-routes.ts`](../../src/app/routes/global-search-routes.ts) ·
surface [`src/api/global-search.html`](../../src/api/global-search.html) ·
guard [`tests/unit/global-search-deep-links.spec.ts`](../../tests/unit/global-search-deep-links.spec.ts).

## 1. Every hit carries a `kind`, and the `kind` picks the link

`SearchHit.kind` is **required**. It names what the row *is*, independently of which adapter
produced it — `source` names the adapter and is free to grow, `kind` is what a renderer switches on.
A hit's `url` is minted by `deepLinkFor(kind, id)` in
[`services/deep-link.ts`](../../src/features/global-search/services/deep-link.ts) and **never**
hand-formatted in an adapter. That is the whole mechanism: one file owns every URL shape, so adding
a surface parameter is a one-line change instead of a hunt through seven adapters, and the guard has
one place to check.

| kind | adapter (`source`) | deep link | what makes it resolve |
|---|---|---|---|
| `ticket` | `tickets` | `/cockpit/?ticket=<ticket_id>` | `readRequestedTicketId()` in [`app.js`](../../src/pages/cockpit/js/app.js) seeds `CockpitViewController.pendingTicketSelection`, which `TicketView` consumes as `initialSelectedTicketId` → `focusTicket` → detail pane loaded |
| `chat` | `chat` | `/chat?taskId=<task_id>` | [`chat-config-modal.mjs`](../../src/pages/chat/ui/chat-config-modal.mjs) adopts `?taskId` instead of minting a new task, so the conversation rehydrates |
| `app` | `apps` | `/cockpit/?app=<manifest name>` | the documented cockpit URL contract (`?app=` is the single source of truth — CLAUDE.md); `RibbonNav` shapes the ribbon and pre-filters tickets to the manifest's `ticketType` |
| `bot` | `bots` | `/cockpit/?agentId=<agent_id>` | `readPreferredSelectedAgentId()` in [`cockpit-persistence.js`](../../src/pages/cockpit/js/cockpit-persistence.js) prefers the query value over localStorage, so the cockpit opens with that bot selected |
| `connector` | `connectors` | `/utilities?connector=<provider>` | `/utilities` scrolls the matching connector card into view and highlights it |
| `doc` | `rag` | **none — declared** | see below |
| `entity` | `personal` | **none — declared** | see below |

### A null link is a declaration, not a gap

Before this contract, two adapters returned `url: null` and two returned a bare surface path
(`'/cockpit/'`, `'/chat'`). Both are failures of the same kind: the reader cannot tell a *deliberate*
absence from a *forgotten* link, and a bare path lands on the right screen with the wrong row — a
ticket hit from two years ago dropped the operator on an unfiltered board with no indication which
row it meant.

So `NO_SURFACE_REASON` is a registry with the reason attached, `deepLinkFor` resolves against it,
and `GET /api/search/sources` publishes it:

- **`doc`** — RAG chunks have no per-document cockpit surface. The Knowledge tab lists *collections*,
  not addressable documents, so a per-chunk URL would 404 the record it claims to open.
- **`entity`** — the personal-data vault (ADR-057) is owner-key encrypted with no browse surface;
  its entities are reachable only through the assistant, which takes no record parameter.

`deepLinkFor` is exhaustive over `SearchHitKind` via a `never` check, so adding a kind without either
a builder or a `NO_SURFACE_REASON` entry is a **compile error**, not an unlinked row discovered in
production.

### The contract is machine-readable

`GET /api/search/sources` returns `{name, kind, deepLink, noSurfaceReason}` per adapter. A surface
groups typed rows and explains an unlinked hit **from the API**, never from its own restatement of
the rules — that restatement is exactly what drifts.

## 2. Isolation: which layer owns the filter

Each adapter is handed the caller's sub as its first argument (the contract in
`search-source.ts`), and the api pool's GUC/RLS wrapper backstops the Postgres adapters. The three
adapters added with this contract each own their own visibility rule **in the adapter**, not in the
injected lister:

- **`apps`** — the lister returns *every* installed app with its `scope` + `ownerSub`; the adapter
  applies the same rule as `isVisibleToCaller` in `swarm-app-service.ts` (public → everyone, person
  → owner only, operator/tenant → operators only). `listApps()` is deliberately called with **no**
  caller argument: letting `SwarmAppService` pre-narrow would make two filters where only one can be
  audited, and neither would provably be the one in force.
- **`bots`** — bots are platform config, not user rows, so the question is *reach*, not ownership.
  The adapter applies ADR-087 `accessRoles` through the shared `roleCanAccess` helper against the
  caller's effective role: `operator` for operators, otherwise `jarvis` — the same user-facing
  delegation role `bot-node-execute-entitlement.ts` uses. Operator-only internal machinery
  (`project-manager`, `queue-bot`, `oshal-developer`, `security-analyst`, …) never appears in a basic
  user's results.
- **`connectors`** — `user_sub = $1` is the first predicate, and every uniqueness index on the table
  is `user_sub`-first. The `SELECT` list is a six-column allowlist; `access_token` and
  `refresh_token` are never named, so no snippet can carry ciphertext to a browser. The hit id is
  the `connection_id`, not the provider: migration `101-connections-multi-account` made a provider
  multi-account per user, and a provider-keyed id would let the merge's `source:id` dedupe collapse
  two Gmail accounts into one row. The deep link stays provider-keyed — `/utilities` focuses a
  provider CARD, which is the right landing place for any of its accounts.

## 3. What the pg_trgm indexes actually bought (measured)

Every adapter matches with `col ILIKE '%' || $q || '%'`. A leading wildcard makes a btree index
unusable, so the planner had exactly one option on those columns: sequential scan.
[`scripts/migrations/103-global-search-trgm.sql`](../../scripts/migrations/103-global-search-trgm.sql)
adds `gin_trgm_ops` indexes on the text columns the adapters actually search, plus composite
`(owner_sub, updated_at DESC)` btrees for the owner-first path.

Measured with
[`scripts/measure-global-search-latency.js`](../../scripts/measure-global-search-latency.js) —
a throwaway database it creates and drops on the configured server, issuing the adapters' exact
predicates. Postgres 16 (pgvector image), local Docker, median of the stated iteration count:

| scenario | tickets | chat (tasks ∪ messages) | connectors |
|---|---|---|---|
| 50 owners, 20 000 rows/table, n=25 | 3.83 → 3.61 ms (1.1×) | **38.53 → 3.46 ms (11.1×)** | 1.56 → 2.70 ms (0.6×) |
| 50 owners, 100 000 rows/table, n=15 | 12.30 → 7.15 ms (1.7×) | **215.32 → 5.41 ms (39.8×)** | 2.47 → 4.83 ms (0.5×) |
| 1 owner, 100 000 rows/table, n=15 | **154.45 → 1.39 ms (111.5×)** | 2.37 → 5.19 ms (0.5×) | 7.70 → 2.30 ms (3.3×) |

Reproduce:

```bash
node scripts/measure-global-search-latency.js --rows 100000 --iterations 15
node scripts/measure-global-search-latency.js --rows 100000 --iterations 15 --single-owner
```

### Reading these numbers honestly

**The trigram index is decisive on exactly one table, and it is not the one you would guess.**
`chat_messages` has no owner column — message hits are only reachable through an inner join to the
caller's own `chat_tasks` — so the text predicate has to be evaluated across the whole table. That
is where the 11.1× and 39.8× come from, and it is the case the backlog item was really about.

**Most of the tickets win is the composite btree, not the trigram.** `EXPLAIN` reports no trigram
index in the tickets plan in any scenario; the 111.5× in the single-owner case is
`idx_tickets_owner_sub_updated` letting the planner walk `updated_at DESC` and stop after `LIMIT 20`.
Calling that "the pg_trgm speedup" would have been the wrong lesson to record.

**Two cells are negative, and they stay in.** On a small table the planner sometimes picks the
trigram index and does slightly worse than a scan it could have finished anyway (connectors at
50 owners; chat in the single-owner case, where dense matches let `LIMIT 80` exit early). Both cost
1–3 ms on operations already under 8 ms, and both flip strongly positive in the other scenario —
connectors 3.3× once one owner holds thousands of connections, chat 39.8× on a shared box. The
indexes are kept because the shape that regresses is the shape that was already fast.

**The many-owner scenario is not the deployment shape here.** A single-operator box is the
`--single-owner` row: the owner filter selects everything, so the text side is all that is left to
index. Measuring only the multi-owner case would have retired an index a one-person deployment
depends on.

### Which columns, and which deliberately not

Indexed: `tickets.title`, `tickets.description`, `chat_tasks.title`, `chat_messages.text`,
`oshal_connections.provider`, `oshal_connections.account_email`.

Not indexed, on purpose: the **apps** and **bots** adapters match in memory over a catalog of tens
of rows with no store round-trip; the **rag** adapter ranks inside ChromaDB/pgvector and issues no
`ILIKE`; the **personal-data vault** is owner-key encrypted at rest, so SQL-side text matching is
impossible there by construction.

The migration is idempotent, guards every table with `to_regclass` (the chat and connection tables
are created by runtime schema bootstrap, not by a numbered migration, so they may legitimately not
exist yet on a first boot), and contains no `CONCURRENTLY` — `DatabaseBootstrapService` wraps each
migration plus its history row in one transaction, and `CONCURRENTLY` cannot run inside one.
