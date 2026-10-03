/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-173 S1 (D6): the operator surface for the capability swarm rows, mounted at /api/capability-providers. GET lists, per capability (tts, stt, image, video), the swarm default (the operator's row, else the seed the config or selector names), every provider with its cost class and its availability for the calling operator from the SAME availability function the resolver asks (D3), every stored row, and the snapshot's freshness. PUT /swarm/:capability validates the provider id against that capability's declarations (an unknown id is a 400 naming the accepted ids, never a silent write) and a text-to-speech voice against the voices that provider lists (D9), upserts the one row under the caller's identity — the table's own operator-only policy is the enforcement, not this file — and refreshes the snapshot so the next call resolves the new default with no restart; DELETE /swarm/:capability returns the capability to its seed. POST /stt/:providerId/try transcribes one uploaded clip through exactly that provider (a required preference, never switched), so an operator can prove a provider works before making it the swarm default (D12). Operator sessions only: a request without an authenticated user session — a service secret among them — is refused before anything is read.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | ADR-173 S1b (D4): PUT and DELETE /offers/:capability/:providerId set and clear one provider's unit price (USD per character, audio second, image or video second) and its quota label on the offer row (migration 184), validated against the capability's declarations; offeredTo is refused until slice S2 builds the grant control. The listing carries each provider's offer and each capability's price unit. Writes refresh the snapshot, so the next call is priced at the new rate.
 */

import { Router, type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import { createChildLogger } from '@/shared/logger';
import { getCaller, hasAuthenticatedUserIdentity, isOperator, requiresOperator } from '@/shared/middleware/authz';
import { preserveRequestIdentity } from '@/shared/middleware/multipart-identity';
import {
  CAPABILITIES,
  CAPABILITY_FLEET_SCOPE,
  CAPABILITY_PRICE_UNITS,
  describeCapabilitySwarmDefault,
  isCapability,
  listCapabilityOptions,
  userCapabilityPrincipal,
  type Capability,
  type CapabilityAdapter,
  type CapabilityCaller,
  type CapabilityProviderOffer,
  type CapabilityRowSnapshot,
  type CapabilitySwarmRow,
} from '@/shared/capability-providers';
import type { CapabilityOfferStore, CapabilitySwarmRowStore } from '@/features/capability-providers';
import type { VoiceService } from '@/features/voice';

const logger = createChildLogger({ module: 'capability-provider-routes' });

/** What the routes need from the composition root. */
export interface CapabilityProviderRouteDeps {
  /** The store over the GUC-wrapped pool; absent without Postgres. */
  store: Pick<CapabilitySwarmRowStore, 'listAll' | 'upsert' | 'remove'> | undefined;
  /** The installed snapshot, refreshed after every write; null until installed. */
  snapshot: () => CapabilityRowSnapshot | null;
  /** The four capability adapters (the same ones the calls resolve through). */
  adapters: () => Readonly<Record<Capability, CapabilityAdapter>>;
  /** The voice service the speech-to-text try action transcribes through. */
  voice: Pick<VoiceService, 'transcribeAudio'>;
  /** The provider-offer store (unit prices, quota labels); absent without Postgres. */
  offers?: Pick<CapabilityOfferStore, 'listAll' | 'upsert' | 'remove'>;
}

/**
 * The single-clip upload the try action reads (memory only, 10 MB like /api/voice/transcribe),
 * re-entering the caller's request identity afterwards so anything the call writes stays theirs.
 */
const clipUpload = preserveRequestIdentity(multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } }).single('audio'));

/**
 * @description Operator sessions only. A request with no authenticated user session (a service
 * secret, an anonymous call) is refused here, before requiresOperator, so the refusal never
 * depends on how the router is mounted.
 */
function requiresOperatorSession(req: Request, res: Response, next: NextFunction): void {
  if (!hasAuthenticatedUserIdentity(req)) {
    res.status(403).json({ success: false, error: 'operator_session_required', message: 'An operator session is required; a service secret cannot read or write capability rows.' });
    return;
  }
  requiresOperator(req, res, next);
}

/**
 * @description The calling operator as a capability caller (availability is computed for them).
 * @param req - An operator request (requiresOperatorSession has run).
 * @returns The caller.
 */
function operatorCaller(req: Request): CapabilityCaller {
  return { principal: userCapabilityPrincipal({ sub: String(getCaller(req).sub), isOperator: isOperator(req) }), appId: null, agentId: null };
}

/**
 * @description One capability's section of the listing.
 * @returns The section.
 */
async function capabilitySection(
  adapter: CapabilityAdapter, req: Request, rows: CapabilitySwarmRow[], offers: CapabilityProviderOffer[], deps: CapabilityProviderRouteDeps,
) {
  const reader = deps.snapshot() ?? undefined;
  const options = await listCapabilityOptions(adapter, operatorCaller(req).principal);
  return {
    capability: adapter.capability,
    priceUnit: CAPABILITY_PRICE_UNITS[adapter.capability],
    swarmDefault: await describeCapabilitySwarmDefault(adapter, reader),
    providers: options.map((option) => ({
      ...option,
      offer: offers.find((offer) => offer.capability === adapter.capability && offer.providerId === option.providerId) ?? null,
    })),
    rows: rows.filter((row) => row.capability === adapter.capability),
  };
}

/** @description GET / — the whole operator view. */
async function handleList(req: Request, res: Response, deps: CapabilityProviderRouteDeps): Promise<void> {
  const startedAt = Date.now();
  try {
    if (!deps.store) {
      res.status(503).json({ success: false, error: 'Capability provider store unavailable (no Postgres pool)' });
      return;
    }
    const rows = await deps.store.listAll();
    const offers = deps.offers ? await deps.offers.listAll() : [];
    const adapters = deps.adapters();
    const capabilities = [];
    for (const capability of CAPABILITIES) capabilities.push(await capabilitySection(adapters[capability], req, rows, offers, deps));
    res.json({ success: true, capabilities, snapshot: deps.snapshot()?.status() ?? null });
  } catch (err) {
    logger.error({ err }, 'Capability provider listing failed');
    res.status(500).json({ success: false, error: (err as Error).message });
  } finally {
    logger.info({ statusCode: res.statusCode, durationMs: Date.now() - startedAt }, 'Capability provider listing completed');
  }
}

/**
 * @description Validate a write body against the capability's declarations (and, for text to
 * speech, the provider's listed voices). Returns the refusal, or the clean values.
 * @returns The refusal (status + body), or the provider id and options to write.
 */
async function validateWrite(
  adapter: CapabilityAdapter,
  body: Record<string, unknown>,
): Promise<{ refusal: { status: number; body: Record<string, unknown> } } | { providerId: string; options: { voice?: string } }> {
  const providerId = typeof body.providerId === 'string' ? body.providerId.trim() : '';
  const accepted = adapter.declarations().map((declaration) => declaration.providerId);
  if (!providerId || !accepted.includes(providerId)) {
    return { refusal: { status: 400, body: { success: false, applied: false, code: 'unknown_provider',
      error: `"${providerId}" is not a ${adapter.capability} provider on this deployment`, accepted } } };
  }
  if (body.model !== undefined) {
    return { refusal: { status: 400, body: { success: false, applied: false, code: 'model_not_supported',
      error: 'No capability call reads a model from a swarm row yet; write the provider (and, for tts, a voice) only' } } };
  }
  const voice = typeof body.voice === 'string' && body.voice.trim() ? body.voice.trim() : null;
  if (!voice) return { providerId, options: {} };
  if (adapter.capability !== 'tts' || !adapter.listVoiceIds) {
    return { refusal: { status: 400, body: { success: false, applied: false, code: 'voice_not_supported', error: `${adapter.capability} rows carry no voice` } } };
  }
  const listed = await adapter.listVoiceIds(providerId);
  if (!listed || !listed.includes(voice)) {
    return { refusal: { status: 400, body: { success: false, applied: false, code: 'voice_not_listed',
      error: `${providerId} does not list the voice "${voice}" (ADR-173 D9: a voice is stored only beside a provider that lists it)`,
      voices: listed ?? [] } } };
  }
  return { providerId, options: { voice } };
}

/** @description PUT /swarm/:capability — write the swarm default for one capability. */
async function handleWrite(req: Request, res: Response, deps: CapabilityProviderRouteDeps): Promise<void> {
  const startedAt = Date.now();
  const capability = String(req.params.capability);
  logger.info({ capability, providerId: (req.body ?? {}).providerId }, 'Capability swarm row write started');
  try {
    if (!isCapability(capability)) { res.status(400).json({ success: false, applied: false, error: `unknown capability "${capability}"`, accepted: CAPABILITIES }); return; }
    if (!deps.store) { res.status(503).json({ success: false, applied: false, error: 'Capability provider store unavailable (no Postgres pool)' }); return; }
    const adapter = deps.adapters()[capability];
    const checked = await validateWrite(adapter, (req.body ?? {}) as Record<string, unknown>);
    if ('refusal' in checked) { res.status(checked.refusal.status).json(checked.refusal.body); return; }
    const row = await deps.store.upsert(CAPABILITY_FLEET_SCOPE, capability, checked.providerId, checked.options, getCaller(req).sub ?? 'operator');
    await deps.snapshot()?.refresh();
    const availability = await adapter.availability(checked.providerId, operatorCaller(req).principal);
    res.json({ success: true, applied: true, row, availability, swarmDefault: await describeCapabilitySwarmDefault(adapter, deps.snapshot() ?? undefined),
      snapshot: deps.snapshot()?.status() ?? null });
  } catch (err) {
    logger.error({ err, capability }, 'Capability swarm row write failed');
    const code = (err as { code?: string }).code;
    res.status(code === '42501' ? 403 : code === '23514' ? 400 : 500).json({ success: false, applied: false, error: (err as Error).message });
  } finally {
    logger.info({ capability, statusCode: res.statusCode, durationMs: Date.now() - startedAt }, 'Capability swarm row write completed');
  }
}

/** @description DELETE /swarm/:capability — return one capability to its seed. */
async function handleRemove(req: Request, res: Response, deps: CapabilityProviderRouteDeps): Promise<void> {
  const startedAt = Date.now();
  const capability = String(req.params.capability);
  try {
    if (!isCapability(capability)) { res.status(400).json({ success: false, applied: false, error: `unknown capability "${capability}"`, accepted: CAPABILITIES }); return; }
    if (!deps.store) { res.status(503).json({ success: false, applied: false, error: 'Capability provider store unavailable (no Postgres pool)' }); return; }
    const removed = await deps.store.remove(CAPABILITY_FLEET_SCOPE, capability);
    await deps.snapshot()?.refresh();
    res.json({ success: true, applied: true, removed, capability,
      swarmDefault: await describeCapabilitySwarmDefault(deps.adapters()[capability], deps.snapshot() ?? undefined),
      snapshot: deps.snapshot()?.status() ?? null });
  } catch (err) {
    logger.error({ err, capability }, 'Capability swarm row removal failed');
    const code = (err as { code?: string }).code;
    res.status(code === '42501' ? 403 : 500).json({ success: false, applied: false, error: (err as Error).message });
  } finally {
    logger.info({ capability, statusCode: res.statusCode, durationMs: Date.now() - startedAt }, 'Capability swarm row removal completed');
  }
}

/**
 * @description Validate an offer write: a declared provider, a price that is null or a finite USD
 * amount of zero or more per unit, and a quota label of at most 120 characters. offeredTo is
 * refused: the grant control is slice S2.
 * @returns The refusal, or the clean values.
 */
function validateOffer(
  adapter: CapabilityAdapter,
  providerId: string,
  body: Record<string, unknown>,
): { refusal: Record<string, unknown> } | { unitPriceUsd: number | null; quotaLabel: string | null } {
  if (!adapter.declarations().some((declaration) => declaration.providerId === providerId)) {
    return { refusal: { code: 'unknown_provider', error: `"${providerId}" is not a ${adapter.capability} provider on this deployment` } };
  }
  if (body.offeredTo !== undefined) return { refusal: { code: 'offered_to_not_supported', error: 'Who a provider is offered to is set from ADR-173 slice S2' } };
  const price = body.unitPriceUsd;
  if (price !== null && (typeof price !== 'number' || !Number.isFinite(price) || price < 0)) {
    return { refusal: { code: 'unit_price_invalid', error: `unitPriceUsd is USD per unit (${CAPABILITY_PRICE_UNITS[adapter.capability]}): a number of zero or more, or null to clear it` } };
  }
  const label = body.quotaLabel === null || body.quotaLabel === undefined ? null : String(body.quotaLabel).trim();
  if (label !== null && (!label || label.length > 120)) return { refusal: { code: 'quota_label_invalid', error: 'quotaLabel is 1 to 120 characters, or null' } };
  return { unitPriceUsd: price as number | null, quotaLabel: label };
}

/** @description PUT /offers/:capability/:providerId — set one provider's unit price and quota label. */
async function handleOfferWrite(req: Request, res: Response, deps: CapabilityProviderRouteDeps): Promise<void> {
  const startedAt = Date.now();
  const capability = String(req.params.capability);
  const providerId = String(req.params.providerId);
  try {
    if (!isCapability(capability)) { res.status(400).json({ success: false, applied: false, error: `unknown capability "${capability}"`, accepted: CAPABILITIES }); return; }
    if (!deps.offers) { res.status(503).json({ success: false, applied: false, error: 'Capability offer store unavailable (no Postgres pool)' }); return; }
    const checked = validateOffer(deps.adapters()[capability], providerId, (req.body ?? {}) as Record<string, unknown>);
    if ('refusal' in checked) { res.status(400).json({ success: false, applied: false, ...checked.refusal }); return; }
    const offer = await deps.offers.upsert(capability, providerId, checked, getCaller(req).sub ?? 'operator');
    await deps.snapshot()?.refresh();
    res.json({ success: true, applied: true, offer, priceUnit: CAPABILITY_PRICE_UNITS[capability], snapshot: deps.snapshot()?.status() ?? null });
  } catch (err) {
    logger.error({ err, capability, providerId }, 'Capability offer write failed');
    const code = (err as { code?: string }).code;
    res.status(code === '42501' ? 403 : code === '23514' ? 400 : 500).json({ success: false, applied: false, error: (err as Error).message });
  } finally {
    logger.info({ capability, providerId, statusCode: res.statusCode, durationMs: Date.now() - startedAt }, 'Capability offer write completed');
  }
}

/** @description DELETE /offers/:capability/:providerId — clear one provider's offer row. */
async function handleOfferRemove(req: Request, res: Response, deps: CapabilityProviderRouteDeps): Promise<void> {
  const startedAt = Date.now();
  const capability = String(req.params.capability);
  const providerId = String(req.params.providerId);
  try {
    if (!isCapability(capability)) { res.status(400).json({ success: false, applied: false, error: `unknown capability "${capability}"`, accepted: CAPABILITIES }); return; }
    if (!deps.offers) { res.status(503).json({ success: false, applied: false, error: 'Capability offer store unavailable (no Postgres pool)' }); return; }
    const removed = await deps.offers.remove(capability, providerId);
    await deps.snapshot()?.refresh();
    res.json({ success: true, applied: true, removed, capability, providerId, snapshot: deps.snapshot()?.status() ?? null });
  } catch (err) {
    logger.error({ err, capability, providerId }, 'Capability offer removal failed');
    res.status((err as { code?: string }).code === '42501' ? 403 : 500).json({ success: false, applied: false, error: (err as Error).message });
  } finally {
    logger.info({ capability, providerId, statusCode: res.statusCode, durationMs: Date.now() - startedAt }, 'Capability offer removal completed');
  }
}

/** @description POST /stt/:providerId/try — transcribe one clip through exactly that provider. */
async function handleSttTry(req: Request, res: Response, deps: CapabilityProviderRouteDeps): Promise<void> {
  const startedAt = Date.now();
  const providerId = String(req.params.providerId);
  try {
    const file = (req as Request & { file?: { buffer: Buffer; mimetype: string } }).file;
    if (!file?.buffer?.length) { res.status(400).json({ success: false, error: 'Upload one audio clip as the multipart field "audio"' }); return; }
    const result = await deps.voice.transcribeAudio(file.buffer, file.mimetype, { providerId, caller: operatorCaller(req) });
    res.json({ success: !result.fallback, ...result });
  } catch (err) {
    logger.error({ err, providerId }, 'Speech-to-text try failed');
    res.status(500).json({ success: false, error: (err as Error).message });
  } finally {
    logger.info({ providerId, statusCode: res.statusCode, durationMs: Date.now() - startedAt }, 'Speech-to-text try completed');
  }
}

/**
 * @description The capability provider operator routes (ADR-173 S1), mounted at
 * /api/capability-providers behind requiresAuth: GET / (defaults, providers with availability,
 * rows, snapshot), PUT /swarm/:capability (write the swarm default), DELETE /swarm/:capability
 * (return to the seed), PUT/DELETE /offers/:capability/:providerId (a provider's unit price and quota
 * label), POST /stt/:providerId/try (prove a provider on one clip). Operator sessions only.
 * @param deps - Store, snapshot, adapters and the voice service.
 * @returns The router.
 */
export function createCapabilityProviderRoutes(deps: CapabilityProviderRouteDeps): Router {
  const router = Router();
  router.get('/', requiresOperatorSession, (req, res) => void handleList(req, res, deps));
  router.put('/swarm/:capability', requiresOperatorSession, (req, res) => void handleWrite(req, res, deps));
  router.delete('/swarm/:capability', requiresOperatorSession, (req, res) => void handleRemove(req, res, deps));
  router.put('/offers/:capability/:providerId', requiresOperatorSession, (req, res) => void handleOfferWrite(req, res, deps));
  router.delete('/offers/:capability/:providerId', requiresOperatorSession, (req, res) => void handleOfferRemove(req, res, deps));
  router.post('/stt/:providerId/try', requiresOperatorSession, clipUpload, (req, res) => void handleSttTry(req, res, deps));
  return router;
}
