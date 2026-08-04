/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard the deliverable capture boundaries. An adversarial review of the original design found it would have authorised a CROSS-TENANT READ: it checked only that the file resolved under /app/workspace-shared, and every user's private store lives inside that same root at userfiles/<sha256(sub)>. These cases exercise a real temp filesystem — including a symlink that escapes — because the whole control is realpath-based and a mocked fs would prove nothing about it.
 */

import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// The module reads CLINE_WORKSPACE_ROOT at import time, so the root is set BEFORE the import.
// POSIX separators throughout: the module ships in a Linux container, and its extraction regex is
// built from the configured root with '/' separators. Node accepts forward slashes for fs calls on
// Windows too, so the same paths drive both the filesystem and the text under test.
const ROOT = mkdtempSync(path.join(tmpdir(), 'oshal-capture-')).split('\\').join('/');
process.env.CLINE_WORKSPACE_ROOT = ROOT;

const saveContent = vi.fn();
vi.mock('@/app/routes/storage-target', () => ({
  saveContent: (...args: unknown[]) => saveContent(...args),
}));

let captureDeliverableFiles: typeof import('@/app/routes/jarvis-deliverable-files').captureDeliverableFiles;
let extractWorkspacePaths: typeof import('@/app/routes/jarvis-deliverable-files').extractWorkspacePaths;

const TASK_DIR = `${ROOT}/task-1/deliverables`;
const VICTIM_DIR = `${ROOT}/userfiles/${'a'.repeat(32)}`;
const OUTSIDE = mkdtempSync(path.join(tmpdir(), 'oshal-outside-')).split('\\').join('/');

beforeAll(async () => {
  mkdirSync(TASK_DIR, { recursive: true });
  mkdirSync(VICTIM_DIR, { recursive: true });
  writeFileSync(`${TASK_DIR}/report.html`, '<h1>pipeline</h1>');
  writeFileSync(`${VICTIM_DIR}/private.txt`, 'ANOTHER TENANT BOOK OF BUSINESS');
  writeFileSync(`${OUTSIDE}/secret.env`, 'API_KEY=live');
  const mod = await import('@/app/routes/jarvis-deliverable-files');
  captureDeliverableFiles = mod.captureDeliverableFiles;
  extractWorkspacePaths = mod.extractWorkspacePaths;
});

afterAll(() => {
  for (const d of [ROOT, OUTSIDE]) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
});

const ctx = {} as never;
const ok = (rel: string) => ({ provider: 'oshal-local', location: rel, downloadUrl: `/api/files/download?provider=oshal-local&path=${encodeURIComponent(rel)}` });

describe('deliverable capture — what it will read', () => {
  it('captures a real deliverable into the OWNER’s store and rewrites the text', async () => {
    saveContent.mockReset().mockResolvedValue(ok('jarvis/task-1/report.html'));
    const p = `${TASK_DIR}/report.html`;
    const res = await captureDeliverableFiles(ctx, 'user-abc', 'task-1', `Saved to ${p} — enjoy.`);

    expect(res.files).toHaveLength(1);
    expect(res.files[0].name).toBe('report.html');
    // The raw workspace path must not survive into the answer; that is the "says downloadable,
    // isn't" text the user actually saw.
    expect(res.text).not.toContain(p);
    expect(res.text).toContain('/api/files/download?provider=oshal-local');

    // The owner passed to storage is the RECORDED task owner, and the target is forced local —
    // resolveStorageTarget prefers Dropbox, and Google Drive returns no downloadUrl at all.
    const [, sub, kind, name, , override] = saveContent.mock.calls[0];
    expect(sub).toBe('user-abc');
    expect(kind).toBe('files');
    expect(name).toBe('report.html');
    expect(override).toEqual({ provider: 'oshal-local' });
  });

  it('refuses another tenant’s private store, even though it is inside the workspace root', async () => {
    saveContent.mockReset().mockResolvedValue(ok('x'));
    const victim = `${VICTIM_DIR}/private.txt`;

    const res = await captureDeliverableFiles(ctx, 'attacker', 'task-1', `see ${victim}`);

    // THE case this module exists for. userfiles/ is under the workspace root, so a containment
    // check against the root alone would have read another user's book of business.
    expect(res.files).toEqual([]);
    expect(saveContent).not.toHaveBeenCalled();
    expect(res.text).toContain(victim); // unchanged — nothing was captured, nothing is claimed
  });

  it('refuses a symlink that escapes the workspace root', async () => {
    saveContent.mockReset().mockResolvedValue(ok('x'));
    const link = `${TASK_DIR}/escape.env`;
    try { symlinkSync(`${OUTSIDE}/secret.env`, link); } catch { return; } // needs privilege on Windows

    const res = await captureDeliverableFiles(ctx, 'user-abc', 'task-1', `see ${link}`);

    // The path LOOKS like it is under the root; only realpath reveals it is not.
    expect(res.files).toEqual([]);
    expect(saveContent).not.toHaveBeenCalled();
  });

  it('refuses traversal to a REAL file outside the root', async () => {
    saveContent.mockReset().mockResolvedValue(ok('x'));
    // Deliberately resolves to a file that EXISTS. An earlier version of this case pointed at
    // /etc/passwd via ../../../..; that path does not exist on the test host, so realpathSync threw
    // and the case passed on ENOENT while the containment check was never exercised at all —
    // verified by deleting the check and watching the suite stay green. OUTSIDE is a sibling of
    // ROOT in tmpdir, so this traverses up one level into a real directory with a real file.
    const escape = `${ROOT}/../${path.basename(OUTSIDE)}/secret.env`;
    const res = await captureDeliverableFiles(ctx, 'user-abc', 'task-1', `see ${escape}`);

    expect(res.files).toEqual([]);
    expect(saveContent).not.toHaveBeenCalled();
    expect(res.text).toContain(escape); // nothing captured, nothing claimed
  });

  it('never claims a download when nothing was captured', async () => {
    saveContent.mockReset();
    const text = 'The report is available in the workspace app directory.';
    const res = await captureDeliverableFiles(ctx, 'user-abc', 'task-1', text);
    expect(res.files).toEqual([]);
    expect(res.text).toBe(text);
  });

  it('survives a storage failure (quota) without losing the answer', async () => {
    saveContent.mockReset().mockRejectedValue(new Error('OSHAL local storage quota (250 MB) exceeded'));
    const p = `${TASK_DIR}/report.html`;
    const res = await captureDeliverableFiles(ctx, 'user-abc', 'task-1', `Saved to ${p}`);
    expect(res.files).toEqual([]);
    expect(res.text).toContain(p); // the user still gets their result
  });

  it('does nothing without a recorded owner', async () => {
    saveContent.mockReset();
    const p = `${TASK_DIR}/report.html`;
    const res = await captureDeliverableFiles(ctx, '', 'task-1', `Saved to ${p}`);
    expect(res.files).toEqual([]);
    expect(saveContent).not.toHaveBeenCalled();
  });
});

describe('deliverable capture — path extraction', () => {
  it('finds BARE paths in prose, not only markdown links', () => {
    // Workers emit bare paths most of the time; handling only markdown is why an earlier attempt
    // left the raw path visible in the answer.
    const p = `${ROOT}/t1/deliverables/a.md`;
    expect(extractWorkspacePaths(`saved to ${p} today`)).toEqual([p]);
  });

  it('does not swallow sentence punctuation or a markdown closing paren', () => {
    const p = `${ROOT}/t1/r.html`;
    expect(extractWorkspacePaths(`see [r](${p}) now`)).toEqual([p]);
    expect(extractWorkspacePaths(`written to ${p}.`)).toEqual([p]);
  });

  it('dedupes and bounds the count', () => {
    const one = `${ROOT}/t1/a.md`;
    expect(extractWorkspacePaths(`${one} and again ${one}`)).toEqual([one]);
    const many = Array.from({ length: 12 }, (_, i) => `${ROOT}/t1/f${i}.md`).join(' ');
    expect(extractWorkspacePaths(many)).toHaveLength(5);
  });
});

describe('deliverable capture — wired into the completion path', () => {
  const ORCH = 'src/app/routes/jarvis-orchestrator.ts';
  const STORE = 'src/app/routes/jarvis-task-store.ts';
  const ROUTES = 'src/app/routes/jarvis-routes.ts';
  const JARVIS_HTML = 'src/api/jarvis.html';
  const readFile = (p: string): string =>
    require('node:fs').readFileSync(require('node:path').resolve(process.cwd(), p), 'utf8');

  it('captures against the RAW deliverable, not the LLM summary', () => {
    const src = readFile(ORCH);
    // The summary is the model's rendering of the work; the true paths live in the worker output.
    // Scanning the summary alone finds nothing whenever the model paraphrased the path — which is
    // most of the time, and is why the user saw a bolded **/deliverables** with no link.
    expect(src).toMatch(/captureDeliverableFiles\(ctx,\s*sub,\s*taskId,\s*deliverable\)/);
    // ...and the substitutions are then applied to the text the user actually reads.
    expect(src).toMatch(/captured\.replacements[\s\S]{0,160}summaryWithLinks\s*=\s*summaryWithLinks\.split/);
    expect(src).toMatch(/finishTask\([^)]*summaryWithLinks[^)]*captured\.files\)/);
  });

  it('resets files when a task is re-filed under the same id', () => {
    const src = readFile(STORE);
    // result/visual are already reset here. Omitting files would let a re-run surface the PREVIOUS
    // run's downloads next to a fresh answer — stale links that look authoritative.
    const conflict = /ON CONFLICT \(id\) DO UPDATE SET[^`]*/.exec(src)?.[0] ?? '';
    expect(conflict).toContain('files = NULL');
  });

  it('validates stored files to the owner-scoped download shape before serving them', () => {
    const src = readFile(STORE);
    expect(src).toContain("const DOWNLOAD_URL_PREFIX = '/api/files/download?'");
    // Anchored: startsWith, never includes/indexOf — otherwise 'https://evil/?x=/api/files/download?'
    // would pass and render as an off-site link inside a task result.
    expect(src).toMatch(/downloadUrl\.startsWith\(DOWNLOAD_URL_PREFIX\)/);
    expect(src).not.toMatch(/downloadUrl\.includes\(DOWNLOAD_URL_PREFIX\)/);
    expect(readFile(ROUTES)).toMatch(/storedFiles\(r\.files\)/);
  });

  it('stops rendering an unreachable workspace path as if it were a link', () => {
    const html = readFile(JARVIS_HTML);
    // /code opens code-server, which is not deployed on a customer box — the link was the
    // "it says downloadable but it isn't" defect.
    expect(html).not.toContain("'/code?file=' + encodeURIComponent(raw)");
    // The branch must SURVIVE, returning '#'. Deleting it does not fall through to '#': the path
    // starts with a single '/', so the general test below returns it verbatim as an href.
    expect(html).toMatch(/raw\.startsWith\('\/app\/workspace-shared\/'\)\)\s*return\s*'#'/);
    expect(html).toContain('downloadsHtml(d.files)');
  });
});
