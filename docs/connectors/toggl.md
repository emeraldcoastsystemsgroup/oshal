# Toggl Track connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `toggl` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.track.toggl.com/api/v9` |
| **Auth** | HTTP Basic (username/password) |
| **Description** | Toggl Track — reads me, workspaces, projects, time entries via api.track.toggl.com. Bring your own key: each user pastes their own token, held per-user in the encrypted connection store. |
| **Icon** | Toggl (verified) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `me` | `toggl-me` | read | GET | `/me` | - |
| `workspaces` | `toggl-workspaces` | read | GET | `/workspaces` | - |
| `projects` | `toggl-projects` | read | GET | `/me/projects` | - |
| `time-entries` | `toggl-time-entries` | read | GET | `/me/time_entries` | - |

## Tools Exposed

- `toggl-me`
- `toggl-workspaces`
- `toggl-projects`
- `toggl-time-entries`
