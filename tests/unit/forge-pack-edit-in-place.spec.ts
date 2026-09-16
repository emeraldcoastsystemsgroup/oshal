/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Bot Forge edit-in-place guard: re-deploying an edited pack must re-emit the SAME pack (same bot agentIds, same ticketType, one manifest, bumped version) instead of minting a duplicate identity set. Drives the REAL swarm-pack router over HTTP against a real on-disk pack tree and the real emitted manifest.
 */

import express, { type NextFunction, type Request, type Response } from 'express';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import type { Server } from 'node:http';
import yaml from 'js-yaml';

/**
 * The pack slug is deliberately distinctive: the deploy route writes REAL persona files into the
 * repo's ai-lab/bot-personas/ (that write is part of the boundary under test), so the sweep below
 * removes exactly the files this spec caused and nothing else.
 */
const SLUG = 'pack-edit-guard';
const SUB = 'auth0|forge-edit-lane';
const PERSONA_DIR = path.resolve(process.cwd(), 'ai-lab/bot-personas');

const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-forge-edit-'));
const originalWorkspaceRoot = process.env.CLINE_WORKSPACE_ROOT;
// PACKS_ROOT is resolved when the route module loads, so the env must be set BEFORE the import.
process.env.CLINE_WORKSPACE_ROOT = workspaceRoot;

/** sha256(sub) truncated the same way the route derives the caller's private packs subtree. */
function userKey(sub: string): string {
  return crypto.createHash('sha256').update(sub).digest('hex').slice(0, 32);
}

const packDir = path.join(workspaceRoot, 'packs', userKey(SUB), SLUG);
const deployedDir = path.join(workspaceRoot, 'deployed-apps');

interface DeployBody {
  ok?: boolean;
  app?: string;
  ticketType?: string;
  bots?: string[];
  edited?: boolean;
  version?: string;
  agentIds?: Array<{ name: string; agentId: string }>;
  error?: string;
}

/** Write pack.json + one bots/<file>.yml per entry, replacing whatever the pack held before. */
function writePack(descriptor: Record<string, unknown>, bots: Array<Record<string, unknown>>): void {
  fs.rmSync(path.join(packDir, 'bots'), { recursive: true, force: true });
  fs.mkdirSync(path.join(packDir, 'bots'), { recursive: true });
  fs.writeFileSync(path.join(packDir, 'pack.json'), JSON.stringify(descriptor, null, 2), 'utf8');
  for (const bot of bots) {
    fs.writeFileSync(path.join(packDir, 'bots', `${String(bot.name)}.yml`), yaml.dump(bot), 'utf8');
  }
}

/** The manifest the deploy actually emitted — the artifact, not the response. */
function emittedManifest(): Record<string, unknown> {
  return yaml.load(fs.readFileSync(path.join(deployedDir, `${SLUG}.yaml`), 'utf8')) as Record<string, unknown>;
}

/** The emitted manifest's bots, as declared on disk. */
function emittedBots(manifest: Record<string, unknown>): Array<{ name: string; agentId: string }> {
  return (manifest.bots as Array<{ name: string; agentId: string }>) ?? [];
}

describe('Bot Forge edit-in-place — an edited pack re-emits the SAME pack', () => {
  let server: Server;
  let baseUrl = '';
  const loaded: string[] = [];

  beforeAll(async () => {
    const { createSwarmPackRoutes } = await import('../../src/app/routes/swarm-pack-routes');
    const app = express();
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as unknown as { oidc: { user: { sub: string } } }).oidc = { user: { sub: SUB } };
      next();
    });
    app.use('/api/swarm/packs', createSwarmPackRoutes({
      loadApp: async (manifestPath: string) => { loaded.push(manifestPath); return {}; },
    }));
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  });

  afterAll(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
    if (originalWorkspaceRoot === undefined) delete process.env.CLINE_WORKSPACE_ROOT;
    else process.env.CLINE_WORKSPACE_ROOT = originalWorkspaceRoot;
  });

  afterEach(() => {
    // The deploy writes personas into the tracked persona directory; leave no residue behind.
    for (const file of fs.existsSync(PERSONA_DIR) ? fs.readdirSync(PERSONA_DIR) : []) {
      if (file.startsWith(`${SLUG}-`)) fs.rmSync(path.join(PERSONA_DIR, file), { force: true });
    }
  });

  async function deploy(): Promise<{ status: number; body: DeployBody }> {
    const response = await fetch(`${baseUrl}/api/swarm/packs/${SLUG}/deploy`, { method: 'POST' });
    return { status: response.status, body: (await response.json()) as DeployBody };
  }

  it('keeps every carried-over bot identity, the ticket type and the single manifest across an edit', async () => {
    writePack(
      { name: SLUG, mode: 'swarm', description: 'first cut', ticketType: 'pack-edit-guard', bots: ['worker'] },
      [{ name: 'worker', role: 'Worker', perspective: 'You audit expense reports.', capabilities: ['audit'] }],
    );

    const first = await deploy();
    expect(first.status, first.body.error).toBe(200);
    const workerId = emittedBots(emittedManifest()).find((b) => b.name === `${SLUG}-worker`)?.agentId;
    expect(workerId).toMatch(/^[0-9a-f-]{36}$/);

    // The operator edits the pack in place: the worker's brief changes, a second bot joins, and the
    // descriptor's ticketType drifts. None of that may re-identify the pack that is already live.
    writePack(
      { name: SLUG, mode: 'swarm', description: 'second cut', ticketType: 'pack-edit-guard-v2', bots: ['worker', 'checker'] },
      [
        { name: 'worker', role: 'Worker', perspective: 'You audit expense reports AND receipts.', capabilities: ['audit', 'receipts'] },
        { name: 'checker', role: 'Checker', perspective: 'You verify the audit.', capabilities: ['verify'] },
      ],
    );

    const second = await deploy();
    expect(second.status, second.body.error).toBe(200);

    const secondManifest = emittedManifest();
    const byName = new Map(emittedBots(secondManifest).map((b) => [b.name, b.agentId]));

    // 1. The carried-over bot keeps its identity — this is the "same pack, not a duplicate" claim.
    expect(byName.get(`${SLUG}-worker`)).toBe(workerId);
    // 2. A genuinely new bot still gets a fresh identity.
    expect(byName.get(`${SLUG}-checker`)).toBeTruthy();
    expect(byName.get(`${SLUG}-checker`)).not.toBe(workerId);
    // 3. The live queue identity is pinned — a drifting descriptor cannot fork a second ticket type.
    expect(second.body.ticketType).toBe('pack-edit-guard');
    expect(secondManifest.ticketType).toBe('pack-edit-guard');
    // 4. Exactly ONE manifest for this pack — no `<slug>-2.yaml` sibling, and the same path reloaded.
    expect(fs.readdirSync(deployedDir).filter((f) => f.startsWith(SLUG))).toEqual([`${SLUG}.yaml`]);
    expect(loaded[1]).toBe(loaded[0]);
    // 5. The edited content really did re-emit (the guard must not be passing on a stale manifest).
    expect(secondManifest.description).toBe('second cut');
    const workerPersona = yaml.load(
      fs.readFileSync(path.join(PERSONA_DIR, `${SLUG}-worker.yaml`), 'utf8'),
    ) as Record<string, string>;
    expect(workerPersona.perspective).toContain('receipts');
    // 6. The edit is a revision of the same pack, reported as such and versioned as such.
    expect(first.body.edited).toBe(false);
    expect(first.body.version).toBe('1.0.0');
    expect(second.body.edited).toBe(true);
    expect(second.body.version).toBe('1.0.1');
    expect(secondManifest.version).toBe('1.0.1');
  });
});

/**
 * The authoring turn happens in the Forge chat, so its half of "an edit is not a duplicate" is a
 * persona contract rather than a runtime path. This is a CONTRACT check on the shipped persona, not
 * evidence about a model's behaviour — the runtime guarantee is the route spec above.
 */
describe('Bot Forge edit-in-place — the packer persona carries the edit contract', () => {
  const persona = fs.readFileSync(path.resolve(process.cwd(), 'ai-lab/bot-personas/codex-packer.yaml'), 'utf8');
  const perspective = String(
    (yaml.load(persona) as { perspective?: unknown }).perspective ?? '',
  );

  it('tells the packer to re-emit an existing pack in place instead of deriving a new slug', () => {
    expect(perspective).toContain('Phase 1b');
    expect(perspective).toMatch(/edit-in-place/i);
    // The three identities an edit must carry forward, named in the persona.
    expect(perspective).toMatch(/`SLUG` — the same pack directory/);
    expect(perspective).toMatch(/`agent_id` \/ `agentId` — read it out of the existing persona/);
    expect(perspective).toMatch(/`ticketType` — the queue the operator's existing tickets/);
    // And the refusal: no invented identity for something that is already live.
    expect(perspective).toMatch(/An edit never mints a new identity/);
    expect(perspective).toMatch(/STOP and say/);
  });

  it('keeps the Forge manifest description honest about editing in place', () => {
    const manifest = yaml.load(
      fs.readFileSync(path.resolve(process.cwd(), 'swarm-apps/codex-packer.yaml'), 'utf8'),
    ) as { description?: string };
    expect(String(manifest.description)).toMatch(/edits that pack in place/i);
    expect(String(manifest.description)).toMatch(/never a duplicate/i);
  });
});
