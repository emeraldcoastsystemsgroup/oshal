# YouTube connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `youtube` |
| **Version** | 1.0.0 |
| **Base URL** | `https://www.googleapis.com/youtube/v3` |
| **Auth** | OAuth2 (bearer) |
| **Description** | Read YouTube channel details and run catalog searches. |
| **Icon** | YouTube (verified) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |
| **Pagination** | cursor (`pageToken`) |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `my-channel` | `youtube-my-channel` | read | GET | `/channels` | - |
| `search` | `youtube-search` | read | GET | `/search` | `query` |

## Tools Exposed

- `youtube-my-channel`
- `youtube-search`
