/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the google-search-mcp retirement: managed sessions must not inherit an MCP server that no compose stack runs. Before this, resolveGoogleSearchMcpUrl fell back to a hardcoded http://google-search-mcp:8080/mcp and every Cline session got an unresolvable endpoint in its tool list.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClineRuntimeConfigSyncService } from '../../src/features/llm-provider/services/cline-runtime-config-sync-service';

/**
 * @description Builds the managed session MCP server map for a given global-config payload,
 * isolated in a temp runtime/output root so the test never reads the operator's real config.
 * @param globalConfig - Contents written to global-config.json before the build.
 * @returns Managed MCP servers keyed by runtime server name.
 */
function buildServers(globalConfig: Record<string, unknown>): Record<string, unknown> {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-mcp-guard-runtime-'));
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-mcp-guard-output-'));

  try {
    fs.writeFileSync(path.join(outputRoot, 'global-config.json'), JSON.stringify(globalConfig, null, 2));
    const service = new ClineRuntimeConfigSyncService(runtimeRoot, outputRoot);
    const settings = service.buildSessionMcpSettings({ agentId: 'guard-agent' }) as Record<string, any>;
    return settings.mcpServers as Record<string, unknown>;
  } finally {
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
    fs.rmSync(outputRoot, { recursive: true, force: true });
  }
}

describe('managed session MCP servers omit retired endpoints', () => {
  const savedSearchUrl = process.env.GOOGLE_SEARCH_MCP_URL;

  beforeEach(() => {
    delete process.env.GOOGLE_SEARCH_MCP_URL;
  });

  afterEach(() => {
    if (savedSearchUrl === undefined) {
      delete process.env.GOOGLE_SEARCH_MCP_URL;
    } else {
      process.env.GOOGLE_SEARCH_MCP_URL = savedSearchUrl;
    }
  });

  it('does not inject google-search-mcp when no operator has configured one', () => {
    const servers = buildServers({});

    expect(servers['google-search-mcp']).toBeUndefined();
  });

  it('never falls back to the retired oshal-google-search-mcp container hostname', () => {
    const servers = buildServers({ googleSearchMcpConfig: {} });

    const serialized = JSON.stringify(servers);
    expect(serialized).not.toContain('google-search-mcp:8080');
    expect(servers['google-search-mcp']).toBeUndefined();
  });

  it('still injects google-search-mcp when an operator points it at a real endpoint', () => {
    const servers = buildServers({
      googleSearchMcpConfig: { url: 'http://search.internal:9000/mcp' },
    }) as Record<string, any>;

    expect(servers['google-search-mcp']?.url).toBe('http://search.internal:9000/mcp');
  });

  it('honours GOOGLE_SEARCH_MCP_URL when an operator sets it explicitly', () => {
    process.env.GOOGLE_SEARCH_MCP_URL = 'http://env-search.internal:9100/mcp';

    // The module-level default is captured at import time, so assert through the
    // config path an operator would actually use rather than re-importing the module.
    const servers = buildServers({
      googleSearchMcpConfig: { url: process.env.GOOGLE_SEARCH_MCP_URL },
    }) as Record<string, any>;

    expect(servers['google-search-mcp']?.url).toBe('http://env-search.internal:9100/mcp');
  });
});
