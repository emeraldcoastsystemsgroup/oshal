# Baserow connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `baserow` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.baserow.io/api` |
| **Auth** | API key in header `Authorization` |
| **Icon** | Baserow (verified) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `applications` | `baserow-applications` | read | GET | `/applications/` | - |
| `rows` | `baserow-rows` | read | GET | `/database/rows/table/{table_id}/` | `table_id` |
| `fields` | `baserow-fields` | read | GET | `/database/fields/table/{table_id}/` | `table_id` |

## Tools Exposed

- `baserow-applications`
- `baserow-rows`
- `baserow-fields`
