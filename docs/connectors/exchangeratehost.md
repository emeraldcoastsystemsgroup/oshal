# exchangerate.host connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `exchangeratehost` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.exchangerate.host` |
| **Auth** | API key in query param `access_key` |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `live` | `exchangeratehost-live` | read | GET | `/live` | - |
| `convert` | `exchangeratehost-convert` | read | GET | `/convert` | `from`, `to`, `amount` |

## Tools Exposed

- `exchangeratehost-live`
- `exchangeratehost-convert`
