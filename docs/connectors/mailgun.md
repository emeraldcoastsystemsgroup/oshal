# Mailgun connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `mailgun` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.mailgun.net/v3` |
| **Auth** | HTTP Basic (username/password) |
| **Icon** | Mailgun (verified) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `domains` | `mailgun-domains` | read | GET | `/domains` | - |
| `events` | `mailgun-events` | read | GET | `/{domain}/events` | `domain` |
| `stats` | `mailgun-stats` | read | GET | `/{domain}/stats/total` | `domain` |
| `bounces` | `mailgun-bounces` | read | GET | `/{domain}/bounces` | `domain` |
| `unsubscribes` | `mailgun-unsubscribes` | read | GET | `/{domain}/unsubscribes` | `domain` |

## Tools Exposed

- `mailgun-domains`
- `mailgun-events`
- `mailgun-stats`
- `mailgun-bounces`
- `mailgun-unsubscribes`
