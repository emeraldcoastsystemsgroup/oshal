# Loggly connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `loggly` |
| **Version** | 1.0.0 |
| **Base URL** | `https://yourcompany.loggly.com/apiv2` |
| **Auth** | HTTP Basic (username/password) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `fields` | `loggly-fields` | read | GET | `/fields` | - |
| `customer` | `loggly-customer` | read | GET | `/customer` | - |

## Tools Exposed

- `loggly-fields`
- `loggly-customer`
