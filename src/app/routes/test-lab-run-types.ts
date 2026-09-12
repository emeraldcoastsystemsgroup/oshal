/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Define exact-principal durable package run and current-authority ports.
 */
import type { InstalledAppTestCase, InstalledTestAuth, InstalledAppTestResult } from '@/features/swarm-apps';

export interface TestLabPrincipal { issuer: string; sub: string }
export interface TestLabRunContext {
  actor: TestLabPrincipal;
  visibleApps: ReadonlyMap<string, string>;
  auth: InstalledTestAuth;
}
export type TestLabRunState = 'queued' | 'running' | 'cancelling' | 'passed' | 'failed' | 'pending' | 'cancelled' | 'interrupted';
export interface TestLabRun {
  id: string;
  requestId: string;
  actor: TestLabPrincipal;
  test: InstalledAppTestCase;
  state: TestLabRunState;
  createdAt: string;
  updatedAt: string;
  result?: InstalledAppTestResult;
  stale?: boolean;
}
export interface TestLabRunSelection { caseId: string; revision: string; executionRevision: string; requestId: string }
export interface TestLabRunStore {
  create(run: TestLabRun): Promise<TestLabRun>;
  get(actor: TestLabPrincipal, id: string): Promise<TestLabRun | null>;
  list(actor: TestLabPrincipal, apps: string[]): Promise<TestLabRun[]>;
  begin(actor: TestLabPrincipal, id: string): Promise<boolean>;
  pulse(actor: TestLabPrincipal, id: string): Promise<TestLabRunState | null>;
  cancel(actor: TestLabPrincipal, id: string): Promise<TestLabRun | null>;
  finish(actor: TestLabPrincipal, id: string, state: TestLabRunState, result: InstalledAppTestResult): Promise<void>;
}
