# Zoom connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `zoom` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.zoom.us/v2` |
| **Auth** | OAuth2 (bearer) |
| **Description** | List and inspect the connected user Zoom meetings, with a resource to schedule a new meeting. |
| **Icon** | Zoom (verified) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |
| **Pagination** | cursor (`next_page_token`) |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `list-meetings` | `zoom-list-meetings` | read | GET | `/users/me/meetings` | - |
| `get-meeting` | `zoom-get-meeting` | read | GET | `/meetings/{meetingId}` | `meetingId` |
| `create-meeting` | `zoom-create-meeting` | read | POST | `/users/me/meetings` | `meeting` |

## Tools Exposed

- `zoom-list-meetings`
- `zoom-get-meeting`
- `zoom-create-meeting`
