/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                    | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Phase 1: Haven voice + context injection layer
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Phase 1i: Clean two-mode switch (Anthropic fast / cline CLI default)
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Phase 2: Replaced inline HTTP calls with harness providers
 *                     |                           |   Priority: 1) codex exec  2) claude code CLI  3) cline CLI fallback
 *                     |                           |   No direct Anthropic HTTP calls — all through CLI harnesses
 */

import { createChildLogger } from '@/shared/logger';
import { HomeContextService, type HomeContextSnapshot, HAVEN_DEFAULT_HOUSEHOLD_ID } from './home-context-service';
import type { LLMService } from '@/features/llm-provider';
// eslint-disable-next-line no-restricted-imports -- two-runtimes: LLM execution runtime, deliberately off the barrel graph (barrel split, TODO-BOUNDARY-FINDING)
import { CodexHarnessProvider } from '@/features/llm-provider/services/codex-cli-provider';
// eslint-disable-next-line no-restricted-imports -- two-runtimes: LLM execution runtime, deliberately off the barrel graph (barrel split, TODO-BOUNDARY-FINDING)
import { ClaudeCodeCliProvider } from '@/features/llm-provider/services/claude-code-cli-provider';

const logger = createChildLogger({ module: 'haven-persona-service' });

// ── Haven system prompt ────────────────────────────────────────────────────────
const HAVEN_BASE_SYSTEM_PROMPT = `You are Haven. You're the primary interface for this platform.

You can handle anything: build software, research topics, manage projects, crunch data,
draft documents, plan work, automate tasks, connect integrations, and more. If a task needs
a specialist — a coder, analyst, architect, scheduler — you dispatch it and come back with results.
The user never needs to know how. They just talk to you.

Your job:
- Understand what the user actually wants. Ask one question if you need to clarify scope.
  Don't interrogate. Don't ask for things you can infer.
- For information, ideation, and planning — just do it. Think out loud when useful.
- Notice things. If there's a pattern, a risk, or an opportunity worth raising, say it.
- Keep track of what's in progress. Reference open work naturally.

Voice rules (non-negotiable):
- Short sentences when the answer is simple. Longer only when complexity demands it.
- Never start with "Certainly", "Sure", "Of course", "Great".
- One clarifying question at a time. Never interrogate.
- Celebrate wins briefly. Move on.
- Never mention agents, bots, swarm, phases, tools, tickets, or internal routing.
- Be direct. Be warm. Be useful.

If you don't know something, say so simply. Don't over-apologize.
If you need confirmation before starting something big, ask once. Then act.`;

// ── Types ──────────────────────────────────────────────────────────────────────

/**
 * @description One turn of Haven conversation history, used to replay prior exchanges
 * back into the LLM so the persona retains context across a chat session.
 */
export interface HavenChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * @description Outcome of a Haven chat turn returned to callers: the persona's reply,
 * the household it was scoped to, and optional flags indicating work was dispatched
 * to a downstream specialist/ticket.
 */
export interface HavenChatResult {
  reply: string;
  householdId: string;
  dispatched?: boolean;
  ticketId?: string;
}

interface DispatchableTicketService {
  createTicket(opts: {
    title: string;
    description: string;
    metadata?: Record<string, unknown>;
  }): Promise<{ id: string; externalId?: string }>;
}

// ── Context formatter ──────────────────────────────────────────────────────────

function buildContextBlock(snapshot: HomeContextSnapshot): string {
  const lines: string[] = ['--- HOUSEHOLD CONTEXT ---'];

  if (snapshot.householdName) {
    lines.push(`Household: ${snapshot.householdName}`);
  }
  lines.push(`Timezone: ${snapshot.timezone}`);

  if (snapshot.members.length > 0) {
    lines.push('\nHousehold members:');
    for (const m of snapshot.members) {
      lines.push(`  - ${m.name}${m.role ? ` (${m.role})` : ''}`);
    }
  }

  if (snapshot.devices.length > 0) {
    lines.push('\nConnected devices:');
    for (const d of snapshot.devices) {
      const loc = d.location ? ` — ${d.location}` : '';
      const type = d.deviceType ? ` [${d.deviceType}]` : '';
      lines.push(`  - ${d.name}${type}${loc} via ${d.platform} (${d.status})`);
    }
  } else {
    lines.push('\nConnected devices: none yet');
  }

  if (snapshot.integrations.length > 0) {
    lines.push('\nLinked integrations:');
    for (const i of snapshot.integrations) {
      const label = i.displayName ?? i.service;
      lines.push(`  - ${label} [${i.category}] — ${i.authStatus}`);
    }
  } else {
    lines.push('\nLinked integrations: none yet');
  }

  if (snapshot.preferences.length > 0) {
    lines.push('\nHousehold preferences:');
    for (const p of snapshot.preferences) {
      lines.push(`  - ${p.category}.${p.key} = ${p.value} (${p.source})`);
    }
  }

  if (snapshot.openThreads.length > 0) {
    lines.push('\nOpen threads (unfinished intentions):');
    for (const t of snapshot.openThreads) {
      lines.push(`  - ${t.description}`);
    }
  }

  if (snapshot.recentMemory.length > 0) {
    lines.push('\nRecent memory:');
    for (const m of snapshot.recentMemory.slice(0, 5)) {
      lines.push(`  - [${m.subject}] ${m.content}`);
    }
  }

  lines.push('--- END CONTEXT ---');
  return lines.join('\n');
}

// ── Service ────────────────────────────────────────────────────────────────────

/**
 * @description Haven persona service.
 *
 * LLM call priority order (all through CLI harness providers, no direct HTTP):
 *   1. CodexHarnessProvider (`codex exec`) — ~2-5s, uses Codex OAuth token
 *   2. ClaudeCodeCliProvider (`claude -p`) — ~2-5s, uses ANTHROPIC_API_KEY or Claude OAuth
 *   3. Existing cline CLI subprocess (full agent loop) — ~30-60s fallback
 */
export class HavenPersonaService {
  private readonly homeContextService: HomeContextService;
  private readonly getProvider: () => LLMService;
  private readonly ticketService?: DispatchableTicketService;
  private readonly codexProvider: CodexHarnessProvider;
  private readonly claudeProvider: ClaudeCodeCliProvider;

  /**
   * @description Wires Haven to its household context source and LLM access, and eagerly
   * constructs the fast CLI harness providers (Codex, Claude Code) used ahead of the
   * slower cline fallback.
   * @param homeContextService Source of household snapshots injected into the system prompt.
   * @param getProvider Lazy accessor for the cline CLI fallback LLM service.
   * @param ticketService Optional service for dispatching work into downstream tickets.
   */
  constructor(
    homeContextService: HomeContextService,
    getProvider: () => LLMService,
    ticketService?: DispatchableTicketService,
  ) {
    this.homeContextService = homeContextService;
    this.getProvider = getProvider;
    this.ticketService = ticketService;
    this.codexProvider = new CodexHarnessProvider();
    this.claudeProvider = new ClaudeCodeCliProvider();
  }

  /**
   * @description Produces a Haven reply for a user message: loads household context,
   * builds the system prompt, and attempts the LLM call through the provider priority
   * chain (Codex CLI, then Claude Code CLI, then cline CLI fallback), returning a
   * friendly placeholder if every provider yields empty text.
   * @param householdId Household to scope context to; defaults to the Haven default household.
   * @param userMessage The latest user input to respond to.
   * @param history Prior conversation turns replayed for context.
   * @returns The persona reply and the household it was scoped to.
   */
  async chat(
    householdId: string = HAVEN_DEFAULT_HOUSEHOLD_ID,
    userMessage: string,
    history: HavenChatMessage[] = [],
  ): Promise<HavenChatResult> {
    await this.homeContextService.ensureHousehold(householdId);
    const snapshot = await this.homeContextService.getContextSnapshot(householdId);

    const contextBlock = buildContextBlock(snapshot);
    const systemPrompt = `${HAVEN_BASE_SYSTEM_PROMPT}\n\n${contextBlock}`;

    const messages = [
      ...history.map((h) => ({ role: h.role as 'user' | 'assistant', content: h.content })),
      { role: 'user' as const, content: userMessage },
    ];

    const lastUserMsg = userMessage;

    // ── LLM call — priority order (all CLI harness providers) ───────────────
    //
    // 1. codex exec  (~2-5s) — uses Codex OAuth token via CodexHarnessProvider
    // 2. claude -p   (~2-5s) — uses ANTHROPIC_API_KEY via ClaudeCodeCliProvider
    // 3. cline CLI   (~30-60s) — full agent loop via existing getProvider()
    //
    let text = '';

    try {
      // ── Priority 1: Codex CLI (fast, uses Codex OAuth) ─────────────────────
      const codexResult = await this.codexProvider.complete(
        `User: ${lastUserMsg}\n\nRespond naturally as Haven. Do not use any tools or read any files.`,
        systemPrompt,
      );
      text = codexResult.text;
      logger.info({ householdId, replyLength: text.length, provider: 'codex-cli' }, 'Haven: codex exec reply ready');
    } catch (codexErr) {
      logger.warn({ err: codexErr }, 'Haven: codex exec failed — trying Claude Code CLI');

      try {
        // ── Priority 2: Claude Code CLI (fast, uses ANTHROPIC_API_KEY or OAuth) ─
        const claudeResult = await this.claudeProvider.complete(lastUserMsg, systemPrompt);
        text = claudeResult.text;
        logger.info({ householdId, replyLength: text.length, provider: 'claude-code-cli' }, 'Haven: Claude Code CLI reply ready');
      } catch (claudeErr) {
        logger.warn({ err: claudeErr }, 'Haven: Claude Code CLI failed — falling back to cline CLI (~30-60s)');

        // ── Priority 3: cline CLI subprocess (slow fallback) ────────────────
        const taskId = `haven-chat-${householdId}-${Date.now()}`;
        const response = await this.getProvider().sendRequest({
          messages,
          systemPrompt,
          taskId,
          agentId: 'haven',
          interactionMode: 'chat',
          maxTokens: 1024,
          temperature: 0.7,
        });
        text = response.content
          .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
          .map((b) => b.text)
          .join('')
          .trim();
        logger.info({ householdId, replyLength: text.length, provider: 'cline-cli' }, 'Haven: cline CLI reply ready');
      }
    }

    if (!text) {
      logger.warn({ householdId }, 'Haven: empty response from LLM');
      return { reply: "I'm here — say that again?", householdId };
    }

    return { reply: text, householdId };
  }
}