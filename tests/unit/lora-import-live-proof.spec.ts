/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial - the LoRA gallery-import live acceptance's own logic: the generated image is a valid unique PNG, box commands refuse any non-fixture path and only prune literal-variable parents, worker output is redacted, and a run passes only when the receipt reaches "ready on worker" AND the pair is in the curated folder training reads with the exact bytes and caption. Not-ready, literal-path-only and surviving-row runs are red; cleanup always removes the box directory, the import ticket and the character.
 */
import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import sharp from 'sharp';

const requireCjs = createRequire(import.meta.url);
const proof = requireCjs('../../scripts/operations/lora-import-live-proof.js');

const OWNER = 'fixture|lora-owner';
const CHARACTER_ID = '11111111-2222-3333-4444-555555555555';
const STORAGE_KEY = `lora-${CHARACTER_ID.replace(/-/g, '')}`;
const CLIENT = 'node-fixture-worker';

interface FakeOptions { receipt?: string; at?: 'expanded' | 'literal'; keepCharacter?: boolean; importStatus?: number; foreignTicket?: boolean }

/** The fake box + server state one run reads and writes. */
interface FakeState {
  options: FakeOptions;
  box: Map<string, { bytes: number; caption: string }>;
  characters: Set<string>;
  tickets: Set<string>;
  commands: string[];
  results: Map<string, Record<string, unknown>>;
  fixture: { subject: string; caption: string } | null;
  pngBytes: number;
}

/** What the worker's PowerShell would print for the probe and removal commands. */
function runBox(state: FakeState, command: string): string {
  const key = (loc: string) => [...state.box.keys()].find((k) => k.startsWith(`${loc}/${STORAGE_KEY}`));
  if (command.includes('Remove-Item')) {
    for (const k of [...state.box.keys()]) if (k.includes(STORAGE_KEY)) state.box.delete(k);
    return JSON.stringify({ expanded: false, literal: false });
  }
  const entry = (loc: string) => { const k = key(loc); const v = k ? state.box.get(k)! : null;
    return { png: Boolean(v), bytes: v ? v.bytes : 0, txt: Boolean(v), caption: v ? v.caption : '' }; };
  return JSON.stringify({ expanded: entry('expanded'), literal: entry('literal') });
}

/** POST /api/lora/dataset/import, including the worker write it queues. */
function importRoute(state: FakeState, body: Record<string, unknown>) {
  state.tickets.add('ticket-import');
  if (state.options.importStatus) return { status: state.options.importStatus, json: { status: 'box_required', ticketId: 'ticket-import' } };
  const fixture = state.fixture!;
  fixture.caption = String(body.caption);
  const where = state.options.at ?? 'expanded';
  if ((state.options.receipt ?? 'ready') === 'ready') {
    state.box.set(`${where}/${STORAGE_KEY}/curated/${fixture.subject}.png`, { bytes: state.pngBytes, caption: fixture.caption });
  }
  state.results.set('lora-task-1', { status: 'failed', output: { stdout: '', stderr: 'C:\\Users\\someone\\x failed', exitCode: 1 } });
  return { status: 202, json: { filename: `${fixture.subject}.png`, ticketId: 'ticket-import', clientId: CLIENT, taskId: 'lora-task-1' } };
}

/** The server routes the case calls, in their real response shapes. */
function fakeRoutes(state: FakeState) {
  return vi.fn(async (method: string, route: string, body?: Record<string, unknown>) => {
    if (method === 'GET' && route.startsWith('/api/lora/dataset?')) {
      const subject = decodeURIComponent(route.split('subject=')[1]);
      if (!state.characters.has(subject)) return { status: 404, json: { error: 'character not found' } };
      return { status: 200, json: { storageKey: STORAGE_KEY, images: [{ filename: `${subject}.png`, status: state.options.receipt ?? 'ready', byte_size: 1 }] } };
    }
    if (route === '/api/lora/characters') {
      state.characters.add(String(body!.subject));
      state.fixture = { subject: String(body!.subject), caption: '' };
      return { status: 201, json: {} };
    }
    if (route === '/api/lora/dataset/import') return importRoute(state, body!);
    if (method === 'POST' && route === `/api/remote-clients/${CLIENT}/tasks`) {
      const command = String((body!.input as { arguments: { command: string } }).arguments.command);
      state.commands.push(command);
      state.results.set(String(body!.taskId), { status: 'completed', output: { stdout: runBox(state, command), stderr: '', exitCode: 0 } });
      return { status: 201, json: {} };
    }
    if (method === 'GET' && route.startsWith(`/api/remote-clients/${CLIENT}/tasks/`)) {
      const result = state.results.get(decodeURIComponent(route.split('/')[5]));
      return result ? { status: 200, json: result } : { status: 404, json: {} };
    }
    throw new Error(`unexpected ${method} ${route}`);
  });
}

/** The running server + worker, in memory: routes, receipts, the character table and the box. */
function fake(options: FakeOptions = {}) {
  const state: FakeState = { options, box: new Map(), characters: new Set(), tickets: new Set(), commands: [],
    results: new Map(), fixture: null, pngBytes: 0 };
  const ticketRow = () => ({ ownerSub: options.foreignTicket ? 'someone-else' : OWNER, ticketType: 'lora-train',
    metadata: { character: state.fixture?.subject, action: 'dataset-import' } });
  const ports = {
    ownerSub: OWNER, api: fakeRoutes(state), loraVersion: '1.5.0', boxRoot: proof.DEFAULT_BOX_ROOT, workerAgentIds: { [CLIENT]: CLIENT },
    tickets: {
      getTicket: vi.fn(async (id: string) => (state.tickets.has(id) ? ticketRow() : null)),
      deleteTicket: vi.fn(async (id: string) => { state.tickets.delete(id); }),
    },
    upload: vi.fn(async (_name: string, _type: string, bytes: Buffer) => {
      state.pngBytes = bytes.length;
      return { status: 201, json: { ref: 'art_fixture', expiresAt: '2026-09-27T18:00:00.000Z' } };
    }),
    query: vi.fn(async (sql: string, params: string[]) => {
      if (sql.startsWith('SELECT id')) return { rows: state.characters.has(params[1]) ? [{ id: CHARACTER_ID }] : [] };
      if (sql.startsWith('DELETE')) { if (!options.keepCharacter) state.characters.delete(params[1]); return { rows: [] }; }
      return { rows: [{ characters: state.characters.has(params[1]) ? 1 : 0, receipts: 0 }] };
    }),
    withOwner: <T>(fn: () => Promise<T>) => fn(),
    sleep: async () => undefined,
    now: (() => { let t = 0; return () => (t += 1_000); })(),
  };
  return { ports, box: state.box, characters: state.characters, tickets: state.tickets, commands: state.commands };
}

describe('fixture and box commands', () => {
  it('generates a valid, unique PNG and a fixture-tagged character', async () => {
    const a = proof.createImportFixture();
    const b = proof.createImportFixture();
    expect(proof.SUBJECT_RE.test(a.subject)).toBe(true);
    const decoded = await sharp(a.png).raw().toBuffer({ resolveWithObject: true });
    expect([decoded.info.width, decoded.info.height, decoded.info.channels]).toEqual([16, 16, 3]);
    expect(a.png.equals(b.png)).toBe(false);
    expect(a.character.heroImage).not.toBe(b.character.heroImage);
  });

  it('refuses to probe or remove anything but a fixture storage key and dataset file', () => {
    expect(() => proof.buildBoxProbeCommand(proof.DEFAULT_BOX_ROOT, 'lora-../../x', 'a.png')).toThrow(/non-fixture/);
    expect(() => proof.buildBoxProbeCommand(proof.DEFAULT_BOX_ROOT, STORAGE_KEY, '../a.png')).toThrow(/non-fixture/);
    expect(() => proof.buildBoxRemoveCommand(proof.DEFAULT_BOX_ROOT, 'lora-*')).toThrow(/non-fixture/);
  });

  it('checks the expanded (training) path and the single-quoted literal path', () => {
    const command = proof.buildBoxProbeCommand(proof.DEFAULT_BOX_ROOT, STORAGE_KEY, 'x.png');
    expect(command).toContain(`expanded = "$env:USERPROFILE/lora-characters/${STORAGE_KEY}/curated/x.png"`);
    expect(command).toContain(`literal = '$env:USERPROFILE/lora-characters/${STORAGE_KEY}/curated/x.png'`);
  });

  it('prunes empty parents only for an unexpanded-variable root and never past a rooted path', () => {
    expect(proof.buildBoxRemoveCommand(proof.DEFAULT_BOX_ROOT, STORAGE_KEY)).toContain('IsPathRooted');
    expect(proof.buildBoxRemoveCommand('D:/lora', STORAGE_KEY)).not.toContain('Split-Path');
  });

  it('redacts user-profile folder names from worker output', () => {
    expect(proof.redactWorkerText('at C:\\Users\\someone\\lora and /home/someone/x')).toBe('at C:\\Users\\user\\lora and /home/user/x');
  });
});

describe('runLoraImportAcceptance', () => {
  it('passes when the receipt is ready and the exact pair is in the curated folder, then removes everything', async () => {
    const f = fake();
    const result = await proof.runLoraImportAcceptance(f.ports);
    expect(result.state, result.detail).toBe('pass');
    expect(result.evidence).toMatchObject({ receipt: 'ready', loraVersion: '1.5.0', cleanupErrors: [] });
    expect(f.box.size).toBe(0);
    expect(f.characters.size).toBe(0);
    expect(f.tickets.size).toBe(0);
    expect(f.commands.every((c) => !c.includes('lora-characters/lora-*'))).toBe(true);
  });

  it('fails when the pair landed only at the unexpanded literal path', async () => {
    const f = fake({ at: 'literal' });
    const result = await proof.runLoraImportAcceptance(f.ports);
    expect(result.state).toBe('fail');
    expect(result.detail).toContain('not in the curated folder training reads');
    expect(result.detail).toContain('single-quoted literal path: png=true');
    expect(f.box.size).toBe(0);
  });

  it('fails when the receipt never reaches ready and reports the worker task, redacted', async () => {
    const f = fake({ receipt: 'failed' });
    const result = await proof.runLoraImportAcceptance(f.ports);
    expect(result.state).toBe('fail');
    expect(result.detail).toContain('did not reach "ready on worker"');
    expect(result.detail).toContain('C:\\Users\\user');
    expect(f.characters.size).toBe(0);
  });

  it('still removes the character and ticket when the worker was not available', async () => {
    const f = fake({ importStatus: 503 });
    const result = await proof.runLoraImportAcceptance(f.ports);
    expect(result.state).toBe('fail');
    expect(result.detail).toContain('HTTP 503 box_required');
    expect(f.characters.size).toBe(0);
    expect(f.commands).toEqual([]);
  });

  it('deletes the import ticket through the ticket service, and only after it revalidates as this run own', async () => {
    const own = fake();
    await proof.runLoraImportAcceptance(own.ports);
    expect(own.ports.tickets.deleteTicket).toHaveBeenCalledWith('ticket-import');
    expect(own.tickets.size).toBe(0);
    const foreign = fake({ foreignTicket: true });
    const result = await proof.runLoraImportAcceptance(foreign.ports);
    expect(foreign.ports.tickets.deleteTicket).not.toHaveBeenCalled();
    expect(result.state).toBe('fail');
    expect(result.detail).toContain("did not revalidate as this run's import ticket; not deleted");
  });

  it('turns a green run red when the character survives cleanup', async () => {
    const f = fake({ keepCharacter: true });
    const result = await proof.runLoraImportAcceptance(f.ports);
    expect(result.state).toBe('fail');
    expect(result.detail).toContain('CLEANUP INCOMPLETE: database residue: characters=1');
  });
});
