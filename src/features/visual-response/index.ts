/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial public barrel for the visual-response feature.
 */

export { TrustedImageReceiptService, VisualResponseService, renderVisualResponse } from './services';
export type { TrustedImageReceipt, TrustedImageReceiptServiceOptions } from './services';
export { VisualResponseSpecSchema, parseVisualResponseSpec } from './visual-response-schema';
export { inferVisualSpec } from './infer-visual-spec';
export type { InferVisualSpecInput } from './infer-visual-spec';
export {
  VisualResponseProviderRecordSchema,
  groundProviderBoundVisualSpec,
  parseVisualResponseProviderRecord,
  stripVisualResponseProviderRecordFences,
} from './provider-grounding';
export type {
  FactLockedAnswerPacket, RenderedVisualResponse, VisualResponseArtifact,
  VisualResponseContent, VisualResponseKind, VisualResponseProvenance, VisualResponseSource,
  VisualResponseSpec, WeatherVisualResponseSpec, PriorityEmailVisualResponseSpec,
  TableVisualResponseSpec, ChartVisualResponseSpec, SummaryVisualResponseSpec,
  TimelineVisualResponseSpec, DiagramVisualResponseSpec,
  GalleryVisualResponseSpec, MapVisualResponseSpec, GaugeVisualResponseSpec,
  ChecklistVisualResponseSpec, AgendaVisualResponseSpec, ComparisonVisualResponseSpec,
  ProfileVisualResponseSpec, ImageVisualResponseSpec, VisualResponseProviderRecord, NwsWeatherProviderRecord,
  GmailSummaryProviderRecord, WalmartCatalogProviderRecord,
} from './types';
export { VISUAL_RESPONSE_KINDS } from './types';
export type { ProviderGroundedVisual } from './provider-grounding';
