/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added tests for GoogleSearchIntegration and KnowledgeEnhancementService (#10 fix)
 */

import { expect, test } from '@playwright/test';
import { GoogleSearchIntegration } from '../src/features/tool-integrations/google-search-integration';
import { KnowledgeEnhancementService } from '../src/features/tool-integrations/knowledge-enhancement-service';

// ═══════════════════════════════════════════════════════════════════════
// 1. GOOGLE SEARCH INTEGRATION
// ═══════════════════════════════════════════════════════════════════════

test.describe('GoogleSearchIntegration', () => {
  test('isConfigured returns false when no credentials set', () => {
    const service = new GoogleSearchIntegration({ apiKey: '', searchEngineId: '' });
    expect(service.isConfigured()).toBe(false);
  });

  test('isConfigured returns true when both credentials are set', () => {
    const service = new GoogleSearchIntegration({ apiKey: 'test-key', searchEngineId: 'test-engine' });
    expect(service.isConfigured()).toBe(true);
  });

  test('search returns empty results when not configured', async () => {
    const service = new GoogleSearchIntegration({ apiKey: '', searchEngineId: '' });
    const response = await service.search('test query');
    expect(response.results).toHaveLength(0);
    expect(response.totalResults).toBe(0);
    expect(response.query).toBe('test query');
  });

  test('getUsageStats starts at zero', () => {
    const service = new GoogleSearchIntegration({ apiKey: '', searchEngineId: '' });
    expect(service.getUsageStats().requestCount).toBe(0);
  });

  test('search with unconfigured service increments no request count', async () => {
    const service = new GoogleSearchIntegration({ apiKey: '', searchEngineId: '' });
    await service.search('query 1');
    await service.search('query 2');
    // No actual API calls made when unconfigured
    expect(service.getUsageStats().requestCount).toBe(0);
  });

  test('search response includes searchTime', async () => {
    const service = new GoogleSearchIntegration({ apiKey: '', searchEngineId: '' });
    const response = await service.search('test');
    expect(response).toHaveProperty('searchTime');
    expect(response.searchTime).toBe(0); // Instant return for unconfigured
  });

  test('constructor accepts partial config and fills defaults', () => {
    const service = new GoogleSearchIntegration({ apiKey: 'key' });
    // Should not throw and should be partially configured (no searchEngineId)
    expect(service.isConfigured()).toBe(false); // Missing searchEngineId
  });

  test('constructor with no args uses environment defaults', () => {
    const service = new GoogleSearchIntegration();
    // Should work without throwing — reads from process.env
    expect(service).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 2. KNOWLEDGE ENHANCEMENT SERVICE
// ═══════════════════════════════════════════════════════════════════════

test.describe('KnowledgeEnhancementService', () => {
  test('enhance with empty queries returns zero results', async () => {
    const searchService = new GoogleSearchIntegration({ apiKey: '', searchEngineId: '' });
    const ragService = createMockRagService();
    const service = new KnowledgeEnhancementService(searchService, ragService);

    const result = await service.enhance([]);
    expect(result.queriesExecuted).toBe(0);
    expect(result.resultsFound).toBe(0);
    expect(result.documentsIngested).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  test('enhance with queries but unconfigured search returns no results', async () => {
    const searchService = new GoogleSearchIntegration({ apiKey: '', searchEngineId: '' });
    const ragService = createMockRagService();
    const service = new KnowledgeEnhancementService(searchService, ragService);

    const result = await service.enhance(['test query 1', 'test query 2']);
    expect(result.queriesExecuted).toBe(2);
    expect(result.resultsFound).toBe(0); // Search returns empty when unconfigured
    expect(result.documentsIngested).toBe(0);
    expect(result.queries).toEqual(['test query 1', 'test query 2']);
  });

  test('enhance respects maxSearchesPerRun config', async () => {
    const searchService = new GoogleSearchIntegration({ apiKey: '', searchEngineId: '' });
    const ragService = createMockRagService();
    const service = new KnowledgeEnhancementService(searchService, ragService, { maxSearchesPerRun: 2 });

    const queries = ['q1', 'q2', 'q3', 'q4', 'q5'];
    const result = await service.enhance(queries);
    expect(result.queriesExecuted).toBe(2);
    expect(result.queries).toEqual(['q1', 'q2']);
  });

  test('getStats reports run count and search stats', async () => {
    const searchService = new GoogleSearchIntegration({ apiKey: '', searchEngineId: '' });
    const ragService = createMockRagService();
    const service = new KnowledgeEnhancementService(searchService, ragService);

    expect(service.getStats().runCount).toBe(0);

    await service.enhance(['test']);
    expect(service.getStats().runCount).toBe(1);

    await service.enhance(['test 2']);
    expect(service.getStats().runCount).toBe(2);
  });

  test('enhance generates unique runIds', async () => {
    const searchService = new GoogleSearchIntegration({ apiKey: '', searchEngineId: '' });
    const ragService = createMockRagService();
    const service = new KnowledgeEnhancementService(searchService, ragService);

    const result1 = await service.enhance(['q1']);
    const result2 = await service.enhance(['q2']);
    expect(result1.runId).not.toBe(result2.runId);
    expect(result1.runId).toMatch(/^ke-/);
  });

  test('enhance reports durationMs', async () => {
    const searchService = new GoogleSearchIntegration({ apiKey: '', searchEngineId: '' });
    const ragService = createMockRagService();
    const service = new KnowledgeEnhancementService(searchService, ragService);

    const result = await service.enhance(['test']);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// TEST HELPERS
// ═══════════════════════════════════════════════════════════════════════

function createMockRagService() {
  return {
    async ensureCollection(_name: string): Promise<void> {},
    async ingest(_documents: string[], _collection: string, _metadata?: Record<string, unknown>): Promise<void> {},
    async query(_query: string, _collection?: string): Promise<{ results: unknown[]; count: number }> {
      return { results: [], count: 0 };
    },
  } as any;
}
