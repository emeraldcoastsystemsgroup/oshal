# Shippo connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `shippo` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.goshippo.com` |
| **Auth** | API key in header `Authorization` |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |
| **Pagination** | link |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `addresses` | `shippo-addresses` | read | GET | `/addresses/` | - |
| `shipments` | `shippo-shipments` | read | GET | `/shipments/` | - |
| `get-shipment` | `shippo-get-shipment` | read | GET | `/shipments/{shipmentId}` | `shipmentId` |
| `tracking` | `shippo-tracking` | read | GET | `/tracks/{carrier}/{trackingNumber}` | `carrier`, `trackingNumber` |

## Tools Exposed

- `shippo-addresses`
- `shippo-shipments`
- `shippo-get-shipment`
- `shippo-tracking`
