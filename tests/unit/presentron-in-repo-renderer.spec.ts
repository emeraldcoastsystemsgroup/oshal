/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the presentron executor swap (BACKLOG "Re-point the presentron chat tool at the real deck renderer"): the tool must render a real .pptx via the in-repo engine into the task workspace (no sidecar HTTP), the any-bot PresentationService.js mock must stay deleted, and VoiceController must load without it and report its presentation endpoints as moved.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Extended for the HTTP-sidecar retirement: the sidecar modules (presentron-integration.ts + the /api/presentations proxy route) must be absent from the tree, and the sidecar-only runtime-config reader (readPresentronRuntimeSettings) must be gone while its RAG/Google-Search siblings remain. The in-repo render path (above) still works.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';
import { StreamManager } from '../../src/features/streaming';
import { ToolExecutorService } from '../../src/features/chat-orchestration/services/tool-executor-service';

const requireModule = createRequire(import.meta.url);

describe('presentron tool — in-repo renderer', () => {
  const previousClineRoot = process.env.CLINE_WORKSPACE_ROOT;
  let tempRoot: string | undefined;

  afterEach(() => {
    if (previousClineRoot === undefined) delete process.env.CLINE_WORKSPACE_ROOT;
    else process.env.CLINE_WORKSPACE_ROOT = previousClineRoot;
    if (tempRoot) {
      fs.rmSync(tempRoot, { recursive: true, force: true });
      tempRoot = undefined;
    }
  });

  it('renders a real themed .pptx into the task workspace via @/features/presentation-generation', async () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'presentron-inrepo-'));
    process.env.CLINE_WORKSPACE_ROOT = tempRoot;
    const executor = new ToolExecutorService({ streamManager: new StreamManager() });

    const result = await executor.executeTool('task-deck', 'presentron', {
      title: 'Quarterly Review',
      theme: 'midnight',
      slides: [
        { title: 'Where we are', content: 'shipped the runtime\nsigned three design partners' },
        { title: 'The numbers', content: '94% :: uptime last quarter\n$1.2M :: pipeline created', notes: 'pause here' },
      ],
    });

    const parsed = JSON.parse(result) as {
      success: boolean; renderer: string; theme: string; slides: number; bytes: number; path: string;
    };
    expect(parsed.success).toBe(true);
    // The executor must resolve the IN-REPO path — this label only exists on the
    // renderPptx-backed handler, never on the retired sidecar client.
    expect(parsed.renderer).toBe('in-repo:presentation-generation');
    expect(parsed.theme).toBe('midnight');
    expect(parsed.slides).toBe(2);

    const rendered = path.join(tempRoot, 'task-deck', parsed.path);
    const buffer = fs.readFileSync(rendered);
    expect(buffer.length).toBe(parsed.bytes);
    // A real OOXML deck is a PK zip — mock JSON or an HTTP error body is not.
    expect(buffer.subarray(0, 2).toString('utf8')).toBe('PK');
    expect(buffer.length).toBeGreaterThan(10_000);
  });

  it('rejects an empty deck instead of calling anything remote', async () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'presentron-inrepo-'));
    process.env.CLINE_WORKSPACE_ROOT = tempRoot;
    const executor = new ToolExecutorService({ streamManager: new StreamManager() });

    await expect(executor.executeTool('task-deck', 'presentron', { title: 'Empty' }))
      .rejects.toThrow(/non-empty "slides" array/);
  });

  it('the any-bot Presentron mock module is gone', () => {
    const mockPath = path.resolve(__dirname, '../../any-bot/server/services/PresentationService.js');
    expect(fs.existsSync(mockPath)).toBe(false);
  });

  it('VoiceController loads without the mock and reports its presentation endpoints as moved', async () => {
    const voiceController = requireModule('../../any-bot/server/controllers/VoiceController.js') as {
      listPresentations(req: object, res: object): Promise<unknown>;
      getPresentation(req: object, res: object): Promise<unknown>;
      getSlides(req: object, res: object): Promise<unknown>;
    };

    for (const invoke of [
      (res: object) => voiceController.listPresentations({}, res),
      (res: object) => voiceController.getPresentation({ params: { id: 'deck-1' } }, res),
      (res: object) => voiceController.getSlides({ params: { id: 'deck-1' } }, res),
    ]) {
      const res = {
        statusCode: 0,
        body: undefined as Record<string, unknown> | undefined,
        status(code: number) { this.statusCode = code; return this; },
        json(payload: Record<string, unknown>) { this.body = payload; return this; },
      };
      await invoke(res);
      expect(res.statusCode).toBe(501);
      expect(res.body).toMatchObject({ success: false, error: 'moved' });
      // No mock presentation data may ever come back from these endpoints again.
      expect(JSON.stringify(res.body)).not.toContain('mock-presentation');
    }
  });

  it('the Presentron HTTP sidecar modules are gone (no source file on disk)', () => {
    // The retired sidecar was two files: the HTTP client that POSTed to presentron:8080,
    // and the /api/presentations proxy route that fronted it. tsc proves nothing in src/
    // re-imports them; this proves the corpses themselves are deleted.
    const sidecarClient = path.resolve(__dirname, '../../src/features/tool-integrations/presentron-integration.ts');
    const sidecarRoute = path.resolve(__dirname, '../../src/app/routes/presentation-routes.ts');
    expect(fs.existsSync(sidecarClient)).toBe(false);
    expect(fs.existsSync(sidecarRoute)).toBe(false);
  });

  it('the sidecar-only runtime-config reader is gone, its siblings remain', async () => {
    const runtimeConfig = await import('../../src/shared/services/runtime-config-loader') as Record<string, unknown>;
    // readPresentronRuntimeSettings was consumed ONLY by the retired /api/presentations proxy.
    expect(runtimeConfig.readPresentronRuntimeSettings).toBeUndefined();
    // Its siblings are untouched — the presentronServiceConfig key still feeds the separate,
    // live presentron-mcp derivation in cline-runtime-config-sync-service.
    expect(typeof runtimeConfig.readRagRuntimeSettings).toBe('function');
    expect(typeof runtimeConfig.readGoogleSearchMcpRuntimeSettings).toBe('function');
  });
});
