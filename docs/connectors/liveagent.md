# LiveAgent connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `liveagent` |
| **Version** | 1.0.0 |
| **Base URL** | `https://your.ladesk.com/api/v3` |
| **Auth** | API key in header `apikey` |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `tickets` | `liveagent-tickets` | read | GET | `/tickets` | - |
| `agents` | `liveagent-agents` | read | GET | `/agents` | - |
| `contacts` | `liveagent-contacts` | read | GET | `/contacts` | - |

## Tools Exposed

- `liveagent-tickets`
- `liveagent-agents`
- `liveagent-contacts`
