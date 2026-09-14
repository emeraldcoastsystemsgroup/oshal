/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Persist owned briefing sources, exact-principal preferences and atomic browser announcement claims.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Bound current-rights reads and serialize pool admission to prevent briefing lock waiters starving authority refreshes.
 */
import type { Pool, PoolClient } from 'pg';
import type { AuthorizationActor } from '@/shared/application-authorization';
import { BRIEFING_INTERVALS, DEFAULT_BRIEFING_PREFERENCE, BriefingPreferenceSchema,
  type BriefingDeclaration, type BriefingPreference, type RegisteredBriefingSource } from '@/shared/briefings';
import { runWithSystemIdentity } from '@/shared/services/database/request-identity';
import { readBriefingAuthority, runBriefingControlTransaction, runBriefingTransaction } from './jarvis-briefing-transaction';

/** @description Trusted read-only composition ports for current recipient identity and application business-data access. */
export interface BriefingPorts {
  resolveRecipient(sub: string): Promise<AuthorizationActor | null>;
  canAccess(actor: AuthorizationActor, app: string, botAgentId?: string): Promise<boolean>;
}
/** @description Durable task fields required to enforce source and issuer visibility. */
export interface BriefingTaskRow {
  id: string; user_sub?: string; session_id?: string; principal_issuer?: string | null; briefing_source_id?: string | null;
  delivered?: boolean; status?: string;
}
interface SourceRow { source_id: string; app: string; session_id: string; definition: RegisteredBriefingSource; active: boolean }
function refuse(message = 'briefing_source_unavailable'): never { throw Object.assign(new Error(message), { status: 403 }); }
function validActor(actor: AuthorizationActor): void { if (!actor.isActive || !actor.sub || !actor.issuer) refuse('briefing_identity_required'); }

/**
 * @description Keep control tables private and bind every preference or delivery to a freshly verified exact principal.
 * @returns A service for owned source registration and exact-principal delivery controls.
 */
export class JarvisBriefingService {
  private readonly active = new Map<string, RegisteredBriefingSource>();
  private readonly generations = new Map<string, symbol>();
  /**
   * @description Bind durable controls to the shared runtime pool and trusted read-only authority ports.
   * @param pool - Runtime database pool, normally configured with at least two connections.
   * @param ports - Current recipient and permission reads; unavailable reads fail closed within two seconds.
   * @param ready - Bootstrap completion required before database access.
   */
  constructor(private readonly pool: Pool, private readonly ports: BriefingPorts, private readonly ready: Promise<unknown> = Promise.resolve()) {}

  private async transaction<T>(operation: (client: PoolClient) => Promise<T>, needsAuthority = false): Promise<T> {
    await this.ready;
    return needsAuthority ? runBriefingTransaction(this.pool, operation) : runBriefingControlTransaction(this.pool, operation);
  }
  private async lock(client: PoolClient, actor: AuthorizationActor, sourceId: string) {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [JSON.stringify([actor.issuer, actor.sub, sourceId])]);
  }
  private async preference(client: PoolClient, actor: AuthorizationActor, source: RegisteredBriefingSource): Promise<BriefingPreference> {
    const result = await client.query('SELECT preference FROM jarvis_briefing_preferences WHERE principal_issuer=$1 AND user_sub=$2 AND source_id=$3',
      [actor.issuer, actor.sub, source.sourceId]);
    return BriefingPreferenceSchema.parse(result.rows[0]?.preference ?? source.defaults ?? DEFAULT_BRIEFING_PREFERENCE);
  }
  private async accessible(actor: AuthorizationActor, source: RegisteredBriefingSource): Promise<boolean> {
    if (!actor.isActive || this.active.get(source.sourceId) !== source) return false;
    const allowed = await readBriefingAuthority(() => this.ports.canAccess(actor, source.app, source.botAgentId));
    return allowed && this.active.get(source.sourceId) === source;
  }

  /**
   * @description Reserve registered and retired producer sessions against ordinary chat impersonation.
   * @param sessionId - Candidate task session.
   * @returns Whether durable source ownership reserves this session.
   */
  async isProducerSession(sessionId: string): Promise<boolean> {
    return this.transaction(async client => Boolean((await client.query('SELECT 1 FROM jarvis_briefing_sources WHERE session_id=$1', [sessionId])).rowCount));
  }

  /**
   * @description Apply the visible limit after authorization so hidden updates never displace ordinary work.
   * @param sub - Authenticated task owner.
   * @param actor - Exact current principal, or null to suppress all briefing sources.
   * @param limit - Maximum visible task rows.
   * @returns Current authorized briefing rows and ordinary tasks, newest first.
   */
  async listTasks(sub: string, actor: AuthorizationActor | null, limit: number) {
    await this.ready;
    const visible = [];
    let cursor: { cursor_time: string; id: string } | undefined;
    while (visible.length < limit) {
      const rows = (await runWithSystemIdentity(() => this.pool.query(`SELECT *,created_at::text AS cursor_time FROM jarvis_tasks WHERE user_sub=$1
        ${cursor ? 'AND (created_at,id)<($2,$3)' : ''} ORDER BY created_at DESC,id DESC LIMIT 100`,
      cursor ? [sub, cursor.cursor_time, cursor.id] : [sub]))).rows;
      if (!rows.length) break;
      visible.push(...(actor ? await this.visibleTasks(actor, rows) : await this.ordinaryTasks(rows)));
      if (rows.length < 100) break;
      cursor = rows[rows.length - 1];
    }
    return (actor ? await this.visibleTasks(actor, visible) : await this.ordinaryTasks(visible)).slice(0, limit);
  }

  /**
   * @description Persist immutable source/session ownership and activate the supplied source generation.
   * @param app - Owning installed application.
   * @param version - Current installed package version.
   * @param declarations - Validated sources owned by this application.
   * @returns Completion after durable registration and local publication.
   */
  async register(app: string, version: string, declarations: readonly BriefingDeclaration[]): Promise<void> {
    const sources = declarations.map(source => ({ ...source, sourceId: `${app}:${source.id}`, app, version }));
    const generation = Symbol(app); this.generations.set(app, generation);
    await this.transaction(async client => {
      await client.query('UPDATE jarvis_briefing_sources SET active=FALSE WHERE app=$1', [app]);
      for (const source of sources) {
        const result = await client.query(`INSERT INTO jarvis_briefing_sources(source_id,app,session_id,definition,active) VALUES($1,$2,$3,$4,TRUE)
          ON CONFLICT(source_id) DO UPDATE SET definition=EXCLUDED.definition,active=TRUE
          WHERE jarvis_briefing_sources.app=EXCLUDED.app AND jarvis_briefing_sources.session_id=EXCLUDED.session_id RETURNING source_id`,
        [source.sourceId, app, source.sessionId, source]);
        if (!result.rowCount) throw new Error('Briefing source ownership cannot be replaced');
      }
    });
    if (this.generations.get(app) !== generation) return;
    for (const [id, source] of this.active) if (source.app === app) this.active.delete(id);
    for (const source of sources) this.active.set(source.sourceId, source);
  }
  /**
   * @description Retract local availability immediately and persist source retirement without releasing ownership.
   * @param app - Application being disabled or removed.
   * @returns Completion after durable retirement.
   */
  async unregister(app: string): Promise<void> {
    this.generations.set(app, Symbol(app));
    for (const [id, source] of this.active) if (source.app === app) this.active.delete(id);
    await this.transaction(client => client.query('UPDATE jarvis_briefing_sources SET active=FALSE WHERE app=$1', [app]));
  }
  /**
   * @description Keep legacy producer-session rows out of prompts when no exact actor is available.
   * @param rows - Candidate task rows.
   * @returns Only ordinary tasks outside every reserved source session.
   */
  async ordinaryTasks<T extends BriefingTaskRow>(rows: readonly T[]): Promise<T[]> {
    return this.transaction(async client => {
      const sessions = new Set((await client.query<{ session_id: string }>('SELECT session_id FROM jarvis_briefing_sources')).rows.map(row => row.session_id));
      return rows.filter(row => !row.briefing_source_id && (!row.session_id || !sessions.has(row.session_id)));
    });
  }
  /**
   * @description Discover active sources under current rights with exact-principal saved preferences.
   * @param actor - Verified caller, never a body-supplied identity.
   * @returns Available sources, effective preferences and browser delivery limits.
   */
  async catalog(actor: AuthorizationActor) {
    validActor(actor);
    const sources = [];
    for (const source of this.active.values()) {
      if (!await this.accessible(actor, source)) continue;
      const preference = await this.transaction(client => this.preference(client, actor, source));
      if (!await this.accessible(actor, source)) continue;
      sources.push({ ...source, preference, channels: ['voice', 'bubble', 'screen'],
        delivery: 'Jarvis must be open. Voice also requires browser audio permission.' });
    }
    return { sources };
  }
  /**
   * @description Replace one source preference after current authorization and the shared delivery lock.
   * @param actor - Verified owner of the preference.
   * @param sourceId - Framework-owned source identifier.
   * @param input - Strict preference payload without caller identity fields.
   * @returns The committed exact-principal preference.
   */
  async savePreference(actor: AuthorizationActor, sourceId: string, input: unknown): Promise<BriefingPreference> {
    validActor(actor); const preference = BriefingPreferenceSchema.parse(input);
    const source = this.active.get(sourceId); if (!source || !await this.accessible(actor, source)) refuse();
    return this.transaction(async client => {
      await this.lock(client, actor, sourceId);
      if (!await this.accessible(actor, source)) refuse();
      await client.query(`INSERT INTO jarvis_briefing_preferences(principal_issuer,user_sub,source_id,preference) VALUES($1,$2,$3,$4)
        ON CONFLICT(principal_issuer,user_sub,source_id) DO UPDATE SET preference=EXCLUDED.preference,updated_at=NOW()`,
      [actor.issuer, actor.sub, sourceId, preference]);
      return preference;
    }, true);
  }

  /**
   * @description Publish an eligible source task without falling through to ordinary delivery on source failure.
   * @param sub - Legacy producer recipient subject requiring unique current issuer resolution.
   * @param sessionId - Producer's permanently owned session.
   * @param write - Task insertion bound to this transaction and resolved exact principal.
   * @returns Undefined for ordinary tasks, false for suppressed sources, or the committed insertion result.
   */
  async publish(sub: string, sessionId: string, write: (client: PoolClient, issuer: string, sourceId: string) => Promise<boolean>): Promise<boolean | undefined> {
    await this.ready;
    const found = await runWithSystemIdentity(() => this.pool.query<SourceRow>('SELECT * FROM jarvis_briefing_sources WHERE session_id=$1', [sessionId]));
    if (!found.rows[0]) return undefined;
    const initialSource = this.active.get(found.rows[0].source_id);
    if (!initialSource || initialSource.app !== found.rows[0].app || initialSource.sessionId !== sessionId) return false;
    const actor = await readBriefingAuthority(() => this.ports.resolveRecipient(sub));
    if (!actor || actor.sub !== sub || !actor.issuer || !await this.accessible(actor, initialSource)) return false;
    return this.transaction(async client => {
      const row = (await client.query<SourceRow>('SELECT * FROM jarvis_briefing_sources WHERE session_id=$1 FOR SHARE', [sessionId])).rows[0];
      if (!row) return undefined;
      const source = this.active.get(row.source_id);
      if (!row.active || !source || source !== initialSource || source.app !== row.app || source.sessionId !== row.session_id) return false;
      await this.lock(client, actor, source.sourceId);
      const current = await readBriefingAuthority(() => this.ports.resolveRecipient(sub));
      if (!current || current.sub !== actor.sub || current.issuer !== actor.issuer || !await this.accessible(current, source)) return false;
      if (!(await this.preference(client, actor, source)).enabled) return false;
      if (!await this.accessible(current, source)) return false;
      const written = await write(client, actor.issuer, source.sourceId);
      if (!await this.accessible(current, source)) throw new Error('Briefing source authority changed during publication');
      return written;
    }, true);
  }

  /**
   * @description Quarantine unqualified or retired source tasks and recheck visibility for the current exact principal.
   * @param actor - Verified task viewer.
   * @param rows - Candidate source and ordinary task rows.
   * @returns Authorized rows with delivery metadata on visible briefing tasks.
   */
  async visibleTasks<T extends BriefingTaskRow>(actor: AuthorizationActor, rows: readonly T[]): Promise<Array<T & { briefing?: { sourceId: string; channel: BriefingPreference['channel'] } }>> {
    validActor(actor);
    const allowed = new Set<string>();
    for (const id of new Set(rows.map(row => row.briefing_source_id))) {
      const source = id ? this.active.get(id) : undefined;
      if (source && await this.accessible(actor, source)) allowed.add(source.sourceId);
    }
    return this.transaction(async client => {
      const known = (await client.query<SourceRow>('SELECT * FROM jarvis_briefing_sources')).rows;
      const sessions = new Set(known.map(row => row.session_id));
      const visible: Array<T & { briefing?: { sourceId: string; channel: BriefingPreference['channel'] } }> = [];
      const generations = new Map<string, RegisteredBriefingSource>();
      for (const row of rows) {
        if (!row.briefing_source_id) { if (!row.session_id || !sessions.has(row.session_id)) visible.push(row); continue; }
        if (row.principal_issuer !== actor.issuer || (row.user_sub && row.user_sub !== actor.sub)) continue;
        const source = this.active.get(row.briefing_source_id);
        if (!source || !allowed.has(source.sourceId) || !await this.accessible(actor, source)) continue;
        const preference = await this.preference(client, actor, source);
        if (preference.enabled && await this.accessible(actor, source)) {
          generations.set(source.sourceId, source);
          visible.push({ ...row, briefing: { sourceId: source.sourceId, channel: preference.channel } });
        }
      }
      return visible.filter(row => !row.briefing || this.active.get(row.briefing.sourceId) === generations.get(row.briefing.sourceId));
    }, true);
  }

  /**
   * @description Commit one winning browser claim per source interval together with task delivery markers.
   * @param actor - Verified recipient authorized again after lock waits.
   * @param taskIds - Candidate completed task identifiers.
   * @param now - Server-controlled announcement time.
   * @returns Only newly claimed tasks and their current delivery channels.
   */
  async claim(actor: AuthorizationActor, taskIds: readonly string[], now = new Date()) {
    validActor(actor);
    const allowed = new Set<string>();
    for (const source of this.active.values()) if (await this.accessible(actor, source)) allowed.add(source.sourceId);
    return this.transaction(async client => {
      const rows = (await client.query<BriefingTaskRow>(`SELECT id,user_sub,session_id,principal_issuer,briefing_source_id,status,delivered
        FROM jarvis_tasks WHERE id=ANY($1::text[]) AND user_sub=$2 AND principal_issuer=$3
          AND briefing_source_id IS NOT NULL AND delivered=FALSE AND status IN ('done','error') ORDER BY id`, [taskIds, actor.sub, actor.issuer])).rows;
      const claimed: Array<{ id: string; channel: BriefingPreference['channel'] }> = [];
      const generations = new Map<string, RegisteredBriefingSource>();
      const ids = [...new Set(rows.map(row => row.briefing_source_id!))].sort();
      for (const sourceId of ids) {
        const source = this.active.get(sourceId); if (!source || !allowed.has(sourceId)) continue;
        await this.lock(client, actor, sourceId);
        if (!await this.accessible(actor, source)) continue;
        const preference = await this.preference(client, actor, source); if (!preference.enabled) continue;
        const previous = (await client.query('SELECT last_announced_at FROM jarvis_briefing_cursors WHERE principal_issuer=$1 AND user_sub=$2 AND source_id=$3',
          [actor.issuer, actor.sub, sourceId])).rows[0]?.last_announced_at;
        if (previous && now.getTime() - new Date(previous).getTime() < BRIEFING_INTERVALS[preference.frequency]) continue;
        if (!await this.accessible(actor, source)) continue;
        const updated = await client.query<{ id: string }>(`UPDATE jarvis_tasks SET delivered=TRUE WHERE id=ANY($1::text[]) AND user_sub=$2
          AND principal_issuer=$3 AND briefing_source_id=$4 AND delivered=FALSE RETURNING id`,
        [rows.filter(row => row.briefing_source_id === sourceId).map(row => row.id), actor.sub, actor.issuer, sourceId]);
        if (!updated.rowCount) continue;
        await client.query(`INSERT INTO jarvis_briefing_cursors(principal_issuer,user_sub,source_id,last_announced_at) VALUES($1,$2,$3,$4)
          ON CONFLICT(principal_issuer,user_sub,source_id) DO UPDATE SET last_announced_at=EXCLUDED.last_announced_at`, [actor.issuer, actor.sub, sourceId, now]);
        if (!await this.accessible(actor, source)) throw new Error('Briefing source authority changed during announcement');
        generations.set(sourceId, source);
        for (const row of updated.rows) claimed.push({ id: row.id, channel: preference.channel });
      }
      if ([...generations].some(([id, source]) => this.active.get(id) !== source)) throw new Error('Briefing source retired during announcement');
      return { claimed };
    }, true);
  }
}
