# Bouncer connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `bouncer` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.usebouncer.com/v1.1` |
| **Auth** | API key in header `x-api-key` |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `email-verify` | `bouncer-email-verify` | read | GET | `/email/verify` | `email` |
| `me-credits` | `bouncer-me-credits` | read | GET | `/me/credits` | - |

## Tools Exposed

- `bouncer-email-verify`
- `bouncer-me-credits`
