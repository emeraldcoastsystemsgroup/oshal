# GitLab connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `gitlab` |
| **Version** | 1.0.0 |
| **Base URL** | `https://gitlab.com/api/v4` |
| **Auth** | API key in header `PRIVATE-TOKEN` |
| **Description** | List and inspect GitLab projects and their issues, with a resource to open a new issue. |
| **Icon** | GitLab (verified) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |
| **Pagination** | link-header |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `list-projects` | `gitlab-list-projects` | read | GET | `/projects` | - |
| `get-project` | `gitlab-get-project` | read | GET | `/projects/{projectId}` | `projectId` |
| `list-issues` | `gitlab-list-issues` | read | GET | `/projects/{projectId}/issues` | `projectId` |
| `create-issue` | `gitlab-create-issue` | read | POST | `/projects/{projectId}/issues` | `projectId`, `title`, `description` |

## Tools Exposed

- `gitlab-list-projects`
- `gitlab-get-project`
- `gitlab-list-issues`
- `gitlab-create-issue`
