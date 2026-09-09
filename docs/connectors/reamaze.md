# Re:amaze connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `reamaze` |
| **Version** | 1.0.0 |
| **Base URL** | `https://yourbrand.reamaze.io/api/v1` |
| **Auth** | HTTP Basic (username/password) |
| **Description** | Re:amaze — reads conversations, articles, contacts via yourbrand.reamaze.io. Bring your own key: each user pastes their own token, held per-user in the encrypted connection store. |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `conversations` | `reamaze-conversations` | read | GET | `/conversations` | - |
| `articles` | `reamaze-articles` | read | GET | `/articles` | - |
| `contacts` | `reamaze-contacts` | read | GET | `/contacts` | - |

## Tools Exposed

- `reamaze-conversations`
- `reamaze-articles`
- `reamaze-contacts`
