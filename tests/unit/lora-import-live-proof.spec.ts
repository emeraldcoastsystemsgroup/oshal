/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial - the LoRA gallery-import live acceptance's own logic: the generated image is a valid unique PNG, box commands refuse any non-fixture path and only prune literal-variable parents, worker output is redacted, and a run passes only when the receipt reaches "ready on worker" AND the pair is in the curated folder training reads with the exact bytes and caption. Not-ready, literal-path-only and surviving-row runs are red; cleanup always removes the box directory, the import ticket and the character.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Real-boundary probe cases. The in-memory worker above answered the probe with the JSON the script HOPED for, so it never caught what real Windows PowerShell 5.1 prints: `Get-Content -Raw` hands `ConvertTo-Json` a provider-decorated string and the caption serializes as a 25 KB nested object, which sank the 2026-09-28 live run as "nothing readable" although the pair was on the GPU box. The new cases run the exact `buildBoxProbeCommand` and `buildBoxRemoveCommand` output through powershell.exe with USERPROFILE pointed at a temp home (the DEFAULT `$env:USERPROFILE/lora-characters` root, so expansion is exercised) and pin one JSON line of plain values (png/txt booleans, bytes = the PNG's size, caption = the exact string, UTF-8 without a BOM) that the verdict passes on; removal likewise prints plain booleans and never climbs above the character directory. Pure cases pin that a decorated, truncated or empty probe is named (which field, the task exit, the first 300 redacted chars of stdout) and that a removal whose stdout is unreadable quotes it. Off win32 the shell cases print one PLATFORM SKIP line, never a silent green.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';

const requireCjs = createRequire(import.meta.url);
const proof = requireCjs('../../scripts/operations/lora-import-live-proof.js');

const OWNER = 'fixture|lora-owner';
const CHARACTER_ID = '11111111-2222-3333-4444-555555555555';
const STORAGE_KEY = `lora-${CHARACTER_ID.replace(/-/g, '')}`;
const CLIENT = 'node-fixture-worker';

const WIN32 = process.platform === 'win32';
if (!WIN32) {
  process.stderr.write(`PLATFORM SKIP: lora-import-live-proof - the real-PowerShell probe and removal cases run only on win32 `
    + `(this host is ${process.platform}); the shipped box commands were NOT executed here.\n`);
}
const onWindows = it.skipIf(!WIN32);

interface FakeOptions { receipt?: string; at?: 'expanded' | 'literal'; keepCharacter?: boolean; importStatus?: number; foreignTicket?: boolean; removeOutput?: string }

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
    return state.options.removeOutput ?? JSON.stringify({ expanded: false, literal: false });
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
    // The probe's JSON line carries this caption back through the worker's console, whose codepage
    // Windows PowerShell 5.1 applies to non-ASCII text; a printable-ASCII caption round-trips on any box.
    expect(a.caption).toMatch(/^[\x20-\x7e]+$/);
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

  it('redacts user-profile folder names from worker output, JSON-escaped and drive-less spellings included', () => {
    expect(proof.redactWorkerText('at C:\\Users\\someone\\lora and /home/someone/x')).toBe('at C:\\Users\\user\\lora and /home/user/x');
    expect(proof.redactWorkerText('"PSPath":"C:\\\\Users\\\\someone\\\\x","CurrentLocation":"Users\\\\someone\\\\y"'))
      .toBe('"PSPath":"C:\\\\Users\\\\user\\\\x","CurrentLocation":"Users\\\\user\\\\y"');
  });
});

describe('the probe and removal commands on real Windows PowerShell (the worker shell)', () => {
  const made: string[] = [];
  afterEach(() => { for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true }); });

  /** A temp home holding one curated pair at the DEFAULT root's expanded path, and a separate cwd for the shell. */
  function curatedHome(fixture: { name: string; png: Buffer; caption: string }) {
    const home = mkdtempSync(join(tmpdir(), 'lora-proof-home-'));
    const cwd = mkdtempSync(join(tmpdir(), 'lora-proof-cwd-'));
    made.push(home, cwd);
    const curated = join(home, 'lora-characters', STORAGE_KEY, 'curated');
    mkdirSync(curated, { recursive: true });
    writeFileSync(join(curated, fixture.name), fixture.png);
    writeFileSync(join(curated, fixture.name.replace(/\.png$/, '.txt')), fixture.caption, 'utf8');
    return { home, cwd, curated };
  }

  /** Run one box command exactly as the worker's shell.exec does, with USERPROFILE pointed at the temp home. */
  function runPowerShell(command: string, home: string, cwd: string) {
    return spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command],
      { cwd, env: { ...process.env, USERPROFILE: home }, encoding: 'utf8', timeout: 60_000 });
  }

  onWindows('the probe prints ONE JSON line of plain values for the pair at the expanded default root, and the verdict passes on it', () => {
    const fixture = proof.createImportFixture();
    const { home, cwd } = curatedHome(fixture);
    const run = runPowerShell(proof.buildBoxProbeCommand(proof.DEFAULT_BOX_ROOT, STORAGE_KEY, fixture.name), home, cwd);
    expect(run.status, run.stderr).toBe(0);
    const lines = run.stdout.trim().split(/\r?\n/);
    expect(lines).toHaveLength(1);
    expect(lines[0].startsWith('{')).toBe(true);
    const probe = proof.parseProbe(run.stdout);
    expect(proof.probeShapeProblem(probe)).toBeNull();
    expect(probe).toEqual({
      expanded: { png: true, bytes: fixture.png.length, txt: true, caption: fixture.caption },
      literal: { png: false, bytes: 0, txt: false, caption: '' },
    });
    expect(run.stdout.length).toBeLessThan(1_000);
    const verdict = proof.decideVerdict({ status: 'ready', elapsedMs: 3_000 }, probe, fixture, null, run);
    expect(verdict.state, verdict.detail).toBe('pass');
  }, 60_000);

  onWindows('the removal prints plain booleans on one line, removes the character directory and never climbs above it', () => {
    const fixture = proof.createImportFixture();
    const { home, cwd, curated } = curatedHome(fixture);
    const run = runPowerShell(proof.buildBoxRemoveCommand(proof.DEFAULT_BOX_ROOT, STORAGE_KEY), home, cwd);
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout.trim().split(/\r?\n/)).toHaveLength(1);
    expect(proof.parseProbe(run.stdout)).toEqual({ expanded: false, literal: false });
    expect(existsSync(curated)).toBe(false);
    expect(existsSync(join(home, 'lora-characters', STORAGE_KEY))).toBe(false);
    expect(existsSync(join(home, 'lora-characters'))).toBe(true);
  }, 60_000);
});

describe('an unreadable probe names itself', () => {
  const ready = { status: 'ready', elapsedMs: 3_000 };

  /** What Windows PowerShell 5.1 printed on 2026-09-28: the caption as a provider-decorated object. */
  function decoratedStdout(caption: string) {
    const txt = `C:\\Users\\someone\\lora-characters\\${STORAGE_KEY}\\curated\\x.txt`;
    return JSON.stringify({
      expanded: { png: true, bytes: 852, txt: true, caption: { value: caption, PSPath: txt, PSParentPath: txt.replace(/\\x\.txt$/, ''), PSChildName: 'x.txt',
        PSDrive: { CurrentLocation: 'Users\\someone\\lora', Name: 'C', Provider: { ImplementingType: 'Microsoft.PowerShell.Commands.FileSystemProvider' } } } },
      literal: { png: false, bytes: 0, txt: false, caption: '' },
    });
  }

  it('reports a decorated caption as not a plain string, with the task exit and the first 300 redacted chars of stdout', () => {
    const fixture = proof.createImportFixture();
    const stdout = decoratedStdout(fixture.caption);
    expect(stdout.length).toBeGreaterThan(proof.PROBE_EXCERPT_CHARS + 100);
    const verdict = proof.decideVerdict(ready, proof.parseProbe(stdout), fixture, null, { stdout, stderr: '', exitCode: 0 });
    expect(verdict.state).toBe('fail');
    expect(verdict.detail).toContain('nothing readable: "expanded".caption is not a plain string (object) (probe task exit 0)');
    expect(verdict.detail).toContain(`Worker stdout, first ${proof.PROBE_EXCERPT_CHARS} chars: "${proof.redactWorkerText(stdout).slice(0, proof.PROBE_EXCERPT_CHARS)}..."`);
    expect(verdict.detail).toContain('C:\\\\Users\\\\user\\\\lora-characters');
    expect(verdict.detail).not.toContain('someone');
    expect(verdict.detail).not.toContain('FileSystemProvider');
  });

  it('reports a truncated payload, an empty stdout with stderr, and a probe task that never answered', () => {
    const fixture = proof.createImportFixture();
    const truncated = decoratedStdout(fixture.caption).slice(0, 200);
    const cut = proof.decideVerdict(ready, proof.parseProbe(truncated), fixture, null, { stdout: truncated, stderr: '', exitCode: 0 });
    expect(cut.state).toBe('fail');
    expect(cut.detail).toContain('nothing readable: no JSON object line in the worker stdout (probe task exit 0)');
    expect(cut.detail).toContain(`chars: "${truncated.slice(0, 40)}`);
    const empty = proof.decideVerdict(ready, null, fixture, null, { stdout: '', stderr: 'C:\\Users\\someone\\x: Access is denied', exitCode: 1 });
    expect(empty.detail).toContain(`(probe task exit 1). Worker stdout, first ${proof.PROBE_EXCERPT_CHARS} chars: (empty); stderr: "C:\\Users\\user\\x: Access is denied".`);
    const none = proof.decideVerdict(ready, null, fixture, null, { stdout: '', stderr: '', exitCode: null, error: 'no result within the budget' });
    expect(none.detail).toContain('(probe task no result within the budget)');
  });

  it('names the wrong-shaped field: a string bytes count, a stringly boolean and a missing literal block', () => {
    const literal = { png: false, bytes: 0, txt: false, caption: '' };
    expect(proof.probeShapeProblem({ expanded: { png: true, bytes: '852', txt: true, caption: 'x' }, literal })).toBe('"expanded".bytes is not a plain number');
    expect(proof.probeShapeProblem({ expanded: { png: 'True', bytes: 852, txt: true, caption: 'x' }, literal })).toBe('"expanded".png/txt are not plain booleans');
    expect(proof.probeShapeProblem({ expanded: { png: true, bytes: 852, txt: true, caption: 'x' } })).toBe('"literal" is not an object');
    expect(proof.probeShapeProblem({ expanded: { png: true, bytes: 852, txt: true, caption: ['x'] }, literal })).toBe('"expanded".caption is not a plain string (array)');
    expect(proof.probeShapeProblem({ expanded: { png: true, bytes: 852, txt: true, caption: 'x' }, literal })).toBeNull();
  });

  it('quotes an unreadable removal stdout in the cleanup error', async () => {
    const f = fake({ removeOutput: 'Remove-Item : Access to the path C:\\Users\\someone\\lora is denied' });
    const result = await proof.runLoraImportAcceptance(f.ports);
    expect(result.state).toBe('fail');
    expect(result.detail).toContain(`CLEANUP INCOMPLETE: box directory ${STORAGE_KEY} was not removed (exit 0; worker stdout: "Remove-Item : Access to the path C:\\Users\\user\\lora is denied")`);
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
