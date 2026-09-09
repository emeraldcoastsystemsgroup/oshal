# Fitbit connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `fitbit` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.fitbit.com` |
| **Auth** | OAuth2 (bearer) |
| **Description** | Fitbit — reads me, day activity, sleep via api.fitbit.com. OAuth: the operator registers the provider app once, then each user connects their own account. |
| **Icon** | Fitbit (verified) |
| **Rate limit** | burst 5, 5/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `me` | `fitbit-me` | read | GET | `/1/user/-/profile.json` | - |
| `day-activity` | `fitbit-day-activity` | read | GET | `/1/user/-/activities/date/{date}.json` | `date` |
| `sleep` | `fitbit-sleep` | read | GET | `/1.2/user/-/sleep/date/{date}.json` | `date` |

## Tools Exposed

- `fitbit-me`
- `fitbit-day-activity`
- `fitbit-sleep`
