# X (Twitter) connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `twitter` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.twitter.com/2` |
| **Auth** | OAuth2 (bearer) |
| **Description** | Read the connected X (Twitter) profile, a user recent posts, and recent-search results. |
| **Icon** | X (verified) |
| **Rate limit** | burst 5, 1/s |
| **Retry** | up to 3, honors Retry-After |
| **Pagination** | cursor (`pagination_token`) |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `me` | `twitter-me` | read | GET | `/users/me` | - |
| `user-tweets` | `twitter-user-tweets` | read | GET | `/users/{userId}/tweets` | `userId` |
| `search-recent` | `twitter-search-recent` | read | GET | `/tweets/search/recent` | `query` |

## Tools Exposed

- `twitter-me`
- `twitter-user-tweets`
- `twitter-search-recent`
