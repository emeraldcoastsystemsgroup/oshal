# Splitwise connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `splitwise` |
| **Version** | 1.0.0 |
| **Base URL** | `https://secure.splitwise.com/api/v3.0` |
| **Auth** | OAuth2 (bearer) |
| **Description** | Splitwise — reads current user, groups, expenses via secure.splitwise.com. OAuth: the operator registers the provider app once, then each user connects their own account. |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `current-user` | `splitwise-current-user` | read | GET | `/get_current_user` | - |
| `groups` | `splitwise-groups` | read | GET | `/get_groups` | - |
| `expenses` | `splitwise-expenses` | read | GET | `/get_expenses` | - |

## Tools Exposed

- `splitwise-current-user`
- `splitwise-groups`
- `splitwise-expenses`
