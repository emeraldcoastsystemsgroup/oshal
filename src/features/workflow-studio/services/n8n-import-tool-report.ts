/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial implementation: size-bounded JSON rendering of an n8n analysis report for the n8n-import-analyze builtin tool. Moved out of tool-executor-service.ts (which sits just under the 1000-line cap) so the executor only dispatches to it.
 */
import { analyzeN8nImport, type N8nImportAnalysis } from './n8n-import-analyzer';

const EXAMPLE_LIMIT = 10;

/** @description The tool result: the analysis with example lists trimmed and the omitted counts stated. */
export type N8nImportToolReport = N8nImportAnalysis & { omittedNodeCount: number; omittedConnectionCount: number };

function trimmedReport(report: N8nImportAnalysis, nodeLimit: number, connectionLimit: number): N8nImportToolReport {
  return {
    ...report,
    nodes: report.nodes.slice(0, nodeLimit),
    connections: report.connections.slice(0, connectionLimit),
    omittedNodeCount: report.nodeCount - nodeLimit,
    omittedConnectionCount: report.connectionCount - connectionLimit,
  };
}

/**
 * @description Analyze one export and render the report as JSON no longer than maxChars. The generic
 * tool-output limiter slices text and would corrupt JSON, so this trims only the displayed example
 * nodes and connections (connections first), never the totals, flags or blockers.
 * @param jsonText - The raw n8n export supplied as the tool input.
 * @param maxChars - The largest serialized result the caller will accept.
 * @returns Valid JSON for an N8nImportToolReport.
 * @throws N8nImportAnalysisError when the export is refused, or Error when even an empty example
 *   list exceeds maxChars.
 */
export function renderN8nImportToolReport(jsonText: string, maxChars: number): string {
  const report = analyzeN8nImport(jsonText);
  let nodeLimit = Math.min(report.nodes.length, EXAMPLE_LIMIT);
  let connectionLimit = Math.min(report.connections.length, EXAMPLE_LIMIT);
  for (;;) {
    const serialized = JSON.stringify(trimmedReport(report, nodeLimit, connectionLimit));
    if (serialized.length <= maxChars) return serialized;
    if (connectionLimit > 0) connectionLimit--;
    else if (nodeLimit > 0) nodeLimit--;
    else throw new Error('n8n import analysis report exceeded output limit');
  }
}
