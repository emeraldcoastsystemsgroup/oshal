/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added regression coverage for the direct rag-query runtime tool and optional Chroma MCP defaults
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { test, expect } from '@playwright/test';
import { ToolExecutorService } from '../src/features/chat-orchestration/services/tool-executor-service';
import { StreamManager } from '../src/features/streaming';
import { ClineRuntimeConfigSyncService } from '../src/features/llm-provider/services/cline-runtime-config-sync-service';

test.describe('RAG Query Tool', () => {
  test('queries across all collections through the built-in RAG service', async () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-rag-query-workspace-'));
    process.env.CLINE_WORKSPACE_ROOT = workspaceRoot;
    process.env.CHROMADB_URL = 'http://chromadb.test';

    const originalFetch = global.fetch;
    global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

      if (url === 'http://chromadb.test/api/v1/collections') {
        return jsonResponse([
          { name: 'alpha', id: 'alpha-id' },
          { name: 'beta', id: 'beta-id' },
        ]);
      }

      if (url === 'http://chromadb.test/api/v1/collections/alpha') {
        return jsonResponse({ id: 'alpha-id', name: 'alpha' });
      }

      if (url === 'http://chromadb.test/api/v1/collections/beta') {
        return jsonResponse({ id: 'beta-id', name: 'beta' });
      }

      if (url === 'http://chromadb.test/api/v1/collections/alpha-id/query') {
        return jsonResponse({
          ids: [['alpha-doc']],
          documents: [['Alpha result']],
          metadatas: [[{ source: 'alpha-source' }]],
          distances: [[0.1]],
        });
      }

      if (url === 'http://chromadb.test/api/v1/collections/beta-id/query') {
        return jsonResponse({
          ids: [['beta-doc']],
          documents: [['Beta result']],
          metadatas: [[{ source: 'beta-source' }]],
          distances: [[0.4]],
        });
      }

      throw new Error(`Unexpected fetch request: ${url} ${init?.method || 'GET'}`);
    }) as typeof global.fetch;

    try {
      const executor = new ToolExecutorService({ streamManager: new StreamManager() });
      const raw = await executor.executeTool('rag-query-task', 'rag-query', {
        query: 'platform report',
        topK: 2,
      });
      const parsed = JSON.parse(raw) as Record<string, any>;

      expect(parsed.collection).toBe('all');
      expect(parsed.count).toBe(2);
      expect(parsed.results[0].collection).toBe('alpha');
      expect(parsed.results[0].score).toBeGreaterThan(parsed.results[1].score);
      expect(parsed.results[1].collection).toBe('beta');
      expect(parsed.results[1].metadata.source).toBe('beta-source');
    } finally {
      global.fetch = originalFetch;
      delete process.env.CLINE_WORKSPACE_ROOT;
      delete process.env.CHROMADB_URL;
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  test('falls back to lexical search when Chroma rejects query_texts without query_embeddings', async () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-rag-query-fallback-'));
    process.env.CLINE_WORKSPACE_ROOT = workspaceRoot;
    process.env.CHROMADB_URL = 'http://chromadb.test';

    const originalFetch = global.fetch;
    global.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

      if (url === 'http://chromadb.test/api/v1/collections/default') {
        return jsonResponse({ id: 'default-id', name: 'default' });
      }

      if (url === 'http://chromadb.test/api/v1/collections/default-id/query') {
        return new Response(JSON.stringify({
          detail: [{ loc: ['body', 'query_embeddings'], msg: 'Field required' }],
        }), {
          status: 422,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (url === 'http://chromadb.test/api/v1/collections/default-id/get') {
        return jsonResponse({
          ids: ['doc-1', 'doc-2'],
          documents: ['CLI verification guide for platform report search', 'Unrelated weather note'],
          metadatas: [{ source: 'rag-upload' }, { source: 'other' }],
        });
      }

      throw new Error(`Unexpected fetch request: ${url}`);
    }) as typeof global.fetch;

    try {
      const executor = new ToolExecutorService({ streamManager: new StreamManager() });
      const raw = await executor.executeTool('rag-fallback-task', 'rag-query', {
        query: 'platform report',
        collection: 'default',
        topK: 3,
      });
      const parsed = JSON.parse(raw) as Record<string, any>;

      expect(parsed.collection).toBe('default');
      expect(parsed.count).toBe(1);
      expect(parsed.results[0].id).toBe('doc-1');
      expect(parsed.results[0].text).toContain('platform report');
    } finally {
      global.fetch = originalFetch;
      delete process.env.CLINE_WORKSPACE_ROOT;
      delete process.env.CHROMADB_URL;
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  test('does not inject chroma-mcp into default MCP settings without an explicit URL', async () => {
    const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-rag-query-runtime-'));
    const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-rag-query-output-'));

    try {
      fs.mkdirSync(path.join(runtimeRoot, 'data'), { recursive: true });
      fs.writeFileSync(path.join(runtimeRoot, 'mcp_settings.json'), JSON.stringify({ mcpServers: { filesystem: { command: 'npx' } } }, null, 2));

      const syncService = new ClineRuntimeConfigSyncService(runtimeRoot, outputRoot);
      const settings = syncService.readMcpSettings() as Record<string, any>;

      expect(settings.mcpServers.filesystem.command).toBe('npx');
      expect(settings.mcpServers['chroma-mcp']).toBeUndefined();
    } finally {
      fs.rmSync(runtimeRoot, { recursive: true, force: true });
      fs.rmSync(outputRoot, { recursive: true, force: true });
    }
  });
});

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
