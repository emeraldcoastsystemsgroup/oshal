# GitHub connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `github` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.github.com` |
| **Auth** | OAuth2 (bearer) |
| **Description** | Read your GitHub profile, repositories, and issue search, with gated actions to create issues and comments. |
| **Icon** | GitHub (verified) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |
| **Pagination** | link-header |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `me` | `github-me` | read | GET | `/user` | - |
| `list-repos` | `github-list-repos` | read | GET | `/user/repos` | - |
| `get-repo` | `github-get-repo` | read | GET | `/repos/{owner}/{repo}` | `owner`, `repo` |
| `search-issues` | `github-search-issues` | read | GET | `/search/issues` | `query` |
| `create-issue` | `github-create-issue` | write (confirm) | POST | `/repos/{owner}/{repo}/issues` | `owner`, `repo`, `title`, `body` |

## Webhook Events

| Event | Verification |
| --- | --- |
| `issues` | hmac |

## Tools Exposed

- `github-me`
- `github-list-repos`
- `github-get-repo`
- `github-search-issues`
- `github-create-issue`
