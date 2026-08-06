/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added PersonaFileLoader — reads bot persona YAML from filesystem (ported from the legacy personaLoader.js)
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Replaced regex YAML parser with js-yaml for robustness (anchors, multi-doc, nested objects) (#8 fix)
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Fixed UUID-based persona lookup — scans YAML files and matches agent_id field when UUID is provided instead of name
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Honored absolute BOT_PERSONA_FILE paths so swarm containers can load exact runtime personas
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Scrubbed legacy-codebase naming from comments (reworded to 'the legacy implementation')
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Search deployed-apps package personas/ dirs after the kernel dir — a runtime-injected store bot's persona was invisible here, so it silently executed on the DEFAULT profile persona (same package-dir blind spot the authorization seeder fixed in swarm-app-service seq 16)
 * 7 | maintainer@emeraldcoastsystemsgroup.com   | Preserve declared allowed_tools for the final server-owned prompt authorization binding.
 */

import { readFileSync, existsSync, readdirSync } from 'fs';
import { isAbsolute, join, resolve } from 'path';
import yaml from 'js-yaml';
import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'persona-file-loader' });

/**
 * @description Parsed bot persona from a YAML file.
 */
export interface BotPersona {
  name: string;
  role: string;
  agentId: string;
  perspective: string;
  systemPrompt: string;
  capabilities: string[];
  allowedTools: string[];
  selectorDescriptor: string;
  routingKeywords: string[];
  authorizations: Record<string, string>;
  maxConcurrent: number;
  scope: string;
  configGuide?: {
    title?: string;
    summary?: string;
    docPath: string;
  };
}

/**
 * @description Default persona directory path (relative to project root).
 */
const DEFAULT_PERSONA_DIR = 'ai-lab/bot-personas';

/**
 * @description Loads a bot persona YAML from the filesystem.
 * Follows the legacy implementation's pattern: bot reads its persona from disk before processing.
 *
 * Search order:
 * 1. Exact path if provided as absolute
 * 2. `{personaDir}/{agentName}.yaml` (UUID-style ids scan the dir matching agent_id)
 * 3. Each `{deployedAppsRoot}/<package>/personas/` dir, same matching — runtime-injected
 *    store bots (ADR-085) bundle their persona beside the manifest, not in the kernel dir
 *
 * @param agentIdOrName - Agent name (e.g., "project-manager") or UUID
 * @param personaDir - Directory containing persona YAML files
 * @returns Parsed persona, or null if not found
 */
export function loadPersonaFromFile(
  agentIdOrName: string,
  personaDir?: string,
): BotPersona | null {
  const dir = resolvePersonaDir(personaDir);
  const kernelPersona = searchDirForPersona(agentIdOrName, dir);
  if (kernelPersona) return kernelPersona;

  for (const packagePersonaDir of listDeployedPackagePersonaDirs()) {
    const packagePersona = searchDirForPersona(agentIdOrName, packagePersonaDir);
    if (packagePersona) return packagePersona;
  }

  logger.debug({ agentIdOrName, searchDir: dir }, 'No persona file found');
  return null;
}

/**
 * @description Search one directory for a persona matching the agent id or name.
 * @param agentIdOrName - Agent name or UUID.
 * @param dir - Directory to search.
 * @returns Parsed persona, or null when the directory has no match.
 */
function searchDirForPersona(agentIdOrName: string, dir: string): BotPersona | null {
  const candidates = buildCandidatePaths(agentIdOrName, dir);

  for (const candidatePath of candidates) {
    if (!existsSync(candidatePath)) continue;

    try {
      const raw = readFileSync(candidatePath, 'utf8');
      const persona = parsePersonaYaml(raw);
      logger.info({ agentIdOrName, path: candidatePath, name: persona.name }, 'Loaded persona from filesystem');
      return persona;
    } catch (err) {
      logger.warn({ err, path: candidatePath }, 'Failed to parse persona file');
    }
  }

  return null;
}

/**
 * @description List every deployed-apps package personas/ directory. The root mirrors
 * DEPLOYED_APPS_DIR in swarm-app-routes (CLINE_WORKSPACE_ROOT-relative) — an app layer
 * constant this feature slice cannot import.
 * @returns Existing `<deployedAppsRoot>/<package>/personas` paths (empty when the root is absent).
 */
function listDeployedPackagePersonaDirs(): string[] {
  const workspaceRoot = process.env.CLINE_WORKSPACE_ROOT
    || process.env.WORKSPACE_ROOT
    || '/app/workspace-shared';
  const root = join(resolve(workspaceRoot), 'deployed-apps');
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(root, entry.name, 'personas'))
      .filter((personasDir) => existsSync(personasDir));
  } catch {
    return [];
  }
}

/**
 * @description Resolves the persona directory, defaulting to ai-lab/bot-personas relative to project root.
 */
function resolvePersonaDir(personaDir?: string): string {
  if (personaDir) return resolve(personaDir);
  // Walk up from src to find project root (where ai-lab/ lives)
  const projectRoot = resolve(__dirname, '..', '..', '..', '..');
  return join(projectRoot, DEFAULT_PERSONA_DIR);
}

/**
 * @description Build candidate file paths for a given agent ID or name.
 * For name-style IDs, tries direct filename match.
 * For UUID-style IDs, scans all YAML files in the directory and matches
 * against the agent_id field inside each file.
 */
function buildCandidatePaths(agentIdOrName: string, dir: string): string[] {
  const paths: string[] = [];

  if (isAbsolute(agentIdOrName)) {
    paths.push(agentIdOrName);
    return paths;
  }

  // If it looks like a name (no UUID-style segments)
  if (!agentIdOrName.includes('-0000-')) {
    paths.push(join(dir, `${agentIdOrName}.yaml`));
    paths.push(join(dir, `${agentIdOrName}.yml`));
    return paths;
  }

  // UUID-style: scan all YAML files and match by agent_id field inside the file
  try {
    const files = readdirSync(dir).filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'));
    for (const file of files) {
      const filePath = join(dir, file);
      try {
        const content = readFileSync(filePath, 'utf8');
        const doc = yaml.load(content) as Record<string, unknown> | null;
        if (doc && (String(doc.agent_id ?? '') === agentIdOrName || String(doc.agentId ?? '') === agentIdOrName)) {
          paths.push(filePath);
          break;
        }
      } catch {
        /* skip unparseable files */
      }
    }
  } catch {
    /* directory not readable */
  }

  return paths;
}

/**
 * @description Parse a persona YAML file into a structured BotPersona using js-yaml.
 * Handles anchors, multi-document, nested objects, block scalars — all standard YAML features.
 */
function parsePersonaYaml(raw: string): BotPersona {
  const doc = yaml.load(raw) as Record<string, unknown> ?? {};
  const configGuide = readConfigGuide(doc.config_guide ?? doc.configGuide);
  return {
    name: String(doc.name ?? ''),
    role: String(doc.role ?? ''),
    agentId: String(doc.agent_id ?? doc.agentId ?? ''),
    perspective: String(doc.perspective ?? ''),
    systemPrompt: String(doc.system_prompt ?? doc.systemPrompt ?? ''),
    capabilities: toStringArray(doc.capabilities),
    allowedTools: toStringArray(doc.allowed_tools ?? doc.allowedTools),
    selectorDescriptor: String(doc.selector_descriptor ?? doc.selectorDescriptor ?? ''),
    routingKeywords: toStringArray(doc.routing_keywords ?? doc.routingKeywords),
    authorizations: toStringMap(doc.authorizations),
    maxConcurrent: Number(doc.max_concurrent ?? doc.maxConcurrent ?? 3),
    scope: String(doc.scope ?? 'shared'),
    ...(configGuide ? { configGuide } : {}),
  };
}

function readConfigGuide(value: unknown): BotPersona['configGuide'] | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const docPath = String(record.doc_path ?? record.docPath ?? record.path ?? '').trim();
  if (!docPath) {
    return undefined;
  }

  const title = String(record.title ?? '').trim();
  const summary = String(record.summary ?? '').trim();

  return {
    docPath,
    ...(title ? { title } : {}),
    ...(summary ? { summary } : {}),
  };
}

/**
 * @description Safely coerce an unknown value to a string array.
 */
function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((v) => String(v)).filter((s) => s.length > 0);
}

/**
 * @description Safely coerce an unknown value to a string-keyed map.
 */
function toStringMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object') return {};
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    result[k] = String(v ?? '');
  }
  return result;
}
