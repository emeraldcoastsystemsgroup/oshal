/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the remote-box resume
 *   delivery rewrite: an apply ticket that targets a NON-co-located worker (render-node-1) used to
 *   get a smarts-free prompt (no resume, no form values, no "a DB row is not a submission" guard) and
 *   the box flailed / fabricated success from DB rows. This proves dispatchApply STAGES the resume
 *   into the task workspace, enqueues with workspacePath (so the node syncs it into codex's cwd),
 *   refuses to enqueue when the resume is absent, and that the prompt no longer uses docker-cp and
 *   still carries the resume-verify + anti-fabrication guards + the LAN callback URL.
 */

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

// vi.hoisted runs before the mocks, so the factory can reference this safely (real temp fs so the
// copyFile staging path actually executes end-to-end — no fs mock).
const hoisted = vi.hoisted(() => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-dispatch-spec-'));
  const resumeSrc = path.join(base, 'src-Resume.pdf');
  fs.writeFileSync(resumeSrc, '%PDF-1.4 unit-test resume');
  // The apply prompt now lives in the career-hunter package, loaded via apply-prompt-bridge. Point the
  // bridge at a fixture so this suite tests the TRANSPORT (staging + envelope + bridge wiring) without
  // the sibling store checkout — the prompt CONTENT is guarded in career-hunter/lib/apply-prompt.test.mjs.
  const promptModule = path.join(base, 'fixture-apply-prompt.js');
  fs.writeFileSync(promptModule,
    "module.exports = { buildApplyPrompt: (input, opts) => " +
    "['Upload ./Resume_ATS.pdf when the form asks for a resume.', " +
    "`POST your outcome to ${opts.controllerUrl}/api/apply/ingest when done.`].join('\\n') };");
  process.env.APPLY_PROMPT_MODULE = promptModule;
  const enqueued: Array<{ clientId: string; env: Record<string, any> }> = [];
  // Mutable so a test can simulate a worker that stopped draining its task queue.
  const state = { depth: 0 };
  return { base, resumeSrc, enqueued, state, queueDepth: () => state.depth, folderFor: (id: string) => path.join(base, id) };
});

vi.mock('@/app/routes/remote-client-routes', () => ({
  remoteClientRegistry: {
    listClients: () => [{
      clientId: 'oshal-chat-0ce849b6-8b95-4cf5-9223-ce22d638f1c9',
      status: 'online',
      healthy: true,
      // The desktop is bound to the user these applications belong to — node selection is
      // owner-scoped (tests/unit/device-access-dispatch.spec.ts), so an unbound box is not a
      // candidate for a named user's work.
      ownerSub: 'example-user-sub',
      capabilities: ['codex.exec'],
      controlPlaneUrl: 'http://203.0.113.10:35457',
      taskQueueDepth: hoisted.queueDepth(),
    }],
    enqueueTask: (clientId: string, env: Record<string, any>) => {
      hoisted.enqueued.push({ clientId, env });
      return { taskId: env.taskId };
    },
  },
  taskWorkspaceFolder: (id: string) => hoisted.folderFor(id),
}));

import { dispatchApply, type ApplyDispatchInput } from '@/app/apply-dispatch';
import { promises as fsp } from 'node:fs';

function baseInput(): ApplyDispatchInput {
  return {
    ticketId: '1986677e-82de-4239-a8c3-c238e727d5d5',
    userSub: 'example-user-sub',
    postingId: 1147705,
    job: { title: 'Senior SE', company: 'Two Six Technologies', url: 'https://boards.example/2six', location: 'Remote, US' },
    profile: { name: 'oshal maintainers', phone: '+15551234567', authorized: 'Yes' },
    packet: { resumePdf: hoisted.resumeSrc, coverPdf: null, workdayAutofill: null },
  };
}

beforeEach(() => {
  hoisted.enqueued.length = 0;
  hoisted.state.depth = 0;
});

afterAll(async () => {
  await fsp.rm(hoisted.base, { recursive: true, force: true }).catch(() => undefined);
});

describe('remote-box apply dispatch', () => {
  it('stages the resume into the task workspace and enqueues with workspacePath (no docker cp)', async () => {
    const r = await dispatchApply(baseInput());

    expect(r.ok).toBe(true);
    expect(r.clientId).toBe('oshal-chat-0ce849b6-8b95-4cf5-9223-ce22d638f1c9');
    expect(hoisted.enqueued).toHaveLength(1);

    const { env } = hoisted.enqueued[0];
    // The node pulls exactly this folder into codex's cwd — it MUST equal the taskId.
    expect(env.workspacePath).toBe(env.taskId);
    expect(env.taskId).toBe(r.taskId);

    // The resume + form values actually landed on disk for the node to sync.
    expect(existsSync(join(hoisted.folderFor(env.taskId), 'Resume_ATS.pdf'))).toBe(true);
    expect(existsSync(join(hoisted.folderFor(env.taskId), 'profile.json'))).toBe(true);

    const prompt: string = env.input.arguments.prompt;
    expect(prompt).not.toMatch(/docker cp/i);
    expect(prompt).toContain('./Resume_ATS.pdf');
    // Callback goes to the box's own registered LAN control-plane URL, not loopback: the remote
    // desktop cannot reach the controller's localhost. The address is RFC 5737 TEST-NET-3, reserved
    // for documentation — a real 192.168.x fixture gets rewritten to "localhost" by the public
    // baseline sanitizer, which turned this pair of assertions into a contradiction (ADR-115).
    expect(prompt).toContain('http://203.0.113.10:35457/api/apply/ingest');
    expect(prompt).not.toMatch(/127\.0\.0\.1|localhost/);
  });

  it('refuses to dispatch (and never enqueues) when the resume PDF is not on the controller', async () => {
    const input = baseInput();
    input.packet.resumePdf = join(hoisted.base, 'does-not-exist.pdf');

    const r = await dispatchApply(input);

    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/resume/i);
    expect(hoisted.enqueued).toHaveLength(0);
  });

  it('refuses to dispatch into a worker that stopped draining its task queue (wedged desktop)', async () => {
    // Heartbeat alive + healthy, but the claim loop is stuck: tasks queue and are never picked up.
    // Dispatching anyway BURNS the ticket (claims the posting, then times out 30 min later), so the
    // durable queue must pause and retry instead. (Observed live 2026-07-21: 1 queued, 0 claimed.)
    hoisted.state.depth = 1;

    const r = await dispatchApply(baseInput());

    expect(r.ok).toBe(false);
    expect(hoisted.enqueued).toHaveLength(0);   // nothing piled onto the wedged worker
  });

  // The prompt CONTENT guards (résumé-verify, anti-fabrication, remote-first/spam-retry/ground-not-defer)
  // moved to the package with the prompt: career-hunter/lib/apply-prompt.test.mjs (node --test). Core
  // keeps only the transport guards above; the fixture proves the bridged prompt flows into the envelope.
  it('uses the bridge-resolved prompt (with the worker callback URL) in the dispatched envelope', async () => {
    const r = await dispatchApply(baseInput());
    expect(r.ok).toBe(true);
    const prompt: string = hoisted.enqueued[0].env.input.arguments.prompt;
    expect(prompt).toContain('http://203.0.113.10:35457/api/apply/ingest'); // the client's registered URL
    expect(prompt).toContain('./Resume_ATS.pdf');
  });

  it('DEFERS (never enqueues) when the career-hunter apply-prompt module is not installed', async () => {
    // Force every bridge candidate to miss: nonexistent explicit path, a workspace with no package,
    // and no dev sibling. Only then does the module truly resolve to null.
    const saved = { m: process.env.APPLY_PROMPT_MODULE, w: process.env.CLINE_WORKSPACE_ROOT, s: process.env.OSHAL_STORE_DIR };
    process.env.APPLY_PROMPT_MODULE = join(hoisted.base, 'no-such-module.js');
    process.env.CLINE_WORKSPACE_ROOT = hoisted.base;   // has no deployed-apps/career-hunter/lib
    delete process.env.OSHAL_STORE_DIR;
    try {
      const r = await dispatchApply(baseInput());
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/apply module is not installed/i);
      expect(hoisted.enqueued).toHaveLength(0);
    } finally {
      process.env.APPLY_PROMPT_MODULE = saved.m;
      if (saved.w === undefined) delete process.env.CLINE_WORKSPACE_ROOT; else process.env.CLINE_WORKSPACE_ROOT = saved.w;
      if (saved.s !== undefined) process.env.OSHAL_STORE_DIR = saved.s;
    }
  });
});
