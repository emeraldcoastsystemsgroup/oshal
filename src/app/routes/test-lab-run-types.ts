/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Define exact-principal durable package run and current-authority ports.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Name the applications one authority resolution decides. Every run-path check walked all installed applications; past the 5 s cap that counted as a denial and cancelled healthy runs, so a check now decides only the run's own application.
 */
import type { Request } from 'express';
import type { InstalledAppTestCase, InstalledTestAuth, InstalledAppTestResult } from '@/features/swarm-apps';

export interface TestLabPrincipal { issuer: string; sub: string }
export interface TestLabRunContext {
  actor: TestLabPrincipal;
  visibleApps: ReadonlyMap<string, string>;
  auth: InstalledTestAuth;
}
/**
 * @description Which applications one fresh authority resolution decides. An application name decides that
 * application alone, and every run-path check (start, read, cancel, the in-flight watch and revalidation)
 * names the run's own application. `null` decides none: the caller's identity is resolved, `visibleApps` is
 * empty, and it serves a step that needs only the owner key. Omitted decides every installed application;
 * only catalog-wide reads such as unfiltered run history need that.
 */
export type TestLabAuthorityScope = string | null | undefined;
/** @description Fresh server-owned caller authority for one scope (see TestLabAuthorityScope). */
export type TestLabAuthority = (scope?: string | null) => Promise<TestLabRunContext>;
/** @description Request-bound form of TestLabAuthority that the composition root supplies to the routes. */
export type TestLabRequestAuthority = (req: Request, scope?: string | null) => Promise<TestLabRunContext>;
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
