# Vonage connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `vonage` |
| **Version** | 1.0.0 |
| **Base URL** | `https://rest.nexmo.com` |
| **Auth** | API key in query param `api_key` |
| **Icon** | Vonage (verified) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `account-numbers` | `vonage-account-numbers` | read | GET | `/account/numbers` | `index`, `size` |
| `search-messages` | `vonage-search-messages` | read | GET | `/search/messages` | `date`, `to` |
| `search-message` | `vonage-search-message` | read | GET | `/search/message` | `id` |

## Tools Exposed

- `vonage-account-numbers`
- `vonage-search-messages`
- `vonage-search-message`
