/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — guards for the node-resident print service (ADR-135 amendment H). The delivery URL is the load-bearing detail: it must address the node's OWN control-plane segment, because that is the only path decideNodeTokenScope admits for the node's own credential. A refactor that "simplifies" it back to /api/print-ingest/documents would break delivery in a way only a live print reveals, so it is pinned here alongside the real scope decision.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Cross the ELECTRON boundary this file used to only claim. Every assertion here passed while the printer was, in fact, never starting on a real node: the spec drives start() from a plain node process where process.execPath IS node, but in the Electron main process execPath is electron.exe, so the child launched a GUI app and died - and buildLocalNodeProcessEnv() is a strict allowlist that never carried ELECTRON_RUN_AS_NODE. The new cases assert the ENV THE CHILD IS ACTUALLY GIVEN (lastSpawn), which is the only thing that would have gone red.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { decideNodeTokenScope } from '@/features/remote-client';
import { nodePrintIntakeUrl, resolvePrintDropEntry, PrintService } from '../../packages/oshal-chat/src/main/print-service';

/** A config with only the fields the print service reads. */
function config(overrides: Record<string, unknown> = {}) {
  return {
    controlPlaneUrl: 'http://swarm.local:35457',
    clientId: 'oshal-chat-node-1',
    sharedSecret: 'oshal_pat_example',
    printServiceEnabled: true,
    printServiceSpoolDir: '',
    ...overrides,
  } as never;
}

describe('the node delivers on its OWN plane', () => {
  it('addresses the node-plane print route, not the global intake', () => {
    expect(nodePrintIntakeUrl(config())).toBe(
      'http://swarm.local:35457/api/remote-clients/oshal-chat-node-1/print-documents',
    );
  });

  it('the URL it builds is one the node\'s own token is actually admitted on', () => {
    const url = nodePrintIntakeUrl(config());
    const path = new URL(url).pathname;
    const decision = decideNodeTokenScope({ boundClientId: 'oshal-chat-node-1', path });
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBe('own-device-plane');
  });

  it('tolerates a trailing slash on the control-plane URL', () => {
    expect(nodePrintIntakeUrl(config({ controlPlaneUrl: 'http://swarm.local:35457/' })))
      .toBe('http://swarm.local:35457/api/remote-clients/oshal-chat-node-1/print-documents');
  });

  it('encodes a clientId that would otherwise break the path', () => {
    const url = nodePrintIntakeUrl(config({ clientId: 'node/../admin' }));
    expect(url).toContain('node%2F..%2Fadmin');
  });
});

describe('opt-in, and refusals that beat a printer which cannot deliver', () => {
  it('is OFF unless explicitly enabled — it is an outward-facing service', () => {
    expect(PrintService.enabled(config({ printServiceEnabled: false }))).toBe(false);
    expect(PrintService.enabled(config({}))).toBe(true);
  });

  it('refuses to start with no node credential', () => {
    const logs: string[] = [];
    const service = new PrintService(config({ sharedSecret: '' }), process.cwd(), (m) => logs.push(m));
    expect(service.start()).toBe(false);
    expect(logs.join(' ')).toContain('no credential');
  });

  it('refuses to start before the node has a clientId', () => {
    const logs: string[] = [];
    const service = new PrintService(config({ clientId: '' }), process.cwd(), (m) => logs.push(m));
    expect(service.start()).toBe(false);
    expect(logs.join(' ')).toContain('clientId');
  });

  it('refuses to start when the print-drop package is absent', () => {
    const logs: string[] = [];
    const service = new PrintService(config(), '/nonexistent-package-root', (m) => logs.push(m));
    expect(service.start()).toBe(false);
    expect(logs.join(' ')).toContain('not installed');
  });
});

describe('print-drop resolution', () => {
  it('finds the monorepo sibling package', () => {
    const chatRoot = new URL('../../packages/oshal-chat', import.meta.url).pathname.replace(/^\//, '');
    expect(resolvePrintDropEntry(chatRoot)).toMatch(/print-drop[\\/]bin[\\/]print-drop\.js$/);
  });

  it('returns null rather than a bogus path when nothing is installed', () => {
    expect(resolvePrintDropEntry('/nowhere-at-all')).toBeNull();
  });
});

describe('the child is launched the way Electron actually requires', () => {
  // Point the resolver at a stub that exits immediately: these cases assert the SPAWN CONTRACT
  // (the argv and env the child is handed), and must not stand up a real printer on a port.
  let stubEntry = '';
  let previous: string | undefined;

  beforeAll(() => {
    const dir = mkdtempSync(join(tmpdir(), 'print-svc-guard-'));
    stubEntry = join(dir, 'stub-print-drop.js');
    writeFileSync(stubEntry, 'process.exit(0);');
    previous = process.env.OSHAL_PRINT_DROP_ENTRY;
    process.env.OSHAL_PRINT_DROP_ENTRY = stubEntry;
  });

  afterAll(() => {
    if (previous === undefined) delete process.env.OSHAL_PRINT_DROP_ENTRY;
    else process.env.OSHAL_PRINT_DROP_ENTRY = previous;
  });

  /** Starts the service against the stub and returns how the child was invoked. */
  function spawnContract(overrides: Record<string, unknown> = {}) {
    const service = new PrintService(config({ printServiceSpoolDir: mkdtempSync(join(tmpdir(), 'print-spool-')), ...overrides }), process.cwd(), () => {});
    service.start();
    const spawned = service.lastSpawn;
    service.stop();
    return spawned;
  }

  it('sets ELECTRON_RUN_AS_NODE - without it the Electron binary starts a GUI app, not the printer', () => {
    const spawned = spawnContract();
    expect(spawned).not.toBeNull();
    // The whole defect in one assertion: in the Electron main process execPath is electron.exe,
    // and buildLocalNodeProcessEnv() is an allowlist that never carried this flag.
    expect(spawned?.env.ELECTRON_RUN_AS_NODE).toBe('1');
  });

  it('passes the configured port, so it can coexist with a standalone print-drop on 631', () => {
    const args = spawnContract({ printServicePort: 6310 })?.args ?? [];
    expect(args).toContain('--port');
    expect(args[args.indexOf('--port') + 1]).toBe('6310');
  });

  it('keeps the credential OUT of argv but present in the env', () => {
    const spawned = spawnContract();
    expect((spawned?.args ?? []).join(' ')).not.toContain('oshal_pat_');
    expect(spawned?.env.OSHAL_PRINT_INTAKE_TOKEN).toBe('oshal_pat_example');
  });
});
