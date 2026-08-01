// Ambient declaration so tsc accepts the runtime dependency `pdf-parse` (no @types published).
// The doc-extract service imports the lib entry directly to bypass pdf-parse's index.js debug mode,
// which reads a sample file from disk at import time.
declare module 'pdf-parse/lib/pdf-parse.js' {
  interface PdfParseResult {
    text: string;
    numpages: number;
    numrender: number;
    info: unknown;
    metadata: unknown;
    version: string;
  }
  function pdfParse(data: Buffer | Uint8Array, options?: Record<string, unknown>): Promise<PdfParseResult>;
  export default pdfParse;
}
