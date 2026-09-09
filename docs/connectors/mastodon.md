# Mastodon connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `mastodon` |
| **Version** | 1.1.0 |
| **Base URL** | `https://mastodon.social/api/v1` |
| **Auth** | OAuth2 (bearer) |
| **Description** | Mastodon — reads verify credentials, home timeline, public timeline, notifications and 2 more via mastodon.social. OAuth: the operator registers the provider app once, then each user connects their own account. |
| **Icon** | Mastodon (verified) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `verify-credentials` | `mastodon-verify-credentials` | read | GET | `/accounts/verify_credentials` | - |
| `home-timeline` | `mastodon-home-timeline` | read | GET | `/timelines/home` | - |
| `public-timeline` | `mastodon-public-timeline` | read | GET | `/timelines/public` | - |
| `notifications` | `mastodon-notifications` | read | GET | `/notifications` | - |
| `account` | `mastodon-account` | read | GET | `/accounts/{id}` | `id` |
| `account-statuses` | `mastodon-account-statuses` | read | GET | `/accounts/{id}/statuses` | `id` |

## Tools Exposed

- `mastodon-verify-credentials`
- `mastodon-home-timeline`
- `mastodon-public-timeline`
- `mastodon-notifications`
- `mastodon-account`
- `mastodon-account-statuses`
