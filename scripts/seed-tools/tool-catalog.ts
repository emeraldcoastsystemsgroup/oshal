/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted from seed-tools.ts (1000-line cap decomposition): aggregates the per-domain tool definition modules into the full seed catalog (order preserved from the original single-file array)
 */

import type { CreateToolInput } from '../../src/entities/tool/schemas/tool-schemas';
import { kubernetesTools } from './kubernetes-tools';
import { cloudTools } from './cloud-tools';
import { developmentTools } from './development-tools';
import { infrastructureTools } from './infrastructure-tools';
import { containerTools } from './container-tools';
import { dataProcessingTools } from './data-processing-tools';
import { systemUtilityTools } from './system-utility-tools';
import { orchestrationTools } from './orchestration-tools';

/**
 * @description Tool catalog with comprehensive metadata - aligned with any-bot/Dockerfile
 * baseline image. Assembled from the per-domain modules in this directory; the ordering
 * matches the original single-file catalog (kubernetes, cloud, development,
 * infrastructure, containers, data-processing, system-utilities, orchestration).
 */
export const toolCatalog: CreateToolInput[] = [
  ...kubernetesTools,
  ...cloudTools,
  ...developmentTools,
  ...infrastructureTools,
  ...containerTools,
  ...dataProcessingTools,
  ...systemUtilityTools,
  ...orchestrationTools,
];
