# Stability AI connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `stabilityai` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.stability.ai/v1` |
| **Auth** | OAuth2 (bearer) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `account` | `stabilityai-account` | read | GET | `/user/account` | - |
| `balance` | `stabilityai-balance` | read | GET | `/user/balance` | - |
| `engines` | `stabilityai-engines` | read | GET | `/engines/list` | - |

## Tools Exposed

- `stabilityai-account`
- `stabilityai-balance`
- `stabilityai-engines`
