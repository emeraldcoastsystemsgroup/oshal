# NocoDB connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `nocodb` |
| **Version** | 1.0.0 |
| **Base URL** | `https://your-nocodb.example.com/api/v2` |
| **Auth** | API key in header `xc-token` |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `bases` | `nocodb-bases` | read | GET | `/meta/bases` | - |
| `tables` | `nocodb-tables` | read | GET | `/meta/bases/{baseId}/tables` | `baseId` |
| `records` | `nocodb-records` | read | GET | `/tables/{tableId}/records` | `tableId` |

## Tools Exposed

- `nocodb-bases`
- `nocodb-tables`
- `nocodb-records`
