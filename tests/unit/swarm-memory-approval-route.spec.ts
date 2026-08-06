/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | SEC-05: pin operator-only explicit memory promotion and exact approval-subject evidence.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | SEC-05 audit: require a valid exact-content digest at the HTTP approval boundary.
 */

import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentMemoryService, SwarmMemoryService } from '../../src/features/agent-management';
import { createMemoryRoutes } from '../../src/app/extensions/swarm/routes/memory-routes';

const originalOperatorSubs = process.env.OSHAL_OPERATOR_SUBS;

function buildServer(swarmMemory: SwarmMemoryService) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const subject = req.header('x-test-sub');
    (req as unknown as { oidc: unknown }).oidc = {
      isAuthenticated: () => true,
      user: subject ? { sub: subject } : {},
    };
    next();
  });
  app.use(createMemoryRoutes({} as AgentMemoryService, swarmMemory));
  return app.listen(0);
}

const APPROVED_DIGEST = 'a'.repeat(64);

async function postApproval(
  baseUrl: string,
  subject: string,
  body: Record<string, unknown> = { contentSha256: APPROVED_DIGEST },
): Promise<Response> {
  return fetch(`${baseUrl}/shared/memory-1/approve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-test-sub': subject },
    body: JSON.stringify(body),
  });
}

describe('swarm memory approval route', () => {
  afterEach(() => {
    if (originalOperatorSubs === undefined) delete process.env.OSHAL_OPERATOR_SUBS;
    else process.env.OSHAL_OPERATOR_SUBS = originalOperatorSubs;
  });

  it('rejects subject aliases and records the exact authenticated operator subject', async () => {
    process.env.OSHAL_OPERATOR_SUBS = 'Operator-Exact';
    const promoteMemory = vi.fn(async () => ({
      trustLevel: 'approved', source: 'swarm-execution',
      createdByWorkload: 'worker-1', approvedBySub: 'Operator-Exact',
    }));
    const server = buildServer({ promoteMemory } as unknown as SwarmMemoryService);
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;
    try {
      const aliasResponse = await postApproval(baseUrl, 'operator-exact');
      expect(aliasResponse.status).toBe(403);
      expect(promoteMemory).not.toHaveBeenCalled();

      const response = await postApproval(baseUrl, 'Operator-Exact');
      expect(response.status).toBe(200);
      expect(promoteMemory).toHaveBeenCalledWith('memory-1', {
        kind: 'explicit-approval', approvedBySub: 'Operator-Exact',
        contentSha256: APPROVED_DIGEST,
        publishShared: false,
      });
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('rejects missing or malformed approval digests before touching durable memory', async () => {
    process.env.OSHAL_OPERATOR_SUBS = 'Operator-Exact';
    const promoteMemory = vi.fn();
    const server = buildServer({ promoteMemory } as unknown as SwarmMemoryService);
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;
    try {
      expect((await postApproval(baseUrl, 'Operator-Exact', {})).status).toBe(400);
      expect((await postApproval(baseUrl, 'Operator-Exact', {
        contentSha256: 'not-a-digest',
      })).status).toBe(400);
      expect(promoteMemory).not.toHaveBeenCalled();
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
