# Invoice Ninja connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `invoiceninja` |
| **Version** | 1.0.0 |
| **Base URL** | `https://invoicing.co/api/v1` |
| **Auth** | API key in header `X-Api-Token` |
| **Icon** | Invoice Ninja (verified) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `invoices` | `invoiceninja-invoices` | read | GET | `/invoices` | - |
| `clients` | `invoiceninja-clients` | read | GET | `/clients` | - |
| `payments` | `invoiceninja-payments` | read | GET | `/payments` | - |

## Tools Exposed

- `invoiceninja-invoices`
- `invoiceninja-clients`
- `invoiceninja-payments`
