# Usersnap connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `usersnap` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.usersnap.com/v1` |
| **Auth** | OAuth2 (bearer) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `projects` | `usersnap-projects` | read | GET | `/projects` | - |
| `project` | `usersnap-project` | read | GET | `/projects/{api_id}` | `api_id` |
| `feedbacks` | `usersnap-feedbacks` | read | GET | `/projects/{api_id}/feedbacks` | `api_id` |

## Tools Exposed

- `usersnap-projects`
- `usersnap-project`
- `usersnap-feedbacks`
