# Aviationstack connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `aviationstack` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.aviationstack.com/v1` |
| **Auth** | API key in query param `access_key` |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `flights` | `aviationstack-flights` | read | GET | `/flights` | `status` |
| `airports` | `aviationstack-airports` | read | GET | `/airports` | `q` |
| `airlines` | `aviationstack-airlines` | read | GET | `/airlines` | `q` |

## Tools Exposed

- `aviationstack-flights`
- `aviationstack-airports`
- `aviationstack-airlines`
