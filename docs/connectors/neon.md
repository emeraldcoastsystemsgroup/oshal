# Neon connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `neon` |
| **Version** | 1.0.0 |
| **Base URL** | `https://console.neon.tech/api/v2` |
| **Auth** | OAuth2 (bearer) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `projects` | `neon-projects` | read | GET | `/projects` | - |
| `project` | `neon-project` | read | GET | `/projects/{project_id}` | `project_id` |
| `branches` | `neon-branches` | read | GET | `/projects/{project_id}/branches` | `project_id` |
| `databases` | `neon-databases` | read | GET | `/projects/{project_id}/branches/{branch_id}/databases` | `project_id`, `branch_id` |

## Tools Exposed

- `neon-projects`
- `neon-project`
- `neon-branches`
- `neon-databases`
