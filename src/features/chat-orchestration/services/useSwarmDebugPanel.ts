/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added browser hook for driving swarm provider processing and run inspection from the debug window
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Surface source field from processing response to warn when provider config is missing
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Added dedicated smoke-test state and actions for the /ui swarm debug surface
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Added recent runs list and work item query with execution output visibility
 */

import { startTransition, useEffect, useState } from 'react';
import { reportClientDebugError } from './debug-client-log';

type SwarmProvider = 'plane';

interface SwarmDebugPolicy {
  maxVerificationAttempts: number;
  maxBuildRegressions: number;
  maxDesignRegressions: number;
  maxWritebackAttempts: number;
  verificationRetryDelayMs: number;
  writebackRetryDelayMs: number;
}

interface SwarmProcessingSummary {
  runId: string;
  provider: SwarmProvider;
  source?: string;
  pulledCount: number;
  processedCount: number;
}

interface SwarmSmokeTestItemPreview {
  externalId?: string;
  title?: string;
}

interface SwarmSmokeTestSummary {
  provider: SwarmProvider;
  itemCount: number;
  source?: string;
  nextCursor?: string;
  effectiveCursor?: string;
  durationMs: number;
  items: SwarmSmokeTestItemPreview[];
}

interface SwarmLifecycleCycle {
  cycle: string;
  status: string;
  details?: Record<string, unknown>;
}

interface SwarmRunRecord {
  runId: string;
  provider: SwarmProvider;
  status: 'in_progress' | 'completed' | 'failed';
  startedAt: string;
  completedAt?: string;
  itemCount: number;
  processed: Array<{
    externalId: string;
    title: string;
    selectedAgentId?: string;
    workUnitCount: number;
    lifecycle: {
      overallStatus: string;
      cycles: SwarmLifecycleCycle[];
    };
  }>;
  error?: string;
}

interface SwarmWorkItem {
  workItemId: string;
  swarmRunId: string;
  externalId: string;
  unitId: string;
  title: string;
  description: string;
  assignedAgentId?: string;
  status: string;
  executionOutput?: unknown;
  verificationResult?: unknown;
  createdAt: string;
  updatedAt: string;
}

interface SwarmRunListEntry {
  runId: string;
  provider: SwarmProvider;
  status: 'in_progress' | 'completed' | 'failed';
  startedAt: string;
  completedAt?: string;
  itemCount: number;
  error?: string;
}

const DEFAULT_POLICY: SwarmDebugPolicy = {
  maxVerificationAttempts: 2,
  maxBuildRegressions: 1,
  maxDesignRegressions: 1,
  maxWritebackAttempts: 2,
  verificationRetryDelayMs: 0,
  writebackRetryDelayMs: 0,
};

/**
 * @description Drives the debug-window swarm control panel against the live swarm APIs.
 * @returns Swarm control state and actions for local provider processing
 */
export function useSwarmDebugPanel() {
  const [provider, setProvider] = useState<SwarmProvider>('plane');
  const [limit, setLimit] = useState(1);
  const [includeSubtickets, setIncludeSubtickets] = useState(false);
  const [runIdInput, setRunIdInput] = useState('');
  const [policy, setPolicy] = useState<SwarmDebugPolicy>(DEFAULT_POLICY);
  const [processing, setProcessing] = useState(false);
  const [smokeTesting, setSmokeTesting] = useState(false);
  const [loadingRun, setLoadingRun] = useState(false);
  const [lastProcessing, setLastProcessing] = useState<SwarmProcessingSummary | null>(null);
  const [lastSmokeTest, setLastSmokeTest] = useState<SwarmSmokeTestSummary | null>(null);
  const [runRecord, setRunRecord] = useState<SwarmRunRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [recentRuns, setRecentRuns] = useState<SwarmRunListEntry[]>([]);
  const [loadingRuns, setLoadingRuns] = useState(false);
  const [workItems, setWorkItems] = useState<SwarmWorkItem[]>([]);
  const [loadingWorkItems, setLoadingWorkItems] = useState(false);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const loadRecentRuns = async (): Promise<void> => {
    setLoadingRuns(true);
    try {
      const result = await requestJson<{ runs: SwarmRunListEntry[] }>('/api/swarm/runs?limit=20');
      startTransition(() => setRecentRuns(result.runs));
    } catch (nextError) {
      handleHookError('loadRecentRuns', nextError, {}, setError);
    } finally {
      setLoadingRuns(false);
    }
  };

  const loadWorkItems = async (runId?: string): Promise<void> => {
    setLoadingWorkItems(true);
    try {
      const query = runId ? `?runId=${encodeURIComponent(runId)}&limit=100` : '?limit=50';
      const result = await requestJson<{ workItems: SwarmWorkItem[] }>(`/api/swarm/work-items${query}`);
      startTransition(() => setWorkItems(result.workItems));
    } catch (nextError) {
      handleHookError('loadWorkItems', nextError, { runId }, setError);
    } finally {
      setLoadingWorkItems(false);
    }
  };

  const selectRun = async (runId: string): Promise<void> => {
    setSelectedRunId(runId);
    setRunIdInput(runId);
    await Promise.all([
      loadRunRecord(runId, setLoadingRun, setRunRecord, setError),
      loadWorkItems(runId),
    ]);
  };

  useEffect(() => { void loadRecentRuns(); }, []);

  const processLeadTickets = async (): Promise<void> => {
    setError(null);
    setProcessing(true);
    try {
      const summary = await requestProcessing(provider, limit, includeSubtickets, policy);
      startTransition(() => { setLastProcessing(summary); setRunIdInput(summary.runId); });
      await loadRunRecord(summary.runId, setLoadingRun, setRunRecord, setError);
      await Promise.all([loadRecentRuns(), loadWorkItems(summary.runId)]);
      setSelectedRunId(summary.runId);
      surfaceSourceWarning(summary, provider, setError);
    } catch (nextError) {
      handleHookError('processLeadTickets', nextError, { provider, limit, includeSubtickets }, setError);
    } finally {
      setProcessing(false);
    }
  };

  const loadRun = async (): Promise<void> => {
    const id = runIdInput.trim();
    if (id.length === 0) { setError('Enter a swarm run ID to inspect.'); return; }
    setError(null);
    await loadRunRecord(id, setLoadingRun, setRunRecord, setError);
  };

  const runSmokeTest = async (): Promise<void> => {
    setError(null);
    setSmokeTesting(true);
    try {
      const summary = await requestJson<SwarmSmokeTestSummary>('/api/swarm/smoke');
      startTransition(() => setLastSmokeTest(summary));
      surfaceSmokeWarning(summary, setError);
    } catch (nextError) {
      handleHookError('runSmokeTest', nextError, { provider }, setError);
    } finally {
      setSmokeTesting(false);
    }
  };

  const submitTicket = async (title: string, body: string, labels: string[], priority?: string): Promise<void> => {
    setError(null);
    setSubmitting(true);
    try {
      const result = await requestJson<SwarmProcessingSummary>('/api/swarm/tickets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tickets: [{ title, body, labels, priority: priority || undefined }],
          policy,
        }),
      });
      startTransition(() => { setLastProcessing(result); setRunIdInput(result.runId); });
      await loadRunRecord(result.runId, setLoadingRun, setRunRecord, setError);
      await Promise.all([loadRecentRuns(), loadWorkItems(result.runId)]);
      setSelectedRunId(result.runId);
    } catch (nextError) {
      handleHookError('submitTicket', nextError, { title }, setError);
    } finally {
      setSubmitting(false);
    }
  };

  return {
    provider, setProvider, limit, setLimit, includeSubtickets, setIncludeSubtickets,
    runIdInput, setRunIdInput, policy, setPolicy, processing, smokeTesting, loadingRun,
    lastProcessing, lastSmokeTest, runRecord, error, processLeadTickets, runSmokeTest, loadRun,
    recentRuns, loadingRuns, loadRecentRuns,
    workItems, loadingWorkItems, loadWorkItems, selectRun, selectedRunId,
    submitting, submitTicket,
  };
}

async function requestProcessing(
  provider: SwarmProvider,
  limit: number,
  includeSubtickets: boolean,
  policy: SwarmDebugPolicy,
): Promise<SwarmProcessingSummary> {
  return requestJson<SwarmProcessingSummary>(`/api/swarm/providers/${provider}/process`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ interactionMode: 'ticket', limit, includeSubtickets, policy }),
  });
}

function surfaceSourceWarning(
  summary: SwarmProcessingSummary,
  provider: SwarmProvider,
  setError: (value: string | null) => void,
): void {
  if (summary.source === 'plane-config-missing') {
    setError('Plane provider config missing — set PLANE_API_URL, PLANE_API_TOKEN, PLANE_WORKSPACE_SLUG, and PLANE_PROJECT_ID in env, or provide PLANE_INTAKE_URL.');
  } else if (summary.pulledCount === 0) {
    setError(`No tickets pulled from ${provider} (source: ${summary.source || 'unknown'}).`);
  }
}

function surfaceSmokeWarning(
  summary: SwarmSmokeTestSummary,
  setError: (value: string | null) => void,
): void {
  if (summary.source === 'plane-config-missing') {
    setError('Plane provider config missing — set PLANE_API_URL, PLANE_API_TOKEN, PLANE_WORKSPACE_SLUG, and PLANE_PROJECT_ID in env, or provide PLANE_INTAKE_URL.');
  } else if (summary.itemCount === 0) {
    setError(`Smoke test reached Plane but returned no tickets (source: ${summary.source || 'unknown'}).`);
  }
}

async function loadRunRecord(
  runId: string,
  setLoadingRun: (value: boolean) => void,
  setRunRecord: (value: SwarmRunRecord | null) => void,
  setError: (value: string | null) => void,
): Promise<void> {
  setLoadingRun(true);
  try {
    const run = await requestJson<SwarmRunRecord>(`/api/swarm/runs/${encodeURIComponent(runId)}`);
    startTransition(() => {
      setRunRecord(run);
      setError(null);
    });
  } catch (error) {
    handleHookError('loadRun', error, { runId }, setError);
  } finally {
    setLoadingRun(false);
  }
}

async function requestJson<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(readErrorMessage(payload, response.status));
  }

  return payload as T;
}

function readErrorMessage(payload: unknown, status: number): string {
  if (payload && typeof payload === 'object' && 'error' in payload && typeof payload.error === 'string') {
    return payload.error;
  }

  return `Request failed with status ${status}.`;
}

function handleHookError(
  action: string,
  error: unknown,
  context: Record<string, unknown>,
  setError: (value: string | null) => void,
): void {
  reportClientDebugError('swarm-debug-panel', action, error, context);
  setError(error instanceof Error ? error.message : 'Swarm debug request failed.');
}
