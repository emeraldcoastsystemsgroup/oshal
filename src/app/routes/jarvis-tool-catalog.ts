/**
 * Jarvis tool catalog — the auto tool-feed (what Jarvis can actually DO) + the image-deliverable
 * contract appended to image-shaped hand-offs.
 *
 * Extracted from jarvis-routes.ts (2026-07-18, ADR-050); YAML routing metadata added for artifact handoffs.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted from jarvis-routes.ts: TOOL_CATALOG + buildToolsBlock (ADR-087 access-role-scoped auto tool-feed) + withImageDeliverableContract (route decomposition, no behaviour change).
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Advertise oshal-uber-rides.js's geocode/reverse subcommands. The CLI grew them with the rides map fix (they are what the surface calls to drop and drag pins), but this catalog is Jarvis's ONLY view of a tool — the block it builds says "a script not listed here is off-limits" — so a capability absent from the usage string does not exist as far as Jarvis is concerned. It was answering "where is X" / "what is at these coordinates" by guessing while a real geocoder sat one subcommand away.
 *
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Load strict versioned YAML semantic routing metadata, retain internal role ceilings, rank contextual tools, and expose browser artifact guidance.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Add a closed typed authorization feed adapter with caller-scoped operations and targets.
 *
 * @module jarvis-tool-catalog
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import yaml from 'js-yaml';
import { roleCanAccess, isSwarmAccessRole, type SwarmAccessRole } from '@/shared/types';
import type { HandoffDirective } from './jarvis-directives';
import { AUTHORIZATION_TOOL, AUTHORIZATION_READ_TOOL, type AuthorizationToolDiscovery } from '@/shared/security/authorization-tool-contract';

/** Semantic metadata helps selection; it grants no execution authority. */
interface SemanticMetadata { keywords: string[]; useWhen: string; context: string }
interface ToolCatalogEntry extends Partial<SemanticMetadata> {
  kind: 'shell'; script: string; usage: string; accessRoles?: SwarmAccessRole[];
}
interface TypedCatalogEntry extends SemanticMetadata { kind: 'typed'; name: typeof AUTHORIZATION_TOOL }
interface ToolCatalog {
  version: 1; tools: ToolCatalogEntry[];
  typedTools?: TypedCatalogEntry[];
  artifactHandoff: SemanticMetadata & { kind: 'artifact-handoff' };
}
/** Existing privileged scripts have an immutable discovery ceiling independent of YAML edits. */
const INTERNAL_SCRIPTS = new Set([
  "oshal-apply.js",
  "oshal-gmail-send.js",
  "oshal-send-alert.js",
  "oshal-vault.js",
  "oshal-vids.js",
  "oshal-tools-mcp.js",
  "oshal-trade-ops.js",
  "oshal-trade-recap.js",
  "oshal-trade-data.js",
  "oshal-deck-data.js",
  "oshal-recap-pipeline.js",
  "oshal-recap-email.js",
  "oshal-recap-render-remote.js",
  "oshal-recap-agent-remote.js",
  "oshal-backtest.js",
  "oshal-backtest-live.js",
  "oshal-gravity.js",
  "oshal-bars.js",
  "oshal-equity-bars.js",
  "oshal-intraday.js",
  "oshal-algos.js",
  "oshal-pick.js",
  "oshal-monitor.js",
  "oshal-optimize.js",
  "oshal-signal-mine.js",
  "oshal-signal-label.js"
]);

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function text(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\r\n\x00-\x1f]/.test(value);
}
function exactKeys(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}
function semantic(value: Record<string, unknown>): boolean {
  return Array.isArray(value.keywords) && value.keywords.length > 0 && value.keywords.length <= 32
    && value.keywords.every((word) => text(word, 64)) && text(value.useWhen, 500) && text(value.context, 500);
}

/**
 * @description Parse bounded versioned YAML. Invalid metadata or widened internal roles fail closed.
 * @param source - Trusted repository YAML contents, never request data.
 * @returns Validated catalog used for model discovery only.
 */
export function parseToolCatalog(source: string): ToolCatalog {
  const fail = (): never => { throw new Error('Invalid Jarvis tool catalog: expected version 1 routing metadata'); };
  if (Buffer.byteLength(source, 'utf8') > 128 * 1024) return fail();
  let value: unknown;
  try { value = yaml.load(source, { schema: yaml.JSON_SCHEMA }); } catch { return fail(); }
  if (!record(value) || !exactKeys(value, ['version', 'tools', 'typedTools', 'artifactHandoff']) || value.version !== 1
    || !Array.isArray(value.tools) || !value.tools.length || value.tools.length > 128) return fail();
  const seen = new Set<string>();
  for (const tool of value.tools) {
    if (!record(tool) || !exactKeys(tool, ['kind', 'script', 'usage', 'accessRoles', 'keywords', 'useWhen', 'context'])
      || tool.kind !== 'shell' || typeof tool.script !== 'string' || !/^oshal-[a-z0-9-]+\.js$/.test(tool.script)
      || seen.has(tool.script) || !text(tool.usage, 2000)) return fail();
    seen.add(tool.script);
    if (tool.accessRoles !== undefined && (!Array.isArray(tool.accessRoles) || tool.accessRoles.length === 0
      || !tool.accessRoles.every(isSwarmAccessRole))) return fail();
    if (INTERNAL_SCRIPTS.has(tool.script) && (!Array.isArray(tool.accessRoles)
      || tool.accessRoles.some((role) => role !== 'operator' && role !== 'swarm'))) return fail();
    if (roleCanAccess(tool.accessRoles as SwarmAccessRole[] | undefined, 'jarvis') && !semantic(tool)) return fail();
    if (['keywords', 'useWhen', 'context'].some((key) => key in tool) && !semantic(tool)) return fail();
  }
  if (value.typedTools !== undefined && (!Array.isArray(value.typedTools) || value.typedTools.length !== 1
    || !value.typedTools.every((tool) => record(tool) && exactKeys(tool, ['kind', 'name', 'keywords', 'useWhen', 'context'])
      && tool.kind === 'typed' && tool.name === AUTHORIZATION_TOOL && semantic(tool)))) return fail();
  const handoff = value.artifactHandoff;
  if (!record(handoff) || !exactKeys(handoff, ['kind', 'keywords', 'useWhen', 'context'])
    || handoff.kind !== 'artifact-handoff' || !semantic(handoff)) return fail();
  return value as unknown as ToolCatalog;
}

/** Read from source in both tsx and compiled dist runtimes; missing/malformed YAML is an error. */
function loadToolCatalog(): ToolCatalog {
  const sourcePath = resolve(__dirname, '../../../src/app/routes/jarvis-tools.yaml');
  return parseToolCatalog(readFileSync(sourcePath, 'utf8'));
}

/**
 * @description Load YAML on every turn and rank matching semantic hints without removing other valid tools.
 * Only catalogued, mounted scripts are advertised; YAML cannot widen existing internal access roles.
 * @param context - Optional request text and current surface; ranking hints only, never authority.
 * @returns Model tool feed with semantic metadata and existing CLI usage.
 */
export function buildToolsBlock(context: { message?: string; surface?: string; authorizationTools?: AuthorizationToolDiscovery[] } = {}): string {
  const catalog = loadToolCatalog();
  const scriptsPath = existsSync('/app/scripts') ? '/app/scripts' : resolve(__dirname, '../../../scripts');
  const mounted = new Set(readdirSync(scriptsPath).filter((file) => /^oshal-.*\.js$/.test(file)));
  const input = ((context.message ?? '') + ' ' + (context.surface ?? '')).slice(0, 16000).toLowerCase();
  const score = (tool: ToolCatalogEntry): number => (tool.keywords ?? []).filter((word) => input.includes(word.toLowerCase())).length;
  const tools = catalog.tools.filter((tool) => mounted.has(tool.script) && roleCanAccess(tool.accessRoles, 'jarvis'))
    .sort((a, b) => score(b) - score(a) || a.script.localeCompare(b.script));
  const lines = tools.map((tool) => '- ' + tool.usage + '  -> node /app/scripts/' + tool.script
    + ' | Keywords: ' + tool.keywords!.join(', ') + '. Use when: ' + tool.useWhen + ' Context: ' + tool.context);
  return [
    'YOUR TOOLS: shell out to these (auto-scoped to the signed-in user via OSHAL_USER_SUB).',
    'Use the request and current surface with keywords and context to select a tool. Keywords are hints, not authorization.',
    'Run a tool with no args or --help to learn usage. NEVER search the web for something a tool here already covers.',
    'These are your ONLY shell tools; a script not listed here is off-limits even if you can see it.',
    'Ask which tool or account the user intends when context leaves multiple plausible choices. Preserve existing confirmation requirements.',
    ...lines,
    ...typedAuthorizationLines(catalog, context.authorizationTools),
  ].join('\n');
}

function typedAuthorizationLines(catalog: ToolCatalog, available: AuthorizationToolDiscovery[] = []): string[] {
  const metadata = catalog.typedTools?.find((entry) => entry.name === AUTHORIZATION_TOOL);
  if (!metadata) return [];
  const tools = available.filter((tool) => tool.name === AUTHORIZATION_TOOL || tool.name === AUTHORIZATION_READ_TOOL);
  if (!tools.length) return [];
  return ['TYPED APPLICATION ACCESS TOOLS: call only the registered typed operation; do not construct a shell command.',
    `Keywords: ${metadata.keywords.join(', ')}. Use when: ${metadata.useWhen} Context: ${metadata.context}`,
    ...tools.map((tool) => `- ${tool.name}: operations=${JSON.stringify(tool.operations)}; targets=${JSON.stringify(tool.targets)}`),
    'Read operations use swarm_authorization_read when granted AUTO. Changes use the authenticated /access preview and apply flow.',
    'Only the user can approve the exact preview in Access Administration. Never claim an access change succeeded before an apply receipt.',
  ];
}

/**
 * @description Load YAML semantic hints for browser artifact dispatch, separate from executable CLI tools.
 * @returns Selection guidance to combine with caller-visible live artifact destinations.
 */
export function buildArtifactToolGuidance(): string {
  const handoff = loadToolCatalog().artifactHandoff;
  return 'ARTIFACT HANDOFF (browser dispatch, not shell): Keywords: ' + handoff.keywords.join(', ')
    + '. Use when: ' + handoff.useWhen + ' Context: ' + handoff.context;
}

/** Detects handoffs whose deliverable is imagery the user expects to SEE, not just read about. */
const IMAGE_DELIVERABLE_REQUEST = /\b(?:images?|photos?|pictures?|screenshots?|galler(?:y|ies))\b/i;

/**
 * @description Appends the image-deliverable contract to an image-shaped handoff description.
 * Jarvis's trusted gallery pipeline receives only local, workspace-confined files — it never
 * fetches worker/model-authored remote URLs (security design). Workers that hot-link images
 * therefore silently produce no visual (Fort Smith 2026-07-15), and toolless bots that win the
 * call-out bid cannot download at all (they self-score against this description, ADR-083), so
 * the contract states both the required artifact shape and the required capability. Provider-bound
 * handoffs are excluded: their visuals are derived server-side from provider records, and their
 * workers must NOT download images (e.g. Walmart returns product-image references only).
 * @param h - The handoff directive about to become a queue ticket.
 * @returns The ticket description, with the contract appended only for image-shaped, non-provider handoffs.
 */
export function withImageDeliverableContract(h: HandoffDirective): string {
  if (h.providerIntent) return h.description;
  if (!IMAGE_DELIVERABLE_REQUEST.test(`${h.title}\n${h.description}`)) return h.description;
  return [
    h.description,
    '',
    'IMAGE DELIVERABLE CONTRACT — this task must produce image FILES the user will see:',
    '- Download the actual images into the ticket workspace `deliverables/assets/` directory (curl/wget).',
    '- Reference them by RELATIVE path (e.g. `![caption](assets/photo.jpg)`) from a Markdown file in `deliverables/`.',
    '- Link that Markdown file from your completion summary.',
    '- Remote/hot-linked image URLs are never displayed to the user and will be silently skipped.',
    '- This work requires shell access and outbound network to download files; a bot without those tools cannot complete it and should score itself low.',
  ].join('\n');
}
