# Asana connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `asana` |
| **Version** | 1.0.0 |
| **Base URL** | `https://app.asana.com/api/1.0` |
| **Auth** | OAuth2 (bearer) |
| **Description** | List Asana tasks and projects, with a resource to create tasks. |
| **Icon** | Asana (verified) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |
| **Pagination** | cursor (`offset`) |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `list-tasks` | `asana-list-tasks` | read | GET | `/tasks` | `assignee`, `workspace` |
| `get-task` | `asana-get-task` | read | GET | `/tasks/{taskId}` | `taskId` |
| `list-projects` | `asana-list-projects` | read | GET | `/projects` | `workspace` |
| `create-task` | `asana-create-task` | read | POST | `/tasks` | `data` |

## Tools Exposed

- `asana-list-tasks`
- `asana-get-task`
- `asana-list-projects`
- `asana-create-task`
