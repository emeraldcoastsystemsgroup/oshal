# Wrike connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `wrike` |
| **Version** | 1.0.0 |
| **Base URL** | `https://www.wrike.com/api/v4` |
| **Auth** | OAuth2 (bearer) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `tasks` | `wrike-tasks` | read | GET | `/tasks` | - |
| `folders` | `wrike-folders` | read | GET | `/folders` | - |
| `contacts` | `wrike-contacts` | read | GET | `/contacts` | - |

## Tools Exposed

- `wrike-tasks`
- `wrike-folders`
- `wrike-contacts`
