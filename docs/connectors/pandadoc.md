# PandaDoc connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `pandadoc` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.pandadoc.com/public/v1` |
| **Auth** | API key in header `Authorization` |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `list-documents` | `pandadoc-list-documents` | read | GET | `/documents` | - |
| `get-document` | `pandadoc-get-document` | read | GET | `/documents/{id}` | `id` |
| `list-templates` | `pandadoc-list-templates` | read | GET | `/templates` | - |

## Tools Exposed

- `pandadoc-list-documents`
- `pandadoc-get-document`
- `pandadoc-list-templates`
