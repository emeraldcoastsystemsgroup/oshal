# Clockify connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `clockify` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.clockify.me/api/v1` |
| **Auth** | API key in header `X-Api-Key` |
| **Icon** | Clockify (verified) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `workspaces` | `clockify-workspaces` | read | GET | `/workspaces` | - |
| `projects` | `clockify-projects` | read | GET | `/workspaces/{workspaceId}/projects` | `workspaceId` |
| `user` | `clockify-user` | read | GET | `/user` | - |

## Tools Exposed

- `clockify-workspaces`
- `clockify-projects`
- `clockify-user`
