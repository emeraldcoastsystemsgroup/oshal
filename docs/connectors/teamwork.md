# Teamwork connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `teamwork` |
| **Version** | 1.0.0 |
| **Base URL** | `https://yourco.teamwork.com` |
| **Auth** | HTTP Basic (username/password) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `projects` | `teamwork-projects` | read | GET | `/projects.json` | - |
| `tasks` | `teamwork-tasks` | read | GET | `/tasks.json` | - |

## Tools Exposed

- `teamwork-projects`
- `teamwork-tasks`
