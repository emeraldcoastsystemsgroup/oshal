# Logz.io connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `logzio` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.logz.io/v1` |
| **Auth** | API key in header `X-API-TOKEN` |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `alerts` | `logzio-alerts` | read | GET | `/alerts` | - |
| `endpoints` | `logzio-endpoints` | read | GET | `/endpoints` | - |
| `users` | `logzio-users` | read | GET | `/users` | - |

## Tools Exposed

- `logzio-alerts`
- `logzio-endpoints`
- `logzio-users`
