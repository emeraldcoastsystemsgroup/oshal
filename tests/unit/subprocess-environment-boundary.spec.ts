/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard secret-free content/MCP child environments and permanent retirement of the unauthenticated dashboard runner plus residual SmartThings/GCP credential subprocesses.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Mutation-guard every remediated active runtime source against reintroducing whole-process environment inheritance.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { buildResearchProcessEnv } from '../../src/app/routes/content-routes';

const requireModule = createRequire(import.meta.url);
const MCPServerManager = requireModule('../../any-bot/server/services/MCPServerManager.js') as {
  buildMcpServerProcessEnv: (
    serverEnv?: Record<string, string>,
    parent?: NodeJS.ProcessEnv,
  ) => NodeJS.ProcessEnv;
};

describe('subprocess credential containment', () => {
  it('runs public-feed research without controller or provider credentials', () => {
    expect(buildResearchProcessEnv('ERP and AI', 12, {
      PATH: 'C:\\runtime',
      HTTPS_PROXY: 'http://proxy.example',
      DATABASE_URL: 'controller-database',
      SESSION_SECRET: 'controller-session',
      ANTHROPIC_API_KEY: 'provider-key',
    })).toEqual({
      PATH: 'C:\\runtime',
      HTTPS_PROXY: 'http://proxy.example',
      CONTENT_LIMIT: '12',
      CONTENT_FOCUS: 'ERP and AI',
    });
  });

  it('gives an MCP server only runtime and its explicitly reviewed settings', () => {
    expect(MCPServerManager.buildMcpServerProcessEnv({
      PLANE_API_KEY: 'server-specific-key',
      PLANE_BASE_URL: 'https://plane.example',
    }, {
      PATH: '/runtime',
      HOME: '/home/runner',
      DATABASE_URL: 'controller-database',
      SESSION_SECRET: 'controller-session',
      AWS_SECRET_ACCESS_KEY: 'ambient-cloud-key',
    })).toEqual({
      PATH: '/runtime',
      HOME: '/home/runner',
      PLANE_API_KEY: 'server-specific-key',
      PLANE_BASE_URL: 'https://plane.example',
    });
  });

  it('keeps retired dashboard and connector code paths non-executable', () => {
    const root = process.cwd();
    const dashboard = fs.readFileSync(
      path.join(root, 'any-bot/server/app-modules/routes-ops-observability.js'),
      'utf8',
    );
    expect(dashboard).toContain("error: 'runtime_test_execution_retired'");
    expect(dashboard).not.toContain("execFile('node'");
    expect(dashboard).not.toContain('testFile.startsWith');

    for (const relative of [
      'any-bot/server/services/tools/smart-home/smartthingsToolKit.js',
      'any-bot/server/services/tools/gcp/gcpToolKit.js',
    ]) {
      const source = fs.readFileSync(path.join(root, relative), 'utf8');
      expect(source).toContain('runBrokeredCli');
      expect(source).not.toContain("require('child_process')");
      expect(source).not.toContain('process.env');
      expect(source).not.toContain('params.userSub');
    }
  });

  it('keeps remediated runtime launchers free of whole-process environment carriers', () => {
    for (const relative of [
      'any-bot/server/app-modules/routes-ops-observability.js',
      'any-bot/server/services/MCPServerManager.js',
      'any-bot/server/services/tools/smart-home/smartthingsToolKit.js',
      'any-bot/server/services/tools/gcp/gcpToolKit.js',
      'src/app/apply-submit.ts',
      'src/app/routes/content-routes.ts',
      'src/app/routes/gov-contracting-cron.ts',
      'src/features/chat-orchestration/services/tool-executor-service.ts',
      'src/features/dev-console/services/dev-session-engine.ts',
      'src/features/remote-client/services/remote-client-service.ts',
      'scripts/lib/gha/run.ts',
      'packages/oshal-chat/src/main/executors.ts',
      'packages/oshal-chat/src/main/ensure-clis.ts',
    ]) {
      const source = fs.readFileSync(path.join(process.cwd(), relative), 'utf8');
      expect(source, `${relative} spreads the whole process environment`)
        .not.toMatch(/\.\.\.process\.env|env\s*:\s*process\.env/);
    }
  });
});
