/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-100 Phase 2: open-asks query ("what has Ella asked me that I haven't followed up on") + status transition. Every ask is returned beside its verbatim source_quote and marked an inference — a follow-up is OSHAL's read, never presented as transcript fact.
 */

import type { Pool } from 'pg';
import { resolvePersonProfiles } from './recall-query';

/** One follow-up ledger entry, always carrying its verbatim source line. */
export interface PersonAsk {
  askId: string;
  kind: 'ask' | 'commitment';
  text: string;
  sourceQuote: string;
  status: 'open' | 'done' | 'dismissed';
  personLabel: string;
  createdAt: string;
  isInference: true;
}

/**
 * @description Returns the owner's open asks/commitments, newest first, optionally scoped to one
 * spoken person name. Each row carries the resolved person label and the verbatim source quote.
 * @param pool - GUC-aware pool.
 * @param ownerSub - Authenticated owner.
 * @param opts - Optional personName filter.
 * @returns Open asks (empty if a named person does not resolve).
 */
export async function getOpenAsks(pool: Pool, ownerSub: string, opts: { personName?: string } = {}): Promise<PersonAsk[]> {
  const params: unknown[] = [ownerSub];
  let personFilter = '';
  if (opts.personName && opts.personName.trim()) {
    const profiles = await resolvePersonProfiles(pool, ownerSub, opts.personName);
    if (profiles.length === 0) return [];
    params.push(profiles.map((p) => p.profileId));
    personFilter = `AND a.profile_id = ANY($${params.length}::uuid[])`;
  }
  const { rows } = await pool.query(
    `SELECT a.ask_id, a.kind, a.text, a.source_quote, a.status, a.created_at,
            COALESCE(asg.custom_name, m.display_name, 'Unidentified Person ' || p.unidentified_ordinal::text) AS person_label
       FROM ambient_person_asks a
       JOIN ambient_speaker_profiles p ON p.profile_id = a.profile_id AND p.owner_sub = a.owner_sub
       LEFT JOIN ambient_speaker_assignments asg ON asg.profile_id = a.profile_id AND asg.owner_sub = a.owner_sub
       LEFT JOIN oshal_tenant_memberships m
         ON asg.assignment_kind = 'tenant_member' AND m.tenant_id = asg.tenant_id AND m.user_sub = asg.member_sub
      WHERE a.owner_sub = $1 AND a.status = 'open' ${personFilter}
      ORDER BY a.created_at DESC`,
    params,
  );
  return rows.map((r) => ({
    askId: String(r.ask_id), kind: r.kind, text: String(r.text), sourceQuote: String(r.source_quote),
    status: r.status, personLabel: String(r.person_label), createdAt: new Date(r.created_at).toISOString(),
    isInference: true as const,
  }));
}

/**
 * @description Transitions an ask's status. Status is canonical USER state (never overwritten by
 * re-enrichment), so this is the only writer of it.
 * @param pool - GUC-aware pool.
 * @param ownerSub - Authenticated owner (scopes the update).
 * @param askId - The ask to update.
 * @param status - The new status.
 * @returns True if a row was updated (ownership-scoped).
 */
export async function updateAskStatus(
  pool: Pool, ownerSub: string, askId: string, status: 'open' | 'done' | 'dismissed',
): Promise<boolean> {
  const resolvedAt = status === 'open' ? null : new Date().toISOString();
  const { rowCount } = await pool.query(
    `UPDATE ambient_person_asks SET status = $3, resolved_at = $4 WHERE owner_sub = $1 AND ask_id = $2`,
    [ownerSub, askId, status, resolvedAt],
  );
  return (rowCount ?? 0) > 0;
}
