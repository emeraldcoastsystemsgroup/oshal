# Cronitor connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `cronitor` |
| **Version** | 1.0.0 |
| **Base URL** | `https://cronitor.io/api` |
| **Auth** | HTTP Basic (username/password) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `monitors` | `cronitor-monitors` | read | GET | `/monitors` | `page` |
| `monitor` | `cronitor-monitor` | read | GET | `/monitors/{key}` | `key` |

## Tools Exposed

- `cronitor-monitors`
- `cronitor-monitor`
