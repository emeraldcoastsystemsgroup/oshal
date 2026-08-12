/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the guest demo resume. Two things must hold: the fictional resume must satisfy the career-hunter engine's has_profile() gate (a non-empty roles[] with titles, so the board indexes it instead of showing "upload your resume"), and the writer must plant it at the exact path the engine reads — default/<sub>/career_db.json under JOBHUNTER_STORE_ROOT — idempotently and without ever throwing (a guest login must never be blocked by a seed).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEMO_CAREER_DB, writeGuestCareerResume } from '../../src/app/routes/guest-demo-seed';

describe('guest demo resume: satisfies the engine has_profile() gate', () => {
  it('has a non-empty roles[] with titles — the "indexed resume" signal', () => {
    const db = DEMO_CAREER_DB as { roles: Array<{ title: string }>; profile: { experience_summary: string } };
    expect(db.roles.length).toBeGreaterThan(0);
    for (const r of db.roles) expect(r.title.length, 'each role needs a title for term derivation').toBeGreaterThan(0);
    // The alternate gate is a non-empty experience_summary — present too, so either path counts it.
    expect(db.profile.experience_summary.length).toBeGreaterThan(20);
  });

  it('is a wholly fictional demo persona — not the operator', () => {
    const flat = JSON.stringify(DEMO_CAREER_DB).toLowerCase();
    for (const forbidden of ['roger', 'murphy', 'emeraldcoast', 'agenticfederal']) {
      expect(flat.includes(forbidden), `demo resume must not contain "${forbidden}"`).toBe(false);
    }
  });
});

describe('guest demo resume: writer plants it where the engine reads', () => {
  let root: string;
  const originalRoot = process.env.JOBHUNTER_STORE_ROOT;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'career-store-'));
    process.env.JOBHUNTER_STORE_ROOT = root;
  });
  afterEach(() => {
    if (originalRoot === undefined) delete process.env.JOBHUNTER_STORE_ROOT;
    else process.env.JOBHUNTER_STORE_ROOT = originalRoot;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('writes career_db.json at default/<sub>/ with a parseable, gate-passing resume', () => {
    const sub = 'guest-0da51d07-642b-45fc-97ce-5c1b86362df3';
    writeGuestCareerResume(sub);
    const file = path.join(root, 'default', sub, 'career_db.json');
    expect(fs.existsSync(file), 'resume must land at the engine path').toBe(true);
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(parsed.roles.length).toBeGreaterThan(0);
  });

  it('is idempotent — never overwrites an existing resume (a returning guest keeps theirs)', () => {
    const sub = 'guest-abc';
    const file = path.join(root, 'default', sub, 'career_db.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{"roles":[{"title":"Existing"}]}', 'utf8');
    writeGuestCareerResume(sub);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).roles[0].title).toBe('Existing');
  });

  it('never throws, even when the store root is unwritable', () => {
    process.env.JOBHUNTER_STORE_ROOT = path.join(root, 'file-not-dir');
    fs.writeFileSync(process.env.JOBHUNTER_STORE_ROOT, 'x'); // a file where a dir is expected
    expect(() => writeGuestCareerResume('guest-xyz')).not.toThrow();
  });
});
