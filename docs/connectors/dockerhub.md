# Docker Hub connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `dockerhub` |
| **Version** | 1.0.0 |
| **Base URL** | `https://hub.docker.com/v2` |
| **Auth** | OAuth2 (bearer) |
| **Icon** | Docker (verified) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |
| **Pagination** | offset (`page`) |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `user` | `dockerhub-user` | read | GET | `/users/{username}/` | `username` |
| `repositories` | `dockerhub-repositories` | read | GET | `/repositories/{namespace}/` | `namespace` |
| `repository` | `dockerhub-repository` | read | GET | `/repositories/{namespace}/{repository}/` | `namespace`, `repository` |
| `tags` | `dockerhub-tags` | read | GET | `/repositories/{namespace}/{repository}/tags/` | `namespace`, `repository` |
| `orgs` | `dockerhub-orgs` | read | GET | `/user/orgs/` | - |

## Tools Exposed

- `dockerhub-user`
- `dockerhub-repositories`
- `dockerhub-repository`
- `dockerhub-tags`
- `dockerhub-orgs`
