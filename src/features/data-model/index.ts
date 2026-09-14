/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Barrel for the data-model explorer slice: the service factory, the pure pieces the specs pin (catalog fold, row-access classification, DDL parser, declaration scanner, ownership, integration map) and the types the app layer implements ports for.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Export the schema-drift half: the structure-only digest, the classifying differ and the digest store.
 */

export { createDataModelService, buildSnapshot, scanRoots, type DataModelService, type DriftOptions, type DriftOutcome } from './services/data-model-service';
export { readCatalog, foldCatalog, CATALOG_SQL, HYPERTABLE_SQL, type CatalogQueryable, type RawCatalog } from './services/catalog-reader';
export { classifyPolicy, summarizeRowAccess } from './services/row-access';
export { parseCreateTable, matchParen, splitTopLevel } from './services/ddl-parser';
export { scanDeclarations, scanText, detectEngine, resolveDeclaredName, CORE_SOURCE_DIRS, type ScanRoot } from './services/declaration-scanner';
export { attributeOwnership, databaseLinks, sortOwners, type OwnershipResult } from './services/ownership';
export { buildIntegrationMap, aggregateEdges, mimeOverlap } from './services/integration-map';
export { buildDigest, diffDigests, digestChanges, digestError, DIGEST_VERSION, QUIET_WINDOW_MS, PARTIAL_READ_RATIO, SCHEMA_DIGEST_INVALID, SCHEMA_DIGEST_PARTIAL, type SchemaDigest, type RelationDigest, type DriftChange, type DriftKind, type DriftReport, type DriftState } from './services/schema-digest';
export { createDriftStore, DIGEST_TABLE, DEFAULT_HISTORY_LIMIT, type DriftStore, type DigestQueryable } from './services/drift-store';
export { keyFamily, maskSegment, tallyFamilies, type FamilyTally } from './services/key-families';
export * from './types';
