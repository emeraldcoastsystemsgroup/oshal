# Oura Ring connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `oura` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.ouraring.com/v2` |
| **Auth** | OAuth2 (bearer) |
| **Rate limit** | burst 5, 5/s |
| **Retry** | up to 3, honors Retry-After |
| **Pagination** | cursor (`next_token`) |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `me` | `oura-me` | read | GET | `/usercollection/personal_info` | - |
| `daily-activity` | `oura-daily-activity` | read | GET | `/usercollection/daily_activity` | `start`, `end` |
| `sleep` | `oura-sleep` | read | GET | `/usercollection/daily_sleep` | `start`, `end` |

## Tools Exposed

- `oura-me`
- `oura-daily-activity`
- `oura-sleep`
