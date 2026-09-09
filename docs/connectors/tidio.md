# Tidio connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `tidio` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.tidio.com` |
| **Auth** | API key in header `X-Tidio-Openapi-Client-Id` |
| **Description** | Tidio — reads contacts, conversations via api.tidio.com. Bring your own key: each user pastes their own token, held per-user in the encrypted connection store. |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `contacts` | `tidio-contacts` | read | GET | `/contacts` | - |
| `conversations` | `tidio-conversations` | read | GET | `/conversations` | - |

## Tools Exposed

- `tidio-contacts`
- `tidio-conversations`
