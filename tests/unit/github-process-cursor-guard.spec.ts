/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Proved the GitHub process shortcut cannot checkpoint intake before processing while generic providers retain explicit behavior
 */

import type { AddressInfo } from 'node:net';
import express from 'express';
import { describe, expect, it, vi } from 'vitest';
import { SwarmOrchestrationController } from '@/features/swarm-orchestration/controllers/swarm-orchestration-controller';

describe('GitHub provider process cursor guard', () => {
  it('forces persistCursor off for GitHub without changing generic providers', async () => {
    const processProvider = vi.fn(async (provider: string) => ({
      runId: `run-${provider}`,
      provider,
      source: 'test',
      effectiveCursor: null,
      pulledCount: 0,
      processedCount: 0,
      processed: [],
    }));
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const controller = new SwarmOrchestrationController(
      { processProvider } as never,
      {} as never,
      {} as never,
      logger,
    );
    const app = express();
    app.use(express.json());
    app.post('/providers/:provider/process', controller.processProvider);
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const port = (server.address() as AddressInfo).port;

    try {
      const github = await fetch(`http://127.0.0.1:${port}/providers/github/process`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ persistCursor: true, useStoredCursor: true }),
      });
      const plane = await fetch(`http://127.0.0.1:${port}/providers/plane/process`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ persistCursor: true, useStoredCursor: true }),
      });

      expect(github.status).toBe(200);
      expect(plane.status).toBe(200);
      expect(processProvider).toHaveBeenNthCalledWith(
        1,
        'github',
        expect.objectContaining({ persistCursor: false, useStoredCursor: true }),
      );
      expect(processProvider).toHaveBeenNthCalledWith(
        2,
        'plane',
        expect.objectContaining({ persistCursor: true, useStoredCursor: true }),
      );
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (
        error ? reject(error) : resolve()
      )));
    }
  });
});
