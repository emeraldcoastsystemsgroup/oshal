/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial implementation of DebugWindow UI component for logs and SSE events
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added swarm ticket processing controls and run inspection to the debug window
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Replaced inline panelStyles with design-system CSS classes for theme compliance
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Show source field in processing summary card for diagnostic visibility
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Added smoke-test controls and result rendering to the swarm debug window
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Added recent runs list, work item details with execution output and verification results
 */

import React, { useDeferredValue } from 'react';
import { useDebugStream, useSwarmDebugPanel } from '../services';

/**
 * @description DebugWindow UI component. Displays logs, SSE events, and a local swarm control panel.
 *
 * @returns {JSX.Element} The rendered debug window component.
 */
export const DebugWindow: React.FC = () => {
  const stream = useDebugStream();
  const swarm = useSwarmDebugPanel();
  const deferredLogs = useDeferredValue(stream.logs);
  const deferredEvents = useDeferredValue(stream.sseEvents);

  return (
    <div className="debug-window glass-panel p-md">
      <div className="flex-col gap-md">
        <header>
          <div className="label">Live Debug Surface</div>
          <h4>Debug Window</h4>
        </header>
        <SwarmLabSection swarm={swarm} />
        <StreamPanel
          error={stream.error}
          logs={deferredLogs}
          sseEvents={deferredEvents}
        />
      </div>
    </div>
  );
};

type SwarmPanelState = ReturnType<typeof useSwarmDebugPanel>;
type StreamState = ReturnType<typeof useDebugStream>;

function SwarmLabSection({ swarm }: { swarm: SwarmPanelState }): React.JSX.Element {
  return (
    <section className="glass-card">
      <div className="flex justify-between items-center mb-sm">
        <div>
          <div className="text-primary" style={{ fontSize: 13, fontWeight: 700 }}>Swarm Ticket Lab</div>
          <div className="text-muted" style={{ fontSize: 12 }}>Lead-ticket first, ticket-mode only.</div>
        </div>
        <StatusChip tone={swarm.runRecord?.status || 'idle'} label={swarm.runRecord?.status || 'idle'} />
      </div>
      <TicketSubmitForm swarm={swarm} />
      <SwarmControlFields swarm={swarm} />
      {swarm.error ? <ErrorNotice message={swarm.error} /> : null}
      {swarm.lastSmokeTest ? <SwarmSmokeSummaryCard swarm={swarm} /> : null}
      {swarm.lastProcessing ? <SwarmProcessingSummaryCard swarm={swarm} /> : null}
      {swarm.runRecord ? <SwarmRunSnapshot swarm={swarm} /> : null}
      <RecentRunsList swarm={swarm} />
      {swarm.workItems.length > 0 ? <WorkItemsPanel swarm={swarm} /> : null}
    </section>
  );
}

function SwarmControlFields({ swarm }: { swarm: SwarmPanelState }): React.JSX.Element {
  return (
    <div className="flex-col gap-sm">
      <div className="control-grid-2col">
        <label className="label">
          Provider
          <select className="select" value={swarm.provider} onChange={(event) => swarm.setProvider(event.target.value as 'plane')}>
            <option value="plane">Plane</option>
          </select>
        </label>
        <label className="label">
          Ticket Limit
          <input className="input" aria-label="Ticket limit" type="number" min={1} max={10} value={swarm.limit} onChange={(event) => swarm.setLimit(readInteger(event.target.value, 1))} />
        </label>
        <label className="label">
          Verify Attempts
          <input className="input" aria-label="Verification attempts" type="number" min={1} max={5} value={swarm.policy.maxVerificationAttempts} onChange={(event) => swarm.setPolicy({ ...swarm.policy, maxVerificationAttempts: readInteger(event.target.value, 1) })} />
        </label>
        <label className="label">
          Write-back Attempts
          <input className="input" aria-label="Write-back attempts" type="number" min={1} max={5} value={swarm.policy.maxWritebackAttempts} onChange={(event) => swarm.setPolicy({ ...swarm.policy, maxWritebackAttempts: readInteger(event.target.value, 1) })} />
        </label>
      </div>
      <label className="label flex items-center gap-sm" style={{ textTransform: 'none' }}>
        <input checked={swarm.includeSubtickets} onChange={(event) => swarm.setIncludeSubtickets(event.target.checked)} type="checkbox" />
        Include subtickets in pull results
      </label>
      <div className="flex gap-sm">
        <button disabled={swarm.smokeTesting} onClick={() => void swarm.runSmokeTest()} className="btn btn-secondary" type="button">
          {swarm.smokeTesting ? 'Testing...' : 'Run Smoke Test'}
        </button>
        <button disabled={swarm.processing} onClick={() => void swarm.processLeadTickets()} className="btn btn-primary" type="button">
          {swarm.processing ? 'Processing...' : 'Process Lead Tickets'}
        </button>
        <button disabled={swarm.loadingRun} onClick={() => void swarm.loadRun()} className="btn btn-secondary" type="button">
          {swarm.loadingRun ? 'Loading...' : 'Load Run'}
        </button>
      </div>
      <label className="label">
        Run ID
        <input className="input" aria-label="Swarm run id" placeholder="Paste a swarm run id" value={swarm.runIdInput} onChange={(event) => swarm.setRunIdInput(event.target.value)} />
      </label>
    </div>
  );
}

function TicketSubmitForm({ swarm }: { swarm: SwarmPanelState }): React.JSX.Element {
  const [title, setTitle] = React.useState('');
  const [body, setBody] = React.useState('');
  const [labels, setLabels] = React.useState('');
  const [priority, setPriority] = React.useState('');
  const [collapsed, setCollapsed] = React.useState(false);

  const handleSubmit = async (): Promise<void> => {
    if (!title.trim()) return;
    const labelArray = labels.split(',').map((l) => l.trim()).filter(Boolean);
    await swarm.submitTicket(title.trim(), body.trim(), labelArray, priority.trim() || undefined);
    setTitle('');
    setBody('');
    setLabels('');
    setPriority('');
  };

  return (
    <div style={{ marginBottom: 12 }}>
      <div className="flex justify-between items-center mb-sm" style={{ cursor: 'pointer' }} onClick={() => setCollapsed(!collapsed)}>
        <div className="text-primary" style={{ fontSize: 13, fontWeight: 700 }}>Submit Ticket</div>
        <span style={{ fontSize: 11 }}>{collapsed ? '▸' : '▾'}</span>
      </div>
      {!collapsed ? (
        <div className="flex-col gap-sm">
          <label className="label">
            Title *
            <input className="input" placeholder="Ticket title" value={title} onChange={(e) => setTitle(e.target.value)} />
          </label>
          <label className="label">
            Description
            <textarea className="input" placeholder="Describe the work to be done" rows={3} value={body} onChange={(e) => setBody(e.target.value)} style={{ resize: 'vertical', fontFamily: 'inherit' }} />
          </label>
          <div className="control-grid-2col">
            <label className="label">
              Labels (comma-separated)
              <input className="input" placeholder="bug, feature, docs" value={labels} onChange={(e) => setLabels(e.target.value)} />
            </label>
            <label className="label">
              Priority
              <select className="select" value={priority} onChange={(e) => setPriority(e.target.value)}>
                <option value="">None</option>
                <option value="urgent">Urgent</option>
                <option value="high">High</option>
                <option value="medium">Medium</option>
                <option value="low">Low</option>
              </select>
            </label>
          </div>
          <button
            disabled={swarm.submitting || !title.trim()}
            onClick={() => void handleSubmit()}
            className="btn btn-primary"
            type="button"
          >
            {swarm.submitting ? 'Submitting...' : 'Submit to Swarm'}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function SwarmSmokeSummaryCard({ swarm }: { swarm: SwarmPanelState }): React.JSX.Element {
  const previewTitle = swarm.lastSmokeTest?.items[0]?.title;

  return (
    <div className="glass-card debug-feed" style={{ marginTop: 12 }}>
      <div className="flex justify-between text-primary" style={{ fontWeight: 700 }}>
        <span>Last smoke test</span>
        <span>{swarm.lastSmokeTest?.durationMs} ms</span>
      </div>
      <div className="text-secondary" style={{ fontSize: 13 }}>
        Pulled {swarm.lastSmokeTest?.itemCount} ticket(s).
        {swarm.lastSmokeTest?.source ? <span className="text-muted"> · source: {swarm.lastSmokeTest.source}</span> : null}
      </div>
      {previewTitle ? <div className="text-muted" style={{ fontSize: 12 }}>First ticket: {previewTitle}</div> : null}
    </div>
  );
}

function SwarmProcessingSummaryCard({ swarm }: { swarm: SwarmPanelState }): React.JSX.Element {
  return (
    <div className="glass-card debug-feed" style={{ marginTop: 12 }}>
      <div className="flex justify-between text-primary" style={{ fontWeight: 700 }}>
        <span>Last swarm request</span>
        <span>{swarm.lastProcessing?.runId}</span>
      </div>
      <div className="text-secondary" style={{ fontSize: 13 }}>
        Pulled {swarm.lastProcessing?.pulledCount} ticket(s), processed {swarm.lastProcessing?.processedCount}.
        {swarm.lastProcessing?.source ? <span className="text-muted"> · source: {swarm.lastProcessing.source}</span> : null}
      </div>
    </div>
  );
}

function SwarmRunSnapshot({ swarm }: { swarm: SwarmPanelState }): React.JSX.Element {
  return (
    <div className="flex-col gap-sm" style={{ marginTop: 12 }}>
      <div className="flex gap-sm" style={{ flexWrap: 'wrap' }}>
        <StatusChip tone={swarm.runRecord?.status || 'idle'} label={swarm.runRecord?.status || 'idle'} />
        <StatusChip tone="count" label={`${swarm.runRecord?.itemCount || 0} item(s)`} />
      </div>
      <div className="glass-card debug-feed">
        {swarm.runRecord?.processed.length ? swarm.runRecord.processed.map((ticket) => (
          <article key={ticket.externalId} className="flex-col gap-sm">
            <div className="text-primary" style={{ fontWeight: 700 }}>{ticket.title}</div>
            <div className="text-secondary" style={{ fontSize: 13 }}>
              Agent {ticket.selectedAgentId || 'unassigned'} · {ticket.workUnitCount} work units · lifecycle {ticket.lifecycle.overallStatus}
            </div>
            <div className="text-muted" style={{ fontSize: 12 }}>{summarizeCycles(ticket.lifecycle.cycles)}</div>
          </article>
        )) : <div className="text-muted">Run has no processed tickets yet.</div>}
      </div>
      {swarm.runRecord?.error ? <ErrorNotice message={swarm.runRecord.error} /> : null}
    </div>
  );
}

function RecentRunsList({ swarm }: { swarm: SwarmPanelState }): React.JSX.Element {
  return (
    <div style={{ marginTop: 12 }}>
      <div className="flex justify-between items-center mb-sm">
        <div className="text-primary" style={{ fontSize: 13, fontWeight: 700 }}>Recent Runs</div>
        <button disabled={swarm.loadingRuns} onClick={() => void swarm.loadRecentRuns()} className="btn btn-secondary" type="button" style={{ fontSize: 11, padding: '2px 8px' }}>
          {swarm.loadingRuns ? 'Loading...' : 'Refresh'}
        </button>
      </div>
      {swarm.recentRuns.length === 0 ? (
        <div className="text-muted" style={{ fontSize: 12 }}>No runs recorded yet.</div>
      ) : (
        <div className="glass-card debug-feed" style={{ maxHeight: 200, overflowY: 'auto' }}>
          {swarm.recentRuns.map((run) => (
            <div
              key={run.runId}
              onClick={() => void swarm.selectRun(run.runId)}
              className="flex justify-between items-center"
              style={{ cursor: 'pointer', padding: '4px 0', borderBottom: '1px solid var(--border-subtle, #333)', opacity: swarm.selectedRunId === run.runId ? 1 : 0.7 }}
            >
              <div>
                <span className="text-primary" style={{ fontSize: 12, fontWeight: swarm.selectedRunId === run.runId ? 700 : 400 }}>
                  {run.runId.slice(0, 8)}...
                </span>
                <span className="text-muted" style={{ fontSize: 11, marginLeft: 6 }}>
                  {run.itemCount} item(s)
                </span>
              </div>
              <div className="flex gap-sm items-center">
                <span className="text-muted" style={{ fontSize: 11 }}>{formatTimestamp(run.startedAt)}</span>
                <StatusChip tone={run.status} label={run.status} />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function WorkItemsPanel({ swarm }: { swarm: SwarmPanelState }): React.JSX.Element {
  return (
    <div style={{ marginTop: 12 }}>
      <div className="flex justify-between items-center mb-sm">
        <div className="text-primary" style={{ fontSize: 13, fontWeight: 700 }}>
          Work Items {swarm.selectedRunId ? `(${swarm.selectedRunId.slice(0, 8)}...)` : ''}
        </div>
        <span className="badge badge-info">{swarm.workItems.length} item(s)</span>
      </div>
      <div className="flex-col gap-sm">
        {swarm.workItems.map((item) => (
          <WorkItemCard key={item.workItemId} item={item} />
        ))}
      </div>
    </div>
  );
}

function WorkItemCard({ item }: { item: { workItemId: string; title: string; description: string; unitId: string; assignedAgentId?: string; status: string; executionOutput?: unknown; verificationResult?: unknown; createdAt: string } }): React.JSX.Element {
  const [expanded, setExpanded] = React.useState(false);
  const hasOutput = item.executionOutput != null;
  const hasVerification = item.verificationResult != null;
  const verificationStatus = hasVerification && typeof item.verificationResult === 'object' && item.verificationResult !== null
    ? (item.verificationResult as Record<string, unknown>).status as string | undefined
    : undefined;

  return (
    <div className="glass-card" style={{ padding: 8 }}>
      <div className="flex justify-between items-center" style={{ cursor: 'pointer' }} onClick={() => setExpanded(!expanded)}>
        <div>
          <span className="text-primary" style={{ fontSize: 12, fontWeight: 700 }}>{item.title || item.unitId}</span>
          {item.assignedAgentId ? <span className="text-muted" style={{ fontSize: 11, marginLeft: 6 }}>agent: {item.assignedAgentId.slice(0, 8)}</span> : null}
        </div>
        <div className="flex gap-sm items-center">
          <StatusChip tone={item.status === 'completed' ? 'completed' : item.status === 'failed' ? 'failed' : 'in_progress'} label={item.status} />
          {hasOutput ? <span className="badge badge-success" style={{ fontSize: 10 }}>output</span> : null}
          {hasVerification ? <StatusChip tone={verificationStatus === 'approved' ? 'completed' : verificationStatus === 'rejected' ? 'failed' : 'in_progress'} label={`QA: ${verificationStatus || 'unknown'}`} /> : null}
          <span style={{ fontSize: 11 }}>{expanded ? '▾' : '▸'}</span>
        </div>
      </div>
      {expanded ? (
        <div style={{ marginTop: 8, fontSize: 12 }}>
          {item.description ? <div className="text-secondary" style={{ marginBottom: 6 }}>{item.description.slice(0, 300)}{item.description.length > 300 ? '...' : ''}</div> : null}
          {hasOutput ? (
            <div style={{ marginTop: 4 }}>
              <div className="text-primary" style={{ fontWeight: 700, marginBottom: 2 }}>Execution Output</div>
              <pre className="glass-card debug-feed" style={{ fontSize: 11, maxHeight: 200, overflowY: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                {formatJson(item.executionOutput)}
              </pre>
            </div>
          ) : null}
          {hasVerification ? (
            <div style={{ marginTop: 4 }}>
              <div className="text-primary" style={{ fontWeight: 700, marginBottom: 2 }}>Verification Result</div>
              <pre className="glass-card debug-feed" style={{ fontSize: 11, maxHeight: 200, overflowY: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                {formatJson(item.verificationResult)}
              </pre>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function formatJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function formatTimestamp(iso: string): string {
  try {
    const d = new Date(iso);
    return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
  } catch {
    return iso;
  }
}

function StreamPanel({ error, logs, sseEvents }: Pick<StreamState, 'error'> & { logs: StreamState['logs']; sseEvents: StreamState['sseEvents'] }): React.JSX.Element {
  return (
    <section className="glass-card">
      <div className="text-primary mb-sm" style={{ fontSize: 13, fontWeight: 700 }}>System Stream</div>
      {error ? <ErrorNotice message={error} /> : null}
      <div className="flex-col gap-sm">
        <StreamFeed title="Logs" items={logs.map((log) => `[${log.timestamp}] ${log.level}: ${log.message}`)} emptyText="No logs yet." />
        <StreamFeed title="SSE Events" items={sseEvents.map((event) => `[${event.timestamp}] ${event.event}: ${event.data}`)} emptyText="No SSE events yet." />
      </div>
    </section>
  );
}

function StreamFeed({ title, items, emptyText }: { title: string; items: string[]; emptyText: string }): React.JSX.Element {
  return (
    <div>
      <strong className="text-secondary mb-sm" style={{ display: 'block' }}>{title}</strong>
      <div className="glass-card debug-feed">
        {items.length === 0 ? <div className="text-muted">{emptyText}</div> : items.map((item) => <div key={item} className="text-secondary" style={{ fontSize: 13 }}>{item}</div>)}
      </div>
    </div>
  );
}

function StatusChip({ label, tone }: { label: string; tone: string }): React.JSX.Element {
  const badgeClass = tone === 'completed' ? 'badge-success'
    : tone === 'failed' ? 'badge-error'
    : 'badge-info';
  return <span className={`badge ${badgeClass}`}>{label}</span>;
}

function ErrorNotice({ message }: { message: string }): React.JSX.Element {
  return <div className="error-notice" style={{ marginTop: 12 }}>{message}</div>;
}

function readInteger(value: string, fallback: number): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function summarizeCycles(cycles: Array<{ cycle: string; status: string }>): string {
  return cycles.map((cycle) => `${cycle.cycle}:${cycle.status}`).join(' · ');
}
