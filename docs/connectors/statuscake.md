# StatusCake connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `statuscake` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.statuscake.com/v1` |
| **Auth** | OAuth2 (bearer) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `uptime` | `statuscake-uptime` | read | GET | `/uptime` | `page`, `limit` |
| `uptime-test` | `statuscake-uptime-test` | read | GET | `/uptime/{test_id}` | `test_id` |
| `pagespeed` | `statuscake-pagespeed` | read | GET | `/pagespeed` | `page`, `limit` |

## Tools Exposed

- `statuscake-uptime`
- `statuscake-uptime-test`
- `statuscake-pagespeed`
