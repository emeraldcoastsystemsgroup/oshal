# Resend connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `resend` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.resend.com` |
| **Auth** | OAuth2 (bearer) |
| **Description** | Resend — reads verified domains and audiences, and sends email through the confirm-gated, audited write-action tier. Bring your own key: each user pastes their own API key, held per-user in the encrypted connection store. |
| **Icon** | Resend (verified) |
| **Rate limit** | burst 5, 2/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `domains` | `resend-domains` | read | GET | `/domains` | - |
| `audiences` | `resend-audiences` | read | GET | `/audiences` | - |

## Tools Exposed

- `resend-domains`
- `resend-audiences`
