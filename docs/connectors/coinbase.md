# Coinbase connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `coinbase` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.coinbase.com` |
| **Auth** | OAuth2 (bearer) |
| **Description** | Read the connected Coinbase user profile and account balances. |
| **Icon** | Coinbase (verified) |
| **Rate limit** | burst 5, 5/s |
| **Retry** | up to 3, honors Retry-After |
| **Pagination** | cursor (`starting_after`) |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `me` | `coinbase-me` | read | GET | `/v2/user` | - |
| `accounts` | `coinbase-accounts` | read | GET | `/v2/accounts` | - |

## Tools Exposed

- `coinbase-me`
- `coinbase-accounts`
