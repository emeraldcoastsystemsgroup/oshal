# ntfy connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `ntfy` |
| **Version** | 1.0.0 |
| **Base URL** | `https://ntfy.sh` |
| **Auth** | None |
| **Icon** | ntfy (verified) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `health` | `ntfy-health` | read | GET | `/v1/health` | - |
| `topic-json` | `ntfy-topic-json` | read | GET | `/{topic}/json` | `topic`, `since` |
| `topic-raw` | `ntfy-topic-raw` | read | GET | `/{topic}/raw` | `topic`, `since` |

## Tools Exposed

- `ntfy-health`
- `ntfy-topic-json`
- `ntfy-topic-raw`
