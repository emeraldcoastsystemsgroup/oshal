# Kickbox connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `kickbox` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.kickbox.com/v2` |
| **Auth** | API key in query param `apikey` |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `verify` | `kickbox-verify` | read | GET | `/verify` | `email` |
| `balance` | `kickbox-balance` | read | GET | `/balance` | - |

## Tools Exposed

- `kickbox-verify`
- `kickbox-balance`
