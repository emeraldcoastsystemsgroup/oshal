/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Barrel for the data-model explorer slice: the service factory, the pure pieces the specs pin (catalog fold, row-access classification, DDL parser, declaration scanner, ownership, integration map) and the types the app layer implements ports for.
 */

export { createDataModelService, buildSnapshot, scanRoots, type DataModelService } from './services/data-model-service';
export { readCatalog, foldCatalog, CATALOG_SQL, HYPERTABLE_SQL, type CatalogQueryable, type RawCatalog } from './services/catalog-reader';
export { classifyPolicy, summarizeRowAccess } from './services/row-access';
export { parseCreateTable, matchParen, splitTopLevel } from './services/ddl-parser';
export { scanDeclarations, scanText, detectEngine, resolveDeclaredName, CORE_SOURCE_DIRS, type ScanRoot } from './services/declaration-scanner';
export { attributeOwnership, databaseLinks, sortOwners, type OwnershipResult } from './services/ownership';
export { buildIntegrationMap, aggregateEdges, mimeOverlap } from './services/integration-map';
export { keyFamily, maskSegment, tallyFamilies, type FamilyTally } from './services/key-families';
export * from './types';
