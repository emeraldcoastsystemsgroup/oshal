# Instatus connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `instatus` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.instatus.com/v1` |
| **Auth** | OAuth2 (bearer) |
| **Icon** | Instatus (verified) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `pages` | `instatus-pages` | read | GET | `/pages` | - |
| `incidents` | `instatus-incidents` | read | GET | `/{page_id}/incidents` | `page_id` |
| `components` | `instatus-components` | read | GET | `/{page_id}/components` | `page_id` |

## Tools Exposed

- `instatus-pages`
- `instatus-incidents`
- `instatus-components`
