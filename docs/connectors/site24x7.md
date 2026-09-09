# Site24x7 connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `site24x7` |
| **Version** | 1.0.0 |
| **Base URL** | `https://www.site24x7.com/api` |
| **Auth** | API key in header `Authorization` |
| **Description** | Site24x7 — reads monitors, current status via www.site24x7.com. Bring your own key: each user pastes their own token, held per-user in the encrypted connection store. |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `monitors` | `site24x7-monitors` | read | GET | `/monitors` | - |
| `current-status` | `site24x7-current-status` | read | GET | `/current_status` | - |

## Tools Exposed

- `site24x7-monitors`
- `site24x7-current-status`
