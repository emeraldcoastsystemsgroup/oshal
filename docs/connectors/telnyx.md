# Telnyx connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `telnyx` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.telnyx.com/v2` |
| **Auth** | OAuth2 (bearer) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `message` | `telnyx-message` | read | GET | `/messages/{id}` | `id` |
| `phone-numbers` | `telnyx-phone-numbers` | read | GET | `/phone_numbers` | `page`, `size` |
| `messaging-profiles` | `telnyx-messaging-profiles` | read | GET | `/messaging_profiles` | `page`, `size` |

## Tools Exposed

- `telnyx-message`
- `telnyx-phone-numbers`
- `telnyx-messaging-profiles`
