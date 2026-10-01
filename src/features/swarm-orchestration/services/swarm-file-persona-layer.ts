/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted from llm-execution-handler.ts, which had crossed 800 code lines: the filesystem persona layer (persona context file written to the workspace, or the persona embedded when the write fails) and its BOT_PERSONA_FILE lookup. Pure move; the lines still log under the llm-execution-handler module.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | options.inline embeds the persona instead of writing a context file and ordering a read_file call, for the in-process hosted planning round, whose brain has no file tools. The embed branch and the policy metadata became helpers shared by both paths; the default path is unchanged.
 */

import { createChildLogger } from '@/shared/logger';
import type { PersonaLayer } from '@/features/agent-management';
import { loadPersonaFromFile } from './persona-file-loader';
import { writePersonaContextFile } from '@/app/composition/tool-runtime-context';

// The module name these lines have always logged under, so a log search keeps finding them.
const logger = createChildLogger({ module: 'llm-execution-handler' });

/** @description How the persona reaches the agent. */
export interface FilePersonaLayerOptions {
  /**
   * Embed the persona in the prompt instead of writing a context file the agent is told to open with
   * `read_file`. For a brain with no file tools, such as the in-process hosted planning round, that
   * instruction cannot be obeyed. Default false.
   */
  inline?: boolean;
}

type LoadedPersona = NonNullable<ReturnType<typeof loadPersonaFromFile>>;

/**
 * @description Loads the bot's persona YAML from the filesystem, writes the context file,
 * and builds a high-priority persona layer that instructs the agent to read the file.
 * This follows the legacy pattern: small system prompt + file-based identity loading.
 * With `options.inline`, no file is written and the persona is embedded in the layer instead.
 * @param agentId - Agent ID for logging and file writing
 * @param agentName - Agent name used to resolve the YAML file
 * @param taskId - Task ID for workspace-scoped context file writing
 * @param personaDir - Optional directory override for persona files
 * @param options - How the persona reaches the agent (inline embedding for tool-less brains)
 * @returns Persona layer instructing agent to read context file, or null if not found
 */
export function buildFilePersonaLayer(
  agentId: string,
  agentName: string,
  taskId: string,
  personaDir?: string,
  options: FilePersonaLayerOptions = {},
): PersonaLayer | null {
  try {
    const personaLookupTarget = resolveFilesystemPersonaLookupTarget(agentName);
    const persona = loadPersonaFromFile(personaLookupTarget, personaDir);
    if (!persona || !persona.perspective) return null;
    if (options.inline) return embeddedPersonaLayer(persona);

    // Write persona context file to workspace (legacy pattern)
    const contextFileName = `${persona.name || agentId}-context.md`;
    const fileWritten = writePersonaContextFile(agentId, persona, contextFileName, taskId);

    if (fileWritten) {
      // Minimal system prompt — agent reads full identity from file
      logger.info({ agentId, personaName: persona.name, contextFileName, taskId }, 'Wrote persona context file for swarm execution');
      return {
        layerType: 'platform',
        priority: 5, // Highest priority — bot identity comes first
        promptFragment: [
          `# YOUR IDENTITY`,
          `You are **${persona.name || agentId}** — ${persona.role || 'AI assistant'}.`,
          '',
          `IMPORTANT: Before responding to ANY message, you MUST first read the file \`${contextFileName}\` using the read_file tool.`,
          `This file contains your complete identity, role description, perspective, and behavioral guidelines.`,
          `Read it first, internalize it, then respond to the user's message in character.`,
        ].join('\n'),
        metadata: personaPolicyMetadata(persona),
      };
    }

    // Fallback: embed full persona in prompt when file write fails
    logger.warn({ agentId, personaName: persona.name }, 'Failed to write persona context file — embedding full persona in system prompt');
    return embeddedPersonaLayer(persona);
  } catch (err) {
    logger.debug({ err, agentName }, 'No filesystem persona found — using DB persona only');
    return null;
  }
}

/**
 * @description The persona embedded in the prompt: identity, perspective and operating procedure.
 * @param persona - The loaded persona.
 * @returns The platform layer carrying the whole persona.
 */
function embeddedPersonaLayer(persona: LoadedPersona): PersonaLayer {
  const promptSections = [`## Bot Identity: ${persona.role}`, '', persona.perspective];
  if (persona.systemPrompt && persona.systemPrompt.trim().length > 0) {
    promptSections.push('', '## Required Operating Procedure', '', persona.systemPrompt.trim());
  }
  return {
    layerType: 'platform',
    priority: 5,
    promptFragment: promptSections.join('\n'),
    metadata: personaPolicyMetadata(persona),
  };
}

/**
 * @description The server-authored policy metadata every persona layer carries.
 * @param persona - The loaded persona.
 * @returns The layer metadata (allowed tools and authorized scopes).
 */
function personaPolicyMetadata(persona: LoadedPersona): PersonaLayer['metadata'] {
  return {
    serverAuthored: true,
    contentSource: 'persona-policy',
    allowedTools: persona.allowedTools,
    authorizedScopes: [persona.scope, ...Object.keys(persona.authorizations)],
  };
}

/**
 * @description Resolves the preferred filesystem persona lookup target for the current runtime.
 * Uses BOT_PERSONA_FILE when present so containers can bind an exact persona file, otherwise
 * falls back to the agent name for legacy name-based lookup.
 * @param agentName - Agent name used for the legacy filename lookup.
 * @returns Absolute persona file path or agent name lookup key.
 */
function resolveFilesystemPersonaLookupTarget(agentName: string): string {
  const configuredPersonaFile = typeof process.env.BOT_PERSONA_FILE === 'string'
    ? process.env.BOT_PERSONA_FILE.trim()
    : '';
  return configuredPersonaFile.length > 0 ? configuredPersonaFile : agentName;
}
