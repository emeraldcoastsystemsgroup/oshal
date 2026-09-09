# MongoDB Atlas connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `mongodbatlas` |
| **Version** | 1.0.0 |
| **Base URL** | `https://cloud.mongodb.com/api/atlas/v2` |
| **Auth** | HTTP Basic (username/password) |
| **Description** | MongoDB Atlas — reads groups, group, clusters, cluster via cloud.mongodb.com. Bring your own key: each user pastes their own token, held per-user in the encrypted connection store. |
| **Icon** | MongoDB (verified) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `groups` | `mongodbatlas-groups` | read | GET | `/groups` | - |
| `group` | `mongodbatlas-group` | read | GET | `/groups/{groupId}` | `groupId` |
| `clusters` | `mongodbatlas-clusters` | read | GET | `/groups/{groupId}/clusters` | `groupId` |
| `cluster` | `mongodbatlas-cluster` | read | GET | `/groups/{groupId}/clusters/{clusterName}` | `groupId`, `clusterName` |

## Tools Exposed

- `mongodbatlas-groups`
- `mongodbatlas-group`
- `mongodbatlas-clusters`
- `mongodbatlas-cluster`
