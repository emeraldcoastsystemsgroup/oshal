# Stripe connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `stripe` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.stripe.com/v1` |
| **Auth** | OAuth2 (bearer) |
| **Description** | Read Stripe customers, charges, and invoices for the connected account. |
| **Icon** | Stripe (verified) |
| **Rate limit** | burst 25, 25/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `list-customers` | `stripe-list-customers` | read | GET | `/customers` | `limit`, `email` |
| `get-customer` | `stripe-get-customer` | read | GET | `/customers/{customerId}` | `customerId` |
| `list-charges` | `stripe-list-charges` | read | GET | `/charges` | `limit` |
| `list-invoices` | `stripe-list-invoices` | read | GET | `/invoices` | `limit`, `customer` |

## Tools Exposed

- `stripe-list-customers`
- `stripe-get-customer`
- `stripe-list-charges`
- `stripe-list-invoices`
