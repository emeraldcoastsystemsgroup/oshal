# ClickUp connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `clickup` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.clickup.com/api/v2` |
| **Auth** | API key in header `Authorization` |
| **Description** | Read the connected ClickUp user profile and its workspaces (teams). |
| **Icon** | ClickUp (verified) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `me` | `clickup-me` | read | GET | `/user` | - |
| `teams` | `clickup-teams` | read | GET | `/team` | - |

## Tools Exposed

- `clickup-me`
- `clickup-teams`
