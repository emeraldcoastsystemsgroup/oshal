# Frill connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `frill` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.frill.co/v1` |
| **Auth** | API key in header `Authorization` |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `ideas` | `frill-ideas` | read | GET | `/ideas` | - |
| `announcements` | `frill-announcements` | read | GET | `/announcements` | - |
| `boards` | `frill-boards` | read | GET | `/boards` | - |

## Tools Exposed

- `frill-ideas`
- `frill-announcements`
- `frill-boards`
