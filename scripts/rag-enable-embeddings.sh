#!/usr/bin/env bash
# CHANGE LOG
# 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — recreate infra-runbooks with DefaultEmbeddingFunction
#
# Why: collections created via the api's rag-service have no embedding
# function attached, so chromadb returns HTTP 422 on query_texts and the
# rag-service falls back to BM25 lexical search. This script uses the
# chroma Python client (inside the chroma container) to recreate each
# collection with embedding_function=DefaultEmbeddingFunction(), preserving
# the documents + metadata. After this runs, rag-service queries work
# semantically without any code change.
#
# Re-runnable: each collection is dropped + recreated with the same docs.
# Idempotent if the docs in chroma haven't changed.
#
# Usage:
#   bash scripts/rag-enable-embeddings.sh                       # infra-runbooks
#   COLLECTIONS="infra-runbooks my-notes" bash scripts/rag-enable-embeddings.sh
set -euo pipefail

CHROMA_CONTAINER="${CHROMA_CONTAINER:-oshal-local-chromadb}"
COLLECTIONS="${COLLECTIONS:-infra-runbooks}"

if ! docker ps --format '{{.Names}}' | grep -q "^${CHROMA_CONTAINER}\$"; then
  echo "ERR: chroma container '${CHROMA_CONTAINER}' not running" >&2
  exit 1
fi

for col in $COLLECTIONS; do
  echo
  echo "── ${col}: rebuild with DefaultEmbeddingFunction ──"
  docker exec -i "$CHROMA_CONTAINER" python - <<PYEOF
import sys, chromadb
from chromadb.utils import embedding_functions

client = chromadb.HttpClient(host="localhost", port=8000)
ef = embedding_functions.DefaultEmbeddingFunction()
name = "${col}"

try:
    old = client.get_collection(name=name)
except Exception as e:
    print(f"  collection '{name}' not found, skipping ({e})", file=sys.stderr)
    sys.exit(0)

# Pull every doc out of the existing collection. ChromaDB.get() with no
# filter returns all rows in this collection — fine for our small runbook
# corpora (tens to low hundreds of chunks).
existing = old.get(include=["documents", "metadatas"])
ids = existing.get("ids") or []
docs = existing.get("documents") or []
metas = existing.get("metadatas") or []
print(f"  pulled {len(ids)} docs from old '{name}'")

if len(ids) == 0:
    print(f"  '{name}' has no docs; skipping")
    sys.exit(0)

# Drop + recreate with the embedding function attached.
client.delete_collection(name=name)
new = client.create_collection(name=name, embedding_function=ef, metadata={"hnsw:space": "cosine"})

# Re-add in batches so embedding doesn't time out on big collections.
BATCH = 64
for i in range(0, len(ids), BATCH):
    chunk_ids = ids[i:i+BATCH]
    chunk_docs = docs[i:i+BATCH]
    chunk_metas = metas[i:i+BATCH] if metas else None
    new.add(ids=chunk_ids, documents=chunk_docs, metadatas=chunk_metas)
    print(f"  ingested batch {i//BATCH + 1} ({len(chunk_ids)} docs)")

print(f"  done: '{name}' rebuilt with {len(ids)} embedded docs")
PYEOF
done

echo
echo "── verify a query ──"
echo "GET /api/rag/search?q=CrashLoopBackOff&collection=infra-runbooks&topK=3"
curl -sf -m 10 "http://localhost:35457/api/rag/search?q=CrashLoopBackOff&collection=infra-runbooks&topK=3" 2>&1 | head -c 800
echo
