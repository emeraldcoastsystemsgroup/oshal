# Dwolla connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `dwolla` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.dwolla.com` |
| **Auth** | OAuth2 (bearer) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `customers` | `dwolla-customers` | read | GET | `/customers` | `limit` |
| `customer` | `dwolla-customer` | read | GET | `/customers/{customerId}` | `customerId` |
| `funding-sources` | `dwolla-funding-sources` | read | GET | `/customers/{customerId}/funding-sources` | `customerId` |
| `transfers` | `dwolla-transfers` | read | GET | `/customers/{customerId}/transfers` | `customerId`, `limit` |

## Tools Exposed

- `dwolla-customers`
- `dwolla-customer`
- `dwolla-funding-sources`
- `dwolla-transfers`
