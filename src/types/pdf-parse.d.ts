/**
 * Minimal ambient typing for the pdf-parse v1 library entry (the package ships no types).
 * We import `pdf-parse/lib/pdf-parse.js` directly: the package's index.js runs debug-mode
 * code paths when it thinks it is the process entry; the lib module is the parser itself.
 */
declare module 'pdf-parse/lib/pdf-parse.js' {
  interface PdfParseResult {
    text: string;
    numpages: number;
    info?: Record<string, unknown>;
  }
  function pdfParse(buffer: Buffer, options?: Record<string, unknown>): Promise<PdfParseResult>;
  export = pdfParse;
}
