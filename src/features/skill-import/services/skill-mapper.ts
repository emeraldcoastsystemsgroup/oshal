/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Map a parsed skill → OSHAL persona + swarm-apps manifest. The perspective wraps the imported body in OSHAL governance (Mode B, citations, least-privilege, quarantined-scripts notice).
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | ADR-097: emitted manifests carry suite (opts.suite, default ai-productivity) so imported skills never land unshelved in the catalog.
 */

import type {
  ParsedSkill, ToolTranslation, SkillImportOptions, EmittedPersona, EmittedManifest,
} from '../types';
import { slugify, deriveAgentId, mineKeywords, deriveCapabilities } from './skill-identifiers';

const DEFAULT_HARNESS = 'codex-cli';
const DEFAULT_MODEL = 'gpt-5.3-codex';
/** Least privilege for an UNTRUSTED import — not codex-packer's danger-full-access. */
const DEFAULT_SANDBOX = 'workspace-write';

/**
 * @description Composes the persona `perspective` (system prompt): identity + description +
 * the imported skill body verbatim + an OSHAL governance footer that binds the foreign skill
 * to the quality gate — Mode B on uncertainty, citations, the exact granted tools, an explicit
 * "these foreign tools were NOT granted" line, the quarantined-scripts notice, and DRY_RUN
 * defaults. This footer is where "run a stranger's skill inside a governed swarm" is realised.
 * @param parsed - the parsed skill
 * @param slug - the emitted slug
 * @param translation - granted/unmapped tools
 * @param quarantinedScripts - bundled scripts held back from execution
 * @returns the composed perspective block-scalar text
 */
export function buildPerspective(
  parsed: ParsedSkill,
  slug: string,
  translation: ToolTranslation,
  quarantinedScripts: string[],
): string {
  const description = String(parsed.frontmatter.description ?? '').trim();
  const unmappedLine = translation.unmapped.length
    ? `- The source skill also referenced tools that were NOT granted: ${translation.unmapped.join(', ')}. Do not assume them — ask an operator to wire and approve them first.`
    : '- No foreign/ungranted tools were referenced.';
  const scriptsLine = quarantinedScripts.length
    ? `- The source skill bundled executable scripts (${quarantinedScripts.join(', ')}). They are QUARANTINED and were NOT wired for execution. Do not run them until an operator reviews and approves them.`
    : '- The source skill bundled no executable scripts.';

  return [
    `You are ${slug}, an OSHAL bot imported from the "${parsed.frontmatter.name}" skill.`,
    description,
    '',
    '## Imported skill instructions',
    parsed.body,
    '',
    '## OSHAL governance (added on import — these override the skill above on conflict)',
    '- Silence is not acceptable. If you cannot proceed, respond in Mode B with a concrete "what would let me answer" list.',
    '- Cite every external claim with a `> **Citation:** doc_id, source_url, fetched_on` block.',
    `- Least privilege: your granted tools are [${translation.granted.join(', ')}].`,
    unmappedLine,
    scriptsLine,
    '- Every side effect defaults to DRY_RUN=true; require an explicit operator opt-in before any external write.',
  ].join('\n');
}

/**
 * @description Maps a parsed skill to an OSHAL persona (BotPersona-compatible, snake_case).
 * @param parsed - the parsed skill
 * @param translation - the tool translation
 * @param opts - import options (agent id, harness, model, sandbox, quarantined scripts)
 * @returns the emitted persona
 */
export function mapSkillToPersona(
  parsed: ParsedSkill,
  translation: ToolTranslation,
  opts: SkillImportOptions = {},
): EmittedPersona {
  const name = String(parsed.frontmatter.name ?? '');
  const slug = slugify(name);
  const description = String(parsed.frontmatter.description ?? '').trim();
  const license = typeof parsed.frontmatter.license === 'string' ? parsed.frontmatter.license : undefined;

  return {
    name: slug,
    role: deriveRole(description, slug),
    agent_id: opts.agentId || deriveAgentId(slug),
    perspective: buildPerspective(parsed, slug, translation, opts.bundledScripts ?? []),
    capabilities: deriveCapabilities(slug, description),
    selector_descriptor: buildSelectorDescriptor(description, slug),
    routing_keywords: mineKeywords(`${name} ${description}`, 8),
    allowed_tools: translation.granted,
    runtime: {
      harness: opts.harness || DEFAULT_HARNESS,
      model: opts.model || DEFAULT_MODEL,
      sandbox: opts.sandbox || DEFAULT_SANDBOX,
    },
    source: { type: 'skill-import', skill: name, ...(license ? { license } : {}) },
  };
}

/**
 * @description Maps a parsed skill to an emitted swarm-apps manifest (codex-packer shape):
 * one worker bot pinned to the imported persona, a one-and-done incident-rca workflow, and a
 * ticketType equal to the slug. `status: 'inactive'` on emission so an import never auto-enables
 * — the operator flips it live via Bot Forge / POST /load after reviewing the audit.
 * @param persona - the already-emitted persona (source of ids/routing)
 * @param opts - import options (provenance source, rag collection)
 * @param personaPath - the cwd-relative path the persona YAML will be written to
 * @returns the emitted manifest
 */
export function mapSkillToManifest(
  persona: EmittedPersona,
  opts: SkillImportOptions = {},
  personaPath = `ai-lab/bot-personas/${persona.name}.yaml`,
): EmittedManifest {
  const displayName = titleCase(persona.name);
  return {
    name: persona.name,
    displayName,
    description: persona.selector_descriptor,
    version: '1.0.0',
    status: 'inactive',
    suite: opts.suite ?? 'ai-productivity',
    ticketType: persona.name,
    workflow: { name: `${displayName} Pipeline`, pipeline: 'incident-rca', workerBot: persona.name },
    bots: [{
      agentId: persona.agent_id,
      name: persona.name,
      persona: personaPath,
      role: persona.role,
      capabilities: persona.capabilities,
      selectorDescriptor: persona.selector_descriptor,
      routingKeywords: persona.routing_keywords,
    }],
    source: { type: 'skill-import', ...(opts.source ?? {}) },
    ...(opts.ragCollection ? { rag: { collection: opts.ragCollection } } : {}),
  };
}

/** A one-line role from the description's first sentence, else a generic imported-skill role. */
function deriveRole(description: string, slug: string): string {
  const firstSentence = description.split(/(?<=[.!?])\s/)[0]?.trim();
  if (firstSentence && firstSentence.length <= 80) return firstSentence.replace(/\.$/, '');
  return `Imported skill: ${slug}`;
}

/** A crisp router selector — the description, prefixed with a trigger clause if it lacks one. */
function buildSelectorDescriptor(description: string, slug: string): string {
  if (!description) return `Use this bot for the ${slug} skill.`;
  const lower = description.toLowerCase();
  const hasTrigger = ['use when', 'use this', 'when the user', 'when you'].some(h => lower.includes(h));
  return hasTrigger ? description : `Use this bot when: ${description}`;
}

/** Title-cases a hyphen-case slug for display (pdf-editor → Pdf Editor). */
function titleCase(slug: string): string {
  return slug.split('-').filter(Boolean).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}
