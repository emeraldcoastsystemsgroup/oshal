/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Agent-card builder for the inbound A2A gateway. Skills are CURATED: only bots the app layer's accessibility predicate admits (ADR-087 isBotAccessibleTo(id,'jarvis') — the same scoping that hides internal machinery from the assistant) AND that clear a defense-in-depth denylist (trading/dev/queue/factory/judge/packer/operator machinery) are published. No internal identifiers leak: skill ids are name slugs, never agentIds/containers/ports; the only URL on the card is the public JSON-RPC endpoint itself.
 */

import {
  A2A_PROTOCOL_VERSION,
  type A2AAgentSkill,
  type A2ASpecAgentCard,
} from '../types';

/**
 * @description The minimal bot shape the card builder needs. The app layer passes
 * registry definitions down (FSD: a feature must not import app/extensions), so this is
 * a structural subset of SwarmBotDefinition.
 */
export interface A2ACardBotInput {
  agentId?: string;
  name: string;
  role: string;
  capabilities: string[];
}

/**
 * @description Defense-in-depth denylist over role+name. ADR-087 scoping is the primary
 * gate (the predicate), but bots that are jarvis-visible yet still inappropriate for
 * EXTERNAL agents — trading, platform-dev, packing/judging machinery, operator tooling —
 * must never appear on a public card even if their accessRoles drift.
 */
const EXTERNAL_SKILL_DENYLIST = /(trading|developer|dev-console|packer|judge|queue|factory|manager|operator|apply|ambient|identity|vault)/i;

/**
 * @description Curates the published skills list from bot definitions. A bot appears
 * only when (1) the accessibility predicate admits it (ADR-087 jarvis visibility —
 * internal machinery is scoped out there), (2) it clears the external denylist, and
 * (3) its name is unique (first definition wins, matching registry resolution order).
 * Skill ids are derived from the NAME (slug), never the agentId — internal UUIDs stay
 * internal.
 * @param bots - Bot definitions (registry rows passed down by the app layer).
 * @param isAccessible - Accessibility predicate, e.g. (id) => isBotAccessibleTo(id, 'jarvis').
 * @returns The curated, de-duplicated skills list.
 */
export function curateAgentSkills(
  bots: ReadonlyArray<A2ACardBotInput>,
  isAccessible: (agentId?: string) => boolean,
): A2AAgentSkill[] {
  const seen = new Set<string>();
  const skills: A2AAgentSkill[] = [];
  for (const bot of bots) {
    if (!isAccessible(bot.agentId)) continue;
    if (EXTERNAL_SKILL_DENYLIST.test(`${bot.name} ${bot.role}`)) continue;
    const id = bot.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    if (!id || seen.has(id)) continue;
    seen.add(id);
    skills.push({
      id,
      name: bot.name,
      description: `${bot.role} capability of the OSHAL swarm`,
      tags: [...(bot.capabilities ?? [])].slice(0, 12),
    });
  }
  return skills;
}

/** @description Inputs for building the published agent card. */
export interface BuildAgentCardInput {
  /** Public base URL (scheme+host) the JSON-RPC endpoint is reachable at. */
  baseUrl: string;
  /** Swarm software version string to advertise. */
  version: string;
  /** Bot definitions to curate skills from. */
  bots: ReadonlyArray<A2ACardBotInput>;
  /** ADR-087 accessibility predicate for the 'jarvis' caller role. */
  isAccessible: (agentId?: string) => boolean;
}

/**
 * @description Builds the spec AgentCard the gateway publishes at
 * /.well-known/agent-card.json. Transport is JSONRPC only (no streaming/push — we answer
 * task polls), auth is operator-issued bearer credentials, and skills are curated via
 * curateAgentSkills. The card's only endpoint is the public /api/a2a URL — no internal
 * hostnames, container names, ports, or agent UUIDs.
 * @param input - Base URL, version, bots, and the accessibility predicate.
 * @returns The agent card object, ready to serialize.
 */
export function buildAgentCard(input: BuildAgentCardInput): A2ASpecAgentCard {
  const base = input.baseUrl.replace(/\/+$/, '');
  return {
    protocolVersion: A2A_PROTOCOL_VERSION,
    name: 'OSHAL Swarm',
    description:
      'OSHAL multi-agent orchestration swarm. Delegate tasks via A2A message/send; '
      + 'work is routed to the best-fit specialist and results are returned as task artifacts.',
    url: `${base}/api/a2a`,
    preferredTransport: 'JSONRPC',
    version: input.version,
    capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: false },
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    securitySchemes: {
      bearer: {
        type: 'http',
        scheme: 'bearer',
        description: 'Per-agent bearer token issued by the OSHAL operator.',
      },
    },
    security: [{ bearer: [] }],
    skills: curateAgentSkills(input.bots, input.isAccessible),
  };
}
