/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Interpret closed package proposals as untrusted model output and replace premature success claims.
 */
import { z } from 'zod';
import type { AuthorizationActor } from '@/shared/application-authorization';
import { packageToolTenant } from '@/shared/package-tools';
import type { JarvisPackageToolDiscovery, JarvisPackageToolProposal, JarvisPackageToolService } from './jarvis-package-tool-service';
const inputSchema = z.object({ toolName: z.string().min(2).max(64), input: z.record(z.string(), z.unknown()) }).strict();

/** @description Resolve at most one exact tool proposal that was offered to this authenticated turn.
 * @param answer Raw model output. @param service Composition-owned proposal service. @param actor Verified turn actor.
 * @param sessionId Owned conversation. @param offered Current turn discovery. @returns Fixed conversational text and an optional server-created proposal.
 */
export async function resolveJarvisPackageToolDirective(answer: string, service: JarvisPackageToolService | undefined,
  actor: AuthorizationActor | undefined, sessionId: string, offered: JarvisPackageToolDiscovery[]): Promise<{
    handled: boolean; answer: string; proposal?: JarvisPackageToolProposal;
  }> {
  if (!/```\s*oshal:package-tool\b/i.test(answer)) return { handled: false, answer };
  const denied = { handled: true, answer: 'That application action is unavailable. Open the application or ask again with your current access.' };
  if (!service || !actor || answer.length > 48 * 1024) return denied;
  if (/```\s*oshal:(?!package-tool\b)[a-z-]+/i.test(answer)) return denied;
  const matches = [...answer.matchAll(/```oshal:package-tool\s*\n([\s\S]*?)\n```/g)];
  if (matches.length !== 1 || (answer.match(/oshal:package-tool/g) ?? []).length !== 1) return denied;
  try {
    const input = inputSchema.parse(JSON.parse(matches[0][1])); const tenantId = packageToolTenant(input.input);
    if (!offered.some(tool => tool.name === input.toolName && tool.tenantId === tenantId)) return denied;
    const proposal = await service.propose(actor, input, sessionId);
    return { handled: true, proposal, answer: proposal.mode === 'ask' ? 'Review the application action below before approving it.' : 'The application will load your current results below.' };
  } catch { return denied; }
}
