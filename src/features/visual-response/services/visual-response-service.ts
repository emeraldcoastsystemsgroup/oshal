/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial owner-scoped persistence service for fact-locked SVG response artifacts.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Gallery specs may now be grounded by server-selected trustedLocalImages (ticket workspace deliverables) when no Walmart provider record exists; receiveGalleryImages routes local items through TrustedImageReceiptService.receiveLocalGalleryImages. Provider-record grounding is unchanged, so provider-bound visuals still hard-require their matching record.
 */

import { createHash, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { createChildLogger } from '@/shared/logger';
import { buildOwnerRlsPolicyStatements, runRuntimeSchemaBootstrap } from '@/shared/services/database';
import type {
  FactLockedAnswerPacket, VisualResponseArtifact, VisualResponseContent,
  VisualResponseKind, VisualResponseProvenance, VisualResponseSource, VisualResponseSpec,
  WalmartCatalogProviderRecord,
} from '../types';
import { VISUAL_RESPONSE_KINDS } from '../types';
import { parseVisualResponseSpec } from '../visual-response-schema';
import { groundProviderBoundVisualSpec } from '../provider-grounding';
import { renderVisualResponse } from './visual-response-renderer';
import { TrustedImageReceiptService, type TrustedImageReceipt } from './trusted-image-receipt-service';

const logger = createChildLogger({ module: 'visual-response-service' });
const ARTIFACT_ROUTE = '/api/jarvis/visuals';
const VISUAL_RESPONSE_SCHEMA_LOCK = 47_110_005;
const MAX_GALLERY_ARTIFACT_BYTES = 5_500_000;

interface ArtifactRow {
  artifact_id: string;
  mime_type: 'image/svg+xml';
  width: number;
  height: number;
  alt_text: string;
  content: Buffer;
  content_sha256: string;
  provenance: VisualResponseProvenance | string;
  created_at: Date | string;
}

/**
 * @description Persists deterministic visualizations of finalized answers. All reads and writes
 * are owner-scoped, with row-level security applied at the schema chokepoint.
 */
export class VisualResponseService {
  private ensured = false;

  constructor(
    private readonly pool: Pool,
    private readonly imageReceiptService = new TrustedImageReceiptService(),
  ) {}

  /**
   * @description Creates or validates the visual artifact schema and owner RLS policy.
   * @returns A promise that resolves when the schema is ready for use.
   */
  async ensureSchema(): Promise<void> {
    if (this.ensured) return;
    const startedAt = Date.now();
    logger.info('Visual response schema ensure started');
    try {
      await runRuntimeSchemaBootstrap({
        pool: this.pool,
        moduleName: 'visual-response',
        statements: visualResponseSchemaStatements(),
        lockKey: VISUAL_RESPONSE_SCHEMA_LOCK,
        requirements: [{
          table: 'visual_response_artifacts',
          columns: [
            'artifact_id', 'user_sub', 'source_surface', 'source_session_id', 'source_job_id',
            'mime_type', 'width', 'height', 'alt_text', 'content', 'content_sha256',
            'provenance', 'created_at',
          ],
        }],
      });
      this.ensured = true;
      logger.info({ durationMs: Date.now() - startedAt }, 'Visual response schema ensure completed');
    } catch (err) {
      logger.error({ err, durationMs: Date.now() - startedAt }, 'Visual response schema ensure failed');
      throw err;
    }
  }

  /**
   * @description Deterministically renders and persists an image for a finalized answer packet.
   * Reusing a source job id updates that job's existing artifact instead of minting an unstable URL.
   * @param userSub - Authenticated owner of the answer and artifact.
   * @param packet - Fact-locked response packet to visualize without adding new facts.
   * @returns Client-safe metadata containing the authenticated image URL and provenance.
   */
  async createArtifact(userSub: string, packet: FactLockedAnswerPacket): Promise<VisualResponseArtifact> {
    const startedAt = Date.now();
    logger.info({ sourceJobId: packet.sourceJobId, sourceSurface: packet.sourceSurface }, 'Visual response creation started');
    try {
      const visualSpec = parseVisualResponseSpec(packet.visualSpec);
      if (!visualSpec) throw new Error('A valid visualSpec is required to create a visual artifact');
      const grounded = visualSpec.kind === 'gallery' && packet.trustedLocalImages?.length
        ? { visualSpec, records: [], sources: [] }
        : groundProviderBoundVisualSpec(visualSpec, packet.providerRecords);
      if (!grounded) {
        throw new Error('Provider-bound visuals require a matching provider record');
      }
      const sources = mergeSources(packet.sources, grounded.sources);
      assertSourceReferences(grounded.visualSpec.sourceRefs, sources);
      const normalizedPacket = { ...packet, visualSpec: grounded.visualSpec, sources };
      const inputSpecSha256 = digestCanonical(grounded.visualSpec);
      await this.ensureSchema();
      const reusable = await this.findBySourceJob(userSub, packet.sourceSurface, packet.sourceJobId);
      const storedInputDigest = reusable?.metadata.provenance.inputSpecSha256;
      if (storedInputDigest && storedInputDigest !== inputSpecSha256) {
        throw new Error('Visual artifact immutability conflict for source job');
      }
      if (reusable && storedInputDigest === inputSpecSha256) {
        logger.info({ artifactId: reusable.metadata.artifactId, durationMs: Date.now() - startedAt }, 'Visual response creation reused immutable artifact before provider receipt');
        return reusable.metadata;
      }
      const trustedImages = await receiveGalleryImages(
        this.imageReceiptService,
        grounded.visualSpec,
        grounded.records,
        packet.trustedLocalImages,
      );
      const rendered = renderVisualResponse(normalizedPacket, trustedImages);
      // Both image-bearing kinds embed transcoded PNG bytes, so both carry the persistence cap.
      if ((grounded.visualSpec.kind === 'gallery' || grounded.visualSpec.kind === 'image')
        && rendered.content.byteLength > MAX_GALLERY_ARTIFACT_BYTES) {
        throw new Error('Trusted image artifact exceeds its persistence byte limit');
      }
      const generatedAt = new Date().toISOString();
      const provenance = buildProvenance(
        normalizedPacket,
        rendered,
        generatedAt,
        trustedImages,
        inputSpecSha256,
      );
      const artifactId = randomUUID();
      const contentSha256 = createHash('sha256').update(rendered.content).digest('hex');
      const result = await this.pool.query<Pick<ArtifactRow, 'artifact_id' | 'created_at'>>(
        `INSERT INTO visual_response_artifacts
          (artifact_id, user_sub, source_surface, source_session_id, source_job_id, mime_type,
           width, height, alt_text, content, content_sha256, provenance)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)
         ON CONFLICT (user_sub, source_surface, source_job_id) DO NOTHING
         RETURNING artifact_id, created_at`,
        [artifactId, userSub, packet.sourceSurface, packet.sourceSessionId, packet.sourceJobId,
          rendered.mimeType, rendered.width, rendered.height, rendered.alt, rendered.content,
          contentSha256, JSON.stringify(provenance)],
      );
      const row = result.rows[0];
      if (!row) {
        const existing = await this.findBySourceJob(userSub, packet.sourceSurface, packet.sourceJobId);
        if (!existing) throw new Error('Visual artifact conflict could not be resolved');
        if (existing.contentSha256 !== contentSha256) {
          if (existing.metadata.provenance.inputSpecSha256 === inputSpecSha256) {
            logger.info({ artifactId: existing.metadata.artifactId, durationMs: Date.now() - startedAt }, 'Visual response creation reused concurrently received immutable artifact');
            return existing.metadata;
          }
          // A discussion URL is an archive reference. Never mutate its bytes when a retry with the
          // same source job produces different facts or presentation.
          throw new Error('Visual artifact immutability conflict for source job');
        }
        logger.info({ artifactId: existing.metadata.artifactId, durationMs: Date.now() - startedAt }, 'Visual response creation reused immutable artifact');
        return existing.metadata;
      }
      const artifact = buildMetadata(row.artifact_id, rendered, row.created_at, provenance);
      logger.info({ artifactId: artifact.artifactId, durationMs: Date.now() - startedAt }, 'Visual response creation completed');
      return artifact;
    } catch (err) {
      logger.error({ err, sourceJobId: packet.sourceJobId, durationMs: Date.now() - startedAt }, 'Visual response creation failed');
      throw err;
    }
  }

  /**
   * @description Reads one visual artifact only when it belongs to the authenticated user.
   * @param userSub - Authenticated owner claim used for query-level isolation.
   * @param artifactId - Persisted artifact identifier from response metadata.
   * @returns The SVG and metadata, or null without revealing another user's artifact.
   */
  async getArtifact(userSub: string, artifactId: string): Promise<VisualResponseContent | null> {
    const startedAt = Date.now();
    logger.info({ artifactId }, 'Visual response read started');
    try {
      await this.ensureSchema();
      const result = await this.pool.query<ArtifactRow>(
        `SELECT artifact_id, mime_type, width, height, alt_text, content, content_sha256,
                provenance, created_at
           FROM visual_response_artifacts
          WHERE artifact_id = $1 AND user_sub = $2`,
        [artifactId, userSub],
      );
      const artifact = result.rows[0] ? rowToContent(result.rows[0]) : null;
      logger.info({ artifactId, found: Boolean(artifact), durationMs: Date.now() - startedAt }, 'Visual response read completed');
      return artifact;
    } catch (err) {
      logger.error({ err, artifactId, durationMs: Date.now() - startedAt }, 'Visual response read failed');
      throw err;
    }
  }

  private async findBySourceJob(userSub: string, sourceSurface: string, sourceJobId: string): Promise<VisualResponseContent | null> {
    const result = await this.pool.query<ArtifactRow>(
      `SELECT artifact_id, mime_type, width, height, alt_text, content, content_sha256,
              provenance, created_at
         FROM visual_response_artifacts
        WHERE user_sub = $1 AND source_surface = $2 AND source_job_id = $3`,
      [userSub, sourceSurface, sourceJobId],
    );
    return result.rows[0] ? rowToContent(result.rows[0]) : null;
  }
}

function visualResponseSchemaStatements(): string[] {
  return [
    `CREATE TABLE IF NOT EXISTS visual_response_artifacts (
      artifact_id UUID PRIMARY KEY,
      user_sub TEXT NOT NULL,
      source_surface TEXT NOT NULL,
      source_session_id TEXT NOT NULL,
      source_job_id TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      width INTEGER NOT NULL,
      height INTEGER NOT NULL,
      alt_text TEXT NOT NULL,
      content BYTEA NOT NULL,
      content_sha256 TEXT NOT NULL,
      provenance JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (user_sub, source_surface, source_job_id)
    )`,
    'CREATE INDEX IF NOT EXISTS visual_response_artifacts_session ON visual_response_artifacts (user_sub, source_session_id, created_at DESC)',
    ...buildOwnerRlsPolicyStatements('visual_response_artifacts', 'user_sub'),
  ];
}

function buildProvenance(
  packet: FactLockedAnswerPacket,
  rendered: ReturnType<typeof renderVisualResponse>,
  generatedAt: string,
  trustedImages: ReadonlyMap<string, TrustedImageReceipt>,
  inputSpecSha256: string,
): VisualResponseProvenance {
  return {
    factLocked: true,
    renderer: rendered.renderer,
    answerSha256: rendered.answerSha256,
    visualSpecSha256: rendered.visualSpecSha256,
    inputSpecSha256,
    visualKind: rendered.kind,
    sourceSurface: cleanIdentifier(packet.sourceSurface),
    sourceSessionId: cleanIdentifier(packet.sourceSessionId),
    sourceJobId: cleanIdentifier(packet.sourceJobId),
    sources: normalizeSources(packet.sources),
    ...(trustedImages.size ? {
      imageReceipts: [...trustedImages.values()].map((receipt) => ({
        sourceRef: receipt.sourceRef,
        sourceUrlSha256: receipt.sourceUrlSha256,
        sourceContentSha256: receipt.sourceContentSha256,
        contentSha256: receipt.contentSha256,
        sourceBytes: receipt.sourceBytes,
        outputBytes: receipt.outputBytes,
        mimeType: receipt.mimeType,
        width: receipt.width,
        height: receipt.height,
      })),
    } : {}),
    generatedAt,
  };
}

/**
 * Resolves the bytes for the two image-bearing kinds. `gallery` may be provider-bound (Walmart) or
 * grounded by server-selected workspace deliverables; the generic `image` kind is workspace-only, so
 * an "image on the fly" can never be aimed at an arbitrary remote URL.
 */
async function receiveGalleryImages(
  receiver: TrustedImageReceiptService,
  visualSpec: VisualResponseSpec,
  records: FactLockedAnswerPacket['providerRecords'],
  localImages: FactLockedAnswerPacket['trustedLocalImages'],
): Promise<Map<string, TrustedImageReceipt>> {
  if (visualSpec.kind === 'image') {
    const received = await receiver.receiveLocalGalleryImages(localImages || [], visualSpec);
    if (!received.size) throw new Error('No trusted image survived receipt');
    return received;
  }
  if (visualSpec.kind !== 'gallery') return new Map();
  const walmart = records?.find((record): record is WalmartCatalogProviderRecord => record.kind === 'walmart-catalog');
  const received = walmart
    ? await receiver.receiveGalleryImages(walmart, visualSpec)
    : await receiver.receiveLocalGalleryImages(localImages || [], visualSpec);
  if (!received.size) throw new Error('No trusted gallery image survived receipt');
  return received;
}

function buildMetadata(
  artifactId: string,
  rendered: ReturnType<typeof renderVisualResponse>,
  createdAt: Date | string,
  provenance: VisualResponseProvenance,
): VisualResponseArtifact {
  return {
    artifactId, type: 'image', kind: rendered.kind, url: `${ARTIFACT_ROUTE}/${artifactId}`,
    mimeType: rendered.mimeType, alt: rendered.alt, width: rendered.width, height: rendered.height,
    createdAt: toIso(createdAt), provenance,
  };
}

function rowToContent(row: ArtifactRow): VisualResponseContent {
  const stored = typeof row.provenance === 'string'
    ? JSON.parse(row.provenance) as Partial<VisualResponseProvenance>
    : (row.provenance || {}) as Partial<VisualResponseProvenance>;
  const visualKind = isVisualKind(stored.visualKind) ? stored.visualKind : 'summary';
  const imageReceipts = normalizeImageReceipts(stored.imageReceipts);
  const provenance: VisualResponseProvenance = {
    factLocked: true,
    renderer: String(stored.renderer || 'oshal-fact-locked-svg-v1'),
    answerSha256: String(stored.answerSha256 || row.content_sha256),
    visualSpecSha256: String(stored.visualSpecSha256 || row.content_sha256),
    ...(isSha256(stored.inputSpecSha256) ? { inputSpecSha256: stored.inputSpecSha256 } : {}),
    visualKind,
    sourceSurface: String(stored.sourceSurface || ''),
    sourceSessionId: String(stored.sourceSessionId || ''),
    sourceJobId: String(stored.sourceJobId || ''),
    sources: normalizeSources(stored.sources),
    ...(imageReceipts.length ? { imageReceipts } : {}),
    generatedAt: String(stored.generatedAt || toIso(row.created_at)),
  };
  return {
    metadata: {
      artifactId: row.artifact_id, type: 'image', kind: visualKind, url: `${ARTIFACT_ROUTE}/${row.artifact_id}`,
      mimeType: row.mime_type, alt: row.alt_text, width: Number(row.width), height: Number(row.height),
      createdAt: toIso(row.created_at), provenance,
    },
    content: Buffer.isBuffer(row.content) ? row.content : Buffer.from(row.content),
    contentSha256: row.content_sha256,
  };
}

function normalizeSources(sources: VisualResponseSource[] | undefined): VisualResponseSource[] {
  return (sources || []).slice(0, 20).map((source) => ({
    type: source.type,
    id: cleanIdentifier(source.id),
    ...(source.label ? { label: String(source.label).slice(0, 120) } : {}),
  })).filter((source) => Boolean(source.id));
}

function mergeSources(
  packetSources: VisualResponseSource[] | undefined,
  providerSources: VisualResponseSource[],
): VisualResponseSource[] {
  const byId = new Map<string, VisualResponseSource>();
  for (const source of [...(packetSources || []), ...providerSources]) {
    if (source.id && !byId.has(source.id)) byId.set(source.id, source);
  }
  return [...byId.values()];
}

function assertSourceReferences(sourceRefs: string[], sources: VisualResponseSource[] | undefined): void {
  if (!sourceRefs.length) return;
  const available = new Set((sources || []).map((source) => source.id));
  const missing = sourceRefs.filter((sourceRef) => !available.has(sourceRef));
  if (missing.length) throw new Error(`Visual spec references unavailable source: ${missing.join(', ')}`);
}

function isVisualKind(value: unknown): value is VisualResponseKind {
  return typeof value === 'string' && (VISUAL_RESPONSE_KINDS as readonly string[]).includes(value);
}

function normalizeImageReceipts(
  value: VisualResponseProvenance['imageReceipts'] | undefined,
): NonNullable<VisualResponseProvenance['imageReceipts']> {
  if (!Array.isArray(value)) return [];
  const digest = /^[a-f0-9]{64}$/;
  return value.slice(0, 4).filter((receipt) => (
    receipt
    && typeof receipt.sourceRef === 'string'
    && receipt.sourceRef.length > 0
    && receipt.sourceRef.length <= 180
    && digest.test(receipt.sourceUrlSha256)
    && digest.test(receipt.sourceContentSha256)
    && digest.test(receipt.contentSha256)
    && receipt.mimeType === 'image/png'
    && Number.isInteger(receipt.sourceBytes) && receipt.sourceBytes > 0 && receipt.sourceBytes <= 3 * 1024 * 1024
    && Number.isInteger(receipt.outputBytes) && receipt.outputBytes > 0 && receipt.outputBytes <= 900_000
    && Number.isInteger(receipt.width) && receipt.width > 0 && receipt.width <= 480
    && Number.isInteger(receipt.height) && receipt.height > 0 && receipt.height <= 320
  )).map((receipt) => ({ ...receipt, sourceRef: cleanIdentifier(receipt.sourceRef) }));
}

function cleanIdentifier(value: string): string {
  return String(value || '').replace(/[^\w.:/-]/g, '-').slice(0, 180);
}

function digestCanonical(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
