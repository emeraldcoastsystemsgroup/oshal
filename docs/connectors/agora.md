# Agora connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `agora` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.agora.io/dev/v1` |
| **Auth** | HTTP Basic (username/password) |
| **Icon** | Agora (verified) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `channel` | `agora-channel` | read | GET | `/channel/{appid}` | `appid`, `page_no`, `page_size` |
| `projects` | `agora-projects` | read | GET | `/projects` | - |

## Tools Exposed

- `agora-channel`
- `agora-projects`
