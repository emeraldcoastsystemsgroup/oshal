/**
 * Response Renderer — the block model for turning a bot's free-form reply into the right rich UI.
 *
 * BACKLOG "Shared Response Renderer (north star)": a bot describes a result in markdown; the surface
 * should bring forward whatever is relevant — a diagram, a code block with highlighting, a map, a
 * chart, a doc viewer — instead of every app hand-rolling that. The first step is SEGMENTATION:
 * split the reply into an ordered list of typed BLOCKS so a surface can render each with the right
 * component (prose via the existing message-renderer's markdown, `mermaid` via a diagram renderer,
 * `oshal:*` typed blocks via a map/chart/doc component). This is complementary to
 * `features/visual-response` (that renders a STRUCTURED fact-locked spec to server SVG; this segments
 * a NARRATIVE reply) and pairs with `features/surface-bridge` (a `set_content` op carries markdown a
 * surface then segments with this).
 *
 * Pure + DOM-free: the segmentation is unit-testable and reusable; the per-block DOM rendering is a
 * deliberately-later browser step.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — the ResponseBlock union (markdown / code / mermaid / oshal-typed) the parseResponse segmenter emits.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Add the DOM-free portable component-registry contracts, trusted image attachment block, capability filter, and ordered render/fallback results.
 *
 * @module shared/ui/response-renderer/types
 */

/** A run of ordinary markdown prose — rendered by the surface's existing markdown renderer. */
export interface MarkdownBlock { type: 'markdown'; text: string }

/** A fenced code block with its declared language (rendered with syntax highlighting). */
export interface CodeBlock { type: 'code'; lang: string; code: string }

/** A fenced ```mermaid block — rendered as a diagram. */
export interface MermaidBlock { type: 'mermaid'; code: string }

/**
 * A fenced OSHAL-typed block — ```oshal:<kind>\n<json>\n``` — the extensibility hook that lets the
 * bot emit a first-class component (map / chart / doc / download / …). `data` is the parsed JSON
 * body; `raw` preserves the original body for debugging / fallback rendering.
 */
export interface OshalBlock { type: 'oshal'; kind: string; data: unknown; raw: string }

/** One segment of a parsed bot reply. */
export type ResponseBlock = MarkdownBlock | CodeBlock | MermaidBlock | OshalBlock;

/** The non-prose block types a surface renders with a dedicated component. */
export type RichBlock = CodeBlock | MermaidBlock | OshalBlock;

/**
 * The minimal, surface-neutral image metadata accepted by the portable registry. A surface still
 * owns URL/provenance validation before it turns this metadata into DOM or native UI.
 */
export interface ResponseImageArtifact {
  type: 'image';
  url: string;
  alt: string;
  artifactId?: string;
  mimeType?: string;
  width?: number;
  height?: number;
  /** Domain-specific presentation kind (for example `weather` or `chart`). */
  kind?: string;
}

/** A trusted image attachment supplied alongside, rather than parsed from, narrative Markdown. */
export interface ImageArtifactBlock {
  type: 'artifact';
  kind: 'image';
  artifact: ResponseImageArtifact;
}

/** Every block the portable component registry can dispatch. */
export type RenderableResponseBlock = ResponseBlock | ImageArtifactBlock;

/** Fixed renderer keys plus one exact, normalized key for each allowlisted OSHAL component kind. */
export type ResponseRendererKey =
  | 'markdown'
  | 'code'
  | 'mermaid'
  | 'artifact:image'
  | `oshal:${string}`;

/** Surface capabilities are exact renderer keys; there is deliberately no wildcard capability. */
export type ResponseRendererCapabilities =
  | ReadonlyArray<ResponseRendererKey>
  | ReadonlySet<ResponseRendererKey>;

/** Why a block produced a safe fallback descriptor instead of invoking/returning a component. */
export type ResponseRenderFallbackReason =
  | 'aborted'
  | 'invalid_block'
  | 'unregistered_component'
  | 'unsupported_capability'
  | 'render_failed';

/** Fields retained for every block so callers can place output/fallbacks in source order. */
interface ResponseBlockRenderResultBase {
  index: number;
  key: ResponseRendererKey | null;
  block: RenderableResponseBlock;
}

/** One component completed successfully. */
export interface ResponseBlockRenderedResult<TOutput> extends ResponseBlockRenderResultBase {
  status: 'rendered';
  value: TOutput;
}

/** One component was not run or failed; a surface can render a safe text/native fallback from it. */
export interface ResponseBlockFallbackResult extends ResponseBlockRenderResultBase {
  status: 'fallback';
  reason: ResponseRenderFallbackReason;
  /** Preserved for diagnostics; surfaces should not expose raw error text without sanitizing it. */
  error?: unknown;
}

/** The ordered result for one registry-dispatched block. */
export type ResponseBlockRenderResult<TOutput> =
  | ResponseBlockRenderedResult<TOutput>
  | ResponseBlockFallbackResult;

/** Metadata supplied to a component without coupling the registry to a browser DOM. */
export interface ResponseBlockRenderMeta {
  index: number;
  key: ResponseRendererKey;
  signal?: AbortSignal;
}

/**
 * A registered component. A type-predicate function is assignable to `validate`, so callers can
 * use either a narrow type guard or an ordinary runtime validator. A false/throwing validator
 * produces an `invalid_block` fallback and the component is never executed.
 */
export interface ResponseBlockComponent<
  TBlock extends RenderableResponseBlock,
  TContext,
  TOutput,
> {
  validate?: (block: RenderableResponseBlock) => boolean;
  render(
    block: TBlock,
    context: TContext,
    meta: ResponseBlockRenderMeta,
  ): TOutput | Promise<TOutput>;
}

/** Per-render controls shared by DOM, native, TV, and other surface adapters. */
export interface ResponseRenderOptions {
  capabilities?: ResponseRendererCapabilities;
  signal?: AbortSignal;
}
