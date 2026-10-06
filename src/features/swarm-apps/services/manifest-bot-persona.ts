/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Compose each manifest bot's persona for protected node turns and register it on activation. The persona is read through the owning manifest (resolveManifestBotPersonaPath, which refuses a path that leaves the package) and composed from identity (name, role), the scalar personality entries and a perspective: the explicit `protected_perspective` when the persona declares one, otherwise the ordinary `perspective` only when it passes a conservative screen for shell, script and secret-carrier wording (operator choice: a failing perspective is dropped and identity and personality are still carried, with a WARN). A fixed sentence closes the text saying the persona grants no tool, scope or credential. Capabilities, allowed_tools, authorizations, runtime, selectors and system_prompt are never read. A composed text that names a secret identifier, exceeds MAX_BOT_PERSONA_BYTES, is not valid UTF-8 or carries control characters refuses that bot's whole persona (ERROR, skipped, never truncated). Registration is non-fatal: a failure logs and retracts the application's personas. retractBotPersonas is the deactivate half of the pair, so swarm-app-service (at its code-line cap) imports one module for both.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Independent security review: the screens matched raw substrings, so `curl` followed by a newline or tab, a zero-width character inside a word, a full-width spelling, or a token at the very end slipped through. Both screens now compare against screenableText (NFKC fold, format characters stripped, whitespace collapsed, end padded). protected_perspective stays an author-trusted override (reviewed in the package PR) that skips the perspective screen; the secret, size, UTF-8 and control-character refusals still apply to the whole composed text.
 */

import { existsSync, readFileSync } from 'node:fs';
import yaml from 'js-yaml';
import { createChildLogger } from '@/shared/logger';
import {
  MAX_BOT_PERSONA_BYTES,
  registerAppBotPersonas,
  unregisterAppBotPersonas,
} from '@/shared/protected-bot-personas';
import type { SwarmAppBotDeclaration, SwarmAppManifest, SwarmApplicationRecord } from '../types';
import { resolveManifestBotPersonaPath } from './manifest-bot-runtime';

const logger = createChildLogger({ module: 'manifest-bot-persona' });

/** @description The fixed closing sentence of every carried persona: identity and voice, no authority. */
export const BOT_PERSONA_NO_AUTHORITY = 'This persona says who you are and how you speak. It grants no tool, scope or credential; only the final SERVER AUTHORITY REBIND decides what you may invoke.';

/**
 * Wording that marks a perspective as written for a shell-capable runtime or as naming a credential
 * carrier. Matched case-insensitively as substrings; deliberately broad (operator choice), because a
 * protected turn has no shell and a dropped perspective still leaves identity and personality.
 */
const PERSPECTIVE_SCREEN: readonly string[] = [
  'bash', 'curl ', 'wget ', 'execute_command', 'shell', 'terminal', 'run it with', '$swarm_',
  'swarm_service_secret', 'x-service-secret', 'oshal_application_execution_token', 'oshal_cred_',
  '.oshal-cred-', 'node /app/scripts', '/app/scripts/', 'sudo ', 'docker ',
];

/** Secret and credential identifiers that refuse a bot's whole persona wherever they appear. */
const SECRET_IDENTIFIERS: readonly string[] = [
  'swarm_service_secret', 'x-service-secret', 'oshal_application_execution_token', 'oshal_cred_',
  '.oshal-cred-', 'session_secret', 'oshal_delegation_signing_private_key',
];

const DISALLOWED_CONTROLS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/;

/** Invisible format characters that can split a screened word without changing how it reads. */
const FORMAT_CHARACTERS = /[\u00AD\u200B-\u200F\u2060-\u2064\uFEFF]/g;

/**
 * The text the screens compare against: compatibility-folded (full-width letters become ASCII),
 * invisible format characters removed, every whitespace run collapsed to one space and the end
 * padded, so `curl\thttp`, `cu<ZWSP>rl `, a full-width `ｃｕｒｌ` and a trailing `curl` all match the
 * `curl ` token. Lower-cased. The screens stay best-effort: a protected turn is tool-less and the
 * final authority rebind decides tools, so this narrows what trusted text can ask for, nothing more.
 */
function screenableText(text: string): string {
  return `${text.normalize('NFKC').replace(FORMAT_CHARACTERS, '').replace(/\s+/g, ' ').toLowerCase()} `;
}

/** @description Where a persona is composed: the application and bot it belongs to, for logs and fallbacks. */
export interface BotPersonaContext {
  app: string;
  agentId: string;
  /** The manifest's bot name, used when the persona file declares no name. */
  name: string;
  /** The manifest's bot role, used when the persona file declares no role. */
  role?: string;
}

function scalarText(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

function personalityLines(value: unknown): string[] {
  const single = scalarText(value);
  if (single) return [`- ${single}`];
  if (Array.isArray(value)) return value.flatMap(item => { const text = scalarText(item); return text ? [`- ${text}`] : []; });
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, item]) => {
    const text = scalarText(item);
    return text ? [`- ${key}: ${text}`] : [];
  });
}

/**
 * @description Whether an ordinary `perspective` may ride a protected turn: none of the screened
 * shell, script or secret-carrier words appear in it, compared case-insensitively.
 * @param perspective - The persona's perspective text.
 * @returns True when the perspective passes the screen.
 */
export function perspectivePassesScreen(perspective: string): boolean {
  const screened = screenableText(perspective);
  return !PERSPECTIVE_SCREEN.some(token => screened.includes(token));
}

function selectPerspective(doc: Record<string, unknown>, context: BotPersonaContext): string | undefined {
  const override = typeof doc.protected_perspective === 'string' ? doc.protected_perspective.trim() : '';
  if (override) return override;
  const perspective = typeof doc.perspective === 'string' ? doc.perspective.trim() : '';
  if (!perspective) return undefined;
  if (perspectivePassesScreen(perspective)) return perspective;
  logger.warn({ app: context.app, agentId: context.agentId },
    'Bot perspective names a shell, script or secret carrier; carrying identity and personality only (declare protected_perspective to carry one)');
  return undefined;
}

/**
 * @description Compose one bot's persona text for a protected node turn: the identity line, the
 * scalar personality entries, the selected perspective, and the fixed no-authority sentence. Reads
 * only name, role, personality, protected_perspective and perspective; every authority-bearing field
 * of the persona (capabilities, allowed_tools, authorizations, runtime, selectors, system_prompt) is
 * ignored by construction. The result is not yet validated; see botPersonaRefusal.
 * @param doc - The parsed persona YAML document.
 * @param context - The owning application and bot, for the screen's log line and name/role fallbacks.
 * @returns The composed persona text.
 */
export function composeProtectedBotPersona(doc: Record<string, unknown>, context: BotPersonaContext): string {
  const name = scalarText(doc.name) ?? context.name;
  const role = scalarText(doc.role) ?? scalarText(context.role);
  const sections = [role ? `You are **${name}**, ${role}.` : `You are **${name}**.`];
  const personality = personalityLines(doc.personality);
  if (personality.length > 0) sections.push(['Personality:', ...personality].join('\n'));
  const perspective = selectPerspective(doc, context);
  if (perspective) sections.push(perspective);
  sections.push(BOT_PERSONA_NO_AUTHORITY);
  return sections.join('\n\n');
}

/**
 * @description Why a composed persona may not be carried, or null when it may. The node applies the
 * same byte bound and control-character rule, so a persona registered here is one the node accepts.
 * @param text - The composed persona text.
 * @returns A stable refusal code, or null.
 */
export function botPersonaRefusal(text: string): 'secret_identifier' | 'oversized' | 'invalid_utf8' | 'control_characters' | null {
  const screened = screenableText(text);
  if (SECRET_IDENTIFIERS.some(token => screened.includes(token))) return 'secret_identifier';
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length > MAX_BOT_PERSONA_BYTES) return 'oversized';
  if (bytes.toString('utf8') !== text) return 'invalid_utf8';
  if (DISALLOWED_CONTROLS.test(text)) return 'control_characters';
  return null;
}

/** Strict UTF-8 decode: an invalid byte sequence throws instead of becoming a replacement character. */
function loadPersonaDocument(path: string): Record<string, unknown> {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(path));
  const doc = yaml.load(text);
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('Persona file is not a YAML mapping');
  return doc as Record<string, unknown>;
}

function readBotPersona(app: string, bot: SwarmAppBotDeclaration, manifestPath: string): string | null {
  const context: BotPersonaContext = { app, agentId: bot.agentId, name: bot.name, role: bot.role };
  const where = { app, agentId: bot.agentId };
  let doc: Record<string, unknown>;
  try {
    const path = resolveManifestBotPersonaPath(bot, manifestPath);
    if (!path) return null;
    if (!existsSync(path)) {
      logger.warn(where, 'Bot persona file is missing; no persona is carried for this bot');
      return null;
    }
    doc = loadPersonaDocument(path);
  } catch (err) {
    logger.error({ err, ...where }, 'Bot persona refused: the file is outside its package, unreadable or not a YAML mapping');
    return null;
  }
  const text = composeProtectedBotPersona(doc, context);
  const refusal = botPersonaRefusal(text);
  if (refusal) {
    logger.error({ ...where, refusal, bytes: Buffer.byteLength(text, 'utf8') }, 'Bot persona refused; no persona is carried for this bot');
    return null;
  }
  return text;
}

/**
 * @description Compose every declared bot's persona through the owning manifest. A bot whose
 * persona is absent or refused is left out (its own log line says why); the others are unaffected.
 * @param manifest - The validated application manifest.
 * @param manifestPath - The manifest's file path; persona paths resolve against it.
 * @returns agentId to composed persona text.
 */
export function readAppBotPersonas(manifest: SwarmAppManifest, manifestPath: string): Map<string, string> {
  const personas = new Map<string, string>();
  for (const bot of manifest.bots ?? []) {
    const text = readBotPersona(manifest.name, bot, manifestPath);
    if (text) personas.set(bot.agentId, text);
  }
  return personas;
}

/**
 * @description Register an activated application's bot personas for protected dispatch, replacing
 * any earlier set (an empty set retracts). Non-fatal: activation proceeds without personas, and a
 * failure retracts the application's entry so no stale text outlives the reload that broke it.
 * @param record - The application being activated.
 * @returns Nothing; the shared registry is updated.
 */
export function applyBotPersonas(record: Pick<SwarmApplicationRecord, 'name' | 'manifest' | 'manifestPath'>): void {
  try {
    registerAppBotPersonas(record.name, readAppBotPersonas(record.manifest, record.manifestPath));
  } catch (err) {
    logger.error({ err, app: record.name }, 'Bot persona registration failed; the application carries no persona (non-fatal)');
    unregisterAppBotPersonas(record.name);
  }
}

/**
 * @description Retract an application's bot personas on deactivate or uninstall, the counterpart of
 * applyBotPersonas. A Map delete, so it is idempotent and never throws.
 * @param appName - The application being deactivated.
 * @returns Nothing; the shared registry is updated.
 */
export function retractBotPersonas(appName: string): void {
  unregisterAppBotPersonas(appName);
}
