# Wise connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `wise` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.transferwise.com/v1` |
| **Auth** | OAuth2 (bearer) |
| **Icon** | Wise (verified) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `profiles` | `wise-profiles` | read | GET | `/profiles` | - |
| `borderless-accounts` | `wise-borderless-accounts` | read | GET | `/borderless-accounts` | `profileId` |
| `transfers` | `wise-transfers` | read | GET | `/transfers` | `profileId`, `limit` |

## Tools Exposed

- `wise-profiles`
- `wise-borderless-accounts`
- `wise-transfers`
