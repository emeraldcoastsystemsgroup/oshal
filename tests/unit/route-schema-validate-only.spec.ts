import { afterEach, describe, expect, it, vi } from 'vitest';
import { ensureContentSchema } from '../../src/app/routes/content-routes';
import { ensureConnectionsSchema } from '../../src/app/routes/connectors-routes';
// (ensureEmailSchema import removed: email-summarizer carved to the app store, ADR-085
//  Wave 3 — oshal_email_digests is app-owned lazy DDL and the packaged route validates it.)
import { ensureFeedsSchema } from '../../src/app/routes/feeds-indexing';
import { ensureFreeTierSchema } from '../../src/app/routes/free-tier-rotation';
import { ensureSecuritySchema as ensureSecuritySchemaForThrow } from '../../src/app/routes/security-routes';
import { ensureInboxSchema } from '../../src/app/routes/inbox-ingest';
import { ensureJarvisSchema } from '../../src/app/routes/jarvis-routes';
import { ensureSecuritySchema } from '../../src/app/routes/security-routes';
import { ensureStoragePrefsSchema } from '../../src/app/routes/storage-target';
// (ensureTradingSchema import repointed with the trading engine extraction, ADR-085 pre-carve:
//  the schema bootstrap is ENGINE and lives in app/trading-schema.ts — the dispatch/reconcile
//  loops await it, so it stays kernel when the trading surface carves.)
import { ensureTradingSchema } from '../../src/app/trading-schema';
import { VisualResponseService } from '../../src/features/visual-response';

const ROUTE_SCHEMA_COLUMNS: Record<string, string[]> = {
  oshal_connections: [
    'connection_id',
    'user_sub',
    'user_email',
    'provider',
    'account_email',
    'account_id',
    'scopes',
    'access_token',
    'refresh_token',
    'expiry',
    'status',
    'created_at',
    'updated_at',
    'tenant_id',
    'connected_by_sub',
    'label',
    'account_key',
    'is_default',
  ],
  oshal_user_deks: ['user_sub', 'wrapped_dek', 'created_at'],
  oshal_tenants: ['tenant_id', 'kind', 'name', 'created_by_sub', 'created_at'],
  oshal_tenant_memberships: ['tenant_id', 'user_sub', 'role', 'created_at'],
  oshal_content_topics: ['user_sub', 'cards', 'focus', 'generated_at'],
  oshal_content_drafts: ['id', 'user_sub', 'topic', 'take', 'draft', 'created_at'],
  oshal_content_focus: ['user_sub', 'focus', 'updated_at'],
  oshal_content_settings: ['user_sub', 'email_social_scan', 'updated_at'],
  oshal_content_articles: [
    'user_sub',
    'url',
    'title',
    'source',
    'matched',
    'score',
    'published_at',
    'first_seen',
    'last_seen',
    'dismissed',
    'dismissed_at',
  ],
  // (oshal_email_digests removed: email-summarizer carved to the app store, ADR-085 Wave 3 —
  //  the packaged route validates its own lazy schema, with owner-RLS appended.)
  feed_messages: [
    'user_sub',
    'source',
    'channel_id',
    'channel_name',
    'channel_type',
    'author_id',
    'author_name',
    'text',
    'ts',
    'posted_at',
    'sentiment',
    'sentiment_label',
    'sentiment_at',
    'indexed_at',
  ],
  feed_settings: [
    'user_sub',
    'poll_enabled',
    'poll_interval_minutes',
    'max_channels',
    'per_channel',
    'sentiment_enabled',
    'last_synced_at',
    'created_at',
    'updated_at',
  ],
  // (oshal_finance_* removed: finance carved to the app store, ADR-085 —
  //  the packaged route validates its own lazy schemas.)
  oshal_free_tier_state: ['connection_id', 'cooldown_until', 'last_used_at', 'last_status', 'updated_at'],
  oshal_inbox_messages: [
    'user_sub',
    'msg_id',
    'thread_id',
    'from_addr',
    'subject',
    'snippet',
    'category',
    'received_at',
    'ingested_at',
    'source',
    'assessed',
  ],
  oshal_inbox_cursor: ['user_sub', 'last_received_at', 'last_run'],
  jarvis_tasks: [
    'id',
    'user_sub',
    'session_id',
    'title',
    'status',
    'result',
    'error',
    'kind',
    'ticket_id',
    'delivered',
    'created_at',
    'finished_at',
  ],
  visual_response_artifacts: [
    'artifact_id',
    'user_sub',
    'source_surface',
    'source_session_id',
    'source_job_id',
    'mime_type',
    'width',
    'height',
    'alt_text',
    'content',
    'content_sha256',
    'provenance',
    'created_at',
  ],
  // (oshal_merchant_payments removed: payments carved to the app store, ADR-085 —
  //  the packaged route validates its own lazy schema.)
  // (oshal_presentations removed: AI Office carved to the app store, ADR-085 Wave 2 —
  //  the packaged route validates its own lazy schema.)
  oshal_security_scans: [
    'scan_id',
    'user_sub',
    'kinds',
    'status',
    'finding_count',
    'new_count',
    'summary',
    'error',
    'started_at',
    'finished_at',
  ],
  oshal_security_findings: [
    'finding_id',
    'user_sub',
    'category',
    'severity',
    'title',
    'detail',
    'source',
    'evidence',
    'fingerprint',
    'status',
    'assessment',
    'assessed_at',
    'ticket_id',
    'first_seen',
    'last_seen',
  ],
  oshal_storage_prefs: [
    'user_sub',
    'code_provider',
    'code_repo',
    'code_folder',
    'files_provider',
    'files_folder',
    'files_repo',
    'updated_at',
  ],
  oshal_trading_signals: [
    'signal_id',
    'user_sub',
    'mode',
    'source',
    'external_id',
    'author',
    'url',
    'title',
    'body',
    'symbols',
    'indicators',
    'content_hash',
    'observed_at',
  ],
  oshal_trading_decisions: [
    'decision_id',
    'user_sub',
    'mode',
    'signal_ids',
    'agent_id',
    'action',
    'symbol',
    'side',
    'qty',
    'order_type',
    'limit_price',
    'confidence',
    'rationale',
    'indicators',
    'guardrails',
    'created_at',
    'stop_price',
    'trail_price',
    'trail_percent',
    'time_in_force',
  ],
  oshal_trading_orders: [
    'order_id',
    'user_sub',
    'mode',
    'decision_id',
    'broker',
    'broker_order_id',
    'client_order_id',
    'symbol',
    'side',
    'qty',
    'order_type',
    'limit_price',
    'status',
    'raw_status',
    'filled_qty',
    'filled_avg_price',
    'realized_pnl',
    'reject_reason',
    'submitted_at',
    'created_at',
    'updated_at',
    'stop_price',
    'trail_price',
    'trail_percent',
    'time_in_force',
  ],
  oshal_trading_predictions: [
    'prediction_id',
    'user_sub',
    'mode',
    'symbol',
    'algo',
    'pred_dir',
    'confidence',
    'price',
    'basis',
    'horizon_hrs',
    'resolved',
    'actual_dir',
    'actual_price',
    'hit',
    'created_at',
    'resolved_at',
  ],
  // (oshal_youtube_activity removed: youtube-kids carved to the app store, ADR-085 —
  //  the packaged route validates its own lazy schema.)
};

function makeCatalogPool(columns: Record<string, string[]> = ROUTE_SCHEMA_COLUMNS) {
  return {
    query: vi.fn(async (text: string, params?: unknown[]) => {
      if (text.includes('to_regclass')) {
        const table = String(params?.[0] || '').replace(/^public\./, '');
        return { rows: [{ exists: Object.prototype.hasOwnProperty.call(columns, table) }], rowCount: 1 };
      }
      if (text.includes('information_schema.columns')) {
        const table = String(params?.[1] || '');
        const column = String(params?.[2] || '');
        const exists = (columns[table] || []).includes(column);
        return { rows: exists ? [{ column_name: column }] : [], rowCount: exists ? 1 : 0 };
      }
      return { rows: [], rowCount: 0 };
    }),
  };
}

async function withValidateOnly(run: () => Promise<void>) {
  const previous = process.env.OSHAL_SCHEMA_BOOTSTRAP;
  process.env.OSHAL_SCHEMA_BOOTSTRAP = 'validate-only';
  try {
    await run();
  } finally {
    if (previous === undefined) delete process.env.OSHAL_SCHEMA_BOOTSTRAP;
    else process.env.OSHAL_SCHEMA_BOOTSTRAP = previous;
  }
}

describe('route-owned schema validate-only posture', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('validates priority route schemas without executing route-level DDL or backfill DML', async () => {
    await withValidateOnly(async () => {
      const pool = makeCatalogPool();

      await ensureConnectionsSchema(pool as never);
      await ensureContentSchema(pool as never);
      await ensureFeedsSchema(pool as never);
      await ensureFreeTierSchema(pool as never);
      await ensureInboxSchema(pool as never);
      await ensureJarvisSchema(pool as never);
      await new VisualResponseService(pool as never).ensureSchema();
      await ensureSecuritySchema(pool as never);
      await ensureStoragePrefsSchema(pool as never);
      await ensureTradingSchema(pool as never);

      const executedSql = pool.query.mock.calls.map(([text]) => String(text));
      expect(executedSql.some((sql) => /^\s*(CREATE|ALTER|DROP|UPDATE|GRANT|REVOKE)\b/i.test(sql))).toBe(false);
      expect(executedSql.some((sql) => sql.includes('to_regclass'))).toBe(true);
      expect(executedSql.some((sql) => sql.includes('information_schema.columns'))).toBe(true);
    });
  });

  it('fails clearly when a priority route table is missing a required column', async () => {
    await withValidateOnly(async () => {
      // (Re-fixtured from finance → security at the finance carve, ADR-085: the throw-path
      //  fixture must live on a schema that STAYS core.)
      const columns = { ...ROUTE_SCHEMA_COLUMNS, oshal_security_findings: ['finding_id', 'user_sub'] };
      const pool = makeCatalogPool(columns);

      await expect(ensureSecuritySchemaForThrow(pool as never)).rejects.toThrow(
        'security routes schema is not ready for the runtime DB role',
      );
    });
  });
});
