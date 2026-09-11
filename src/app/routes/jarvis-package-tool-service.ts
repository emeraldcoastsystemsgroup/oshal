/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Bind transient Jarvis package proposals to exact user, input, current policy and one activation.
 */
import { randomUUID } from 'node:crypto';
import type { AuthorizationActor, AuthorizationDecision } from '@/shared/application-authorization';
import { runWithApplicationAuthorizationActor } from '@/shared/application-authorization-context';
import { packageToolTenant } from '@/shared/package-tools';

export interface PackageToolPosture { app: string; name: string; mode: 'auto' | 'ask'; generation: string; assertCurrent(): void }
export interface JarvisPackageToolMetadata {
  name: string; displayName?: string; description?: string; usageInstructions?: string; inputSchema?: Record<string, unknown>;
  enabled: boolean; defaultAuthMode: 'auto' | 'ask' | 'off'; requiresApproval?: boolean;
  routingTags?: string[]; tags?: string[];
}
export interface JarvisPackageToolPorts {
  names(): string[];
  inspect(name: string): PackageToolPosture | null;
  metadata(name: string): Promise<JarvisPackageToolMetadata | null>;
  authorize(actor: AuthorizationActor, input: { app: string; kind: 'tools'; operation: string; tenantId?: string }): Promise<AuthorizationDecision>;
  execute(name: string, input: Record<string, unknown>, userSub: string, sessionId: string): Promise<string>;
  canUseSession(actor: AuthorizationActor, sessionId: string): Promise<boolean>;
  now?: () => number;
}
export interface JarvisPackageToolProposal {
  id: string; app: string; toolName: string; label: string; mode: 'auto' | 'ask'; input: Record<string, unknown>; expiresAt: string;
}
export interface JarvisPackageToolDiscovery {
  app: string; name: string; label: string; mode: 'auto' | 'ask'; description: string; usage: string;
  keywords: string[]; inputSchema: Record<string, unknown>; tenantId?: string;
}
interface StoredProposal {
  public: JarvisPackageToolProposal; actor: { sub: string; issuer: string }; sessionId: string; posture: PackageToolPosture;
  state: 'pending' | 'executing' | 'completed' | 'failed'; expires: number;
}
const fail = (code: string, status = 403) => Object.assign(new Error(code), { status });
const line = (value: unknown, max: number) => typeof value === 'string' ? value.replace(/[\x00-\x1f]/g, ' ').slice(0, max) : '';
function keywords(metadata: JarvisPackageToolMetadata): string[] {
  const values = [...(Array.isArray(metadata.routingTags) ? metadata.routingTags : []).slice(0, 64),
    ...(Array.isArray(metadata.tags) ? metadata.tags : []).slice(0, 64)];
  return [...new Set(values.map(value => line(value, 80).trim()).filter(Boolean))].slice(0, 16);
}
function exactActor(actor: AuthorizationActor): void {
  if (!actor?.isActive || !actor.sub || !actor.issuer) throw fail('package_tool_identity_required', 401);
}
function boundedInput(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail('package_tool_input_invalid', 400);
  const json = JSON.stringify(input);
  if (Buffer.byteLength(json) > 16 * 1024) throw fail('package_tool_input_too_large', 400);
  const copy = JSON.parse(json); packageToolTenant(copy); return copy;
}

/** @description Hold short-lived controller-owned proposals without persisting private business results.
 * @param ports Installed registry, current policy and canonical session ownership. @returns An empty bounded proposal service.
 */
export class JarvisPackageToolService {
  private readonly proposals = new Map<string, StoredProposal>();
  private readonly now: () => number;
  constructor(private readonly ports: JarvisPackageToolPorts) { this.now = ports.now ?? Date.now; }
  private prune(): void {
    for (const [id, row] of this.proposals) if (row.expires <= this.now()) this.proposals.delete(id);
  }
  private async current(actor: AuthorizationActor, name: string, input: Record<string, unknown>) {
    exactActor(actor); const posture = this.ports.inspect(name); if (!posture) throw fail('package_tool_unavailable');
    const metadata = await this.ports.metadata(name);
    if (!metadata?.enabled || metadata.name !== name || !['auto', 'ask'].includes(metadata.defaultAuthMode)) throw fail('package_tool_unavailable');
    const tenantId = packageToolTenant(input);
    if (!(await this.ports.authorize(actor, { app: posture.app, kind: 'tools', operation: name, ...(tenantId ? { tenantId } : {}) })).allowed) throw fail('package_tool_permission_denied');
    posture.assertCurrent();
    const mode = posture.mode === 'ask' || metadata.defaultAuthMode === 'ask' || metadata.requiresApproval ? 'ask' as const : 'auto' as const;
    return { posture, metadata, mode };
  }
  private get(actor: AuthorizationActor, id: string): StoredProposal {
    exactActor(actor); this.prune(); const row = this.proposals.get(id);
    if (!row) throw fail('package_tool_proposal_expired', 410);
    if (row.actor.sub !== actor.sub || row.actor.issuer !== actor.issuer) throw fail('package_tool_proposal_unavailable');
    return row;
  }
  private async verify(actor: AuthorizationActor, row: StoredProposal): Promise<void> {
    if (!await this.ports.canUseSession(actor, row.sessionId)) throw fail('package_tool_session_unavailable');
    const current = await this.current(actor, row.public.toolName, row.public.input);
    if (current.mode !== row.public.mode || current.posture.app !== row.public.app || current.posture.generation !== row.posture.generation) throw fail('package_tool_proposal_changed');
    row.posture.assertCurrent();
    if (row.expires <= this.now() || this.proposals.get(row.public.id) !== row) throw fail('package_tool_proposal_expired', 410);
  }
  /** @description List only installed tools and exact workspace selections that current application policy admits.
   * @param actor Verified caller. @returns Bounded routing metadata with no business records.
   */
  async discover(actor: AuthorizationActor): Promise<JarvisPackageToolDiscovery[]> {
    exactActor(actor); const output: JarvisPackageToolDiscovery[] = []; let bytes = 0;
    for (const name of this.ports.names().slice(0, 128)) for (const tenantId of [undefined, ...(actor.tenantIds ?? []).slice(0, 16)]) {
      if (output.length >= 32) return output;
      try {
        const current = await this.current(actor, name, tenantId ? { tenantId } : {});
        const schema = current.metadata.inputSchema ?? { type: 'object', properties: {} };
        if (Buffer.byteLength(JSON.stringify(schema)) > 16 * 1024) continue;
        const entry = { app: current.posture.app, name, label: line(current.metadata.displayName || name, 120), mode: current.mode,
          description: line(current.metadata.description, 500), usage: line(current.metadata.usageInstructions, 1500), keywords: keywords(current.metadata),
          inputSchema: structuredClone(schema), ...(tenantId ? { tenantId } : {}) };
        const size = Buffer.byteLength(JSON.stringify(entry)); if (bytes + size > 48 * 1024) continue;
        output.push(entry); bytes += size;
      } catch { /* Unavailable metadata, policy or source is absent from discovery. */ }
    }
    return output;
  }
  /** @description Capture exact visible input and caller before offering an action to the signed-in page.
   * @param actor Verified user. @param input Fixed tool selector and domain input. @param sessionId Canonical owned conversation.
   * @returns An opaque proposal; model-supplied confirmation grants no authority.
   */
  async propose(actor: AuthorizationActor, input: { toolName: string; input: unknown }, sessionId: string): Promise<JarvisPackageToolProposal> {
    exactActor(actor); this.prune(); const payload = boundedInput(input.input);
    if (!await this.ports.canUseSession(actor, sessionId)) throw fail('package_tool_session_unavailable');
    const current = await this.current(actor, input.toolName, payload);
    const own = [...this.proposals.values()].filter(row => row.actor.sub === actor.sub && row.actor.issuer === actor.issuer);
    if (own.length >= 16 || this.proposals.size >= 256) throw fail('package_tool_proposal_limit', 429);
    const expires = this.now() + 120_000;
    const proposal = { id: randomUUID(), app: current.posture.app, toolName: input.toolName, label: line(current.metadata.displayName || input.toolName, 120),
      mode: current.mode, input: payload, expiresAt: new Date(expires).toISOString() };
    current.posture.assertCurrent();
    this.proposals.set(proposal.id, { public: proposal, actor: { sub: actor.sub, issuer: actor.issuer }, sessionId, posture: current.posture, expires, state: 'pending' });
    return structuredClone(proposal);
  }
  /** @description Consume exactly one proposal from the authenticated same-origin interaction.
   * @param actor Current user. @param id Opaque server proposal. @returns Transient result after current authority revalidation.
   */
  async execute(actor: AuthorizationActor, id: string): Promise<{ result: unknown; expiresAt: string }> {
    const row = this.get(actor, id);
    if (row.state !== 'pending') throw fail('package_tool_proposal_consumed', 409);
    row.state = 'executing';
    try {
      await this.verify(actor, row);
      const output = await runWithApplicationAuthorizationActor(actor, () => this.ports.execute(row.public.toolName, structuredClone(row.public.input), actor.sub, row.sessionId));
      await this.verify(actor, row);
      if (Buffer.byteLength(output) > 256 * 1024) throw fail('package_tool_result_too_large');
      const result = JSON.parse(output); row.state = 'completed'; row.expires = Math.min(row.expires, this.now() + 30_000);
      return { result, expiresAt: new Date(row.expires).toISOString() };
    } catch (error) { row.state = 'failed'; throw error; }
  }
  /** @description Refuse replay of private business output; domain ownership may change independently of the named tool grant.
   * @param actor Current verified user. @param id Consumed proposal identifier. @returns A refusal; completed bytes are never retained.
   */
  async result(actor: AuthorizationActor, id: string): Promise<never> {
    const row = this.get(actor, id);
    if (row.state !== 'completed') throw fail('package_tool_result_unavailable', 409);
    throw fail('package_tool_result_expired', 410);
  }
  /** @description Revalidate a pending panel before exposing its exact input through asynchronous ask polling.
   * @param actor Current user. @param id Server-created proposal. @returns Pending proposal, or undefined after consumption/expiry/refusal.
   */
  async readProposal(actor: AuthorizationActor, id: string): Promise<JarvisPackageToolProposal | undefined> {
    try { const row = this.get(actor, id); if (row.state !== 'pending') return undefined; await this.verify(actor, row); return structuredClone(row.public); }
    catch { return undefined; }
  }
}
