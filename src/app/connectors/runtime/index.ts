/**
 * Connector runtime — public surface. Import from here, not the individual files.
 * @module connectors/runtime
 */
export { ConnectorClient, brokeredBearer, parseNextLink } from './connector-client';
export { invokeSpecResource, createConnectorSpecRouter } from './spec-routes';
export type { SpecRouteDeps, SpecRouteResult } from './spec-routes';
export { ConnectorError } from './connector-error';
export type { ConnectorErrorCode, ConnectorErrorInit } from './connector-error';
export type {
  AuthSpec, ConnectorClientConfig, PaginationStrategy, RateLimitPolicy, RequestOptions, RetryPolicy, TokenProvider,
} from './types';
export { buildClientFromSpec, loadConnectorSpec, validateSpec } from './spec';
export type { BuildSpecOptions, ConnectorSpec, SpecAuth, SpecClient, SpecPagination, SpecResource } from './spec';
export { specFromOpenApi } from './openapi-import';
export type { ImportResult } from './openapi-import';
export { specToMarkdown } from './spec-to-doc';
export { auditSpec, auditConnectorCatalog, formatAudit } from './catalog-audit';
export type { AuditIssue, ConnectorAudit } from './catalog-audit';
export {
  actionProfilesForSpec,
  buildConnectorActionPreview,
  describeConnectorAction,
  extractSpecResourcePlaceholders,
  inferConnectorActionType,
  isConnectorActionDryRun,
  requiresConnectorConfirmation,
  supportsConnectorDryRun,
} from './action-safety';
export type { ConnectorActionProfile, ConnectorActionType } from './action-safety';
export {
  connectorActionRequiresApproval,
  validateActionParams,
  validateSpecActions,
} from './action-params';
export type { SpecAction, SpecActionMethod, SpecActionRiskLevel } from './action-params';
export { resolveConnectorActionCreds } from './action-creds';
export type { ConnectorActionTokenResolver } from './action-creds';
export {
  hashConnectorActionParams,
  recordConnectorActionAudit,
  runConnectorAction,
  splitConnectorActionInputs,
} from './action-executor';
export type {
  ConnectorActionAuditPool,
  ConnectorActionAuditRow,
  ConnectorActionAuditStatus,
  RunConnectorActionDeps,
} from './action-executor';
export { ConnectorMarketplaceService } from './marketplace';
export type {
  ConnectorInstallState,
  ConnectorMarketplaceEntry,
  ConnectorMarketplaceOptions,
  ConnectorMarketplaceState,
  ConnectorMarketplaceSummary,
  ConnectorRiskLevel,
} from './marketplace';
