/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR                                    | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Add fresh personal SmartThings consent and metadata-only grant management under exact verified issuer/subject identity; never adopt legacy credentials or enable device actions.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Revalidate request identity and consumed consent inside persistence before commit and suppress metadata after invalidation during commit.
 */
import type { Request, Response, Router } from 'express';
import type { AppContext } from '@/app/composition/app-context';
import { createChildLogger } from '@/shared/logger';
import { getRequestIdentity, runWithRequestIdentity } from '@/shared/services/database/request-identity';
import { caller } from './connector-response-helpers';
import { connectorOrigin, CONNECTOR_CEREMONY_TTL, type ConnectorConsent, type ConnectorOAuthCeremonies } from './connector-oauth-state';
import { PROVIDERS, providerCreds } from './connector-provider-registry';
import { redirectUri } from './connector-oauth-ceremony';
import {
  createFreshQualifiedGrant, getQualifiedGrant, listQualifiedGrants, reconnectFreshQualifiedGrant,
  revokeQualifiedGrant, type FreshQualifiedGrantInput, type QualifiedGrantMetadata,
} from './connector-qualified-grants';
import { withQualifiedConnectorSession } from './connector-qualified-session';
import type { QualifiedConnectorPrincipal, QualifiedConnectorQueryable } from './connector-qualified-token-crypto';
import { exchangeQualifiedSmartThings, verifyQualifiedSmartThings } from './connector-qualified-smartthings';

const log = createChildLogger({ module: 'connector-qualified-routes' });
const PROVIDER = 'smartthings';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type CompletedConsent = ConnectorConsent & { code?: string; error?: string; expiresAt: number };
interface Scope { principal: QualifiedConnectorPrincipal; signal: AbortSignal; check(): void }
class Refusal extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}
function refuse(status: number, code: string): never { throw new Refusal(status, code); }
function principal(req: Request): QualifiedConnectorPrincipal {
  const me = caller(req);
  if (!me) refuse(401, 'not_authenticated');
  const identity = getRequestIdentity();
  if (!me.principalIssuer || !identity || identity.system === true || identity.sub !== me.sub
    || identity.principalIssuer !== me.principalIssuer) refuse(403, 'verified_identity_required');
  return Object.freeze({ sub: me.sub, principalIssuer: me.principalIssuer });
}
function fixedFailure(error: unknown): Refusal {
  if (error instanceof Refusal) return error;
  const code = error && typeof error === 'object' && 'code' in error ? error.code : null;
  if (code === 'invalid_input') return new Refusal(400, code);
  if (code === 'not_found_or_stale') return new Refusal(404, code);
  if (code === 'conflict') return new Refusal(409, code);
  if (code === 'not_authorized') return new Refusal(403, code);
  if (code === 'aborted') return new Refusal(408, code);
  if (code === 'storage_failure') return new Refusal(503, code);
  return new Refusal(502, 'qualified_connector_unavailable');
}
async function requestScope(req: Request, res: Response, work: (scope: Scope) => Promise<void>): Promise<void> {
  const started = Date.now(), abort = new AbortController();
  const close = () => { if (!res.writableEnded) abort.abort(); };
  const cancel = () => abort.abort();
  const timer = setTimeout(cancel, 30000);
  req.once('aborted', cancel); res.once('close', close);
  res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
  log.debug({ operation: 'personal_grant' }, 'qualified connector request started');
  try {
    const who = principal(req);
    const check = () => {
      if (abort.signal.aborted || req.aborted || res.destroyed) refuse(408, 'aborted');
      const current = principal(req);
      if (current.sub !== who.sub || current.principalIssuer !== who.principalIssuer) refuse(403, 'verified_identity_required');
    };
    await runWithRequestIdentity({ ...who, isOperator: false }, async () => {
      check();
      await work({ principal: who, signal: abort.signal, check });
    });
  } catch (error) {
    const safe = fixedFailure(error);
    log.error({ err: safe, durationMs: Date.now() - started }, 'qualified connector request refused');
    if (!res.headersSent && !res.destroyed) res.status(safe.status).json({ error: safe.code });
  } finally {
    clearTimeout(timer); req.off('aborted', cancel); res.off('close', close);
    log.debug({ durationMs: Date.now() - started }, 'qualified connector request completed');
  }
}
async function transaction<T>(ctx: AppContext, scope: Scope, work: (db: QualifiedConnectorQueryable) => Promise<T>): Promise<T> {
  scope.check();
  const result = await withQualifiedConnectorSession(ctx.pool, scope.principal, async db => {
    scope.check();
    const value = await work(db);
    scope.check(); // Refuse inside the transaction so identity/consent loss rolls back before COMMIT.
    return value;
  }, { signal: scope.signal });
  scope.check(); // A completed commit cannot be undone here, but its metadata must not leak.
  return result;
}
function mutationOrigin(req: Request): void {
  const origin = connectorOrigin(req);
  if (!origin || req.get('origin') !== origin) refuse(403, 'same_origin_required');
}
function scalar(value: unknown): string {
  if (typeof value !== 'string' || !value || value !== value.trim()) refuse(400, 'invalid_input');
  return value;
}
function connectionId(value: unknown): string {
  const id = scalar(value);
  if (!UUID.test(id)) refuse(400, 'invalid_input');
  return id;
}
function matchRevision(req: Request): string {
  const value = req.get('if-match');
  if (!value) refuse(428, 'revision_required');
  const match = /^"([1-9][0-9]{0,18})"$/.exec(value);
  if (!match || BigInt(match[1]) > 9223372036854775807n) refuse(400, 'invalid_input');
  return match[1];
}
function metadata(res: Response, grant: QualifiedGrantMetadata): void {
  res.set('ETag', '"' + grant.revision + '"').json({ connection: grant });
}
async function getTarget(ctx: AppContext, scope: Scope, id: string): Promise<QualifiedGrantMetadata> {
  const target = await transaction(ctx, scope, db => getQualifiedGrant(db, scope.principal, { connectionId: id }));
  scope.check();
  if (target.provider !== PROVIDER) refuse(404, 'not_found_or_stale');
  return target;
}
async function saveFresh(ctx: AppContext, scope: Scope, fresh: FreshQualifiedGrantInput,
  reconnect?: { connectionId: string; accountKey: string; expectedRevision: string }): Promise<QualifiedGrantMetadata> {
  scope.check();
  if (reconnect && reconnect.accountKey !== fresh.validatedIdentity.accountKey) refuse(409, 'account_mismatch');
  return transaction(ctx, scope, db => reconnect
    ? reconnectFreshQualifiedGrant(db, scope.principal, { ...fresh, connectionId: reconnect.connectionId, expectedRevision: reconnect.expectedRevision })
    : createFreshQualifiedGrant(db, scope.principal, fresh));
}
async function start(req: Request, res: Response, ctx: AppContext, ceremonies: ConnectorOAuthCeremonies, scope: Scope): Promise<void> {
  if (Object.keys(req.query).some(key => key !== 'reconnect')) refuse(400, 'invalid_input');
  const origin = connectorOrigin(req), creds = providerCreds(PROVIDER), def = PROVIDERS[PROVIDER];
  if (!origin) refuse(400, 'origin_not_configured');
  if (!creds.clientId || !creds.clientSecret) refuse(503, 'provider_not_configured');
  const target = req.query.reconnect === undefined ? undefined : await getTarget(ctx, scope, connectionId(req.query.reconnect));
  scope.check();
  const reconnect = target ? { connectionId: target.connectionId, accountKey: target.accountKey, expectedRevision: target.revision } : undefined;
  const consent = ceremonies.issue({ provider: PROVIDER, caller: { ...scope.principal, email: '' },
    origin, redirect: redirectUri(PROVIDER), qualified: { scope: 'personal', reconnect } });
  res.cookie(consent.cookieName, consent.cookieSecret, { httpOnly: true, secure: origin.startsWith('https:'),
    sameSite: 'lax', maxAge: CONNECTOR_CEREMONY_TTL, path: '/api/connect' });
  const params = new URLSearchParams({ client_id: creds.clientId, redirect_uri: redirectUri(PROVIDER),
    response_type: 'code', scope: def.scopes.join(def.scopeSep), ...def.authParams, state: consent.state });
  res.redirect(302, def.authUrl + '?' + params.toString());
}
async function paste(req: Request, res: Response, ctx: AppContext, scope: Scope): Promise<void> {
  mutationOrigin(req);
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)
    || Object.keys(req.body).some(key => key !== 'token')) refuse(400, 'invalid_input');
  const accessToken = scalar(req.body.token);
  if (Buffer.byteLength(accessToken) > 65536 || /[\u0000-\u001f\u007f]/u.test(accessToken)) refuse(400, 'invalid_input');
  const target = req.params.connectionId ? await getTarget(ctx, scope, connectionId(req.params.connectionId)) : undefined;
  const expectedRevision = target ? matchRevision(req) : undefined;
  if (target && expectedRevision !== target.revision) refuse(404, 'not_found_or_stale');
  const validatedIdentity = await verifyQualifiedSmartThings(accessToken, { expectedAccountKey: target?.accountKey, signal: scope.signal });
  scope.check();
  const reconnect = target ? { connectionId: target.connectionId, accountKey: target.accountKey, expectedRevision: expectedRevision! } : undefined;
  metadata(res, await saveFresh(ctx, scope, { validatedIdentity, accessToken, refreshToken: null, expiresAt: null }, reconnect));
}

/**
 * @description Register opt-in personal grant endpoints ahead of generic connector routes; all remain behind connectorCallbackAuth.
 * @param router Authenticated connectors router.
 * @param ctx Existing application database pool with request GUC wrapper.
 * @param ceremonies Shared browser-bound state store; provider callbacks keep their registered URL.
 * @returns Nothing; only metadata can be returned, never credentials.
 */
export function registerQualifiedConnectorRoutes(router: Router, ctx: AppContext, ceremonies: ConnectorOAuthCeremonies): void {
  router.get('/qualified', (req, res) => requestScope(req, res, async scope => {
    if (Object.keys(req.query).some(key => !['limit', 'afterConnectionId'].includes(key))) refuse(400, 'invalid_input');
    const limitText = req.query.limit === undefined ? undefined : scalar(req.query.limit);
    if (limitText !== undefined && !/^[1-9][0-9]{0,2}$/.test(limitText)) refuse(400, 'invalid_input');
    const input = { limit: limitText === undefined ? undefined : Number(limitText),
      afterConnectionId: req.query.afterConnectionId === undefined ? undefined : connectionId(req.query.afterConnectionId) };
    res.json({ connections: await transaction(ctx, scope, db => listQualifiedGrants(db, scope.principal, input)) });
  }));
  router.get('/qualified/smartthings/start', (req, res) => requestScope(req, res, scope => start(req, res, ctx, ceremonies, scope)));
  router.post('/qualified/smartthings/token', (req, res) => requestScope(req, res, scope => paste(req, res, ctx, scope)));
  router.post('/qualified/smartthings/:connectionId/token', (req, res) => requestScope(req, res, scope => paste(req, res, ctx, scope)));
  router.get('/qualified/:connectionId', (req, res) => requestScope(req, res, async scope => {
    metadata(res, await getTarget(ctx, scope, connectionId(req.params.connectionId)));
  }));
  router.delete('/qualified/:connectionId', (req, res) => requestScope(req, res, async scope => {
    mutationOrigin(req);
    const id = connectionId(req.params.connectionId), expectedRevision = matchRevision(req);
    const target = await getTarget(ctx, scope, id);
    metadata(res, await transaction(ctx, scope, db => revokeQualifiedGrant(db, scope.principal,
      { connectionId: id, provider: target.provider, accountKey: target.accountKey, expectedRevision })));
  }));
}

/**
 * @description Complete only the server-captured qualified intent after the existing browser/issuer ceremony has been redeemed.
 * @param req Original authenticated browser completion.
 * @param res Metadata-free completion redirect or fixed sanitized error.
 * @param ctx Request-bound application pool.
 * @param data Consumed server-side consent; browser query cannot select a target or namespace.
 * @returns Completion after validated fresh provider credentials have been committed; never enables device actions.
 */
export async function completeQualifiedConnector(req: Request, res: Response, ctx: AppContext, data: CompletedConsent): Promise<void> {
  await requestScope(req, res, async scope => {
    if (data.provider !== PROVIDER || data.qualified?.scope !== 'personal' || data.tenant
      || data.caller.sub !== scope.principal.sub || data.caller.principalIssuer !== scope.principal.principalIssuer
      || data.expiresAt <= Date.now() || data.redirect !== redirectUri(PROVIDER)) refuse(400, 'invalid_qualified_consent');
    if (data.error || !data.code) refuse(400, 'provider_consent_refused');
    const expiresAt = data.expiresAt;
    const consentScope: Scope = { ...scope, check: () => {
      scope.check();
      if (expiresAt <= Date.now()) refuse(400, 'invalid_qualified_consent');
    } };
    const fresh = await exchangeQualifiedSmartThings(data.code, { redirect: data.redirect, signal: scope.signal });
    consentScope.check();
    const validatedIdentity = await verifyQualifiedSmartThings(fresh.accessToken,
      { expectedAccountKey: data.qualified.reconnect?.accountKey, signal: scope.signal });
    consentScope.check();
    const result = await saveFresh(ctx, consentScope, { ...fresh, validatedIdentity }, data.qualified.reconnect);
    consentScope.check();
    res.redirect(302, '/utilities?qualified=connected&connection=' + encodeURIComponent(result.connectionId));
  });
}
