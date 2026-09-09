# Statuspage connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `statuspage` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.statuspage.io/v1` |
| **Auth** | API key in header `Authorization` |
| **Description** | Statuspage — reads pages, page, components, incidents and 1 more via api.statuspage.io. Bring your own key: each user pastes their own token, held per-user in the encrypted connection store. |
| **Icon** | Statuspage (verified) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |
| **Pagination** | offset (`page`) |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `pages` | `statuspage-pages` | read | GET | `/pages` | - |
| `page` | `statuspage-page` | read | GET | `/pages/{pageId}` | `pageId` |
| `components` | `statuspage-components` | read | GET | `/pages/{pageId}/components` | `pageId` |
| `incidents` | `statuspage-incidents` | read | GET | `/pages/{pageId}/incidents` | `pageId` |
| `subscribers` | `statuspage-subscribers` | read | GET | `/pages/{pageId}/subscribers` | `pageId` |

## Tools Exposed

- `statuspage-pages`
- `statuspage-page`
- `statuspage-components`
- `statuspage-incidents`
- `statuspage-subscribers`
