# RAG Center

Native OSHAL engineering surface mounted at `/rag-center/`.

## Purpose

This page gives operators a real-data view of the current knowledge layer:
- uploaded-document inventory from knowledge-memory records
- collection rollups across tracked ingest and live vector collections
- live retrieval testing through the current RAG search API

## Data Sources

- `GET /api/memory/knowledge/summary`
- `GET /api/memory/knowledge?limit=500`
- `GET /api/rag/collections`
- `GET /api/rag/search`
- `GET /api/agents`

## Current Scope

- Real document counts, chunk counts, and shared-vs-targeted scope
- Real collection list from current Chroma-backed runtime
- Real vector runtime status from `/api/rag/health`
- Real embedding-provider catalog from `/api/rag/embedding-models`
- Real query testing against current vector collections
- Document drill-down with metadata, embedding labels, and collection focus actions
- Fast triage filtering by document text, source, task link, and metadata
- Direct handoff into the shared upload workspace via `/chat?openWorkspace=rag`

## Known Limits

- Historical retrieval hit counts are not yet persisted
- Vector-space or cluster visualization is not yet exposed by the backend
- Inventory relies on tracked knowledge-memory records for document metadata
