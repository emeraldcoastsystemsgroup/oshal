# SendGrid connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `sendgrid` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.sendgrid.com/v3` |
| **Auth** | OAuth2 (bearer) |
| **Description** | List SendGrid transactional mail templates, with a resource to send email. |
| **Icon** | SendGrid (verified) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `list-templates` | `sendgrid-list-templates` | read | GET | `/templates` | `pageSize` |
| `send-mail` | `sendgrid-send-mail` | write (confirm) | POST | `/mail/send` | `mail` |

## Tools Exposed

- `sendgrid-list-templates`
- `sendgrid-send-mail`
