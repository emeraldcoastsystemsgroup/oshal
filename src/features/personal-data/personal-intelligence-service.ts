/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-058 scaffold: Personal-Intelligence Service (private swarm service, not a registered bot)
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Preserve exact ownerSub identity through personal-vault resolution and every store call; nonblank validation and empty fallback remain fail-closed, while valid case/whitespace variants no longer collapse into another user's vault namespace.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Apply the shared exact-subject contract before vault resolution: nullish absence alone may use the configured default, while empty, malformed, control-bearing, and oversized assertions fail closed and all valid whitespace/case variants remain distinct.
 */

/**
 * Personal-Intelligence Service (ADR-058). The PRIVATE intelligence — NOT a registered/public bot.
 *
 * It is the ONLY holder of vault credentials, it is DETERMINISTIC (no LLM inside), and it scopes every
 * write to one ownerSub. Public bots *propose* (emit SchemaContribution / data-access intents); this
 * service *disposes* (resolve → sort-junk → dual-write) and brokers reads (ADR-056). Because it is a
 * service and not an agent, the router can't select it, chat can't reach it, and a prompt-injected bot
 * can't become it. Enabled by a START PARAMETER (ENABLE_PERSONAL_INTELLIGENCE); default params are
 * single-tenant (the operator's) for now.
 *
 * This is the SHAPE/contract. The VaultStore (real graph/vector/metric writes + entity resolution) is
 * injected and its implementation is deferred per the ADR.
 */
import type { Provenance } from './ontology';
import { resolveVault, type VaultLayout } from './vault';
import {
  type SchemaContribution,
  type EntityContribution,
  type EdgeContribution,
  type FactContribution,
  DEFAULT_CONTRIBUTION_FLOOR,
} from './schema-contribution';
import { requireExactUserSubject } from '@/shared/security/exact-user-subject';

/** Start-parameter config. The service does not read a manifest — it boots from these. */
export interface PersonalIntelligenceConfig {
  storeRoot: string;
  tenant: string;
  /** the operator's sub right now; the default owner for unscoped contributions. Set to null once multi-tenant. */
  defaultOwnerSub: string | null;
  contributionFloor: number;
}

/**
 * Read PIS config from start parameters. Returns null when the service is DISABLED (the gate).
 * Mirrors ENABLE_QUEUE_MANAGER / ENABLE_AGENT_SCHEDULER.
 */
export function readPersonalIntelligenceConfig(env: NodeJS.ProcessEnv = process.env): PersonalIntelligenceConfig | null {
  if (env.ENABLE_PERSONAL_INTELLIGENCE !== 'true') return null;
  return {
    storeRoot: env.PI_STORE_ROOT || env.JOBHUNTER_STORE_ROOT || '',
    tenant: env.PI_TENANT || 'default',
    defaultOwnerSub: env.PI_DEFAULT_OWNER_SUB || null,
    contributionFloor: Number(env.PI_CONTRIBUTION_FLOOR) || DEFAULT_CONTRIBUTION_FLOOR,
  };
}

/**
 * The deterministic store the PIS writes through — the only thing under vault credentials. Injected;
 * implementation deferred (graph/vector/metric + entity resolution). Every method is ownerSub-scoped.
 */
export interface VaultStore {
  /** Entity resolution: existing node id for this (type, match) or null. The make-or-break hinge. */
  resolveEntity(layout: VaultLayout, ownerSub: string, type: string, match: Record<string, string>): Promise<string | null>;
  upsertEntity(layout: VaultLayout, ownerSub: string, c: EntityContribution, prov: Provenance): Promise<{ id: string; merged: boolean }>;
  upsertEdge(layout: VaultLayout, ownerSub: string, fromId: string, toId: string, c: EdgeContribution, prov: Provenance): Promise<{ id: string }>;
  writeFact(layout: VaultLayout, ownerSub: string, entityId: string, c: FactContribution, prov: Provenance): Promise<void>;
}

export interface IngestResult { created: number; merged: number; dropped: number; edges: number; facts: number; }

export class PersonalIntelligenceService {
  constructor(
    private readonly config: PersonalIntelligenceConfig,
    private readonly store: VaultStore,
  ) {}

  /** No ownerSub + no default = refuse. Prevents the "everything lands in the operator's vault" footgun (ADR-058 risk 3). */
  private requireOwner(ownerSub?: string): string {
    const candidate = ownerSub ?? this.config.defaultOwnerSub;
    if (candidate === null || candidate === undefined) {
      throw new Error('PIS: no ownerSub and no default owner — refusing unscoped write');
    }
    return requireExactUserSubject(candidate, 'PIS ownerSub');
  }

  /**
   * Ingest a contribution: resolve → sort-junk (confidence floor + dedup) → dual-write. Deterministic.
   * One path for connector pulls AND bot reverberation (ADR-058 §3).
   */
  async ingest(contribution: SchemaContribution): Promise<IngestResult> {
    const ownerSub = this.requireOwner(contribution.ownerSub);
    const layout = resolveVault(this.config.storeRoot, this.config.tenant, ownerSub);
    const floor = this.config.contributionFloor;
    const out: IngestResult = { created: 0, merged: 0, dropped: 0, edges: 0, facts: 0 };

    // 1. Entities — resolve or mint; map local ref → real id so edges/facts can bind.
    const refToId = new Map<string, string>();
    for (const e of contribution.entities) {
      if (e.confidence < floor) { out.dropped++; continue; }                 // sort the junk
      const existing = await this.store.resolveEntity(layout, ownerSub, e.type, e.match);
      const r = await this.store.upsertEntity(layout, ownerSub, e, contribution.provenance);
      r.merged ? out.merged++ : out.created++;
      if (e.ref) refToId.set(e.ref, r.id);
      void existing; // resolution result is folded into upsert; kept explicit for the deferred impl
    }

    // 2. Edges — bind from/to via the ref map, else an existing id (scope-checked by the store).
    for (const edge of contribution.edges) {
      if (edge.confidence < floor) { out.dropped++; continue; }
      const fromId = refToId.get(edge.from) ?? edge.from;
      const toId = refToId.get(edge.to) ?? edge.to;
      await this.store.upsertEdge(layout, ownerSub, fromId, toId, edge, contribution.provenance);
      out.edges++;
    }

    // 3. Facts — math lives in the metric store, never in a prompt.
    for (const f of contribution.facts) {
      if (f.confidence < floor) { out.dropped++; continue; }
      const entityId = refToId.get(f.entity) ?? f.entity;
      await this.store.writeFact(layout, ownerSub, entityId, f, contribution.provenance);
      out.facts++;
    }

    return out;
  }
}

/** Factory — only construct the PIS when the start parameter enables it; null otherwise. */
export function createPersonalIntelligenceService(
  store: VaultStore,
  env: NodeJS.ProcessEnv = process.env,
): PersonalIntelligenceService | null {
  const config = readPersonalIntelligenceConfig(env);
  return config ? new PersonalIntelligenceService(config, store) : null;
}
