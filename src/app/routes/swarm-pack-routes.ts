/**
 * Swarm Pack Routes — download / inspect codex-packer output.
 *
 * codex-packer writes its output to a deterministic, named directory
 * `${CLINE_WORKSPACE_ROOT}/packs/<name>/` containing a `pack.json` descriptor
 * ({ name, mode: 'wrapper' | 'swarm', description, files }). These routes let the
 * cockpit list packs, read a descriptor, and DOWNLOAD the pack as a ZIP — the
 * "one-shot codex wrapper → downloadable zip" half of ADR-039. The "load a
 * multi-bot swarm into the runtime" half (deploy) is a sibling slice.
 *
 * ZIP is emitted with zero dependencies (store method + Node 20 `zlib.crc32`).
 *
 * Deploying a pack that is ALREADY live is an EDIT IN PLACE, not a second app: the emission
 * keeps the bots' existing agent ids and the existing ticketType and bumps the patch version.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — GET /packs (list), GET /packs/:name (descriptor), GET /packs/:name/download (dependency-free store-ZIP). Slice 1 of the codex-packer → deploy rails.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Per-user pack isolation (closes the shared-packs leak): every route now scopes to packs/<userKey>/ where userKey = sha256(OIDC sub). list/descriptor/download/workflow/deploy only ever touch the caller's own subtree; 401 when unauthenticated. The packer side gets the same key via the .oshal-user-key workspace file (applyUserScoping).
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Bot Forge edit-in-place: deploying a pack that is already live re-emits the SAME pack instead of a duplicate - every carried-over bot keeps the agentId the swarm registered it under (agents upsert on agent_id, so a fresh uuid per deploy registered a second identity for the same bot and orphaned the row tickets/chat tasks point at), the ticketType stays the queue the operator's tickets live in, and the manifest version bumps a patch. Only a genuinely new bot name mints an id; the response reports edited/version/agentIds.
 *
 * @module swarm-pack-routes
 */
import { Router, type Request, type Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import * as crypto from 'crypto';
import yaml from 'js-yaml';
import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'swarm-pack-routes' });

/** Minimal contract we need from the swarm-app service (avoids tight coupling). */
interface AppLoader { loadApp(manifestPath: string): Promise<unknown>; }

/** "html5-game-generator" → "Html5 Game Generator". */
function titleCase(s: string): string {
  return s.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Root holding the per-user pack subtrees (packs/<userKey>/<name>/). */
const PACKS_ROOT = path.join(process.env.CLINE_WORKSPACE_ROOT || '/app/workspace-shared', 'packs');

/** Reject anything that isn't a safe single path segment (no traversal). */
function safeName(name: string): string | null {
  return /^[a-zA-Z0-9._-]{1,80}$/.test(name) ? name : null;
}

/**
 * @description FS-safe, collision-free per-user key derived from the OIDC sub.
 * sha256 hex (OIDC subs may contain `|` / `:` and aren't path-safe). The bot side
 * (codex-packer) gets the SAME key via the `.oshal-user-key` workspace file written
 * by applyUserScoping, so packs land where these routes read them.
 * @param sub - the caller's OIDC sub
 * @returns 32-char hex key
 */
function userKey(sub: string): string {
  return crypto.createHash('sha256').update(sub).digest('hex').slice(0, 32);
}

/**
 * @description The caller's private packs root (packs/<userKey>/). Returns null when
 * unauthenticated — the routes are behind requiresAuth, so this is a defensive guard.
 * Isolating reads/writes here is the security boundary: packs were shared (any logged-in
 * user could list/download/deploy any pack) before this.
 * @param req - the Express request (carries the OIDC session)
 * @returns absolute per-user packs dir, or null if no authenticated sub
 */
function userPacksRoot(req: Request): string | null {
  const sub = (req as unknown as { oidc?: { user?: { sub?: string } } }).oidc?.user?.sub;
  if (!sub) return null;
  return path.join(PACKS_ROOT, userKey(String(sub)));
}

/** Recursively collect files under a dir as { name (relative, posix), abs }. */
function walk(dir: string, base = dir): Array<{ name: string; abs: string }> {
  const out: Array<{ name: string; abs: string }> = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(abs, base));
    else if (entry.isFile()) out.push({ name: path.relative(base, abs).split(path.sep).join('/'), abs });
  }
  return out;
}

/** Build a ZIP (store method, no compression) from a list of files. No deps. */
function buildZip(files: Array<{ name: string; data: Buffer }>): Buffer {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const nameBuf = Buffer.from(f.name, 'utf8');
    const crc = zlib.crc32(f.data) >>> 0;
    const size = f.data.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6); local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10); local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(size, 18); local.writeUInt32LE(size, 22);
    local.writeUInt16LE(nameBuf.length, 26); local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, f.data);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(0, 8); cd.writeUInt16LE(0, 10);
    cd.writeUInt16LE(0, 12); cd.writeUInt16LE(0, 14);
    cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(size, 20); cd.writeUInt32LE(size, 24);
    cd.writeUInt16LE(nameBuf.length, 28); cd.writeUInt16LE(0, 30); cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34); cd.writeUInt16LE(0, 36); cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);
    offset += local.length + nameBuf.length + size;
  }
  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4); end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cdBuf.length, 12); end.writeUInt32LE(offset, 16); end.writeUInt16LE(0, 20);
  return Buffer.concat([...chunks, cdBuf, end]);
}

/** Read a pack's descriptor (pack.json) if present, else a minimal inferred one. */
function readDescriptor(dir: string, name: string): Record<string, unknown> {
  try {
    const raw = fs.readFileSync(path.join(dir, 'pack.json'), 'utf8');
    return { name, ...JSON.parse(raw) };
  } catch {
    return { name, mode: 'unknown', description: '', files: walk(dir).map((f) => f.name) };
  }
}

/** The writable deploy dir a pack's manifest is (re-)emitted into (swarm-apps/ is read-only). */
function deployedAppsDir(): string {
  return path.join(process.env.CLINE_WORKSPACE_ROOT || '/app/workspace-shared', 'deployed-apps');
}

/** The identity a previous deploy of the SAME pack already put into the running swarm. */
interface PriorEmission {
  /** manifest version of that emission */
  version: string;
  /** the ticket type its queue was created under ('' when the manifest omitted one) */
  ticketType: string;
  /** manifest bot name -> the agentId the swarm knows that bot by */
  agentIdByBotName: Map<string, string>;
}

/**
 * @description Reads the manifest a previous deploy of this pack emitted. Editing a pack and
 * deploying it again is an EDIT of the app that is already live, not a second app: bots upsert on
 * `agent_id`, so minting a fresh uuid per deploy registers a duplicate identity for the same bot
 * and orphans the row existing tickets/chat tasks point at, and a drifted ticketType forks a second
 * queue away from the operator's existing tickets.
 * @param manifestPath - deployed-apps/<pack>.yaml for this pack
 * @returns the prior identity to carry forward, or null when this pack has never been deployed
 */
function readPriorEmission(manifestPath: string): PriorEmission | null {
  if (!fs.existsSync(manifestPath)) return null;
  try {
    const prior = (yaml.load(fs.readFileSync(manifestPath, 'utf8')) || {}) as Record<string, unknown>;
    const agentIdByBotName = new Map<string, string>();
    for (const bot of Array.isArray(prior.bots) ? prior.bots : []) {
      const entry = bot as { name?: unknown; agentId?: unknown };
      if (typeof entry.name === 'string' && typeof entry.agentId === 'string' && entry.agentId) {
        agentIdByBotName.set(entry.name, entry.agentId);
      }
    }
    return {
      version: typeof prior.version === 'string' ? prior.version : '1.0.0',
      ticketType: typeof prior.ticketType === 'string' ? prior.ticketType : '',
      agentIdByBotName,
    };
  } catch (err) {
    logger.warn({ err, manifestPath }, 'prior pack manifest unreadable - emitting fresh bot identities');
    return null;
  }
}

/** "1.0.0" -> "1.0.1": a re-emission is a revision of the same pack, never a new pack. */
function bumpPatchVersion(version: string): string {
  const parts = /^(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  return parts ? `${parts[1]}.${parts[2]}.${Number(parts[3]) + 1}` : '1.0.0';
}

/**
 * @description Reads the pack's bots/ YAMLs, writes each one as a persona, and returns the manifest
 * bot declarations. A bot name the previous emission already registered keeps that agentId; only a
 * name the swarm has never seen for this pack mints a new one.
 * @param dir - the pack directory
 * @param name - the pack slug (also the app name and the persona prefix)
 * @param prior - the previous emission's identity, or null for a first deploy
 * @returns manifest bot declarations in pack order
 */
function buildPackBots(dir: string, name: string, prior: PriorEmission | null): Array<Record<string, unknown>> {
  const botsDir = path.join(dir, 'bots');
  const botFiles = fs.existsSync(botsDir) ? fs.readdirSync(botsDir).filter((f) => /\.ya?ml$/.test(f)) : [];
  const personaDir = path.resolve(process.cwd(), 'ai-lab/bot-personas');
  fs.mkdirSync(personaDir, { recursive: true });
  const bots: Array<Record<string, unknown>> = [];
  for (const bf of botFiles) {
    const parsed = (yaml.load(fs.readFileSync(path.join(botsDir, bf), 'utf8')) || {}) as Record<string, unknown>;
    const baseName = String(parsed.name || bf.replace(/\.ya?ml$/, '')).toLowerCase().replace(/[^a-z0-9-]/g, '-');
    const botName = `${name}-${baseName}`.slice(0, 60);
    const persona = { name: botName, role: parsed.role || '', perspective: parsed.perspective || parsed.prompt || `You are ${botName}.` };
    fs.writeFileSync(path.join(personaDir, `${botName}.yaml`), yaml.dump(persona, { lineWidth: 120 }), 'utf8');
    bots.push({
      agentId: prior?.agentIdByBotName.get(botName) || crypto.randomUUID(),
      name: botName,
      persona: `ai-lab/bot-personas/${botName}.yaml`,
      role: parsed.role || '',
      capabilities: Array.isArray(parsed.capabilities) ? parsed.capabilities : [],
    });
  }
  return bots;
}

/**
 * @description Builds the app manifest for a pack emission. The app id is the pack slug, the
 * ticketType isolates its queue (the cockpit ?app= contract), and gated swarms get a reviewer.
 * On an edit the ticketType and the version come from the prior emission, so the re-emission lands
 * on the same queue as the next revision rather than as a second app.
 * @param name - the pack slug
 * @param desc - the pack descriptor (pack.json)
 * @param bots - the manifest bot declarations from buildPackBots
 * @param prior - the previous emission's identity, or null for a first deploy
 * @returns the manifest plus the resolved ticketType / version / gated flags
 */
function buildPackManifest(
  name: string,
  desc: Record<string, unknown>,
  bots: Array<Record<string, unknown>>,
  prior: PriorEmission | null,
): { manifest: Record<string, unknown>; ticketType: string; version: string; gated: boolean } {
  const gated = desc.hasApprovalGates === true && bots.length > 1;
  const ticketType = prior?.ticketType || String(desc.ticketType || name);
  const version = prior ? bumpPatchVersion(prior.version) : '1.0.0';
  const manifest: Record<string, unknown> = {
    name, displayName: titleCase(name),
    description: String(desc.description || `Deployed swarm: ${titleCase(name)}`),
    version, status: 'active', ticketType,
    ...(desc.theme ? { theme: desc.theme } : {}),
    workflow: {
      name: `${titleCase(name)} Workflow`,
      pipeline: 'incident-rca',                 // single accountable worker + optional reviewer (the proven app pattern)
      workerBot: (bots[0] as { name: string }).name,
      ...(gated ? { reviewerBot: (bots[bots.length - 1] as { name: string }).name, maxRevisions: 3 } : {}),
    },
    bots,
  };
  return { manifest, ticketType, version, gated };
}

/**
 * @description Builds the swarm-pack router (mount at /api/swarm/packs).
 * @returns Express router exposing list / descriptor / download.
 */
export function createSwarmPackRoutes(appLoader?: AppLoader): Router {
  const router = Router();

  /** GET / — list the CALLER's packs (newest first). Scoped per-user. */
  router.get('/', (req: Request, res: Response) => {
    const root = userPacksRoot(req);
    if (!root) { res.status(401).json({ error: 'not authenticated' }); return; }
    try {
      if (!fs.existsSync(root)) { res.json({ packs: [] }); return; }
      const packs = fs.readdirSync(root, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => ({ dir: path.join(root, d.name), name: d.name, mtime: fs.statSync(path.join(root, d.name)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime)
        .map((p) => ({ ...readDescriptor(p.dir, p.name), updatedAt: new Date(p.mtime).toISOString() }));
      res.json({ packs });
    } catch (err) {
      logger.error({ err }, 'list packs failed');
      res.status(500).json({ error: (err as Error).message });
    }
  });

  /** GET /studio — the Packs panel surface (list + download/deploy). */
  router.get('/studio', (_req: Request, res: Response) => {
    res.sendFile(path.resolve(process.cwd(), 'src/api/swarm-packs.html'), (err) => {
      if (err) { logger.error({ err }, 'serve packs panel failed'); res.status(404).send('Not found'); }
    });
  });

  /** GET /:name — one pack's descriptor + file list (caller's packs only). */
  router.get('/:name', (req: Request, res: Response) => {
    const root = userPacksRoot(req);
    if (!root) { res.status(401).json({ error: 'not authenticated' }); return; }
    const name = safeName(String(req.params.name));
    if (!name) { res.status(400).json({ error: 'bad pack name' }); return; }
    const dir = path.join(root, name);
    if (!fs.existsSync(dir)) { res.status(404).json({ error: 'pack not found' }); return; }
    res.json(readDescriptor(dir, name));
  });

  /** GET /:name/download — the pack as a ZIP (one-shot codex wrapper = downloadable). */
  router.get('/:name/download', (req: Request, res: Response) => {
    const root = userPacksRoot(req);
    if (!root) { res.status(401).json({ error: 'not authenticated' }); return; }
    const name = safeName(String(req.params.name));
    if (!name) { res.status(400).json({ error: 'bad pack name' }); return; }
    const dir = path.join(root, name);
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) { res.status(404).json({ error: 'pack not found' }); return; }
    try {
      const files = walk(dir).map((f) => ({ name: f.name, data: fs.readFileSync(f.abs) }));
      if (!files.length) { res.status(404).json({ error: 'pack is empty' }); return; }
      const zip = buildZip(files);
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="${name}.zip"`);
      res.send(zip);
      logger.info({ name, files: files.length, bytes: zip.length }, 'pack downloaded');
    } catch (err) {
      logger.error({ err, name }, 'pack download failed');
      res.status(500).json({ error: (err as Error).message });
    }
  });

  /** GET /:name/workflow — the pack's workflow.json (the visual-representation
   *  source the cockpit renders read-only). 404 if the pack has no graph. */
  router.get('/:name/workflow', (req: Request, res: Response) => {
    const root = userPacksRoot(req);
    if (!root) { res.status(401).json({ error: 'not authenticated' }); return; }
    const name = safeName(String(req.params.name));
    if (!name) { res.status(400).json({ error: 'bad pack name' }); return; }
    const wf = path.join(root, name, 'workflow.json');
    if (!fs.existsSync(wf)) { res.status(404).json({ error: 'pack has no workflow.json' }); return; }
    try {
      res.json({ name, workflow: JSON.parse(fs.readFileSync(wf, 'utf8')) });
    } catch (err) {
      res.status(500).json({ error: `workflow.json parse failed: ${(err as Error).message}` });
    }
  });

  /** POST /:name/deploy — emit a multi-bot swarm pack into the runtime: write bot personas,
   *  generate a swarm-apps manifest (app id + ticketType + workflow + gated reviewer), and
   *  loadApp() it — which registers the bots, the workflow pipeline, and the ticketType. The
   *  ticketType + app name isolate the ticket queue (the cockpit ?app= contract) so it never leaks
   *  into other views. Deploying a pack that is ALREADY live is an EDIT IN PLACE: the same app is
   *  re-emitted with its bots' existing agent ids and its existing ticketType, a bumped patch
   *  version, and no second manifest. Wrapper packs are downloaded, not deployed. */
  router.post('/:name/deploy', async (req: Request, res: Response) => {
    const root = userPacksRoot(req);
    if (!root) { res.status(401).json({ error: 'not authenticated' }); return; }
    const name = safeName(String(req.params.name));
    if (!name) { res.status(400).json({ error: 'bad pack name' }); return; }
    if (!appLoader) { res.status(503).json({ error: 'app loader unavailable' }); return; }
    const dir = path.join(root, name);
    if (!fs.existsSync(dir)) { res.status(404).json({ error: 'pack not found' }); return; }
    const desc = readDescriptor(dir, name) as Record<string, unknown>;
    if (desc.mode === 'wrapper') {
      res.status(400).json({ error: 'wrapper packs are downloaded, not deployed', download: `/api/swarm/packs/${name}/download` });
      return;
    }
    try {
      // The pack slug names exactly ONE manifest, so an edit overwrites rather than forking.
      const deployedDir = deployedAppsDir();
      const manifestPath = path.join(deployedDir, `${name}.yaml`);
      const prior = readPriorEmission(manifestPath);
      const bots = buildPackBots(dir, name, prior);
      if (!bots.length) { res.status(400).json({ error: 'pack has no bots/ to deploy' }); return; }
      const { manifest, ticketType, version, gated } = buildPackManifest(name, desc, bots, prior);
      // The boot path also auto-loads deployed-apps/, so the emission survives restarts.
      fs.mkdirSync(deployedDir, { recursive: true });
      fs.writeFileSync(manifestPath, `# Generated by codex-packer deploy — ${new Date().toISOString()}\n` + yaml.dump(manifest, { lineWidth: 120, noRefs: true }), 'utf8');
      // Load it — registers bots (agents table), workflow pipeline, ticketType, UI.
      await appLoader.loadApp(manifestPath);
      logger.info({ name, ticketType, bots: bots.length, gated, edited: Boolean(prior), version },
        prior ? 'swarm pack re-emitted in place' : 'swarm pack deployed');
      res.json({
        ok: true, app: name, ticketType, gated, version, edited: Boolean(prior),
        bots: bots.map((b) => b.name),
        agentIds: bots.map((b) => ({ name: b.name, agentId: b.agentId })),
        openUrl: `/cockpit/?app=${name}`,
      });
    } catch (err) {
      logger.error({ err, name }, 'pack deploy failed');
      res.status(500).json({ error: (err as Error).message });
    }
  });

  return router;
}
