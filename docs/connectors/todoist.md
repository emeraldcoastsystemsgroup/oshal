# Todoist connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `todoist` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.todoist.com/rest/v2` |
| **Auth** | OAuth2 (bearer) |
| **Description** | List Todoist projects and tasks, with gated actions to create and close tasks. |
| **Icon** | Todoist (verified) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `projects` | `todoist-projects` | read | GET | `/projects` | - |
| `tasks` | `todoist-tasks` | read | GET | `/tasks` | `projectId` |
| `create-task` | `todoist-create-task` | read | POST | `/tasks` | `task` |

## Tools Exposed

- `todoist-projects`
- `todoist-tasks`
- `todoist-create-task`
