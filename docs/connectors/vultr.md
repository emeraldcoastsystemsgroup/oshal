# Vultr connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `vultr` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.vultr.com/v2` |
| **Auth** | OAuth2 (bearer) |
| **Icon** | Vultr (verified) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `account` | `vultr-account` | read | GET | `/account` | - |
| `instances` | `vultr-instances` | read | GET | `/instances` | - |
| `instance` | `vultr-instance` | read | GET | `/instances/{instanceId}` | `instanceId` |
| `block-storage` | `vultr-block-storage` | read | GET | `/blocks` | - |
| `dns-domains` | `vultr-dns-domains` | read | GET | `/domains` | - |
| `regions` | `vultr-regions` | read | GET | `/regions` | - |

## Tools Exposed

- `vultr-account`
- `vultr-instances`
- `vultr-instance`
- `vultr-block-storage`
- `vultr-dns-domains`
- `vultr-regions`
