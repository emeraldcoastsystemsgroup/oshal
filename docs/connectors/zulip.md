# Zulip connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `zulip` |
| **Version** | 1.0.0 |
| **Base URL** | `https://your-org.zulipchat.com/api/v1` |
| **Auth** | HTTP Basic (username/password) |
| **Icon** | Zulip (verified) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `users` | `zulip-users` | read | GET | `/users` | - |
| `streams` | `zulip-streams` | read | GET | `/streams` | - |
| `messages` | `zulip-messages` | read | GET | `/messages` | `anchor`, `numBefore`, `numAfter` |

## Tools Exposed

- `zulip-users`
- `zulip-streams`
- `zulip-messages`
