# Nolt connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `nolt` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.nolt.io/v1` |
| **Auth** | API key in header `Authorization` |
| **Description** | Nolt — reads boards, board posts, post via api.nolt.io. Bring your own key: each user pastes their own token, held per-user in the encrypted connection store. |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `boards` | `nolt-boards` | read | GET | `/boards` | - |
| `board-posts` | `nolt-board-posts` | read | GET | `/boards/{boardId}/posts` | `boardId` |
| `post` | `nolt-post` | read | GET | `/posts/{postId}` | `postId` |

## Tools Exposed

- `nolt-boards`
- `nolt-board-posts`
- `nolt-post`
