/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Global search: personal-data vault adapter — substring match over the caller's OWN decrypted entity labels/attrs via the per-user SQLite vault (owner-keyed handle + ownerSub-filtered reads, same pattern as personal-routes). Disabled PIS (ENABLE_PERSONAL_INTELLIGENCE unset) = clean logged skip, never fake data.
 */

import { createChildLogger } from '@/shared/logger';
import {
  SqliteVaultStore,
  readPersonalIntelligenceConfig,
  resolveVault,
  type PersonalIntelligenceConfig,
} from '@/features/personal-data';
import type { SearchHit, SearchSource } from './search-source';
import { buildSnippet } from './search-ranking';

const logger = createChildLogger({ module: 'global-search-personal' });

/**
 * @description Searches the caller's Personal Data Vault (ADR-057). Isolation: the vault file is
 * resolved from the CALLER's sub (resolveVault) and every read passes ownerSub — labels/attrs are
 * owner-key encrypted at rest, so a wrong-sub read can't even decrypt. Search is in-memory over
 * decrypted labels because at-rest encryption makes SQL-side text match impossible by design.
 * When the PIS is disabled the adapter logs once and returns [] — a clean skip, not fake data.
 */
export class PersonalDataSearchSource implements SearchSource {
  public readonly name = 'personal';
  private readonly config: PersonalIntelligenceConfig | null;
  private readonly store: SqliteVaultStore | null;
  private warnedDisabled = false;

  /**
   * @description Reads the PIS config once (env-gated, like personal-routes) and holds a vault
   * store only when the feature is enabled.
   * @param config - Optional config override (tests); defaults to the env-derived config.
   */
  constructor(config?: PersonalIntelligenceConfig | null) {
    this.config = config !== undefined ? config : readPersonalIntelligenceConfig();
    this.store = this.config ? new SqliteVaultStore() : null;
  }

  /**
   * @description Case-insensitive substring match over the caller's decrypted entity labels and
   * attribute values. Label matches outrank attr matches; the vault has no timestamps on
   * entities, so ts stays null and recency doesn't apply.
   * @param userSub - The caller's sub — the vault owner key AND the row filter.
   * @param query - Raw user query.
   * @param limit - Max hits to return.
   * @returns Caller-owned vault entity hits.
   */
  async search(userSub: string, query: string, limit: number): Promise<SearchHit[]> {
    if (!this.config || !this.store) {
      if (!this.warnedDisabled) {
        this.warnedDisabled = true;
        logger.info('personal-data source skipped — Personal-Intelligence Service disabled (set ENABLE_PERSONAL_INTELLIGENCE=true)');
      }
      return [];
    }
    try {
      const layout = resolveVault(this.config.storeRoot, this.config.tenant, userSub);
      const q = query.toLowerCase();
      const hits: SearchHit[] = [];
      for (const entity of this.store.getEntities(layout, userSub)) {
        const label = entity.label || '';
        const attrsText = Object.values(entity.attrs ?? {}).map((v) => String(v)).join(' ');
        const inLabel = label.toLowerCase().includes(q);
        const inAttrs = !inLabel && attrsText.toLowerCase().includes(q);
        if (!inLabel && !inAttrs) continue;
        hits.push({
          id: entity.id,
          title: label || `(${entity.type})`,
          snippet: buildSnippet(inLabel ? attrsText || label : attrsText, query) || entity.type,
          url: null,
          score: inLabel ? 1.0 : 0.6,
          source: this.name,
          ts: null,
        });
        if (hits.length >= limit) break;
      }
      return hits;
    } catch (err) {
      logger.error({ err, stack: (err as Error).stack }, 'personal-data search failed');
      return [];
    }
  }
}
