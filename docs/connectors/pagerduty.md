# PagerDuty connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `pagerduty` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.pagerduty.com` |
| **Auth** | API key in header `Authorization` |
| **Description** | Read PagerDuty incidents, services, on-call schedules, users, and account abilities. |
| **Icon** | PagerDuty (verified) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |
| **Pagination** | offset (`offset`) |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `abilities` | `pagerduty-abilities` | read | GET | `/abilities` | - |
| `incidents` | `pagerduty-incidents` | read | GET | `/incidents` | `status` |
| `services` | `pagerduty-services` | read | GET | `/services` | - |
| `oncalls` | `pagerduty-oncalls` | read | GET | `/oncalls` | - |
| `users` | `pagerduty-users` | read | GET | `/users` | - |

## Tools Exposed

- `pagerduty-abilities`
- `pagerduty-incidents`
- `pagerduty-services`
- `pagerduty-oncalls`
- `pagerduty-users`
