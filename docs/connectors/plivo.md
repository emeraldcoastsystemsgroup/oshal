# Plivo connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `plivo` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.plivo.com/v1` |
| **Auth** | HTTP Basic (username/password) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `account` | `plivo-account` | read | GET | `/Account/{authId}/` | `authId` |
| `messages` | `plivo-messages` | read | GET | `/Account/{authId}/Message/` | `authId`, `limit`, `offset` |
| `numbers` | `plivo-numbers` | read | GET | `/Account/{authId}/Number/` | `authId`, `limit`, `offset` |

## Tools Exposed

- `plivo-account`
- `plivo-messages`
- `plivo-numbers`
