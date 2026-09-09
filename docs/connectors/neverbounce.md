# NeverBounce connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `neverbounce` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.neverbounce.com/v4` |
| **Auth** | API key in query param `key` |
| **Description** | NeverBounce — reads single check, account info via api.neverbounce.com. Bring your own key: each user pastes their own token, held per-user in the encrypted connection store. |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `single-check` | `neverbounce-single-check` | read | GET | `/single/check` | `email` |
| `account-info` | `neverbounce-account-info` | read | GET | `/account/info` | - |

## Tools Exposed

- `neverbounce-single-check`
- `neverbounce-account-info`
