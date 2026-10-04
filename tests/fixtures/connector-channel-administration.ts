/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Real administration routers over isolated connector state and provider recorders, with synthetic authenticated principals.
 */
import express, { type RequestHandler } from 'express';
import type { AddressInfo } from 'node:net';
import { vi } from 'vitest';
import { createConnectorMarketplaceRoutes } from '@/app/routes/connector-marketplace-routes';
import { createChatChannelRoutes } from '@/app/routes/chat-channel-routes';
import { ChannelLinkService, DiscordChannelConfig } from '@/features/chat-channels';
import type { AppContext } from '@/app/composition-root';

/** @description Synthetic verified session seam; production operator middleware remains real. @param req Request. @param res Response. @param next Next middleware. */
const authenticate: RequestHandler = (req, res, next) => {
  const user = req.get('x-fixture-user');
  if (user !== 'member' && user !== 'operator') { res.sendStatus(401); return; }
  const sub = `fixture-${user}`;
  Object.assign(req, { oidc: { isAuthenticated: () => true, user: { sub },
    idTokenClaims: { sub, iss: 'https://identity.example.test', aud: 'oshal' } } });
  next();
};

/** @description Isolated service data and mutation recorders; no provider, live config or database is reached. @returns App context and effects. */
function connectorContext() {
  const overrides = new Map<string, boolean>();
  const mutate = vi.fn(() => ({ id: 'fixture-provider', enabled: true }));
  const register = vi.fn(async () => [{ tool: { name: 'fixture-tool' } }]);
  const deregister = vi.fn(async () => ['fixture-tool']);
  const setForUser = vi.fn(async (sub: string, _provider: string, enabled: boolean) => { overrides.set(sub, enabled); });
  const marketplace = {
    list: () => ({ entries: [], totals: {} }), enableProvider: mutate, disableProvider: mutate,
    removeProvider: mutate, refreshProviderAudit: mutate,
    enableProviderForUser: (sub: string, provider: string) => setForUser(sub, provider, true),
    disableProviderForUser: (sub: string, provider: string) => setForUser(sub, provider, false),
    userEnablementRows: async (sub: string) => overrides.has(sub) ? [{ provider: 'fixture-provider', enabled: overrides.get(sub) }] : [],
    enabledProviderSetForUser: async (sub: string) => new Set(overrides.get(sub) === false ? [] : ['fixture-provider']),
  };
  const ctx = { pool: null, connectorMarketplaceService: marketplace, toolRegistryService: {},
    dynamicToolExecutorRegistry: {}, connectorSpecToolService: { registerConnectorProvider: register,
      deregisterConnectorProvider: deregister } } as unknown as AppContext;
  return { ctx, mutate, register, deregister, setForUser };
}

/** @description Mount real routes over loopback only, with network/database seams explicitly replaced. @returns Requests, effects and cleanup. */
export async function connectorChannelAdministrationFixture() {
  vi.stubEnv('OSHAL_OPERATOR_SUBS', 'fixture-operator'); vi.stubEnv('OSHAL_OPERATOR_EMAILS', '');
  vi.stubEnv('DISCORD_BOT_TOKEN', '');
  vi.spyOn(DiscordChannelConfig.prototype, 'boot').mockResolvedValue(undefined);
  vi.spyOn(ChannelLinkService.prototype, 'ensureSchema').mockResolvedValue(undefined);
  const mint = vi.spyOn(ChannelLinkService.prototype, 'mintLinkCode').mockResolvedValue('fixture-code');
  const unlink = vi.spyOn(ChannelLinkService.prototype, 'unlink').mockResolvedValue(true);
  const service = connectorContext(), app = express(); app.use(express.json());
  app.use('/api/connectors', authenticate, createConnectorMarketplaceRoutes(service.ctx));
  app.use('/api/channels', createChatChannelRoutes(service.ctx, authenticate, { dispatch: vi.fn(async () => 'unused') }));
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(done => server.once('listening', done));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { ...service, mint, unlink,
    call: (route: string, method = 'POST', user = 'member', body: unknown = {}, headers: Record<string, string> = {}) => fetch(base + route,
      { method, headers: { 'x-fixture-user': user, 'content-type': 'application/json', ...headers }, ...(method === 'GET' ? {} : { body: JSON.stringify(body) }) }),
    close: async () => { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()));
      vi.restoreAllMocks(); vi.unstubAllEnvs(); },
  };
}
