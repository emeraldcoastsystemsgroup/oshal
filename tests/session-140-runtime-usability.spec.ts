/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added runtime usability tests for legacy docs routing, root helper usage, and hot-swap guidance
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added coverage for portable markdown link validation on macOS
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Added regression coverage for paused and cancelled ticket transition support required by rebuilt runtime images
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Added regression coverage for work-item idempotency, routing_failed surfacing, and canonical /app/workspace path display
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Added regression coverage for legacy engineering bot lifecycle status route wiring
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Added regression coverage for Swagger route discovery and paused fallback task-state support in cockpit compatibility routes
 * 7 | maintainer@emeraldcoastsystemsgroup.com   | Added regression coverage for historical/default 3456 messaging, PM-bot callback port ownership, and callback-port root handling
 */

import { test, expect } from '@playwright/test';
import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const OSHAL_ROOT = path.resolve(__dirname, '..');

/**
 * @description Resolves a path within the OSHAL workspace root for file-based assertions.
 *
 * @param segments - Relative path segments within the OSHAL project root.
 * @returns Absolute file path for the requested project file.
 */
function resolveOshalPath(...segments: string[]): string {
  return path.join(OSHAL_ROOT, ...segments);
}

test.describe('Session 140 runtime usability follow-up', () => {
  test('server exposes a legacy /api-docs redirect to /docs', () => {
    const serverContent = fs.readFileSync(resolveOshalPath('src', 'app', 'server.ts'), 'utf-8');
    expect(serverContent).toContain("'/api-docs'");
    expect(serverContent).toContain("res.redirect(302, '/docs')");
    expect(serverContent).toContain('GET /api-docs - redirecting to /docs');
    expect(serverContent).toContain("path.resolve(process.cwd(), 'src/app/routes/**/*.ts')");
  });

  test('public setup docs now advertise /docs as the primary swagger route', () => {
    const docPaths = [
      resolveOshalPath('README.md'),
      resolveOshalPath('docs', 'setup', 'core-setup.md'),
      resolveOshalPath('docs', 'setup', 'mac-install.md'),
    ];

    for (const docPath of docPaths) {
      const content = fs.readFileSync(docPath, 'utf-8');
      expect(content).toContain('/docs');
      expect(content).toContain('/api-docs');
    }
  });

  test('operator-facing docs restore 3456 as the historical default while labeling 35456 as standalone convenience', () => {
    const readmeContent = fs.readFileSync(resolveOshalPath('README.md'), 'utf-8');
    const coreSetupContent = fs.readFileSync(resolveOshalPath('docs', 'setup', 'core-setup.md'), 'utf-8');
    const macInstallContent = fs.readFileSync(resolveOshalPath('docs', 'setup', 'mac-install.md'), 'utf-8');

    expect(readmeContent).toContain('Historical / canonical operator surface:');
    expect(readmeContent).toContain('http://localhost:3456/cockpit/');
    expect(readmeContent).toContain('Standalone convenience stack started by `setup:docker`:');
    expect(readmeContent).toContain('project-manager bot on `:1455`');
    expect(readmeContent).toContain('`http://localhost:51455/auth/callback`');
    expect(coreSetupContent).toContain('historical/default OSHAL app surface');
    expect(coreSetupContent).toContain('http://localhost:3456/cockpit/');
    expect(coreSetupContent).toContain('project-manager bot on `:1455`');
    expect(macInstallContent).toContain('historical/default OSHAL app surface');
    expect(macInstallContent).toContain('http://localhost:3456/cockpit/');
    expect(macInstallContent).toContain('project-manager bot is the default callback owner on `:1455`');
  });

  test('root runtime helper exists and documents refresh commands with hot-swap guidance', () => {
    const helperContent = fs.readFileSync(resolveOshalPath('oshal.sh'), 'utf-8');
    expect(helperContent).toContain('refresh-api');
    expect(helperContent).toContain('refresh-core');
    expect(helperContent).toContain('refresh-all');
    expect(helperContent).toContain('hot-swapped');
    expect(helperContent).toContain('NOT hot-swapped');
    expect(helperContent).toContain('historical/default');
    expect(helperContent).toContain('standalone convenience stack');
  });

  test('root runtime helper help command renders without requiring Docker access', () => {
    const output = childProcess.execFileSync('bash', [resolveOshalPath('oshal.sh'), 'help'], {
      cwd: OSHAL_ROOT,
      encoding: 'utf-8',
    });

    expect(output).toContain('OSHAL runtime helper');
    expect(output).toContain('refresh-api');
    expect(output).toContain('refresh-core');
    expect(output).toContain('swarm-up');
  });

  test('localhost startup and swarm runtime wiring reflect historical 3456 default plus PM-bot callback ownership', () => {
    const localhostScript = fs.readFileSync(resolveOshalPath('scripts', 'start-localhost.sh'), 'utf-8');
    const swarmCompose = fs.readFileSync(resolveOshalPath('docker-compose.swarm-local.yml'), 'utf-8');

    expect(localhostScript).toContain('export PORT="${PORT:-3456}"');
    expect(swarmCompose).toContain('- "1455:1455"');
    expect(swarmCompose).toContain('OPENAI_CODEX_CALLBACK_PORT: "1455"');
  });

  test('markdown link validator uses a portable Node-based scanner', () => {
    const validatorContent = fs.readFileSync(resolveOshalPath('scripts', 'validate-doc-links.sh'), 'utf-8');
    expect(validatorContent).toContain('require_command node');
    expect(validatorContent).toContain("node - \"$REPO_ROOT\"");
    expect(validatorContent).not.toContain('grep -oP');
  });

  test('ticket service transition map includes paused and cancelled lifecycle states', () => {
    const ticketServiceContent = fs.readFileSync(
      resolveOshalPath('src', 'features', 'ticketing', 'services', 'ticket-service.ts'),
      'utf-8',
    );
    const taskTypesContent = fs.readFileSync(
      resolveOshalPath('src', 'shared', 'types', 'task.ts'),
      'utf-8',
    );
    const cockpitRouteHelpersContent = fs.readFileSync(
      resolveOshalPath('src', 'app', 'routes', 'cockpit-route-helpers.ts'),
      'utf-8',
    );
    const ticketRoutesContent = fs.readFileSync(
      resolveOshalPath('src', 'app', 'routes', 'ticket-routes.ts'),
      'utf-8',
    );
    expect(ticketServiceContent).toContain("paused: new Set(['approved', 'backlog', 'escalated', 'cancelled'])");
    expect(ticketServiceContent).toContain("cancelled: new Set(['backlog'])");
    expect(ticketServiceContent).toContain("backlog: new Set(['approved', 'escalated', 'paused', 'cancelled'])");
    expect(taskTypesContent).toContain("'paused'");
    expect(cockpitRouteHelpersContent).toContain("case 'paused':");
    expect(ticketRoutesContent).toContain("return 'paused';");
  });

  test('work-item persistence and queue watchdog support duplicate prevention plus routing_failed surfacing', () => {
    const repositoryContent = fs.readFileSync(
      resolveOshalPath('src', 'entities', 'work-item', 'repositories', 'work-item-repository.ts'),
      'utf-8',
    );
    const schemaContent = fs.readFileSync(
      resolveOshalPath('src', 'shared', 'services', 'database', 'work-item-schema.ts'),
      'utf-8',
    );
    const watchdogContent = fs.readFileSync(
      resolveOshalPath('src', 'features', 'swarm-orchestration', 'services', 'work-item-routing-watchdog-service.ts'),
      'utf-8',
    );
    const queueManagerContent = fs.readFileSync(
      resolveOshalPath('src', 'features', 'swarm-orchestration', 'services', 'queue-manager-service.ts'),
      'utf-8',
    );
    const cockpitHelperContent = fs.readFileSync(
      resolveOshalPath('src', 'app', 'routes', 'cockpit-work-item-helpers.ts'),
      'utf-8',
    );
    const compatRoutesContent = fs.readFileSync(
      resolveOshalPath('src', 'app', 'routes', 'legacy-engineering-compat-routes.ts'),
      'utf-8',
    );

    expect(repositoryContent).toContain('async findByIdentity(');
    expect(repositoryContent).toContain('async markRoutingFailed(');
    expect(schemaContent).toContain('ALTER TABLE work_items DROP CONSTRAINT IF EXISTS work_items_status_check');
    expect(schemaContent).toContain("'routing_failed'");
    expect(watchdogContent).toContain('class WorkItemRoutingWatchdogService');
    expect(queueManagerContent).toContain('WorkItemRoutingWatchdogService');
    expect(cockpitHelperContent).toContain('Routing failed:');
    expect(compatRoutesContent).toContain('routingFailures');
  });

  test('workspace helpers normalize activity paths onto canonical /app/workspace mounts while keeping code-server links usable', () => {
    const serverHelperContent = fs.readFileSync(
      resolveOshalPath('src', 'app', 'routes', 'cockpit-route-helpers.ts'),
      'utf-8',
    );
    const uiHelperContent = fs.readFileSync(
      resolveOshalPath('src', 'pages', 'cockpit', 'js', 'views', 'ticket-view-helpers.js'),
      'utf-8',
    );

    expect(serverHelperContent).toContain("return `/app/workspace/${workspaceId}`;");
    expect(serverHelperContent).toContain("return `/app/workspace/${normalizedValue.replace(/^\\/+/, '')}`;");
    expect(uiHelperContent).toContain("return `/app/workspace/${workspaceTicketId}`;");
    expect(uiHelperContent).toContain("normalizedDisplayPath.replace(/^\\/app/, '') || '/workspace'");
  });

  test('legacy engineering compatibility routes expose bot lifecycle status lookups', () => {
    const compatRoutesContent = fs.readFileSync(
      resolveOshalPath('src', 'app', 'routes', 'legacy-engineering-compat-routes.ts'),
      'utf-8',
    );
    expect(compatRoutesContent).toContain("app.get('/api/bot/status'");
    expect(compatRoutesContent).toContain("botLifecycleService.status(containerName)");
  });

  test('server supports callback-port root handling so bot-owned redirect listeners can accept auth callbacks', () => {
    const serverContent = fs.readFileSync(resolveOshalPath('src', 'app', 'server.ts'), 'utf-8');
    expect(serverContent).toContain('isOpenAiCodexCallbackPortRequest');
    expect(serverContent).toContain('hasAuthCallbackQuery');
    expect(serverContent).toContain('Routing callback-port root request to OpenAI Codex callback handler');
    expect(serverContent).toContain('This port is reserved for authentication redirect handling.');
  });
});