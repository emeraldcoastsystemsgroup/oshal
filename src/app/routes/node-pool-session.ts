/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Isolated node-pool assignment file handling behind trusted persona roots, bounded YAML parsing, owner-only credential files, and reversible session snapshots so released nodes cannot retain the prior assignment's credentials.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Add an owner-only active-session marker and fail-safe boot recovery. A process crash can no longer make a node report idle while credential files from the interrupted assignment remain reusable; managed output symlinks are rejected before writes.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import yaml from 'js-yaml';
import { z } from 'zod';
import {
  buildClineConfig,
  buildClineGlobalState,
  type CredentialBag,
} from '@/features/llm-provider';

const MAX_PERSONA_BYTES = 256 * 1024;

const personaSchema = z.object({
  name: z.string().max(256).optional(),
  role: z.string().max(256).optional(),
  agent_id: z.string().max(128).optional(),
  agentId: z.string().max(128).optional(),
  perspective: z.string().max(128 * 1024).optional(),
  capabilities: z.array(z.string().max(256)).max(256).optional(),
  max_concurrent: z.number().int().positive().max(128).optional(),
  scope: z.string().max(128).optional(),
  selector_descriptor: z.string().max(8 * 1024).optional(),
}).passthrough();

/** @description Input needed to materialize one hot-loaded node session. */
export interface NodeSessionInput {
  agentId: string;
  personaFile?: string;
  provider: string;
  model: string;
  credentials: CredentialBag;
}

interface FileSnapshot {
  path: string;
  content: Buffer | null;
  mode: number | null;
}

/** @description Opaque pre-assignment files restored when an assignment ends. */
export interface NodeSessionSnapshot {
  files: FileSnapshot[];
  markerPath: string;
}

/** @description Applied session metadata safe to retain in node state. */
export interface AppliedNodeSession {
  personaFile: string;
  snapshot: NodeSessionSnapshot;
}

/** @description Expected validation error for a rejected assignment payload. */
export class NodePoolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NodePoolInputError';
  }
}

interface SessionPaths {
  persona: string;
  clineConfig: string;
  globalState: string;
  marker: string;
}

/**
 * @description Writes a fresh node session and returns the files that must be restored.
 * If any write fails, the complete pre-assignment snapshot is restored before rethrowing.
 * @param input - Validated identity, provider, model, persona, and credential data.
 * @returns Snapshot plus the canonical persona path retained in public assignment state.
 */
export function applyNodeSession(input: NodeSessionInput): AppliedNodeSession {
  const paths = resolveSessionPaths();
  const snapshot = captureSession(paths);
  try {
    markSessionActive(paths.marker);
    const resolvedPersona = resolveTrustedPersonaFile(input.personaFile);
    const persona = buildPersona(input.agentId, resolvedPersona);
    writeProtectedJson(paths.persona, persona);
    writeProviderFiles(paths, input);
    return { personaFile: resolvedPersona || '', snapshot };
  } catch (error) {
    restoreNodeSession(snapshot);
    throw error;
  }
}

/**
 * @description Restores every file captured before assignment, deleting files that
 * did not exist beforehand. This removes assignment credentials on release/failure.
 * @param snapshot - Opaque file snapshot returned by {@link applyNodeSession}.
 */
export function restoreNodeSession(snapshot: NodeSessionSnapshot | null): void {
  if (!snapshot) return;
  for (const file of snapshot.files) restoreFile(file);
  removeFileIfPresent(snapshot.markerPath);
}

/**
 * @description Removes managed assignment files after a process died with an active-session
 * marker. The in-memory baseline cannot be reconstructed after a crash, so availability yields
 * to credential isolation: a fresh assignment must recreate every managed file.
 * @returns True when abandoned assignment residue was found and removed.
 */
export function recoverAbandonedNodeSession(): boolean {
  const paths = resolveSessionPaths();
  if (!pathEntryExists(paths.marker)) return false;
  for (const filePath of [paths.persona, paths.clineConfig, paths.globalState]) {
    removeFileIfPresent(filePath);
  }
  removeFileIfPresent(paths.marker);
  return true;
}

function resolveSessionPaths(): SessionPaths {
  const outputDir = path.resolve(process.env.CONFIG_OUTPUT_DIR || './output');
  const clineDir = path.resolve(process.env.CLINE_CONFIG_DIR || path.join(os.homedir(), '.cline'));
  return {
    persona: path.join(outputDir, 'bot-persona.json'),
    clineConfig: path.join(clineDir, 'config.json'),
    globalState: path.join(clineDir, 'data', 'globalState.json'),
    marker: path.join(outputDir, '.node-pool-session-active'),
  };
}

function captureSession(paths: SessionPaths): NodeSessionSnapshot {
  return {
    files: [paths.persona, paths.clineConfig, paths.globalState].map(captureFile),
    markerPath: paths.marker,
  };
}

function captureFile(filePath: string): FileSnapshot {
  if (!pathEntryExists(filePath)) return { path: filePath, content: null, mode: null };
  const stat = requireRegularManagedFile(filePath);
  return { path: filePath, content: fs.readFileSync(filePath), mode: stat.mode };
}

function restoreFile(snapshot: FileSnapshot): void {
  if (snapshot.content === null) {
    removeFileIfPresent(snapshot.path);
    return;
  }
  fs.mkdirSync(path.dirname(snapshot.path), { recursive: true, mode: 0o700 });
  if (pathEntryExists(snapshot.path)) requireRegularManagedFile(snapshot.path);
  fs.writeFileSync(snapshot.path, snapshot.content, { mode: snapshot.mode ?? 0o600 });
  if (snapshot.mode !== null) fs.chmodSync(snapshot.path, snapshot.mode);
}

function writeProviderFiles(paths: SessionPaths, input: NodeSessionInput): void {
  const config = buildClineConfig(input.provider, input.model, input.credentials);
  if (config) writeProtectedJson(paths.clineConfig, config);
  else if (fs.existsSync(paths.clineConfig)) fs.unlinkSync(paths.clineConfig);

  const globalState = buildClineGlobalState(input.provider, input.model, input.credentials);
  writeProtectedJson(paths.globalState, globalState);
}

function writeProtectedJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  if (pathEntryExists(filePath)) requireRegularManagedFile(filePath);
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
}

function markSessionActive(markerPath: string): void {
  fs.mkdirSync(path.dirname(markerPath), { recursive: true, mode: 0o700 });
  if (pathEntryExists(markerPath)) requireRegularManagedFile(markerPath);
  fs.writeFileSync(markerPath, `${new Date().toISOString()}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.chmodSync(markerPath, 0o600);
}

function requireRegularManagedFile(filePath: string): fs.Stats {
  const stat = fs.lstatSync(filePath);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error('Node session target is not a regular file');
  }
  return stat;
}

function pathEntryExists(filePath: string): boolean {
  try {
    fs.lstatSync(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function removeFileIfPresent(filePath: string): void {
  if (!pathEntryExists(filePath)) return;
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() && !stat.isSymbolicLink()) {
    throw new Error('Node session target is not a removable file');
  }
  fs.unlinkSync(filePath);
}

function buildPersona(agentId: string, personaFile: string | null): Record<string, unknown> {
  if (!personaFile) {
    return { name: agentId, role: 'worker', agentId, perspective: '', capabilities: '' };
  }
  const parsed = readPersona(personaFile);
  const declaredId = parsed.agent_id || parsed.agentId;
  if (declaredId && declaredId !== agentId) {
    throw new NodePoolInputError('Persona identity does not match the requested agent');
  }
  return {
    name: parsed.name || agentId,
    role: parsed.role || 'worker',
    agentId,
    perspective: parsed.perspective || '',
    capabilities: (parsed.capabilities || []).join(','),
    maxConcurrent: parsed.max_concurrent || 3,
    scope: parsed.scope || 'shared',
    selectorDescriptor: parsed.selector_descriptor || '',
    personaFile,
  };
}

function readPersona(personaFile: string): z.infer<typeof personaSchema> {
  try {
    const raw = fs.readFileSync(personaFile, 'utf8');
    return personaSchema.parse(yaml.load(raw));
  } catch (error) {
    if (error instanceof NodePoolInputError) throw error;
    throw new NodePoolInputError('Persona YAML is invalid');
  }
}

function resolveTrustedPersonaFile(rawPath?: string): string | null {
  const requested = String(rawPath || '').trim();
  if (!requested) return null;
  if (!/\.ya?ml$/i.test(requested)) throw new NodePoolInputError('Persona file must be YAML');
  const candidate = path.resolve(requested);
  if (!fs.existsSync(candidate)) throw new NodePoolInputError('Persona file was not found');
  const canonical = fs.realpathSync(candidate);
  const stat = fs.statSync(canonical);
  if (!stat.isFile() || stat.size > MAX_PERSONA_BYTES) {
    throw new NodePoolInputError('Persona file is not a bounded regular file');
  }
  const allowed = trustedPersonaRoots().some((root) => pathIsWithin(root, canonical));
  if (!allowed) throw new NodePoolInputError('Persona file is outside configured roots');
  return canonical;
}

function trustedPersonaRoots(): string[] {
  const configured = String(process.env.NODE_POOL_PERSONA_ROOTS || '')
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
  const defaults = [
    path.resolve(process.cwd(), 'ai-lab', 'bot-personas'),
    path.resolve('/app/ai-lab/bot-personas'),
  ];
  return [...new Set([...configured, ...defaults].map((root) => path.resolve(root)))]
    .filter((root) => fs.existsSync(root) && fs.statSync(root).isDirectory())
    .map((root) => fs.realpathSync(root));
}

function pathIsWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
