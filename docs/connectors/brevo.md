# Brevo connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `brevo` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.brevo.com/v3` |
| **Auth** | API key in header `api-key` |
| **Icon** | Brevo (verified) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `contacts` | `brevo-contacts` | read | GET | `/contacts` | - |
| `lists` | `brevo-lists` | read | GET | `/contacts/lists` | - |
| `email-campaigns` | `brevo-email-campaigns` | read | GET | `/emailCampaigns` | - |
| `senders` | `brevo-senders` | read | GET | `/senders` | - |
| `account` | `brevo-account` | read | GET | `/account` | - |
| `transactional-stats` | `brevo-transactional-stats` | read | GET | `/smtp/statistics/aggregatedReport` | - |

## Tools Exposed

- `brevo-contacts`
- `brevo-lists`
- `brevo-email-campaigns`
- `brevo-senders`
- `brevo-account`
- `brevo-transactional-stats`
