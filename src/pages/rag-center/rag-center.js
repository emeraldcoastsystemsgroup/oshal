/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added native RAG Center browser logic for live knowledge inventory, collection rollup, and retrieval query testing
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Elevated RAG Center into a vector-ops console with runtime health, embedding catalog, and document triage controls
 */

class RagCenterApp {
  constructor() {
    this.state = createInitialState();
    this.elements = {
      collectionList: document.getElementById('collectionList'),
      collectionSelect: document.getElementById('collectionSelect'),
      documentCollectionFilter: document.getElementById('documentCollectionFilter'),
      documentDetail: document.getElementById('documentDetail'),
      documentSearchInput: document.getElementById('documentSearchInput'),
      documentTableBody: document.getElementById('documentTableBody'),
      metricChunks: document.getElementById('metricChunks'),
      metricCollections: document.getElementById('metricCollections'),
      metricDocuments: document.getElementById('metricDocuments'),
      metricScopeMix: document.getElementById('metricScopeMix'),
      queryForm: document.getElementById('queryForm'),
      queryInput: document.getElementById('queryInput'),
      refreshButton: document.getElementById('refreshButton'),
      resultList: document.getElementById('resultList'),
      resultDetail: document.getElementById('resultDetail'),
      runQueryButton: document.getElementById('runQueryButton'),
      signalGrid: document.getElementById('signalGrid'),
      scopeFilter: document.getElementById('scopeFilter'),
      statusBanner: document.getElementById('statusBanner'),
    };
  }

  async init() {
    this.bindEvents();
    await this.refresh();
  }

  bindEvents() {
    this.elements.refreshButton.addEventListener('click', async () => {
      await this.refresh();
    });

    this.elements.queryForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      await this.runQuery();
    });

    this.elements.scopeFilter.addEventListener('change', () => {
      this.renderFocusedViews();
    });

    this.elements.documentCollectionFilter.addEventListener('change', () => {
      this.renderFocusedViews();
    });

    this.elements.documentSearchInput.addEventListener('input', () => {
      this.renderFocusedViews();
    });

    this.elements.collectionList.addEventListener('click', (event) => {
      this.handleCollectionClick(event);
    });

    this.elements.documentTableBody.addEventListener('click', (event) => {
      this.handleDocumentClick(event);
    });

    this.elements.resultList.addEventListener('click', (event) => {
      this.handleResultClick(event);
    });

    this.elements.resultDetail.addEventListener('click', (event) => {
      this.handleDetailAction(event);
    });

    this.elements.documentDetail.addEventListener('click', (event) => {
      this.handleDetailAction(event);
    });
  }

  async refresh() {
    this.setStatus('Loading RAG Center...', 'info');
    setBusyState(this.elements.refreshButton, true);
    writeClientLog('info', 'rag-center-refresh-start');

    const results = await Promise.allSettled([
      requestJson('/api/memory/knowledge/summary?surface=1'),
      requestJson('/api/memory/knowledge?limit=500&surface=1'),
      requestJson('/api/rag/collections'),
      requestJson('/api/agents'),
      requestJson('/api/rag/health'),
      requestJson('/api/rag/embedding-models'),
    ]);

    logRejectedResults(['summary', 'documents', 'collections', 'agents', 'health', 'embedding-models'], results);
    this.state = buildAppState(results, this.state);
    this.render();
    this.setStatus(buildRefreshMessage(this.state), this.state.failedCount > 0 ? 'warning' : 'success');
    setBusyState(this.elements.refreshButton, false);
    writeClientLog('info', 'rag-center-refresh-complete', {
      collections: getAllCollectionNames(this.state).length,
      documents: this.state.documents.length,
      failedCount: this.state.failedCount,
    });
  }

  async runQuery() {
    const query = this.elements.queryInput.value.trim();
    const collection = this.elements.collectionSelect.value.trim();

    if (!query) {
      this.setStatus('Enter a query before running retrieval.', 'error');
      this.elements.resultList.innerHTML = renderEmptyState('Enter a query to inspect retrieval hits.');
      return;
    }

    this.setStatus(`Running query${collection ? ` against ${collection}` : ' across all collections'}...`, 'info');
    setBusyState(this.elements.runQueryButton, true);
    writeClientLog('info', 'rag-center-query-start', { collection: collection || 'all', query });

    try {
      const url = buildQueryUrl(query, collection);
      const payload = await requestJson(url);
      this.state.queryResults = normalizeSearchResults(payload);
      this.state.selectedResultKey = pickResultKey(this.state.queryResults, this.state.selectedResultKey);
      this.renderQueryViews();
      this.setStatus(buildQueryMessage(this.state.queryResults, collection), 'success');
      writeClientLog('info', 'rag-center-query-complete', {
        collection: collection || 'all',
        hits: this.state.queryResults.length,
      });
    } catch (error) {
      this.state.queryResults = [];
      this.state.selectedResultKey = '';
      this.renderQueryViews();
      this.setStatus('RAG query failed. Review browser logs and API availability.', 'error');
      writeClientLog('error', 'rag-center-query-failed', {
        collection: collection || 'all',
        error: readErrorMessage(error),
      });
    } finally {
      setBusyState(this.elements.runQueryButton, false);
    }
  }

  render() {
    renderMetrics(this.state, this.elements);
    renderSignals(this.state, this.elements);
    syncCollectionSelectors(this.state, this.elements);
    this.renderFocusedViews();
    this.renderQueryViews();
  }

  renderFocusedViews() {
    this.renderCollections();
    this.renderDocumentTable();
    this.renderDocumentDetail();
  }

  renderQueryViews() {
    this.renderResults();
    this.renderResultDetail();
  }

  renderCollections() {
    const cards = buildCollectionCards(this.state);
    if (!cards.length) {
      this.elements.collectionList.innerHTML = renderEmptyState(
        'No vector collections or tracked knowledge documents are available yet.',
      );
      return;
    }

    const activeCollection = this.readCollectionFocus();
    this.elements.collectionList.innerHTML = cards.map((card) => {
      return renderCollectionCard(card, card.name === activeCollection);
    }).join('');
  }

  renderDocumentTable() {
    const rows = this.readFilteredDocuments();
    this.state.selectedDocumentKey = pickDocumentKey(rows, this.state.selectedDocumentKey);

    this.elements.documentTableBody.innerHTML = rows.length
      ? rows.map((document) => renderDocumentRow(document, this.state.agentsById, document.documentKey === this.state.selectedDocumentKey)).join('')
      : renderEmptyTableRow('No uploaded documents match the current filters.');
  }

  renderResults() {
    this.state.selectedResultKey = pickResultKey(this.state.queryResults, this.state.selectedResultKey);
    if (!this.state.queryResults.length) {
      this.elements.resultList.innerHTML = renderEmptyState(
        'Run a query to inspect retrieval hits, score order, and source previews.',
      );
      return;
    }

    this.elements.resultList.innerHTML = this.state.queryResults.map((result) => {
      return renderResultCard(result, result.resultKey === this.state.selectedResultKey, countDocumentsInCollection(this.state.documents, result.collection));
    }).join('');
  }

  renderDocumentDetail() {
    const document = findDocumentByKey(this.readFilteredDocuments(), this.state.selectedDocumentKey);
    this.elements.documentDetail.innerHTML = document
      ? renderDocumentDetail(document, this.state.agentsById)
      : renderEmptyState('Select a knowledge document to inspect ownership, source metadata, and ingestion detail.');
  }

  renderResultDetail() {
    const result = findResultByKey(this.state.queryResults, this.state.selectedResultKey);
    this.elements.resultDetail.innerHTML = result
      ? renderResultDetail(result, this.state.queryResults, countDocumentsInCollection(this.state.documents, result.collection))
      : renderEmptyState('Pick a query hit to inspect the source text, collection linkage, and retrieval metadata.');
  }

  setStatus(message, tone) {
    this.elements.statusBanner.textContent = message;
    this.elements.statusBanner.dataset.tone = tone;
  }

  handleCollectionClick(event) {
    const card = event.target.closest('[data-collection]');
    if (!(card instanceof HTMLElement)) {
      return;
    }

    const collection = readString(card.dataset.collection);
    const nextValue = this.readCollectionFocus() === collection ? '' : collection;
    this.elements.documentCollectionFilter.value = nextValue;
    this.elements.collectionSelect.value = nextValue;
    this.renderFocusedViews();
    this.setStatus(nextValue ? `Focused collection ${nextValue}.` : 'Collection focus cleared.', 'info');
  }

  handleDocumentClick(event) {
    const row = event.target.closest('[data-document-key]');
    if (!(row instanceof HTMLElement)) {
      return;
    }

    this.state.selectedDocumentKey = readString(row.dataset.documentKey);
    this.renderDocumentTable();
    this.renderDocumentDetail();
  }

  handleResultClick(event) {
    const card = event.target.closest('[data-result-key]');
    if (!(card instanceof HTMLElement)) {
      return;
    }

    this.state.selectedResultKey = readString(card.dataset.resultKey);
    this.renderResults();
    this.renderResultDetail();
  }

  handleDetailAction(event) {
    const button = event.target.closest('[data-collection-focus]');
    if (!(button instanceof HTMLButtonElement)) {
      return;
    }

    const collection = readString(button.dataset.collectionFocus);
    this.elements.documentCollectionFilter.value = collection;
    this.elements.collectionSelect.value = collection;
    this.renderFocusedViews();
    this.setStatus(`Focused collection ${collection}.`, 'info');
  }

  readFilteredDocuments() {
    return filterDocuments(this.state, {
      collection: this.readCollectionFocus(),
      search: this.elements.documentSearchInput.value,
      scope: this.elements.scopeFilter.value,
    });
  }

  readCollectionFocus() {
    return readString(this.elements.documentCollectionFilter.value);
  }
}

function createInitialState() {
  return {
    agentsById: {},
    collections: [],
    documents: [],
    embeddingCatalog: { providers: [] },
    failedCount: 0,
    health: { chromadb: 'unknown' },
    queryResults: [],
    selectedDocumentKey: '',
    selectedResultKey: '',
    summary: createEmptySummary(),
  };
}

function createEmptySummary() {
  return {
    collections: [],
    totals: {
      chunks: 0,
      collections: 0,
      documents: 0,
      sharedDocuments: 0,
      targetedDocuments: 0,
    },
  };
}

function buildAppState(results, previousState) {
  const documents = settledValue(results[1], previousState.documents, normalizeDocuments);
  const summary = settledValue(results[0], buildSummaryFallback(documents), normalizeSummary);

  return {
    agentsById: settledValue(results[3], previousState.agentsById, normalizeAgents),
    collections: settledValue(results[2], previousState.collections, normalizeCollections),
    documents,
    embeddingCatalog: settledValue(results[5], previousState.embeddingCatalog, normalizeEmbeddingCatalog),
    failedCount: countRejected(results),
    health: settledValue(results[4], previousState.health, normalizeHealth),
    queryResults: previousState.queryResults,
    selectedDocumentKey: pickDocumentKey(documents, previousState.selectedDocumentKey),
    selectedResultKey: previousState.selectedResultKey,
    summary,
  };
}

function settledValue(result, fallback, normalizer) {
  if (!result || result.status !== 'fulfilled') {
    return fallback;
  }

  return normalizer(result.value);
}

function countRejected(results) {
  return results.filter((result) => result.status === 'rejected').length;
}

function logRejectedResults(labels, results) {
  results.forEach((result, index) => {
    if (result?.status !== 'rejected') {
      return;
    }

    writeClientLog('error', 'rag-center-refresh-source-failed', {
      error: readErrorMessage(result.reason),
      source: labels[index] || `source-${index}`,
    });
  });
}

function normalizeSummary(payload) {
  const totals = asRecord(payload?.totals);
  const collections = asArray(payload?.collections).map((entry) => ({
    chunks: numberValue(entry?.chunks),
    collection: readString(entry?.collection) || 'unknown',
    documents: numberValue(entry?.documents),
    latest: readString(entry?.latest),
  }));

  return {
    collections: collections.sort((left, right) => right.latest.localeCompare(left.latest)),
    totals: {
      chunks: numberValue(totals.chunks),
      collections: numberValue(totals.collections),
      documents: numberValue(totals.documents),
      sharedDocuments: numberValue(totals.sharedDocuments),
      targetedDocuments: numberValue(totals.targetedDocuments),
    },
  };
}

function normalizeDocuments(payload) {
  const documents = asArray(payload?.documents);
  return documents
    .map((entry) => ({
      agentId: readString(entry?.agentId),
      chunkCount: numberValue(entry?.chunkCount),
      collection: readString(entry?.collection) || 'unknown',
      createdAt: readString(entry?.createdAt),
      documentCount: numberValue(entry?.documentCount),
      documentKey: buildDocumentKey(entry),
      embeddingModelId: readString(entry?.embeddingModelId),
      embeddingProviderId: readString(entry?.embeddingProviderId),
      format: readString(entry?.format),
      knowledgeId: readString(entry?.knowledgeId),
      metadata: asRecord(entry?.metadata),
      source: readString(entry?.source) || 'unknown',
      taskId: readString(entry?.taskId),
      title: readString(entry?.title) || 'Untitled knowledge item',
      updatedAt: readString(entry?.updatedAt),
    }))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

function normalizeCollections(payload) {
  return asArray(payload?.collections)
    .map((entry) => readString(entry))
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right));
}

function normalizeHealth(payload) {
  return {
    chromadb: readString(payload?.chromadb) || 'unknown',
  };
}

function normalizeEmbeddingCatalog(payload) {
  return {
    providers: asArray(payload?.providers).map((provider) => ({
      models: asArray(provider?.models),
      providerId: readString(provider?.providerId),
      providerName: readString(provider?.providerName) || readString(provider?.providerId) || 'Unknown',
    })),
  };
}

function normalizeAgents(payload) {
  const agents = asArray(payload?.agents);
  return agents.reduce((accumulator, agent) => {
    const agentId = readString(agent?.agentId || agent?.agent_id);
    if (!agentId) {
      return accumulator;
    }

    accumulator[agentId] = readString(agent?.name) || agentId;
    return accumulator;
  }, {});
}

function normalizeSearchResults(payload) {
  return asArray(payload?.results).map((entry, index) => ({
    collection: readString(entry?.collection) || 'unknown',
    id: readString(entry?.id),
    metadata: asRecord(entry?.metadata),
    resultKey: buildResultKey(entry, index),
    score: numberValue(entry?.score),
    text: readString(entry?.text),
  }));
}

function buildSummaryFallback(documents) {
  const collectionMap = new Map();
  let chunks = 0;
  let sharedDocuments = 0;
  let targetedDocuments = 0;

  for (const document of documents) {
    chunks += document.chunkCount;
    if (hasAgentScope(document)) {
      targetedDocuments += 1;
    } else {
      sharedDocuments += 1;
    }

    const existing = collectionMap.get(document.collection);
    if (!existing) {
      collectionMap.set(document.collection, {
        chunks: document.chunkCount,
        collection: document.collection,
        documents: 1,
        latest: document.createdAt,
      });
      continue;
    }

    existing.documents += 1;
    existing.chunks += document.chunkCount;
    if (document.createdAt > existing.latest) {
      existing.latest = document.createdAt;
    }
  }

  return {
    collections: [...collectionMap.values()].sort((left, right) => right.latest.localeCompare(left.latest)),
    totals: {
      chunks,
      collections: collectionMap.size,
      documents: documents.length,
      sharedDocuments,
      targetedDocuments,
    },
  };
}

function renderMetrics(state, elements) {
  setText(elements.metricDocuments, formatNumber(state.summary.totals.documents));
  setText(elements.metricCollections, formatNumber(getAllCollectionNames(state).length));
  setText(elements.metricChunks, formatNumber(state.summary.totals.chunks));
  setText(
    elements.metricScopeMix,
    `${formatNumber(state.summary.totals.sharedDocuments)} / ${formatNumber(state.summary.totals.targetedDocuments)}`,
  );
}

function renderSignals(state, elements) {
  const latestDocument = state.documents[0] || null;
  const targetedAgents = new Set(state.documents.filter((document) => hasAgentScope(document)).map((document) => document.agentId));
  const vectorOnlyCount = countVectorOnlyCollections(state);
  const trackedLiveCollections = countTrackedLiveCollections(state);
  const missingEmbeddingCount = countDocumentsMissingEmbeddings(state.documents);
  const chromaState = state.health.chromadb || 'unknown';
  const providerCount = state.embeddingCatalog.providers.length;

  elements.signalGrid.innerHTML = [
    renderSignalCard('Vector Runtime', chromaState, chromaState === 'connected' ? 'Chroma is reachable from the current OSHAL runtime.' : 'Vector runtime is degraded or unreachable.', readHealthTone(chromaState)),
    renderSignalCard('Embedding Catalog', `${formatNumber(providerCount)} / ${formatNumber(countCatalogModels(state.embeddingCatalog))}`, providerCount ? 'Providers / models available for ingest targeting.' : 'Embedding catalog is unavailable from the current runtime.', providerCount ? 'success' : 'warning'),
    renderSignalCard('Latest Ingest', latestDocument ? formatDateTime(latestDocument.createdAt) : 'No data yet', latestDocument ? latestDocument.title : 'No tracked knowledge document has been recorded yet.'),
    renderSignalCard('Tracked + Live Overlap', formatNumber(trackedLiveCollections), trackedLiveCollections ? 'Collections exist in both tracked metadata and the live vector store.' : 'No overlap between tracked knowledge and live vectors yet.'),
    renderSignalCard('Bot Coverage', formatNumber(targetedAgents.size), targetedAgents.size ? 'Bots currently have targeted knowledge collections.' : 'No bot-specific knowledge documents are recorded yet.'),
    renderSignalCard('Metadata Gaps', `${formatNumber(vectorOnlyCount)} / ${formatNumber(missingEmbeddingCount)}`, 'Vector-only collections / documents using runtime-default embedding metadata.', vectorOnlyCount || missingEmbeddingCount ? 'warning' : 'success'),
  ].join('');
}

function syncCollectionSelectors(state, elements) {
  const collections = getAllCollectionNames(state);
  updateSelectOptions(elements.collectionSelect, collections, 'All collections');
  updateSelectOptions(elements.documentCollectionFilter, collections, 'All collections');
}

function updateSelectOptions(select, values, allLabel) {
  const previousValue = select.value;
  const options = [`<option value="">${escapeHtml(allLabel)}</option>`];

  for (const value of values) {
    const selected = value === previousValue ? ' selected' : '';
    options.push(`<option value="${escapeAttribute(value)}"${selected}>${escapeHtml(value)}</option>`);
  }

  select.innerHTML = options.join('');
  if (!values.includes(previousValue)) {
    select.value = '';
  }
}

function getAllCollectionNames(state) {
  const names = new Set(state.collections);
  for (const document of state.documents) {
    names.add(document.collection);
  }
  for (const collection of state.summary.collections) {
    names.add(collection.collection);
  }

  return [...names].filter(Boolean).sort((left, right) => left.localeCompare(right));
}

function buildCollectionCards(state) {
  const summaryByCollection = state.summary.collections.reduce((accumulator, collection) => {
    accumulator[collection.collection] = collection;
    return accumulator;
  }, {});

  return getAllCollectionNames(state).map((name) => {
    const summary = summaryByCollection[name];
    return {
      chunks: summary?.chunks || 0,
      documents: summary?.documents || 0,
      isVectorCollection: state.collections.includes(name),
      latest: summary?.latest || '',
      name,
      sharedDocuments: countScopedDocuments(state.documents, name, 'shared'),
      targetedDocuments: countScopedDocuments(state.documents, name, 'targeted'),
    };
  });
}

function filterDocuments(state, filters) {
  return state.documents.filter((document) => {
    return matchesScope(document, filters.scope)
      && matchesCollection(document, filters.collection)
      && matchesDocumentSearch(document, filters.search);
  });
}

function matchesScope(document, scope) {
  if (scope === 'shared') {
    return !hasAgentScope(document);
  }
  if (scope === 'targeted') {
    return hasAgentScope(document);
  }
  return true;
}

function matchesCollection(document, collection) {
  return !collection || collection === 'all' ? true : document.collection === collection;
}

function hasAgentScope(document) {
  return Boolean(readString(document.agentId));
}

function renderCollectionCard(card, isActive) {
  const latest = card.latest ? formatDateTime(card.latest) : 'No tracked ingest timestamp yet';
  const vectorState = card.isVectorCollection ? 'Live vector collection' : 'Tracked metadata only';

  return `
    <article class="collection-card" data-collection="${escapeAttribute(card.name)}" data-active="${isActive ? 'true' : 'false'}">
      <strong>${escapeHtml(card.name)}</strong>
      <div class="collection-meta">
        <span class="chip">${escapeHtml(`${formatNumber(card.documents)} docs`)}</span>
        <span class="chip">${escapeHtml(`${formatNumber(card.chunks)} chunks`)}</span>
        <span class="chip">${escapeHtml(vectorState)}</span>
      </div>
      <div class="collection-meta">
        <span class="chip scope-shared">${escapeHtml(`${formatNumber(card.sharedDocuments)} shared`)}</span>
        <span class="chip scope-targeted">${escapeHtml(`${formatNumber(card.targetedDocuments)} targeted`)}</span>
      </div>
      <div class="muted">Last ingest: ${escapeHtml(latest)}</div>
    </article>
  `;
}

function renderDocumentRow(document, agentsById, isActive) {
  const scopeLabel = hasAgentScope(document)
    ? `Bot: ${agentsById[document.agentId] || document.agentId}`
    : 'General swarm knowledge';

  return `
    <tr class="document-row" data-document-key="${escapeAttribute(document.documentKey)}" data-active="${isActive ? 'true' : 'false'}">
      <td><strong>${escapeHtml(document.title)}</strong><div class="muted mono">${escapeHtml(document.knowledgeId || 'metadata-only')}</div></td>
      <td><span class="chip ${hasAgentScope(document) ? 'scope-targeted' : 'scope-shared'}">${escapeHtml(scopeLabel)}</span></td>
      <td>${escapeHtml(document.collection)}</td>
      <td>${escapeHtml(formatNumber(document.chunkCount))}</td>
      <td>${escapeHtml(buildSourceLabel(document))}</td>
      <td>${escapeHtml(formatDateTime(document.createdAt))}</td>
    </tr>
  `;
}

function buildSourceLabel(document) {
  return [document.source, document.format].filter(Boolean).join(' • ') || 'unknown';
}

function renderResultCard(result, isActive, trackedDocuments) {
  const metadataSummary = summarizeMetadata(result.metadata);
  return `
    <article class="result-card" data-result-key="${escapeAttribute(result.resultKey)}" data-active="${isActive ? 'true' : 'false'}">
      <strong>${escapeHtml(result.collection)}</strong>
      <div class="result-meta">
        <span class="chip">Score ${escapeHtml(result.score.toFixed(3))}</span>
        <span class="chip">${escapeHtml(`${formatNumber(trackedDocuments)} tracked docs`)}</span>
        ${metadataSummary ? `<span class="chip">${escapeHtml(metadataSummary)}</span>` : ''}
      </div>
      <div>${escapeHtml(trimPreview(result.text))}</div>
    </article>
  `;
}

function renderDocumentDetail(document, agentsById) {
  const metadataSummary = summarizeDocumentMetadata(document.metadata);
  const scopeLabel = hasAgentScope(document)
    ? `Bot: ${agentsById[document.agentId] || document.agentId}`
    : 'General swarm knowledge';

  return `
    <strong>${escapeHtml(document.title)}</strong>
    <p>${escapeHtml(scopeLabel)} in ${escapeHtml(document.collection)}.</p>
    <div class="detail-meta">
      ${renderDetailMetaRow('Collection', document.collection)}
      ${renderDetailMetaRow('Chunks', formatNumber(document.chunkCount))}
      ${renderDetailMetaRow('Documents', formatNumber(document.documentCount))}
      ${renderDetailMetaRow('Source', buildSourceLabel(document))}
      ${renderDetailMetaRow('Embedding', buildEmbeddingLabel(document))}
      ${renderDetailMetaRow('Metadata Keys', formatNumber(Object.keys(document.metadata).length))}
      ${renderDetailMetaRow('Task Link', document.taskId || 'No task linked')}
      ${renderDetailMetaRow('Created', formatDateTime(document.createdAt))}
      ${renderDetailMetaRow('Updated', formatDateTime(document.updatedAt))}
    </div>
    <div class="detail-actions">
      <button type="button" data-collection-focus="${escapeAttribute(document.collection)}">Focus This Collection</button>
    </div>
    <div class="detail-preview">${escapeHtml(metadataSummary)}</div>
  `;
}

function renderResultDetail(result, queryResults, trackedDocuments) {
  const metadataSummary = summarizeDocumentMetadata(result.metadata);
  const rank = queryResults.findIndex((entry) => entry.resultKey === result.resultKey) + 1;
  const collectionHitCount = queryResults.filter((entry) => entry.collection === result.collection).length;
  return `
    <strong>${escapeHtml(result.collection)}</strong>
    <p>Live retrieval preview from the current vector store.</p>
    <div class="detail-meta">
      ${renderDetailMetaRow('Rank', `#${rank || 1}`)}
      ${renderDetailMetaRow('Score', result.score.toFixed(3))}
      ${renderDetailMetaRow('Confidence', describeScore(result.score))}
      ${renderDetailMetaRow('Collection Hits', formatNumber(collectionHitCount))}
      ${renderDetailMetaRow('Tracked Docs In Collection', formatNumber(trackedDocuments))}
      ${renderDetailMetaRow('Source Tags', summarizeMetadata(result.metadata) || 'No metadata tags')}
      ${renderDetailMetaRow('Chunk Id', result.id || 'Unknown')}
    </div>
    <div class="detail-actions">
      <button type="button" data-collection-focus="${escapeAttribute(result.collection)}">Focus This Collection</button>
    </div>
    <div class="detail-preview">${escapeHtml(result.text || 'No preview text returned.')}</div>
    <div class="muted" style="margin-top:12px">${escapeHtml(metadataSummary)}</div>
  `;
}

function renderDetailMetaRow(label, value) {
  return `<div class="detail-meta-row"><span>${escapeHtml(label)}</span><span>${escapeHtml(value)}</span></div>`;
}

function renderSignalCard(label, value, hint, tone = 'default') {
  return `
    <article class="signal-card" data-tone="${escapeAttribute(tone)}">
      <div class="metric-label">${escapeHtml(label)}</div>
      <strong>${escapeHtml(value)}</strong>
      <span>${escapeHtml(hint)}</span>
    </article>
  `;
}

function summarizeMetadata(metadata) {
  const pieces = [readString(metadata.source), readString(metadata.docIndex), readString(metadata.chunkIndex)]
    .filter(Boolean);
  return pieces.join(' • ');
}

function summarizeDocumentMetadata(metadata) {
  const fileNames = readStringList(metadata.fileNames);
  if (fileNames.length) {
    return `Files: ${fileNames.join(', ')}`;
  }

  const entries = Object.entries(metadata).slice(0, 6).map(([key, value]) => `${key}: ${stringifyMetadataValue(value)}`);
  return entries.length ? entries.join('\n') : 'No extra metadata recorded for this knowledge item.';
}

function renderEmptyState(message) {
  return `<div class="empty-state">${escapeHtml(message)}</div>`;
}

function renderEmptyTableRow(message) {
  return `<tr><td colspan="6" class="muted">${escapeHtml(message)}</td></tr>`;
}

function buildRefreshMessage(state) {
  const collectionCount = getAllCollectionNames(state).length;
  if (state.failedCount > 0) {
    return `RAG Center loaded with partial data. ${state.failedCount} source(s) failed while ${state.documents.length} documents and ${collectionCount} collections were still rendered.`;
  }

  return `RAG Center refreshed. ${state.documents.length} documents across ${collectionCount} collections are visible.`;
}

function buildQueryMessage(results, collection) {
  const targetLabel = collection || 'all collections';
  if (!results.length) {
    return `Query completed for ${targetLabel}. No retrieval hits were returned.`;
  }

  return `Query completed for ${targetLabel}. ${results.length} retrieval hit(s) returned.`;
}

function countDocumentsInCollection(documents, collection) {
  return documents.filter((document) => document.collection === collection).length;
}

function countScopedDocuments(documents, collection, scope) {
  return documents.filter((document) => {
    return document.collection === collection && matchesScope(document, scope);
  }).length;
}

function countVectorOnlyCollections(state) {
  return buildCollectionCards(state).filter((card) => card.isVectorCollection && card.documents === 0).length;
}

function countTrackedLiveCollections(state) {
  return buildCollectionCards(state).filter((card) => card.isVectorCollection && card.documents > 0).length;
}

function countDocumentsMissingEmbeddings(documents) {
  return documents.filter((document) => !document.embeddingProviderId || !document.embeddingModelId).length;
}

function countCatalogModels(catalog) {
  return catalog.providers.reduce((total, provider) => total + provider.models.length, 0);
}

function pickDocumentKey(documents, currentKey) {
  if (documents.some((document) => document.documentKey === currentKey)) {
    return currentKey;
  }
  return documents[0]?.documentKey || '';
}

function pickResultKey(results, currentKey) {
  if (results.some((result) => result.resultKey === currentKey)) {
    return currentKey;
  }
  return results[0]?.resultKey || '';
}

function findDocumentByKey(documents, documentKey) {
  return documents.find((document) => document.documentKey === documentKey) || null;
}

function findResultByKey(results, resultKey) {
  return results.find((result) => result.resultKey === resultKey) || null;
}

function buildQueryUrl(query, collection) {
  const params = new URLSearchParams({ q: query, topK: '5' });
  if (collection) {
    params.set('collection', collection);
  }
  return `/api/rag/search?${params.toString()}`;
}

function requestJson(url) {
  return fetch(url, { credentials: 'same-origin' }).then(async (response) => {
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Request failed (${response.status}) for ${url}: ${body}`);
    }
    return response.json();
  });
}

function setBusyState(button, isBusy) {
  button.disabled = isBusy;
  button.setAttribute('aria-busy', isBusy ? 'true' : 'false');
}

function writeClientLog(level, event, details = {}) {
  const payload = {
    event,
    level,
    surface: 'rag-center',
    timestamp: new Date().toISOString(),
    ...details,
  };
  const sink = typeof console[level] === 'function' ? console[level] : console.info;
  sink(JSON.stringify(payload));
}

function setText(element, value) {
  element.textContent = value;
}

function buildDocumentKey(document) {
  const knowledgeId = readString(document?.knowledgeId);
  if (knowledgeId) {
    return knowledgeId;
  }
  return [readString(document?.collection), readString(document?.title), readString(document?.createdAt)].join(':');
}

function buildResultKey(result, index) {
  return [readString(result?.collection), readString(result?.id), String(index)].join(':');
}

function buildEmbeddingLabel(document) {
  return [document.embeddingProviderId, document.embeddingModelId].filter(Boolean).join(' / ') || 'Runtime default';
}

function readHealthTone(chromaState) {
  if (chromaState === 'connected') {
    return 'success';
  }
  if (chromaState === 'unreachable') {
    return 'error';
  }
  return 'warning';
}

function describeScore(score) {
  if (score >= 0.85) {
    return 'Strong match';
  }
  if (score >= 0.6) {
    return 'Usable match';
  }
  return 'Weak match';
}

function trimPreview(value) {
  return value.length > 280 ? `${value.slice(0, 277)}...` : value;
}

function formatDateTime(value) {
  if (!value) {
    return 'Unknown';
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function formatNumber(value) {
  return new Intl.NumberFormat('en-US').format(numberValue(value));
}

function numberValue(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function readString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function readStringList(value) {
  return asArray(value).map((entry) => readString(entry)).filter(Boolean);
}

function matchesDocumentSearch(document, query) {
  const normalizedQuery = readString(query).toLowerCase();
  if (!normalizedQuery) {
    return true;
  }

  const fields = [
    document.title,
    document.collection,
    document.source,
    document.format,
    document.knowledgeId,
    document.taskId,
    JSON.stringify(document.metadata),
  ];
  return fields.some((field) => readString(field).toLowerCase().includes(normalizedQuery));
}

function stringifyMetadataValue(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => readString(entry) || String(entry)).filter(Boolean).join(', ') || '[]';
  }
  if (value && typeof value === 'object') {
    return JSON.stringify(value);
  }
  return readString(value) || String(value);
}

function readErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function escapeAttribute(value) {
  return escapeHtml(value);
}

const app = new RagCenterApp();
app.init().catch((error) => {
  writeClientLog('error', 'rag-center-init-failed', { error: readErrorMessage(error) });
});
