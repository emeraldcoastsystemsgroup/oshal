/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Global search (new slice): the pluggable SearchSource adapter contract + the normalized SearchHit shape every adapter emits. Caller scoping is IN the contract (userSub is the first search argument) so an adapter that ignores it is visibly wrong at review time — the isolation model, not a convention.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | SearchHit gains a required `kind` (ticket/chat/app/connector/bot/doc/entity). `source` names the ADAPTER and is free to grow; `kind` names WHAT the row is and is what a renderer switches on and what picks the deep-link builder. Making it required is deliberate: a new adapter cannot ship an untyped, unlinkable row by omission.
 */

import type { SearchHitKind } from './deep-link';

/**
 * @description One normalized result row from any search source. Every adapter maps its native
 * rows into this shape so the merge layer can rank/interleave without knowing the store.
 */
export interface SearchHit {
  /** Native id of the underlying record (ticket_id, task_id, entity id, chunk id, ...). */
  id: string;
  /** Human title of the hit (ticket title, chat task title, entity label, doc title). */
  title: string;
  /** Short excerpt around the match — already trimmed by the adapter. */
  snippet: string;
  /**
   * What this row IS, independent of which adapter produced it. Drives the typed row renderer
   * and selects the deep-link builder. See {@link SearchHitKind}.
   */
  kind: SearchHitKind;
  /**
   * Canonical cockpit deep link for the record, minted by `deepLinkFor(kind, id)` — NEVER a
   * hand-formatted path. `null` ONLY for a kind registered in `NO_SURFACE_REASON` with its reason;
   * an unexplained null is a bug the deep-link guard fails on.
   */
  url: string | null;
  /** Source-native relevance score. NOT comparable across sources until normalized by the merge. */
  score: number;
  /** Adapter name this hit came from (matches SearchSource.name). */
  source: string;
  /** ISO timestamp of the underlying record (used for recency weighting), or null when unknown. */
  ts: string | null;
}

/**
 * @description Optional caller attributes beyond the sub — some stores (permission-aware RAG)
 * grant on email/domain/tenant groups, not just ownership. Adapters that only need the sub
 * ignore this entirely.
 */
export interface SearchCallerExtras {
  /** The caller's verified email (lowercased), when the session carries one. */
  email?: string | null;
  /** Whether the caller is a platform operator (env allowlist — see shared/middleware/authz). */
  isOperator?: boolean;
  /** Group handles the caller carries (tenant:<id>, source-ACL groups, token roles). */
  groups?: string[];
}

/**
 * @description A pluggable search source. CRITICAL ISOLATION CONTRACT: every implementation MUST
 * scope its reads to `userSub` (explicit owner column filter, owner-keyed store handle, or a
 * permission context built from the caller) — the api pool's GUC/RLS wrapper is the backstop,
 * never the only line. Returning another user's rows is a security bug, not a ranking bug.
 */
export interface SearchSource {
  /** Stable adapter name — used in the `sources=` route filter and stamped on each hit. */
  readonly name: string;
  /**
   * @description Run a caller-scoped search against this source.
   * @param userSub - The authenticated caller's OIDC sub. NEVER trusted from a request body.
   * @param query - Raw user query text (adapters escape for their own store).
   * @param limit - Max hits this source should return (the merge caps globally too).
   * @param extras - Optional caller attributes for permission-aware stores.
   * @returns Normalized hits, best-first by the source's native ranking.
   */
  search(userSub: string, query: string, limit: number, extras?: SearchCallerExtras): Promise<SearchHit[]>;
}
