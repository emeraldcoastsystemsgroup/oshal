/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * DATE         | AUTHOR      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial implementation of useDebugStream hook for real-time logs and SSE events
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added error reporting and bounded stream state updates for the debug window
 */

import { startTransition, useEffect, useState } from 'react';
import { reportClientDebugError } from './debug-client-log';

interface DebugLogEntry {
  level: string;
  message: string;
  timestamp: string;
}

interface DebugStreamEvent {
  event: string;
  data: string;
  timestamp: string;
}

/**
 * @description React hook to subscribe to real-time logs and SSE events from the backend.
 * Uses EventSource for SSE and fetches logs from a logging API endpoint.
 *
 * @returns {{
 *   logs: Array<{ level: string; message: string; timestamp: string }>,
 *   sseEvents: Array<{ event: string; data: string; timestamp: string }>,
 *   error: string | null
 * }}
 */
export function useDebugStream() {
  const [logs, setLogs] = useState<DebugLogEntry[]>([]);
  const [sseEvents, setSseEvents] = useState<DebugStreamEvent[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let isDisposed = false;
    const sse = new EventSource('/api/stream/debug');

    sse.onmessage = (event) => {
      try {
        const nextEvent = toDebugStreamEvent(event.data);
        startTransition(() => {
          setSseEvents((prev) => appendBoundedEntry(prev, nextEvent));
          setError((current) => current === 'Debug event stream disconnected.' ? null : current);
        });
      } catch (nextError) {
        reportClientDebugError('useDebugStream', 'parseSseEvent', nextError);
        setError('Failed to parse debug event payload.');
      }
    };

    sse.onerror = () => {
      reportClientDebugError('useDebugStream', 'streamConnection', new Error('Debug event stream disconnected.'));
      setError('Debug event stream disconnected.');
      sse.close();
    };

    const fetchLogs = async () => {
      try {
        const nextLogs = await requestDebugLogs();
        if (isDisposed) {
          return;
        }

        startTransition(() => {
          setLogs(nextLogs);
          setError((current) => current === 'Failed to refresh debug log feed.' ? null : current);
        });
      } catch (nextError) {
        reportClientDebugError('useDebugStream', 'fetchLogs', nextError);
        setError('Failed to refresh debug log feed.');
      }
    };

    void fetchLogs();
    const logInterval = window.setInterval(() => {
      void fetchLogs();
    }, 5000);

    return () => {
      isDisposed = true;
      sse.close();
      window.clearInterval(logInterval);
    };
  }, []);

  return { logs, sseEvents, error };
}

async function requestDebugLogs(): Promise<DebugLogEntry[]> {
  const response = await fetch('/api/logs');
  if (!response.ok) {
    throw new Error(`Debug log request failed with status ${response.status}.`);
  }

  return response.json() as Promise<DebugLogEntry[]>;
}

function toDebugStreamEvent(payload: string): DebugStreamEvent {
  const parsed = JSON.parse(payload) as Partial<DebugStreamEvent>;
  return {
    event: parsed.event || 'message',
    data: parsed.data || '',
    timestamp: parsed.timestamp || new Date().toLocaleTimeString(),
  };
}

function appendBoundedEntry<T>(entries: T[], nextEntry: T): T[] {
  return [...entries.slice(-11), nextEntry];
}
