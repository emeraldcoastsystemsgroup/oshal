# JFrog Artifactory connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `jfrog` |
| **Version** | 1.0.0 |
| **Base URL** | `https://yourcompany.jfrog.io/artifactory/api` |
| **Auth** | OAuth2 (bearer) |
| **Icon** | JFrog (verified) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `ping` | `jfrog-ping` | read | GET | `/system/ping` | - |
| `version` | `jfrog-version` | read | GET | `/system/version` | - |
| `repositories` | `jfrog-repositories` | read | GET | `/repositories` | - |
| `repository` | `jfrog-repository` | read | GET | `/repositories/{repoKey}` | `repoKey` |
| `storage-info` | `jfrog-storage-info` | read | GET | `/storageinfo` | - |
| `builds` | `jfrog-builds` | read | GET | `/build` | - |

## Tools Exposed

- `jfrog-ping`
- `jfrog-version`
- `jfrog-repositories`
- `jfrog-repository`
- `jfrog-storage-info`
- `jfrog-builds`
