# Healthchecks.io connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `healthchecks` |
| **Version** | 1.0.0 |
| **Base URL** | `https://healthchecks.io/api/v3` |
| **Auth** | API key in header `X-Api-Key` |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `checks` | `healthchecks-checks` | read | GET | `/checks` | - |
| `check-flips` | `healthchecks-check-flips` | read | GET | `/checks/{uuid}/flips` | `uuid` |
| `badges` | `healthchecks-badges` | read | GET | `/badges` | - |

## Tools Exposed

- `healthchecks-checks`
- `healthchecks-check-flips`
- `healthchecks-badges`
