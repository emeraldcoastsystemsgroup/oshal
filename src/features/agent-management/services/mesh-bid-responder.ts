/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — the shared BID_REQUEST responder every swarm participant wires as its SwarmAgentWorker directHandler. Closes the ADR-083 Tier-1 gap: bot-node-server built its worker with NO directHandler, so nodes received call-outs over Redis and dropped them (responded: 0 on every broadcast). The self-score is a TRUE self-assessment: the bot scores the ticket text against its OWN declared routing keywords (persona) and required-capability overlap — no free confidence baseline, so a bot with zero domain signal cannot clear the auction threshold on luck.
 */

import { createChildLogger } from '@/shared/logger';
import type { MeshTransport, MeshEnvelope } from './mesh-communication-service';
import { MESH_CHANNELS } from './mesh-communication-service';

const logger = createChildLogger({ module: 'mesh-bid-responder' });

/**
 * @description What a swarm participant needs to answer a BID_REQUEST: its identity,
 * its declared capabilities, and (optionally) its persona file for routing keywords.
 */
export interface MeshBidResponderOptions {
  meshTransport: MeshTransport;
  agentId: string;
  agentName: string;
  capabilities: string[];
  /** Persona YAML path (BOT_PERSONA_FILE) — routing_keywords are read from it once at
   *  construction. Absent/unreadable persona degrades to capability-only scoring. */
  personaPath?: string;
}

/** Load routing keywords from the persona YAML (best-effort, once). */
function loadRoutingKeywords(personaPath?: string): string[] {
  if (!personaPath) return [];
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('fs');
    if (!fs.existsSync(personaPath)) return [];
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const yaml = require('js-yaml');
    const parsed = yaml.load(fs.readFileSync(personaPath, 'utf-8')) as Record<string, unknown> | null;
    const raw = parsed?.routing_keywords ?? parsed?.routingKeywords;
    if (!Array.isArray(raw)) return [];
    return raw.filter((k): k is string => typeof k === 'string' && k.trim().length > 0).map((k) => k.trim());
  } catch (err) {
    logger.warn({ err, personaPath }, 'Persona routing_keywords unreadable — capability-only bidding');
    return [];
  }
}

/**
 * @description Computes this bot's self-scored confidence for one BID_REQUEST (exported
 * for unit coverage). The score is evidence-based with NO free baseline:
 *  - keyword score: how many of the bot's OWN declared routing keywords (phrases included)
 *    appear in the ticket title+description — 3+ hits is a full claim;
 *  - capability score: overlap with the request's required capabilities, when the caller
 *    supplied them (the build pipeline does; the ADR-083 task call-out sends none);
 *  - name-token match adds only a 0.05 tie-breaker (a ticket merely CONTAINING a bot's
 *    name token must never out-bid the true owner — the misrouting class ADR-083 killed).
 * A bot with zero domain evidence scores ≈0 and cannot clear the 0.5 auction threshold.
 */
export function computeBidConfidence(
  input: { title: string; description: string; requiredCapabilities: string[] },
  self: { agentName: string; capabilities: string[]; routingKeywords: string[] },
): number {
  const text = `${input.title}\n${input.description}`.toLowerCase();

  const kwHits = self.routingKeywords.filter((k) => text.includes(k.toLowerCase())).length;
  const kwScore = kwHits > 0 ? Math.min(1, kwHits / 3) : 0;

  const required = input.requiredCapabilities;
  const capMatched = required.filter((c) => self.capabilities.includes(c)).length;
  const capScore = required.length > 0 ? capMatched / required.length : 0;

  const domainScore = Math.max(kwScore, capScore);

  const nameTokens = self.agentName.toLowerCase().split(/[-_\s]+/);
  const nameHit = nameTokens.some((t) => t.length > 2 && text.includes(t));
  const nameBoost = nameHit ? 0.05 : 0;

  return Math.min(1, domainScore * 0.9 + nameBoost);
}

/**
 * @description Builds the directHandler a SwarmAgentWorker wires so this participant
 * ANSWERS call-outs: on a BID_REQUEST envelope, self-score and publish a BID_RESPONSE
 * back to the requester's direct channel (correlationId preserved for request/reply).
 * Sub-0.05 confidence stays silent — no point flooding the window with zero-claims.
 * @param options - Identity + declarations of this participant.
 * @returns An async (envelope, entryId) handler; non-bid envelopes are ignored.
 */
export function createMeshBidResponder(
  options: MeshBidResponderOptions,
): (envelope: MeshEnvelope, entryId: string) => Promise<void> {
  const routingKeywords = loadRoutingKeywords(options.personaPath);
  logger.info(
    { agentId: options.agentId, agentName: options.agentName, keywordCount: routingKeywords.length, capabilityCount: options.capabilities.length },
    'Mesh bid responder armed',
  );

  return async (envelope: MeshEnvelope, _entryId: string): Promise<void> => {
    const payload = envelope.payload as Record<string, unknown> | undefined;
    if (payload?.signalType !== 'BID_REQUEST') return;

    const confidence = computeBidConfidence(
      {
        title: String(payload.ticketTitle || ''),
        description: String(payload.ticketDescription || ''),
        requiredCapabilities: Array.isArray(payload.capabilities) ? (payload.capabilities as string[]) : [],
      },
      { agentName: options.agentName, capabilities: options.capabilities, routingKeywords },
    );
    if (confidence < 0.05) return;

    try {
      await options.meshTransport.publish({
        correlationId: envelope.correlationId,
        fromAgentId: options.agentId,
        toAgentId: envelope.fromAgentId,
        channel: MESH_CHANNELS.agentDirect(envelope.fromAgentId),
        payload: {
          signalType: 'BID_RESPONSE',
          agentId: options.agentId,
          confidence,
          capabilities: options.capabilities,
          signalId: payload.signalId,
        },
        messageType: 'reply',
      });
      logger.info(
        { signalId: payload.signalId, confidence: Number(confidence.toFixed(2)), agentId: options.agentId },
        'Responded to BID_REQUEST',
      );
    } catch (err) {
      logger.warn({ err, signalId: payload.signalId }, 'Failed to respond to BID_REQUEST');
    }
  };
}
