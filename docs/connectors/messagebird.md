# MessageBird connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `messagebird` |
| **Version** | 1.0.0 |
| **Base URL** | `https://rest.messagebird.com` |
| **Auth** | API key in header `Authorization` |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `messages` | `messagebird-messages` | read | GET | `/messages` | `limit`, `offset` |
| `balance` | `messagebird-balance` | read | GET | `/balance` | - |
| `contacts` | `messagebird-contacts` | read | GET | `/contacts` | `limit`, `offset` |

## Tools Exposed

- `messagebird-messages`
- `messagebird-balance`
- `messagebird-contacts`
