# Gitea connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `gitea` |
| **Version** | 1.0.0 |
| **Base URL** | `https://gitea.example.com/api/v1` |
| **Auth** | API key in header `Authorization` |
| **Icon** | Gitea (verified) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `current-user` | `gitea-current-user` | read | GET | `/user` | - |
| `repos` | `gitea-repos` | read | GET | `/user/repos` | - |
| `repo` | `gitea-repo` | read | GET | `/repos/{owner}/{repo}` | `owner`, `repo` |
| `issues` | `gitea-issues` | read | GET | `/repos/{owner}/{repo}/issues` | `owner`, `repo` |
| `pulls` | `gitea-pulls` | read | GET | `/repos/{owner}/{repo}/pulls` | `owner`, `repo` |
| `orgs` | `gitea-orgs` | read | GET | `/user/orgs` | - |

## Tools Exposed

- `gitea-current-user`
- `gitea-repos`
- `gitea-repo`
- `gitea-issues`
- `gitea-pulls`
- `gitea-orgs`
