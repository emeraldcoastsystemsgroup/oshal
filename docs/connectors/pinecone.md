# Pinecone connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `pinecone` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.pinecone.io` |
| **Auth** | API key in header `Api-Key` |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `indexes` | `pinecone-indexes` | read | GET | `/indexes` | - |
| `index` | `pinecone-index` | read | GET | `/indexes/{index_name}` | `index_name` |
| `collections` | `pinecone-collections` | read | GET | `/collections` | - |

## Tools Exposed

- `pinecone-indexes`
- `pinecone-index`
- `pinecone-collections`
