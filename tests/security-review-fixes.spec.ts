/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Regression coverage for the 5 review findings (P0 shell injection, P1 auth gates, P2 reviewerBot + path check)
 */

import { test, expect } from '@playwright/test';
import * as path from 'path';

// ── P0: shell:true must be off in fast-intake spawn ────────────────────────
test.describe('P0 — fast-intake spawn does not use shell:true', () => {
  test('source has shell:false (or no shell flag) on the codex spawn', async () => {
    const fs = await import('fs');
    const repoRoot = path.resolve(__dirname, '..');
    const src = fs.readFileSync(
      path.join(repoRoot, 'src/features/intake/services/fast-intake-service.ts'),
      'utf-8',
    );
    // The spawn call must not enable shell. We accept shell:false explicitly
    // (current state) or no shell key at all (Node default = false).
    const spawnBlock = src.match(/spawn\(binary,[\s\S]{0,200}\)/);
    expect(spawnBlock, 'expected to find spawn(binary, args, opts) in fast-intake-service.ts').toBeTruthy();
    expect(spawnBlock![0]).not.toContain('shell: true');
  });
});

// ── P1: /api/intake/fast requires auth ────────────────────────────────────
test.describe('P1 — /api/intake/fast requires authentication', () => {
  test('source mounts route behind requiresAuth middleware', async () => {
    const fs = await import('fs');
    const repoRoot = path.resolve(__dirname, '..');
    const src = fs.readFileSync(
      path.join(repoRoot, 'src/app/routes/fast-intake-routes.ts'),
      'utf-8',
    );
    // The POST handler signature must include requiresAuth somewhere between
    // the path and the handler. The route is `app.post('/api/intake/fast', requiresAuth, ...)`.
    expect(src).toMatch(/app\.post\(\s*['"]\/api\/intake\/fast['"]\s*,\s*requiresAuth/);
  });

  test('server.ts call passes requiresAuth into registerFastIntakeRoutes', async () => {
    const fs = await import('fs');
    const repoRoot = path.resolve(__dirname, '..');
    const src = fs.readFileSync(path.join(repoRoot, 'src/app/server.ts'), 'utf-8');
    expect(src).toMatch(/registerFastIntakeRoutes\(app,\s*requiresAuth/);
  });
});

// ── P1: debug trace route requires auth ────────────────────────────────────
test.describe('P1 — /api/debug/tickets/:id/trace requires authentication', () => {
  test('source mounts route behind requiresAuth middleware', async () => {
    const fs = await import('fs');
    const repoRoot = path.resolve(__dirname, '..');
    const src = fs.readFileSync(path.join(repoRoot, 'src/app/routes/debug-routes.ts'), 'utf-8');
    expect(src).toMatch(
      /router\.get\(\s*['"]\/api\/debug\/tickets\/:ticketId\/trace['"]\s*,\s*requiresAuth/,
    );
  });

  test('server.ts call passes requiresAuth into registerDebugRoutes', async () => {
    const fs = await import('fs');
    const repoRoot = path.resolve(__dirname, '..');
    const src = fs.readFileSync(path.join(repoRoot, 'src/app/server.ts'), 'utf-8');
    expect(src).toMatch(/registerDebugRoutes\(app,\s*requiresAuth/);
  });
});

// ── P2: reviewerBot is no longer silently dropped ─────────────────────────
test.describe('P2 — registerWorkflow passes reviewerBot through', () => {
  test('swarm-app-service.registerWorkflow includes reviewerBot in registration payload', async () => {
    const fs = await import('fs');
    const repoRoot = path.resolve(__dirname, '..');
    const src = fs.readFileSync(
      path.join(repoRoot, 'src/features/swarm-apps/services/swarm-app-service.ts'),
      'utf-8',
    );
    // Find the registerFromApp call body and assert reviewerBot is one of
    // the keys passed in.
    const block = src.match(/registerFromApp\(\s*manifest\.name,\s*\{[\s\S]*?\}\s*\)/);
    expect(block, 'expected to find registerFromApp call in swarm-app-service.ts').toBeTruthy();
    expect(block![0]).toContain('reviewerBot:');
    expect(block![0]).toContain('manifest.workflow.reviewerBot');
  });

  test('SwarmAppWorkflow type declares reviewerBot field', async () => {
    const fs = await import('fs');
    const repoRoot = path.resolve(__dirname, '..');
    const src = fs.readFileSync(path.join(repoRoot, 'src/features/swarm-apps/types.ts'), 'utf-8');
    expect(src).toMatch(/reviewerBot\?:\s*string/);
  });
});

// ── P2: workspace path startsWith confusion is gone ────────────────────────
test.describe('P2 — sanitizeWorkspacePath rejects sibling-prefix paths', () => {
  test('source uses anchored prefix check (startsWith with path.sep, not bare string)', async () => {
    const fs = await import('fs');
    const repoRoot = path.resolve(__dirname, '..');
    const src = fs.readFileSync(
      path.join(repoRoot, 'src/features/task-explorer/services/task-explorer-workspace-service.ts'),
      'utf-8',
    );
    // Confirm the bare-startsWith pattern is gone from sanitizeWorkspacePath
    // and that the anchored variant is in place.
    const fn = src.match(/private sanitizeWorkspacePath\([\s\S]*?\n  \}/);
    expect(fn, 'sanitizeWorkspacePath function found').toBeTruthy();
    expect(fn![0], 'no bare startsWith(workspaceRoot) without sep').not.toMatch(
      /startsWith\(workspaceRoot\)\s*\)/,
    );
    expect(fn![0]).toMatch(/startsWith\(`?\$?\{?normalizedRoot/);
    expect(fn![0]).toMatch(/path\.sep/);
  });
});
