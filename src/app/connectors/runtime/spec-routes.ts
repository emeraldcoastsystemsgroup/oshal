/**
 * Connector spec -> live HTTP routes (ADR-065 Phase 5).
 *
 * The bridge from "validated spec" to "running API": mount one of these per connector and every
 * declared resource becomes an endpoint, with credentials resolved per-request through the ADR-056
 * broker. Adding a connector to the live app becomes: drop a connector.yaml, then one line —
 *
 *   app.use('/api/connectors/github', requiresAuth, createConnectorSpecRouter(githubSpec, {
 *     resolveCreds: async (req) => ({ token: brokeredBearer(getValidAccessToken, pool, req.userSub, 'github') }),
 *   }));
 *
 * No bespoke route file per connector. The core (`invokeSpecResource`) is a pure function so it
 * unit-tests with no HTTP server (same pattern as the webhook ingress).
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — ADR-065 Phase 5. Additive;
 *            | not mounted in server.ts by default (callers wire it with their broker).
 * -----------------------------------------------------------------------------
 * @module connectors/runtime/spec-routes
 */

import { Router, type Request, type Response } from 'express';
import { hasExplicitWriteConfirmation, confirmationRequiredPayload } from '@/shared/security/explicit-write-confirmation';
import {
  buildConnectorActionPreview,
  describeConnectorAction,
  isConnectorActionDryRun,
  requiresConnectorConfirmation,
  supportsConnectorDryRun,
} from './action-safety';
import { ConnectorError } from './connector-error';
import { buildClientFromSpec, type BuildSpecOptions, type ConnectorSpec } from './spec';

export interface SpecRouteResult {
  status: number;
  body: { ok: boolean; data?: unknown; error?: string; code?: string };
}

/** Map a thrown error to an HTTP status + body. ConnectorError carries its own status/code. */
function errToResult(e: unknown): SpecRouteResult {
  if (e instanceof ConnectorError) {
    const status = typeof e.status === 'number' ? e.status : e.code === 'bad_request' ? 400 : e.code === 'auth' ? 401 : 502;
    return { status, body: { ok: false, error: e.message, code: e.code } };
  }
  const msg = e instanceof Error ? e.message : String(e);
  // An unknown-resource / bad-input error from the generator is the caller's fault.
  const status = /unknown resource/.test(msg) ? 404 : 400;
  return { status, body: { ok: false, error: msg } };
}

/**
 * Pure call: build the client from the spec + caller creds, invoke the resource, return status+body.
 * No Express — directly testable.
 */
export async function invokeSpecResource(
  spec: ConnectorSpec,
  creds: BuildSpecOptions,
  resource: string,
  inputs: Record<string, unknown>,
): Promise<SpecRouteResult> {
  try {
    const resourceSpec = spec.resources.find((item) => item.name === resource);
    if (!resourceSpec) {
      return { status: 404, body: { ok: false, error: `${spec.provider}: unknown resource '${resource}'` } };
    }
    if (isConnectorActionDryRun(inputs) && supportsConnectorDryRun(resourceSpec)) {
      return { status: 200, body: { ok: true, data: buildConnectorActionPreview(spec, resourceSpec, inputs) } };
    }
    if (requiresConnectorConfirmation(resourceSpec) && !hasExplicitWriteConfirmation(inputs)) {
      return {
        status: 400,
        body: {
          ok: false,
          code: 'confirmation_required',
          error: String(confirmationRequiredPayload('connector-action', `${spec.provider}.${resource}`).message),
          data: describeConnectorAction(spec, resourceSpec),
        },
      };
    }
    const client = buildClientFromSpec(spec, creds);
    const data = await client.call(resource, inputs || {});
    return { status: 200, body: { ok: true, data } };
  } catch (e) {
    return errToResult(e);
  }
}

export interface SpecRouteDeps {
  /** Resolve build-time credentials (token/apiKey) for the calling request — wire the broker here. */
  resolveCreds: (req: Request) => BuildSpecOptions | Promise<BuildSpecOptions>;
  /** Pull resource inputs from the request (default: body for writes, query for GET). */
  inputsFrom?: (req: Request) => Record<string, unknown>;
}

/**
 * Express router exposing a connector spec:
 *   GET  /_resources        -> the resource/tool catalog (introspection)
 *   POST /:resource         -> call a resource; request body (or inputsFrom) supplies the inputs
 */
export function createConnectorSpecRouter(spec: ConnectorSpec, deps: SpecRouteDeps): Router {
  const router = Router();
  const inputsFrom = deps.inputsFrom ?? ((req: Request) => ({ ...(req.query as Record<string, unknown>), ...((req.body as Record<string, unknown>) || {}) }));

  router.get('/_resources', (_req: Request, res: Response) => {
    res.json({
      provider: spec.provider,
      displayName: spec.displayName,
      resources: spec.resources.map((r) => ({ ...describeConnectorAction(spec, r) })),
    });
  });

  router.post('/:resource', async (req: Request, res: Response) => {
    const creds = await deps.resolveCreds(req);
    const result = await invokeSpecResource(spec, creds, String(req.params.resource), inputsFrom(req));
    res.status(result.status).json(result.body);
  });

  return router;
}
