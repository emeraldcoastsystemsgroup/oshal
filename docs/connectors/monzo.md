# Monzo connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `monzo` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.monzo.com` |
| **Auth** | OAuth2 (bearer) |
| **Icon** | Monzo (verified) |
| **Rate limit** | burst 5, 5/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `whoami` | `monzo-whoami` | read | GET | `/ping/whoami` | - |
| `accounts` | `monzo-accounts` | read | GET | `/accounts` | - |
| `balance` | `monzo-balance` | read | GET | `/balance` | `accountId` |
| `transactions` | `monzo-transactions` | read | GET | `/transactions` | `accountId` |
| `pots` | `monzo-pots` | read | GET | `/pots` | `accountId` |

## Tools Exposed

- `monzo-whoami`
- `monzo-accounts`
- `monzo-balance`
- `monzo-transactions`
- `monzo-pots`
