/**
 * Response Renderer — barrel (shared/ui).
 *
 * The bot-narrative → typed-block segmenter (the first step of the "Shared Response Renderer" north
 * star). Import: `import { parseResponse, hasRichBlocks, ResponseBlock } from '@/shared/ui/response-renderer'`.
 * Complements shared/ui/message-renderer (which renders prose markdown to HTML) — a surface renders
 * a `markdown` block with that, and `code`/`mermaid`/`oshal` blocks with dedicated components.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial barrel for the response-renderer segmenter.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Export the DOM-free portable component registry foundation.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Export the concrete component set (markdown/code/mermaid/oshal:chart/oshal:table), the standard registry, and the renderResponseHtml pipeline. This barrel is also the vite `response-renderer` browser-bundle entry (served at /dist/response-renderer.js).
 *
 * @module shared/ui/response-renderer
 */

export * from './types';
export { parseResponse, hasRichBlocks } from './parse-response';
export {
  ResponseComponentRegistry,
  createResponseComponentRegistry,
  normalizeResponseRendererKey,
  responseRendererKeyForBlock,
} from './component-registry';
export * from './components';
