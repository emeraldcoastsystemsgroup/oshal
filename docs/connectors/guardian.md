# The Guardian connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `guardian` |
| **Version** | 1.0.0 |
| **Base URL** | `https://content.guardianapis.com` |
| **Auth** | API key in query param `api-key` |
| **Icon** | The Guardian (verified) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `search` | `guardian-search` | read | GET | `/search` | `q` |
| `sections` | `guardian-sections` | read | GET | `/sections` | - |
| `tags` | `guardian-tags` | read | GET | `/tags` | `q` |

## Tools Exposed

- `guardian-search`
- `guardian-sections`
- `guardian-tags`
