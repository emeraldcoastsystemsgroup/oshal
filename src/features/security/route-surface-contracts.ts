/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added executable security contracts for helper-mounted, mixed-auth, and non-/api control surfaces that the literal server.ts mount scanner cannot fully classify.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { RawFinding } from './types';

/** @description One source file and the load-bearing guard expressions it must retain. */
export interface RouteGuardRequirement {
  file: string;
  markers: readonly string[];
}

/** @description Auditable contract for a route the ordinary literal mount scan cannot see. */
export interface RouteSurfaceContract {
  id: string;
  route: string;
  registrationMarker: string;
  posture: string;
  requirements: readonly RouteGuardRequirement[];
}

/**
 * @description Known non-standard route registrations. Each entry names the server composition
 * marker and the exact internal guard rails that make anonymous machine delivery intentional.
 */
export const ROUTE_SURFACE_CONTRACTS: readonly RouteSurfaceContract[] = [
  {
    id: 'connector-webhook-ingress',
    route: '/api/hooks/:provider/:event',
    registrationMarker: 'mountConnectorWebhookRoutes(app, ctx)',
    posture: 'Provider signature is verified over the exact raw body before dispatch.',
    requirements: [
      {
        file: 'src/app/routes/connector-webhook-routes.ts',
        markers: ["app.use('/api/hooks'", 'createWebhookIngressRouter({', 'resolveSecret(v.secret)'],
      },
      {
        file: 'src/app/connectors/webhooks/webhook-ingress.ts',
        markers: ['export function verifySignature', 'if (!spec.secret)', 'const verdict = verifySignature'],
      },
    ],
  },
  {
    id: 'facebook-data-deletion',
    route: '/auth/facebook/data-deletion',
    registrationMarker: "app.post('/auth/facebook/data-deletion'",
    posture: 'Meta HMAC signed_request verification precedes one bounded system-identity delete.',
    // Two files since the 2026-08-06 connectors-routes decomposition: signed_request verification
    // moved to connector-oauth-ceremony.ts while the handler and its single delete stayed put. The
    // constant-time compare is asserted where it now lives rather than dropped — a contract that
    // silently stops finding its marker is a contract that stops protecting the route.
    requirements: [
      {
        file: 'src/app/routes/connector-oauth-ceremony.ts',
        markers: ['crypto.timingSafeEqual(sig, expected)'],
      },
      {
        file: 'src/app/routes/connectors-routes.ts',
        markers: [
          'if (!data || !data.user_id)',
          'runWithSystemIdentity(() => ctx.pool.query(',
        ],
      },
    ],
  },
  {
    id: 'telegram-channel-webhook',
    route: '/api/channels/telegram/webhook',
    registrationMarker: 'createChatChannelRoutes(ctx, requiresAuth)',
    posture: 'The webhook fails closed on token absence/mismatch; every user route carries OIDC.',
    requirements: [{
      file: 'src/app/routes/chat-channel-routes.ts',
      markers: [
        'if (!token) { res.sendStatus(503); return; }',
        'verifyWebhookSecret(headerSecret, expected)',
        "router.get('/', requiresAuth",
        "router.post('/telegram/link', requiresAuth",
        "router.delete('/telegram/:channelUserId', requiresAuth",
        "router.post('/telegram/register-webhook', requiresAuth",
      ],
    }],
  },
  {
    id: 'node-pool-control-plane',
    route: '/node/*',
    registrationMarker: "app.use('/node', createNodePoolRoutes(nodePoolState))",
    posture: 'Every node control/status request requires the configured machine secret.',
    requirements: [{
      file: 'src/app/routes/node-pool-routes.ts',
      markers: ['router.use(requireServiceSecret);', 'assignmentRequestSchema.safeParse(req.body)'],
    }],
  },
];

type SourceReader = (absolutePath: string) => string;

/**
 * @description Audits active non-standard registrations against their source-level guard
 * contract. A missing file or marker is a high-severity finding rather than a silent skip.
 * @param serverSource - Current server.ts source.
 * @param root - Repository/security scan root.
 * @param contracts - Contracts to evaluate; injectable for focused tests.
 * @param readSource - Source reader; injectable for guard-removal tests.
 * @returns High-severity route-auth findings for broken active contracts.
 */
export function auditRouteSurfaceContracts(
  serverSource: string,
  root: string,
  contracts: readonly RouteSurfaceContract[] = ROUTE_SURFACE_CONTRACTS,
  readSource: SourceReader = (absolutePath) => fs.readFileSync(absolutePath, 'utf8'),
): RawFinding[] {
  const active = contracts.filter((contract) => serverSource.includes(contract.registrationMarker));
  return active.flatMap((contract) => contractFindings(contract, root, readSource));
}

function contractFindings(
  contract: RouteSurfaceContract,
  root: string,
  readSource: SourceReader,
): RawFinding[] {
  const missing = contract.requirements.flatMap((requirement) => missingMarkers(requirement, root, readSource));
  if (missing.length === 0) return [];
  return [{
    category: 'route_auth',
    severity: 'high',
    title: `Route security contract broken: ${contract.route}`,
    detail: `${contract.route} is registered through a helper, mixed-auth router, or non-/api mount. `
      + `Its reviewed fail-closed contract is incomplete: ${missing.join('; ')}. ${contract.posture}`,
    source: contract.requirements[0]?.file || 'src/app/server.ts',
    evidence: { contractId: contract.id, route: contract.route, missing },
    fingerprint: `route_auth:contract:${contract.id}`,
  }];
}

function missingMarkers(
  requirement: RouteGuardRequirement,
  root: string,
  readSource: SourceReader,
): string[] {
  let source: string;
  try {
    source = readSource(path.join(root, requirement.file));
  } catch {
    return [`${requirement.file} is unreadable`];
  }
  return requirement.markers
    .filter((marker) => !source.includes(marker))
    .map((marker) => `${requirement.file} missing ${JSON.stringify(marker)}`);
}
