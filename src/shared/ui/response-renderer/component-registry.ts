/**
 * Response Renderer — DOM-free block/component registry.
 *
 * The registry performs bounded dispatch only. It never constructs DOM, interprets arbitrary
 * component names, or renders a fallback itself. Each input block receives one ordered result:
 * either a component value or a reason a caller must use its safe text/native fallback.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial exact-key registry with validation, capability filtering, ordered async isolation, and AbortSignal support.
 *
 * @module shared/ui/response-renderer/component-registry
 */

import type {
  RenderableResponseBlock,
  ResponseBlockComponent,
  ResponseBlockFallbackResult,
  ResponseBlockRenderResult,
  ResponseRendererCapabilities,
  ResponseRendererKey,
  ResponseRenderFallbackReason,
  ResponseRenderOptions,
} from './types';

const FIXED_KEYS = new Set<ResponseRendererKey>([
  'markdown',
  'code',
  'mermaid',
  'artifact:image',
]);

// Component names become registry/capability identifiers. Keep them deliberately boring and
// bounded: no wildcard, path, whitespace, or punctuation semantics are accepted.
const OSHAL_KIND = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

type StoredComponent<TContext, TOutput> = ResponseBlockComponent<
  RenderableResponseBlock,
  TContext,
  TOutput
>;

/**
 * Normalize one registry/capability key. Only the four fixed keys and one exact `oshal:<kind>`
 * form are valid. Returning null is fail-closed; callers must not guess a component.
 */
export function normalizeResponseRendererKey(value: string): ResponseRendererKey | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (FIXED_KEYS.has(normalized as ResponseRendererKey)) return normalized as ResponseRendererKey;
  if (!normalized.startsWith('oshal:')) return null;
  const kind = normalized.slice('oshal:'.length);
  return OSHAL_KIND.test(kind) ? `oshal:${kind}` : null;
}

/** Resolve a block to its one exact registry key, or null for an invalid runtime shape. */
export function responseRendererKeyForBlock(
  block: RenderableResponseBlock,
): ResponseRendererKey | null {
  if (!block || typeof block !== 'object') return null;
  if (block.type === 'markdown') return typeof block.text === 'string' ? 'markdown' : null;
  if (block.type === 'code') {
    return typeof block.lang === 'string' && typeof block.code === 'string' ? 'code' : null;
  }
  if (block.type === 'mermaid') return typeof block.code === 'string' ? 'mermaid' : null;
  if (block.type === 'artifact') {
    const artifact = block.artifact;
    return block.kind === 'image'
      && artifact?.type === 'image'
      && typeof artifact.url === 'string'
      && typeof artifact.alt === 'string'
      ? 'artifact:image'
      : null;
  }
  if (block.type === 'oshal') {
    if (typeof block.raw !== 'string') return null;
    return normalizeResponseRendererKey(`oshal:${String(block.kind || '')}`);
  }
  return null;
}

/**
 * An exact-key portable registry. Component outputs/context remain generic, allowing a browser
 * adapter to return Nodes while a native or TV adapter returns its own view model.
 */
export class ResponseComponentRegistry<TContext, TOutput> {
  private readonly components = new Map<ResponseRendererKey, StoredComponent<TContext, TOutput>>();

  /** Register one component. Invalid/wildcard keys and normalized duplicates are programmer errors. */
  register<TBlock extends RenderableResponseBlock>(
    key: string,
    component: ResponseBlockComponent<TBlock, TContext, TOutput>,
  ): this {
    const normalized = normalizeResponseRendererKey(key);
    if (!normalized) throw new Error(`Invalid response renderer key: ${key}`);
    if (this.components.has(normalized)) {
      throw new Error(`Response renderer already registered: ${normalized}`);
    }
    if (!component || typeof component.render !== 'function') {
      throw new Error(`Response renderer needs a render function: ${normalized}`);
    }
    this.components.set(normalized, component as unknown as StoredComponent<TContext, TOutput>);
    return this;
  }

  /** True only when the exact normalized key has a registered component. */
  has(key: string): boolean {
    const normalized = normalizeResponseRendererKey(key);
    return normalized ? this.components.has(normalized) : false;
  }

  /** Registered keys in deterministic insertion order. */
  keys(): ResponseRendererKey[] {
    return [...this.components.keys()];
  }

  /**
   * Render blocks sequentially so component execution and returned descriptors both follow source
   * order. A validation/render failure is isolated to its block; later blocks still execute.
   */
  async renderBlocks(
    blocks: ReadonlyArray<RenderableResponseBlock>,
    context: TContext,
    options: ResponseRenderOptions = {},
  ): Promise<Array<ResponseBlockRenderResult<TOutput>>> {
    const capabilities = normalizedCapabilities(options.capabilities);
    const results: Array<ResponseBlockRenderResult<TOutput>> = [];
    for (let index = 0; index < blocks.length; index += 1) {
      results.push(await this.renderBlock(blocks[index] as RenderableResponseBlock, index, context, {
        capabilities,
        signal: options.signal,
      }));
    }
    return results;
  }

  private async renderBlock(
    block: RenderableResponseBlock,
    index: number,
    context: TContext,
    options: { capabilities?: ReadonlySet<ResponseRendererKey>; signal?: AbortSignal },
  ): Promise<ResponseBlockRenderResult<TOutput>> {
    const key = responseRendererKeyForBlock(block);
    if (options.signal?.aborted) return fallback(index, key, block, 'aborted');
    if (!key) return fallback(index, null, block, 'invalid_block');

    const component = this.components.get(key);
    if (!component) return fallback(index, key, block, 'unregistered_component');
    if (options.capabilities && !options.capabilities.has(key)) {
      return fallback(index, key, block, 'unsupported_capability');
    }

    if (component.validate) {
      try {
        if (!component.validate(block)) return fallback(index, key, block, 'invalid_block');
      } catch (error) {
        return fallback(index, key, block, 'invalid_block', error);
      }
    }
    if (options.signal?.aborted) return fallback(index, key, block, 'aborted');

    try {
      const pending = component.render(block, context, { index, key, signal: options.signal });
      const value = await settleWithAbort(pending, options.signal);
      return { status: 'rendered', index, key, block, value };
    } catch (error) {
      return options.signal?.aborted
        ? fallback(index, key, block, 'aborted')
        : fallback(index, key, block, 'render_failed', error);
    }
  }
}

/** Convenience factory that preserves inference for a surface's context/output types. */
export function createResponseComponentRegistry<TContext, TOutput>(): ResponseComponentRegistry<
  TContext,
  TOutput
> {
  return new ResponseComponentRegistry<TContext, TOutput>();
}

function normalizedCapabilities(
  capabilities: ResponseRendererCapabilities | undefined,
): ReadonlySet<ResponseRendererKey> | undefined {
  if (!capabilities) return undefined;
  const normalized = new Set<ResponseRendererKey>();
  for (const candidate of capabilities) {
    const key = normalizeResponseRendererKey(candidate);
    if (key) normalized.add(key);
  }
  return normalized;
}

function fallback(
  index: number,
  key: ResponseRendererKey | null,
  block: RenderableResponseBlock,
  reason: ResponseRenderFallbackReason,
  error?: unknown,
): ResponseBlockFallbackResult {
  return {
    status: 'fallback', index, key, block, reason,
    ...(error === undefined ? {} : { error }),
  };
}

/** Resolve/reject promptly on abort while leaving a handler attached to the component promise. */
function settleWithAbort<T>(value: T | Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return Promise.resolve(value);
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error('Response render aborted'));

  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener('abort', onAbort);
      reject(signal.reason ?? new Error('Response render aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(value).then(
      (result) => {
        signal.removeEventListener('abort', onAbort);
        resolve(result);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}
