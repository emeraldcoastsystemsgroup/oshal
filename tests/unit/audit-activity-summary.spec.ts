import { describe, expect, it } from 'vitest';
import { summarizeAuditActivity, type AuditRow } from '../../src/features/governance/audit/audit-emit';

function rows(entries: Array<Partial<AuditRow>>): AuditRow[] {
  return entries.map((e, i) => ({
    audit_id: String(i),
    actor_sub: null,
    action: 'x',
    resource_type: 'x',
    resource_id: null,
    decision: 'info',
    metadata: null,
    created_at: '2026-06-30T00:00:00Z',
    ...e,
  }));
}

describe('summarizeAuditActivity', () => {
  it('rolls up per-action counts with allow/deny split and last-seen', () => {
    const s = summarizeAuditActivity(rows([
      { actor_sub: 'a', action: 'tool.execute', resource_type: 'tool', decision: 'allow', created_at: '2026-06-30T01:00:00Z' },
      { actor_sub: 'a', action: 'tool.execute', resource_type: 'tool', decision: 'info', created_at: '2026-06-30T02:00:00Z' },
      { actor_sub: 'b', action: 'connector.enable', resource_type: 'connector', decision: 'allow', created_at: '2026-06-30T03:00:00Z' },
      { actor_sub: null, action: 'ticket.access', resource_type: 'ticket', decision: 'deny', created_at: '2026-06-30T04:00:00Z' },
    ]));

    expect(s.total).toBe(4);
    expect(s.byAction[0].action).toBe('tool.execute'); // sorted by count desc
    expect(s.byAction.find((a) => a.action === 'tool.execute')).toMatchObject({
      count: 2, allow: 1, deny: 0, lastAt: '2026-06-30T02:00:00Z',
    });
    expect(s.byAction.find((a) => a.action === 'ticket.access')).toMatchObject({ count: 1, deny: 1 });
    expect(s.byActor.find((x) => x.actorSub === 'a')?.count).toBe(2);
    expect(s.byActor.find((x) => x.actorSub === null)?.count).toBe(1); // anonymous
    expect(s.byResourceType.find((x) => x.resourceType === 'tool')?.count).toBe(2);
  });

  it('handles empty input', () => {
    expect(summarizeAuditActivity([])).toEqual({ total: 0, byAction: [], byActor: [], byResourceType: [] });
  });
});
