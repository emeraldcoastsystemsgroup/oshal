/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the injected-bot persona blind spot: a store package's personas/ dir under deployed-apps/ must be searched when the kernel dir misses, by UUID and by name — without it a forge-injected bot silently executes on the DEFAULT profile persona (observed live 2026-08-01: capability-ideator answered as the travel concierge).
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { loadPersonaFromFile } from '../../src/features/swarm-orchestration/services/persona-file-loader';

/** Contains '-0000-' so the loader takes its UUID scan path (see buildCandidatePaths). */
const PACKAGE_AGENT_ID = 'c1de0000-0000-0000-0000-00000000abcd';

const PACKAGE_PERSONA_YAML = [
  'name: pack-thinker',
  'role: Package Thinker',
  `agent_id: ${PACKAGE_AGENT_ID}`,
  'perspective: |',
  '  You are the PACKAGE THINKER persona shipped inside a deployed-apps store package.',
  'capabilities:',
  '  - proposal-generation',
].join('\n');

describe('persona-file-loader — deployed-apps package personas', () => {
  let workspaceRoot: string;
  let kernelDir: string;
  let savedWorkspaceRoot: string | undefined;
  let savedClineRoot: string | undefined;

  beforeEach(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), 'pfl-ws-'));
    kernelDir = mkdtempSync(join(tmpdir(), 'pfl-kernel-'));
    const personasDir = join(workspaceRoot, 'deployed-apps', 'pack-thinker', 'personas');
    mkdirSync(personasDir, { recursive: true });
    writeFileSync(join(personasDir, 'pack-thinker.yaml'), PACKAGE_PERSONA_YAML);

    savedClineRoot = process.env.CLINE_WORKSPACE_ROOT;
    savedWorkspaceRoot = process.env.WORKSPACE_ROOT;
    process.env.CLINE_WORKSPACE_ROOT = workspaceRoot;
    delete process.env.WORKSPACE_ROOT;
  });

  afterEach(() => {
    if (savedClineRoot === undefined) delete process.env.CLINE_WORKSPACE_ROOT;
    else process.env.CLINE_WORKSPACE_ROOT = savedClineRoot;
    if (savedWorkspaceRoot === undefined) delete process.env.WORKSPACE_ROOT;
    else process.env.WORKSPACE_ROOT = savedWorkspaceRoot;
    rmSync(workspaceRoot, { recursive: true, force: true });
    rmSync(kernelDir, { recursive: true, force: true });
  });

  it('finds an injected package persona by UUID when the kernel dir misses', () => {
    const persona = loadPersonaFromFile(PACKAGE_AGENT_ID, kernelDir);
    expect(persona?.name).toBe('pack-thinker');
    expect(persona?.perspective).toContain('PACKAGE THINKER');
  });

  it('finds an injected package persona by name when the kernel dir misses', () => {
    const persona = loadPersonaFromFile('pack-thinker', kernelDir);
    expect(persona?.role).toBe('Package Thinker');
  });

  it('prefers the kernel dir when both define the same name', () => {
    writeFileSync(
      join(kernelDir, 'pack-thinker.yaml'),
      ['name: pack-thinker', 'role: Kernel Thinker', 'perspective: kernel copy wins'].join('\n'),
    );
    const persona = loadPersonaFromFile('pack-thinker', kernelDir);
    expect(persona?.role).toBe('Kernel Thinker');
  });

  it('returns null when neither location has the persona', () => {
    expect(loadPersonaFromFile('missing-bot', kernelDir)).toBeNull();
    expect(loadPersonaFromFile('9d9d0000-0000-0000-0000-000000009999', kernelDir)).toBeNull();
  });
});
