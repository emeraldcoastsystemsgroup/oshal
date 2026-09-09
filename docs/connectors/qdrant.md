# Qdrant connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `qdrant` |
| **Version** | 1.0.0 |
| **Base URL** | `https://your-cluster.qdrant.io` |
| **Auth** | API key in header `api-key` |
| **Description** | Qdrant — reads collections, collection, aliases via your-cluster.qdrant.io. Bring your own key: each user pastes their own token, held per-user in the encrypted connection store. |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `collections` | `qdrant-collections` | read | GET | `/collections` | - |
| `collection` | `qdrant-collection` | read | GET | `/collections/{collection_name}` | `collection_name` |
| `aliases` | `qdrant-aliases` | read | GET | `/aliases` | - |

## Tools Exposed

- `qdrant-collections`
- `qdrant-collection`
- `qdrant-aliases`
