/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Regression guard for BACKLOG "Deploy verification cannot clean its Jarvis task while oshal-engineering is inactive". Proves /api/tasks is framework-owned, not captured by oshal-engineering, so synthetic task cleanup DELETE /api/tasks/:taskId succeeds with HTTP 204 when oshal-engineering is inactive, while foreign deletions and genuine inactive apps remain refused.
 */

import express, { type Request, type Response } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import path from 'node:path';
import { readManifest, SwarmAppService, type AppAccessResolver } from '../../src/features/swarm-apps';
import { createSwarmAppGateMiddleware } from '../../src/app/middleware/swarm-app-gate-middleware';
import { createTaskRoutes } from '../../src/app/routes/task-routes';
import { InMemoryTaskStore } from '../../src/entities/task';
import { InMemoryMessageStore } from '../../src/entities/message';
import { runWithRequestIdentity } from '../../src/shared/services/database/request-identity';

describe('deploy verification task cleanup route ownership', () => {
  const KERNEL_MANIFEST = path.resolve('swarm-apps/oshal-engineering.yaml');
  const BUILD_MANIFEST = path.resolve('swarm-apps-build/oshal-engineering.yaml');

  it('proves oshal-engineering manifests never claim /api/tasks or /api/workflow-studio', () => {
    for (const manifestPath of [KERNEL_MANIFEST, BUILD_MANIFEST]) {
      const manifest = readManifest(manifestPath);
      const routes = manifest.routes ?? [];
      const mountPaths = routes.map((r) => r.mountPath).filter(Boolean);
      expect(mountPaths, `${manifestPath} must not claim /api/tasks`).not.toContain('/api/tasks');
      expect(mountPaths, `${manifestPath} must not claim /api/workflow-studio`).not.toContain('/api/workflow-studio');
    }
  });

  describe('real HTTP boundary: gate middleware + task router with oshal-engineering inactive', () => {
    let server: Server;
    let baseUrl: string;
    let taskStore: InMemoryTaskStore;
    let messageStore: InMemoryMessageStore;

    const OPERATOR_SUB = 'auth0|deploy-verifier-operator';
    const FOREIGN_SUB = 'auth0|foreign-user';
    const ISSUER = 'https://identity.example.test';

    beforeEach(async () => {
      taskStore = new InMemoryTaskStore();
      messageStore = new InMemoryMessageStore();

      // Mock SwarmAppService ownerOf: oshal-engineering is inactive, but DOES NOT own /api/tasks.
      // Another app 'inactive-app' owns '/api/inactive-app' to prove gate enforcement.
      const service = {
        ownerOf: vi.fn((requestPath: string) => {
          if (requestPath.startsWith('/api/inactive-app')) {
            return { appName: 'inactive-app', status: 'inactive' as const };
          }
          // /api/tasks has no app owner -> framework-owned (null)
          return null;
        }),
      } as unknown as SwarmAppService;

      const resolver = {
        resolveForPrincipal: vi.fn(),
      } as unknown as AppAccessResolver;

      const app = express();
      app.use(express.json());

      // Identity middleware: read identity headers
      app.use((req: Request, _res: Response, next) => {
        const sub = (req.headers['x-test-sub'] as string) || OPERATOR_SUB;
        const isOp = req.headers['x-test-operator'] === 'true';
        runWithRequestIdentity({ sub, principalIssuer: ISSUER, isOperator: isOp }, () => {
          Object.assign(req, {
            oidc: {
              isAuthenticated: () => true,
              user: { sub },
              idTokenClaims: { iss: ISSUER },
            },
          });
          next();
        });
      });

      // App gate middleware
      app.use(createSwarmAppGateMiddleware(service, resolver));

      // Task routes
      const ctx = {
        taskStore,
        messageStore,
        memoryService: {
          createCheckpoint: async () => ({}),
          listCheckpoints: async () => [],
        },
        workspaceBootstrapService: {
          getTaskWorkspaceStatus: async () => ({}),
          bootstrapTaskWorkspace: async () => ({}),
        },
        workspaceService: {
          resolveTaskOwner: async (taskId: string) => (await taskStore.get(taskId))?.ownerSub ?? null,
        },
        orchestrator: {
          processMessage: async () => ({ success: true, response: 'ok' }),
        },
        pool: {},
      } as never;

      app.use('/api/tasks', createTaskRoutes(ctx));
      app.all('/api/inactive-app/*rest', (_req, res) => res.json({ reached: true }));

      server = createServer(app);
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    afterEach(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    it('successfully cleans up synthetic task and messages while oshal-engineering is inactive', async () => {
      const sessionId = 'deploy-verify-9278c0ec-4d5c-475c-93ab-59974c0acee0';

      // Seed synthetic task created by deploy verification
      await taskStore.create({
        taskId: sessionId,
        title: 'deploy verification ask',
        ownerSub: OPERATOR_SUB,
        processingMode: 'agentic',
      });

      // Seed synthetic messages
      await messageStore.save({
        taskId: sessionId,
        role: 'user',
        type: 'task',
        text: 'Are all services healthy?',
      });
      await messageStore.save({
        taskId: sessionId,
        role: 'assistant',
        type: 'task',
        text: 'All services healthy and responsive.',
      });

      // Confirm row presence before cleanup
      expect(await taskStore.get(sessionId)).toBeDefined();
      expect(await messageStore.getByTask(sessionId)).toHaveLength(2);

      // Execute exact deploy verification cleanup call: DELETE /api/tasks/<sessionId>
      const response = await fetch(`${baseUrl}/api/tasks/${sessionId}`, {
        method: 'DELETE',
        headers: {
          'x-test-sub': OPERATOR_SUB,
          'x-test-operator': 'true',
        },
      });

      // Must succeed with 204 No Content (NOT 503 application_inactive)
      expect(response.status).toBe(204);

      // Verify the exact synthetic chat_tasks row and chat_messages are completely absent afterward
      expect(await taskStore.get(sessionId)).toBeNull();
      expect(await messageStore.getByTask(sessionId)).toEqual([]);
    });

    it('refuses foreign cleanup and non-existent task deletion', async () => {
      const targetSessionId = 'deploy-verify-protected-session-1';

      await taskStore.create({
        taskId: targetSessionId,
        title: 'private user task',
        ownerSub: OPERATOR_SUB,
        processingMode: 'agentic',
      });

      // Foreign user attempting to delete
      const foreignResponse = await fetch(`${baseUrl}/api/tasks/${targetSessionId}`, {
        method: 'DELETE',
        headers: {
          'x-test-sub': FOREIGN_SUB,
          'x-test-operator': 'false',
        },
      });

      expect(foreignResponse.status).toBe(404);
      // Original task still preserved
      expect(await taskStore.get(targetSessionId)).toBeDefined();

      // Deleting a non-existent task returns 404
      const missingResponse = await fetch(`${baseUrl}/api/tasks/non-existent-task`, {
        method: 'DELETE',
        headers: {
          'x-test-sub': OPERATOR_SUB,
          'x-test-operator': 'true',
        },
      });
      expect(missingResponse.status).toBe(404);
    });

    it('preserves 503 application_inactive for genuinely inactive app routes', async () => {
      const response = await fetch(`${baseUrl}/api/inactive-app/resource`, {
        headers: {
          'x-test-sub': OPERATOR_SUB,
          'x-test-operator': 'true',
        },
      });

      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toMatchObject({
        error: 'Application inactive',
        appName: 'inactive-app',
      });
    });
  });
});
