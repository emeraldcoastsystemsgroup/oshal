# Bitbucket connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `bitbucket` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.bitbucket.org/2.0` |
| **Auth** | OAuth2 (bearer) |
| **Description** | Read the connected Bitbucket account profile and its repositories. |
| **Icon** | Bitbucket (verified) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |
| **Pagination** | link |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `me` | `bitbucket-me` | read | GET | `/user` | - |
| `repositories` | `bitbucket-repositories` | read | GET | `/repositories` | - |

## Tools Exposed

- `bitbucket-me`
- `bitbucket-repositories`
