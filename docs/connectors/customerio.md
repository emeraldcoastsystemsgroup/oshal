# Customer.io connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `customerio` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.customer.io/v1` |
| **Auth** | HTTP Basic (username/password) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `campaigns` | `customerio-campaigns` | read | GET | `/campaigns` | - |
| `segments` | `customerio-segments` | read | GET | `/segments` | - |
| `newsletters` | `customerio-newsletters` | read | GET | `/newsletters` | - |
| `broadcasts` | `customerio-broadcasts` | read | GET | `/broadcasts` | - |
| `messages` | `customerio-messages` | read | GET | `/messages` | - |

## Tools Exposed

- `customerio-campaigns`
- `customerio-segments`
- `customerio-newsletters`
- `customerio-broadcasts`
- `customerio-messages`
