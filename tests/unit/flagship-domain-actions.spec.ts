import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

function read(rel: string): string {
  return fs.readFileSync(rel, 'utf8');
}

describe('flagship domain action contracts', () => {
  // ADR-085 completion state: ALL FIVE flagship domains (career, comms/email, finance,
  // home, social) now ship as oshal-applications store packages — each carved with its
  // read surface + approval-gated action loop intact, exercised by the package tests +
  // the live deploy battery. This spec pins the completed carve state so a flagship
  // surface cannot silently reappear in (or vanish from) the kernel unnoticed.
  it('documents all five flagship domains as store-carved', () => {
    const plan = read('docs/apps/swarm-store-migration-plan.md');
    for (const app of ['career-hunter', 'email-summarizer', 'finance', 'home', 'social']) {
      expect(plan, `migration plan must name ${app}`).toContain(app);
    }
  });

  it('keeps the kernel free of flagship surface mounts (the packages own them)', () => {
    const server = read('src/app/server.ts');
    for (const mount of [
      "app.use('/api/email',",
      "app.use('/api/career-hunter',",
      "app.use('/api/finance',",
      "app.use('/api/home',",
      "app.use('/api/social',",
    ]) {
      expect(server, `kernel must not hard-mount ${mount}`).not.toContain(mount);
    }
  });

  it('keeps the shared email-send machinery kernel-resident for every packaged sender', () => {
    // (The email READ/draft/send ROUTES carved to the email-summarizer package, ADR-085
    //  Wave 3 — but the ONE fenced MIME builder + the Graph sibling + the Gmail metadata
    //  summarizer stay core: notify-routes, jarvis-brief-cron, and the carved packages all
    //  import @/app/routes/email-routes. The header-injection fence itself is guarded in
    //  risky-write-guards.spec.ts.)
    const email = read('src/app/routes/email-routes.ts');
    expect(email).toContain('export async function sendGmail');
    expect(email).toContain('export async function sendOutlookMail');
    expect(email).toContain('export function summarizeGmailMetadata');

    // The kernel senders stay wired through it (no forked MIME builders).
    expect(read('src/app/routes/notify-routes.ts')).toContain("import { sendGmail } from './email-routes'");
    expect(read('src/app/routes/jarvis-brief-cron.ts')).toContain("import { sendGmail } from './email-routes'");
  });
});
