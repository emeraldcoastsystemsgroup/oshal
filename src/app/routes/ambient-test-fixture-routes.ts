/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-100 attributed-ingest fixture for the AI Test Lab. POST /api/jarvis/ambient/segments refuses speaker ids by design, so the only writer of an ATTRIBUTED line was the trusted audio pipeline and the Lab could prove nothing beyond unattributed recall — asks, per-person profiles and consent were unreachable without a microphone. This router seeds exactly one attributed line for one stable per-owner fixture voice through the SAME collaborators the audio route uses (SpeakerProfileStore.identify/assignProfile, recordConsent, AmbientListeningService.appendAttributedSegments, enrichBatch), with the analyst's reply — and only the analyst's reply — supplied deterministically so no LLM is spent. It is fail-closed machine-gated: requireServiceSecret INSIDE the router (503 unconfigured, 401 without an exact X-Service-Secret), so a normal signed-in session cannot reach it, and the owner is ALWAYS the caller's own OIDC subject, so a secret holder can never seed into someone else's store.
 */

import { createHash } from 'node:crypto';
import { Router, type Request, type RequestHandler } from 'express';
import type { AppContext } from '@/app/composition/app-context';
import {
  AmbientInputError,
  AmbientModeDisabledError,
  ambientListeningFor,
  type AmbientListeningServiceContract,
} from '@/features/ambient-listening';
import {
  eligibleProfileIds,
  enrichBatch,
  recordConsent,
  type EnrichBrainInvoker,
} from '@/features/person-model';
import { speakerProfilesFor, type SpeakerProfileStoreContract } from '@/features/speaker-diarization';
import { createChildLogger } from '@/shared/logger';
import { requireServiceSecret } from '@/shared/middleware/authz';
import { runWithRequestIdentity } from '@/shared/services/database/request-identity';

const logger = createChildLogger({ module: 'ambient-test-fixture-routes' });

/** @description Custom name given to the one fixture voice the Lab seeds against, per owner. */
export const AMBIENT_FIXTURE_VOICE_LABEL = 'Test Lab fixture voice';
/** @description `model` stamped on the fixture enrichment and ask, so it is never read as analyst output. */
export const AMBIENT_FIXTURE_MODEL = 'test-lab-fixture';
/** @description The single closed-taxonomy topic the fixture line rolls up under. */
export const AMBIENT_FIXTURE_TOPIC = 'test-lab-fixture';
/** @description Embedding "model" recorded on the fixture profile; never a real voiceprint. */
const FIXTURE_EMBEDDING_MODEL = 'test-lab-fixture-voice-v1';
const FIXTURE_EMBEDDING_DIMENSIONS = 192;
const TOKEN_PATTERN = /^[a-z0-9][a-z0-9-]{3,39}$/i;

/** @description Collaborators the fixture drives; injectable so a route spec can run without a database. */
export interface AmbientTestFixtureRouteOptions {
  service?: Pick<AmbientListeningServiceContract, 'getSettings' | 'appendAttributedSegments'>;
  store?: Pick<SpeakerProfileStoreContract, 'identify' | 'assignProfile'>;
  /** The real `enrichBatch` by default; the ANALYST inside it is always the deterministic fixture reply. */
  enrich?: typeof enrichBatch;
}

/** What one fixture seed produced, echoed back so a Lab step can assert against it. */
interface FixtureSeedResult {
  token: string;
  profileId: string;
  label: string;
  segmentId: string;
  duplicate: boolean;
  consentRecorded: boolean;
  enriched: number;
  asks: number;
  model: string;
  ask: string;
  quote: string;
}

type FixtureDeps = Required<AmbientTestFixtureRouteOptions> & { pool: AppContext['pool'] };

/**
 * @description Builds the machine-gated Test Lab attributed-ingest fixture router. The server mounts
 * it behind `requiresAuth`; the router additionally requires an exact `X-Service-Secret`, so a
 * signed-in browser session alone is refused. Every write is scoped to the caller's own subject.
 * @param ctx - App context carrying the GUC-aware Postgres pool.
 * @param options - Optional collaborators for isolated route tests.
 * @returns Express router mounted at `/api/jarvis/ambient/test-fixture`.
 */
export function createAmbientTestFixtureRoutes(
  ctx: Pick<AppContext, 'pool'>,
  options: AmbientTestFixtureRouteOptions = {},
): Router {
  const router = Router();
  const deps: FixtureDeps = {
    pool: ctx.pool,
    service: options.service ?? ambientListeningFor(ctx.pool),
    store: options.store ?? speakerProfilesFor(ctx.pool),
    enrich: options.enrich ?? enrichBatch,
  };
  // Fail-closed machine gate, declared INSIDE the router so it travels with the module and the
  // machine-write discovery scan can see it.
  router.use(requireServiceSecret);
  router.post('/attributed-line', fixtureRoute('seedAttributedLine', async (req, res, ownerSub) => {
    res.status(201).json(await seedFixtureLine(deps, ownerSub, readToken(req)));
  }));
  return router;
}

/**
 * @description Deterministic pseudo-voiceprint for one owner's fixture voice. Stable per owner, so a
 * repeated Lab run matches the SAME profile instead of minting a new one, and owner-salted so two
 * owners never share a profile. It is a hash expansion, never a recorded voice.
 * @param ownerSub - The owning OIDC subject.
 * @returns A 192-dimension vector in [-1, 1).
 */
export function fixtureVoiceEmbedding(ownerSub: string): number[] {
  const out: number[] = [];
  for (let block = 0; out.length < FIXTURE_EMBEDDING_DIMENSIONS; block += 1) {
    const digest = createHash('sha256').update(`oshal-test-lab-fixture-voice|${ownerSub}|${block}`).digest();
    for (const byte of digest) {
      if (out.length >= FIXTURE_EMBEDDING_DIMENSIONS) break;
      out.push((byte - 127.5) / 127.5);
    }
  }
  return out;
}

/**
 * @description The transcript line the fixture seeds. Ask-shaped and token-bearing so a Lab step can
 * find exactly its own line, and self-labelling so the owner can recognise it in their transcript.
 * @param token - The run token supplied by the caller.
 * @returns The verbatim fixture line.
 */
export function fixtureLineText(token: string): string {
  return `Test Lab fixture ${token}: can you send me the handover notes before Friday?`;
}

/**
 * @description The follow-up the fixture analyst extracts from {@link fixtureLineText}.
 * @param token - The run token supplied by the caller.
 * @returns The ask text persisted in `ambient_person_asks`.
 */
export function fixtureAskText(token: string): string {
  return `Send the handover notes before Friday (Test Lab fixture ${token}).`;
}

/** Validates the caller's run token: it names the segment and appears verbatim in the line. */
function readToken(req: Request): string {
  const token = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
  if (!TOKEN_PATTERN.test(token)) {
    throw new AmbientInputError('token must be 4-40 characters of [a-z0-9-]', 'invalid_fixture_token');
  }
  return token;
}

/** Seeds voice, line, consent and enrichment for one run, in the order the audio pipeline uses. */
async function seedFixtureLine(deps: FixtureDeps, ownerSub: string, token: string): Promise<FixtureSeedResult> {
  const voice = await resolveFixtureVoice(deps.store, ownerSub);
  const settings = await deps.service.getSettings(ownerSub);
  const line = await seedAttributedLine(deps, ownerSub, voice.profileId, token);
  const consentRecorded = await ensureFixtureConsent(deps.pool, ownerSub, voice.profileId, line.segmentId);
  const outcome = await deps.enrich(
    deps.pool,
    ownerSub,
    [{
      segmentId: line.segmentId,
      text: line.text,
      speakerLabel: AMBIENT_FIXTURE_VOICE_LABEL,
      profileId: voice.profileId,
      capturedAt: line.capturedAt,
    }],
    fixtureAnalyst(line.segmentId, token),
    { timeZone: settings.timeZone, model: AMBIENT_FIXTURE_MODEL },
  );
  return {
    token,
    profileId: voice.profileId,
    label: voice.label,
    segmentId: line.segmentId,
    duplicate: line.duplicate,
    consentRecorded,
    enriched: outcome.enriched,
    asks: outcome.asks,
    model: AMBIENT_FIXTURE_MODEL,
    ask: fixtureAskText(token),
    quote: line.text,
  };
}

/** Matches (or creates once) the owner's stable fixture voice through the real profile store. */
async function resolveFixtureVoice(
  store: FixtureDeps['store'],
  ownerSub: string,
): Promise<{ profileId: string; label: string; created: boolean }> {
  const match = await store.identify(ownerSub, fixtureVoiceEmbedding(ownerSub), FIXTURE_EMBEDDING_MODEL);
  const profileId = match.profile.profileId;
  const assigned = await store.assignProfile(ownerSub, profileId, {
    kind: 'custom', customName: AMBIENT_FIXTURE_VOICE_LABEL,
  });
  return {
    profileId,
    label: assigned?.assignment.customName ?? AMBIENT_FIXTURE_VOICE_LABEL,
    created: match.created,
  };
}

/** One attributed line through the trusted append path; a replayed token resolves to its first write. */
async function seedAttributedLine(
  deps: FixtureDeps,
  ownerSub: string,
  profileId: string,
  token: string,
): Promise<{ segmentId: string; text: string; capturedAt: string; duplicate: boolean }> {
  const clientSegmentId = `testlab-fixture-${token}`;
  // `recording_import` so the fixture never flips the owner's ambient_enabled privacy setting to
  // write; it is an import of one synthetic line, not live capture.
  const result = await deps.service.appendAttributedSegments(ownerSub, [{
    text: fixtureLineText(token),
    capturedAt: new Date(),
    endedAt: null,
    speakerLabel: AMBIENT_FIXTURE_VOICE_LABEL,
    wakePhraseDetected: false,
    matchedWakePhrase: null,
    sessionId: null,
    clientSegmentId,
    speakerProfileId: profileId,
  }], 'recording_import');
  const stored = result.segments[0];
  if (stored) {
    return {
      segmentId: stored.segmentId, text: stored.text,
      capturedAt: stored.capturedAt.toISOString(), duplicate: false,
    };
  }
  return { ...(await findSeededLine(deps.pool, ownerSub, clientSegmentId)), duplicate: true };
}

/** Resolves an already-seeded line so a replayed token stays idempotent instead of failing. */
async function findSeededLine(
  pool: AppContext['pool'],
  ownerSub: string,
  clientSegmentId: string,
): Promise<{ segmentId: string; text: string; capturedAt: string }> {
  const { rows } = await pool.query(
    `SELECT segment_id, transcript_text, captured_at FROM ambient_transcript_segments
      WHERE user_sub = $1 AND client_segment_id = $2 LIMIT 1`,
    [ownerSub, clientSegmentId],
  );
  const row = rows[0];
  if (!row) throw new AmbientInputError('fixture line was neither stored nor found', 'fixture_line_missing');
  return {
    segmentId: String(row.segment_id),
    text: String(row.transcript_text),
    capturedAt: new Date(row.captured_at as string).toISOString(),
  };
}

/** Grants transcript-scope modeling for the fixture voice once; the ledger is append-only. */
async function ensureFixtureConsent(
  pool: AppContext['pool'],
  ownerSub: string,
  profileId: string,
  segmentId: string,
): Promise<boolean> {
  const eligible = await eligibleProfileIds(pool, ownerSub);
  if (eligible.has(profileId)) return false;
  await recordConsent(pool, ownerSub, {
    profileId, scope: 'transcript', status: 'granted', isMinor: false,
    method: 'owner_attested', evidenceSegmentId: segmentId,
  });
  return true;
}

/**
 * The ONE substituted collaborator: the ambient-analyst's reply. Everything downstream — taxonomy
 * validation, ask/rollup/relation persistence — is the production code path. A live analyst run is
 * tracked separately by the "Ambient Recall — live acceptance on real transcripts" backlog entry.
 */
function fixtureAnalyst(segmentId: string, token: string): EnrichBrainInvoker {
  return async () => JSON.stringify({
    enrichments: [{
      segmentId,
      tone: 'neutral',
      intent: 'ask_request',
      topics: [AMBIENT_FIXTURE_TOPIC],
      ask: fixtureAskText(token),
    }],
  });
}

type FixtureHandler = (
  req: Request,
  res: Parameters<RequestHandler>[1],
  ownerSub: string,
) => Promise<void>;

/**
 * Resolves the caller's own subject, fails closed without one, and re-enters the request as that
 * owner with `isOperator: false` — the valid service secret makes the ambient stamp an OPERATOR,
 * which would hand a secret holder cross-tenant reach on every write below.
 */
function fixtureRoute(operation: string, handler: FixtureHandler): RequestHandler {
  return async (req, res) => {
    const startedAt = Date.now();
    const ownerSub = callerSub(req);
    logger.info({ operation, method: req.method }, 'Ambient fixture route entered');
    if (!ownerSub) {
      res.status(401).json({ error: 'sign_in_required' });
      return;
    }
    try {
      await runWithRequestIdentity({ sub: ownerSub, isOperator: false }, () => handler(req, res, ownerSub));
      logger.info({ operation, status: res.statusCode, durationMs: Date.now() - startedAt }, 'Ambient fixture route completed');
    } catch (error) {
      logger.error({ err: error, operation, durationMs: Date.now() - startedAt }, 'Ambient fixture route failed');
      writeFixtureError(res, error);
    }
  };
}

/** The owner is ALWAYS the validated session subject — never a body, query or header assertion. */
function callerSub(req: Request): string | null {
  const user = (req as Request & { oidc?: { user?: { sub?: string } } }).oidc?.user;
  return user?.sub ? String(user.sub) : null;
}

/** Maps the ambient error vocabulary onto status codes, defaulting to an opaque 500. */
function writeFixtureError(res: Parameters<RequestHandler>[1], error: unknown): void {
  if (error instanceof AmbientInputError) {
    res.status(400).json({ error: error.code, message: error.message });
    return;
  }
  if (error instanceof AmbientModeDisabledError) {
    res.status(409).json({ error: 'ambient_not_enabled', message: error.message });
    return;
  }
  res.status(500).json({ error: 'ambient_fixture_unavailable' });
}
