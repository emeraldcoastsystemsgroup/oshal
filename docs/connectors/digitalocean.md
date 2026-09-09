# DigitalOcean connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `digitalocean` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.digitalocean.com/v2` |
| **Auth** | OAuth2 (bearer) |
| **Description** | DigitalOcean — reads account, droplets, droplet, apps and 2 more via api.digitalocean.com. OAuth: the operator registers the provider app once, then each user connects their own account. |
| **Icon** | DigitalOcean (verified) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |
| **Pagination** | offset (`page`) |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `account` | `digitalocean-account` | read | GET | `/account` | - |
| `droplets` | `digitalocean-droplets` | read | GET | `/droplets` | - |
| `droplet` | `digitalocean-droplet` | read | GET | `/droplets/{dropletId}` | `dropletId` |
| `apps` | `digitalocean-apps` | read | GET | `/apps` | - |
| `databases` | `digitalocean-databases` | read | GET | `/databases` | - |
| `kubernetes-clusters` | `digitalocean-kubernetes-clusters` | read | GET | `/kubernetes/clusters` | - |

## Tools Exposed

- `digitalocean-account`
- `digitalocean-droplets`
- `digitalocean-droplet`
- `digitalocean-apps`
- `digitalocean-databases`
- `digitalocean-kubernetes-clusters`
