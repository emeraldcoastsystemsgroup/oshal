# Pinterest connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `pinterest` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.pinterest.com/v5` |
| **Auth** | OAuth2 (bearer) |
| **Icon** | Pinterest (verified) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |
| **Pagination** | cursor (`bookmark`) |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `me` | `pinterest-me` | read | GET | `/user_account` | - |
| `boards` | `pinterest-boards` | read | GET | `/boards` | - |
| `pins` | `pinterest-pins` | read | GET | `/pins` | - |
| `board-pins` | `pinterest-board-pins` | read | GET | `/boards/{boardId}/pins` | `boardId` |

## Tools Exposed

- `pinterest-me`
- `pinterest-boards`
- `pinterest-pins`
- `pinterest-board-pins`
