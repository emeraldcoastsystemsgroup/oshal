# Braintree connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `braintree` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.braintreegateway.com` |
| **Auth** | HTTP Basic (username/password) |
| **Icon** | Braintree (verified) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `customers` | `braintree-customers` | read | GET | `/merchants/{merchantId}/customers` | `merchantId` |
| `customer` | `braintree-customer` | read | GET | `/merchants/{merchantId}/customers/{customerId}` | `merchantId`, `customerId` |
| `transactions` | `braintree-transactions` | read | GET | `/merchants/{merchantId}/transactions` | `merchantId` |
| `transaction` | `braintree-transaction` | read | GET | `/merchants/{merchantId}/transactions/{transactionId}` | `merchantId`, `transactionId` |
| `subscriptions` | `braintree-subscriptions` | read | GET | `/merchants/{merchantId}/subscriptions/{subscriptionId}` | `merchantId`, `subscriptionId` |
| `plans` | `braintree-plans` | read | GET | `/merchants/{merchantId}/plans` | `merchantId` |

## Tools Exposed

- `braintree-customers`
- `braintree-customer`
- `braintree-transactions`
- `braintree-transaction`
- `braintree-subscriptions`
- `braintree-plans`
