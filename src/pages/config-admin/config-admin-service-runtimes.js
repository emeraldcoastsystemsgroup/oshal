/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | CM-6: Extracted Presentron runtime config and added RAG + Google Search MCP service runtime sections
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Removed the retired Presentron and deprecated Google Search MCP runtime helpers; only the RAG runtime section remains
 */

import { createUiLogger, serializeUiError } from '../shared/ui-debug.js';
import { requestJson, readString, readRecord, setInlineStatus, toErrorMessage } from './config-admin-utils.js';

const logger = createUiLogger('config-admin-service-runtimes');

// ── RAG Runtime ─────────────────────────────────────────────────────────────

/**
 * @description Populate the RAG runtime form fields from loaded config.
 */
export function renderRagRuntimeForm(elements, ragConfig) {
  if (!elements.ragConfigEndpointInput) {
    return;
  }
  const config = readRecord(ragConfig);
  const chunking = readRecord(config.chunking);

  elements.ragConfigEndpointInput.value = readString(config.endpoint);
  elements.ragConfigDefaultCollectionInput.value = readString(config.defaultCollection) || 'default';
  elements.ragConfigEmbeddingProviderInput.value = readString(config.embeddingProviderId) || 'openai';
  elements.ragConfigEmbeddingModelInput.value = readString(config.embeddingModelId) || 'text-embedding-3-small';
  elements.ragConfigChunkStrategySelect.value = readString(chunking.strategy) || 'tiered';
  elements.ragConfigChunkSizeInput.value = chunking.chunkSize || 700;
  elements.ragConfigChunkOverlapInput.value = chunking.chunkOverlap || 100;

  const tierSizes = Array.isArray(chunking.tierSizes) ? chunking.tierSizes.join(',') : '1200,700,350';
  const tierOverlaps = Array.isArray(chunking.tierOverlaps) ? chunking.tierOverlaps.join(',') : '180,100,60';
  elements.ragConfigTierSizesInput.value = tierSizes;
  elements.ragConfigTierOverlapsInput.value = tierOverlaps;

  updateRagTierVisibility(elements);

  setInlineStatus(
    elements.ragRuntimeStatus,
    config.endpoint
      ? 'RAG engine is configured. Test the connection to confirm the vector store is reachable.'
      : 'RAG engine is not configured yet. Set the endpoint to enable vector-based knowledge retrieval.',
    config.endpoint ? 'info' : 'error',
  );
}

/**
 * @description Show/hide the tier-specific fields based on the selected chunking strategy.
 */
export function updateRagTierVisibility(elements) {
  const strategy = elements.ragConfigChunkStrategySelect?.value || 'tiered';
  const isTiered = strategy === 'tiered';
  if (elements.ragTierFieldsWrap) {
    elements.ragTierFieldsWrap.style.display = isTiered ? '' : 'none';
  }
  if (elements.ragTierOverlapsWrap) {
    elements.ragTierOverlapsWrap.style.display = isTiered ? '' : 'none';
  }
}

/**
 * @description Save the RAG runtime config to the backend.
 */
export async function saveRagRuntimeConfig(elements, state, setStatus) {
  const payload = buildRagRuntimePayload(elements);
  setStatus('Saving shared RAG runtime config...', 'info');
  setInlineStatus(elements.ragRuntimeStatus, 'Saving shared RAG runtime config...', 'info');
  try {
    await requestJson('/api/config/rag', {
      method: 'POST',
      body: JSON.stringify({ config: payload }),
    });
    state.ragConfig = payload;
    renderRagRuntimeForm(elements, state.ragConfig);
    setInlineStatus(elements.ragRuntimeStatus, 'Shared RAG runtime saved. Re-run the health check to verify the vector store is reachable.', 'success');
    setStatus('Shared RAG runtime saved.', 'success');
    logger.info('RAG runtime config saved', { endpoint: payload.endpoint });
  } catch (error) {
    const message = `Failed to save RAG runtime: ${toErrorMessage(error)}`;
    setInlineStatus(elements.ragRuntimeStatus, message, 'error');
    setStatus(message, 'error');
    logger.error('RAG runtime config save failed', { error: serializeUiError(error) });
  }
}

/**
 * @description Test the RAG engine connection using the persisted config endpoint.
 */
export async function testRagRuntimeConnection(elements, setStatus) {
  setStatus('Testing RAG engine connection...', 'info');
  setInlineStatus(elements.ragRuntimeStatus, 'Testing RAG engine connection using persisted shared runtime settings...', 'info');
  try {
    const payload = await requestJson('/api/rag/health');
    const ok = payload?.success === true || payload?.status === 'ok' || payload?.chromadb === 'connected';
    const tone = ok ? 'success' : 'error';
    setInlineStatus(
      elements.ragRuntimeStatus,
      ok
        ? 'RAG engine responded successfully. Vector store is reachable from this runtime.'
        : 'RAG engine is unavailable from this runtime. Verify the endpoint and try again.',
      tone,
    );
    setStatus(`RAG engine health is ${ok ? 'connected' : 'unavailable'}.`, tone);
    logger.info('RAG runtime health check completed', { ok });
  } catch (error) {
    const message = `RAG health check failed: ${toErrorMessage(error)}`;
    setInlineStatus(elements.ragRuntimeStatus, message, 'error');
    setStatus(message, 'error');
    logger.error('RAG runtime health check failed', { error: serializeUiError(error) });
  }
}

/**
 * @description Build the RAG runtime payload from form elements.
 */
function buildRagRuntimePayload(elements) {
  const strategy = readString(elements.ragConfigChunkStrategySelect?.value) || 'tiered';
  const payload = {
    endpoint: readString(elements.ragConfigEndpointInput?.value),
    defaultCollection: readString(elements.ragConfigDefaultCollectionInput?.value) || 'default',
    embeddingProviderId: readString(elements.ragConfigEmbeddingProviderInput?.value) || 'openai',
    embeddingModelId: readString(elements.ragConfigEmbeddingModelInput?.value) || 'text-embedding-3-small',
    chunking: {
      strategy,
      chunkSize: parseInt(elements.ragConfigChunkSizeInput?.value, 10) || 700,
      chunkOverlap: parseInt(elements.ragConfigChunkOverlapInput?.value, 10) || 100,
    },
  };

  if (strategy === 'tiered') {
    const tierSizesRaw = readString(elements.ragConfigTierSizesInput?.value);
    const tierOverlapsRaw = readString(elements.ragConfigTierOverlapsInput?.value);
    payload.chunking.tierSizes = tierSizesRaw
      ? tierSizesRaw.split(',').map((s) => parseInt(s.trim(), 10)).filter(Number.isFinite)
      : [1200, 700, 350];
    payload.chunking.tierOverlaps = tierOverlapsRaw
      ? tierOverlapsRaw.split(',').map((s) => parseInt(s.trim(), 10)).filter(Number.isFinite)
      : [180, 100, 60];
  }

  return payload;
}
