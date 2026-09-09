# LinkedIn connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `linkedin` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.linkedin.com` |
| **Auth** | OAuth2 (bearer) - scopes: openid, profile, email, w_member_social |
| **Description** | LinkedIn — reads the connected member's profile, and publishes a member share through the confirm-gated, audited write-action tier. OAuth: the operator registers the provider app once, then each user connects their own account. |
| **Rate limit** | burst 5, 2/s |
| **Retry** | up to 2, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `me` | `linkedin-me` | read | GET | `/v2/userinfo` | - |

## Tools Exposed

- `linkedin-me`
