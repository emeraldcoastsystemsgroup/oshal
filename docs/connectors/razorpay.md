# Razorpay connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `razorpay` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.razorpay.com/v1` |
| **Auth** | HTTP Basic (username/password) |
| **Icon** | Razorpay (verified) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `customers` | `razorpay-customers` | read | GET | `/customers` | - |
| `payments` | `razorpay-payments` | read | GET | `/payments` | - |
| `payment` | `razorpay-payment` | read | GET | `/payments/{paymentId}` | `paymentId` |
| `orders` | `razorpay-orders` | read | GET | `/orders` | - |
| `subscriptions` | `razorpay-subscriptions` | read | GET | `/subscriptions` | - |
| `invoices` | `razorpay-invoices` | read | GET | `/invoices` | - |

## Tools Exposed

- `razorpay-customers`
- `razorpay-payments`
- `razorpay-payment`
- `razorpay-orders`
- `razorpay-subscriptions`
- `razorpay-invoices`
