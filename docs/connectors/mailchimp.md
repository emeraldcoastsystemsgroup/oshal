# Mailchimp connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `mailchimp` |
| **Version** | 1.0.0 |
| **Base URL** | `https://us1.api.mailchimp.com/3.0` |
| **Auth** | HTTP Basic (username/password) |
| **Description** | Read Mailchimp audiences, list members, campaigns, reports, and automations. |
| **Icon** | MailChimp (verified) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `lists` | `mailchimp-lists` | read | GET | `/lists` | - |
| `members` | `mailchimp-members` | read | GET | `/lists/{list_id}/members` | `list_id` |
| `campaigns` | `mailchimp-campaigns` | read | GET | `/campaigns` | - |
| `reports` | `mailchimp-reports` | read | GET | `/reports` | - |
| `automations` | `mailchimp-automations` | read | GET | `/automations` | - |

## Tools Exposed

- `mailchimp-lists`
- `mailchimp-members`
- `mailchimp-campaigns`
- `mailchimp-reports`
- `mailchimp-automations`
