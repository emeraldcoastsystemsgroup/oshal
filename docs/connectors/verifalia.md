# Verifalia connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `verifalia` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.verifalia.com/v2.5` |
| **Auth** | HTTP Basic (username/password) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `email-validations` | `verifalia-email-validations` | read | GET | `/email-validations` | - |
| `credits-balance` | `verifalia-credits-balance` | read | GET | `/credits/balance` | - |

## Tools Exposed

- `verifalia-email-validations`
- `verifalia-credits-balance`
