# Xata connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `xata` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.xata.io` |
| **Auth** | OAuth2 (bearer) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `workspaces` | `xata-workspaces` | read | GET | `/workspaces` | - |
| `workspace` | `xata-workspace` | read | GET | `/workspaces/{workspace_id}` | `workspace_id` |
| `databases` | `xata-databases` | read | GET | `/workspaces/{workspace_id}/dbs` | `workspace_id` |

## Tools Exposed

- `xata-workspaces`
- `xata-workspace`
- `xata-databases`
