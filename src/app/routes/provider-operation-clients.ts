/**
 * Request-scoped provider operation clients for application-owned deterministic routes.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1   | maintainer@emeraldcoastsystemsgroup.com     | Replace credential-bearing child-process
 *     | environments with typed in-process calls. Each core provider module receives one explicit
 *     | credential value and an argument vector; ambient CLI credential resolution is unreachable
 *     | through this bridge.
 */

type ProviderOperationResult = Record<string, unknown>;
type ProviderOperation = (
  credential: unknown,
  args: string[],
) => Promise<ProviderOperationResult>;

interface WalmartProviderModule {
  executeWalmartOperation: ProviderOperation;
}

interface UberRidesProviderModule {
  executeUberRidesOperation: ProviderOperation;
}

interface UberEatsProviderModule {
  executeUberEatsOperation: ProviderOperation;
}

interface DuffelProviderModule {
  executeDuffelOperation: ProviderOperation;
}

// The relative path has the same depth from src/app/routes and dist/app/routes, so source and
// compiled controller runtimes resolve the single shipped scripts/ implementation identically.
const walmartProvider = require('../../../scripts/oshal-walmart.js') as WalmartProviderModule;
const uberRidesProvider = require('../../../scripts/oshal-uber-rides.js') as UberRidesProviderModule;
const uberEatsProvider = require('../../../scripts/oshal-uber.js') as UberEatsProviderModule;
const duffelProvider = require('../../../scripts/oshal-duffel.js') as DuffelProviderModule;

/** Run one Walmart catalog/deep-link operation with the caller's resolved credential. */
export async function runWalmartProviderOperation(
  credential: string | undefined,
  args: readonly string[],
): Promise<ProviderOperationResult> {
  return walmartProvider.executeWalmartOperation(credential, [...args]);
}

/** Run one Uber Rides estimate/geocode/deep-link operation with request-local configuration. */
export async function runUberRidesProviderOperation(
  credential: string | undefined,
  args: readonly string[],
): Promise<ProviderOperationResult> {
  return uberRidesProvider.executeUberRidesOperation(credential, [...args]);
}

/** Run one curated Uber Eats catalog/deep-link operation with request-local configuration. */
export async function runUberEatsProviderOperation(
  credential: string | undefined,
  args: readonly string[],
): Promise<ProviderOperationResult> {
  return uberEatsProvider.executeUberEatsOperation(credential, [...args]);
}

/** Run one Duffel search/demo-handoff operation with the caller's request-local token. */
export async function runDuffelProviderOperation(
  credential: string | undefined,
  args: readonly string[],
): Promise<ProviderOperationResult> {
  return duffelProvider.executeDuffelOperation(credential, [...args]);
}
