# Sinch connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `sinch` |
| **Version** | 1.0.0 |
| **Base URL** | `https://us.sms.api.sinch.com/xms/v1` |
| **Auth** | OAuth2 (bearer) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `batches` | `sinch-batches` | read | GET | `/{servicePlanId}/batches` | `servicePlanId`, `page`, `pageSize` |
| `batch` | `sinch-batch` | read | GET | `/{servicePlanId}/batches/{batchId}` | `servicePlanId`, `batchId` |
| `groups` | `sinch-groups` | read | GET | `/{servicePlanId}/groups` | `servicePlanId`, `page`, `pageSize` |

## Tools Exposed

- `sinch-batches`
- `sinch-batch`
- `sinch-groups`
