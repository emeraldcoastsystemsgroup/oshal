# Calendly connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `calendly` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.calendly.com` |
| **Auth** | OAuth2 (bearer) |
| **Description** | Read the connected Calendly user, their scheduled events, and event types. |
| **Icon** | Calendly (verified) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |
| **Pagination** | cursor (`page_token`) |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `me` | `calendly-me` | read | GET | `/users/me` | - |
| `list-events` | `calendly-list-events` | read | GET | `/scheduled_events` | `user` |
| `list-event-types` | `calendly-list-event-types` | read | GET | `/event_types` | `user` |

## Tools Exposed

- `calendly-me`
- `calendly-list-events`
- `calendly-list-event-types`
