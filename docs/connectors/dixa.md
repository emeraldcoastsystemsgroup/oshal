# Dixa connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `dixa` |
| **Version** | 1.0.0 |
| **Base URL** | `https://dev.dixa.io/v1` |
| **Auth** | OAuth2 (bearer) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `conversations` | `dixa-conversations` | read | GET | `/conversations` | - |
| `agents` | `dixa-agents` | read | GET | `/agents` | - |
| `end-users` | `dixa-end-users` | read | GET | `/end-users` | - |

## Tools Exposed

- `dixa-conversations`
- `dixa-agents`
- `dixa-end-users`
