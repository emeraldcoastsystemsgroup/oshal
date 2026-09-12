/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Define exact-owner catalog schedules and bounded batch evidence without credentials or executable request fields.
 */
import type { TestLabPrincipal, TestLabRunContext, TestLabRunSelection, TestLabRunState } from './test-lab-run-types';

export type TestLabCadence = 'hourly' | 'daily' | 'weekly';
export interface TestLabScheduleInput { appName: string; levels: Array<'unit' | 'integration'>; cadence: TestLabCadence }
export interface TestLabSchedule extends TestLabScheduleInput {
  id: string; actor: TestLabPrincipal; enabled: boolean; revision: number; nextRunAt: string | null; createdAt: string; updatedAt: string;
}
export interface TestLabScheduleDrift { appName: string; missingRegistrations: string[]; inventoryError?: string }
export interface TestLabBatchSummary {
  selected: number; deferred: number;
  unavailable: Array<{ appName: string; caseId: string; reason: string }>;
  drift: TestLabScheduleDrift[];
  runs: Array<{ appName: string; caseId: string; runId: string; state: TestLabRunState }>;
  error?: string;
}
export interface TestLabScheduleBatch {
  id: string; scheduleId: string; actor: TestLabPrincipal; requestId: string; scheduleRevision: number;
  oneOff: boolean; state: 'running' | 'completed' | 'cancelled' | 'interrupted';
  createdAt: string; updatedAt: string; summary: TestLabBatchSummary;
}
export interface TestLabScheduleClaim { schedule: TestLabSchedule; batch: TestLabScheduleBatch; created: boolean }
export interface TestLabScheduleStore {
  create(actor: TestLabPrincipal, input: TestLabScheduleInput): Promise<TestLabSchedule>;
  list(actor: TestLabPrincipal): Promise<TestLabSchedule[]>;
  get(actor: TestLabPrincipal, id: string): Promise<TestLabSchedule | null>;
  update(actor: TestLabPrincipal, id: string, revision: number, enabled: boolean, now: Date): Promise<TestLabSchedule | null>;
  claim(actor: TestLabPrincipal, id: string, revision: number, requestId: string): Promise<TestLabScheduleClaim>;
  claimDue(now: Date): Promise<TestLabScheduleClaim | null>;
  heartbeat(batch: TestLabScheduleBatch): Promise<boolean>;
  checkpoint(batch: TestLabScheduleBatch, summary: TestLabBatchSummary): Promise<void>;
  finish(batch: TestLabScheduleBatch, state: TestLabScheduleBatch['state'], summary: TestLabBatchSummary): Promise<void>;
  history(actor: TestLabPrincipal, id: string): Promise<TestLabScheduleBatch[]>;
}
export type TestLabScheduleContext = () => Promise<TestLabRunContext>;
export type TestLabScheduledContext = (actor: TestLabPrincipal) => Promise<TestLabRunContext>;
export type TestLabScheduledSelection = Omit<TestLabRunSelection, 'requestId'> & { appName: string };

/** @description Resolve only documented local cadences; no cron expressions or arbitrary dispatch payloads exist.
 * @param cadence Validated cadence. @returns Interval in milliseconds. */
export function testLabCadenceMs(cadence: TestLabCadence): number {
  return { hourly: 3600000, daily: 86400000, weekly: 604800000 }[cadence];
}
