# Elastic Security connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `elastic-security` |
| **Version** | 1.0.0 |
| **Base URL** | `https://YOUR-DEPLOYMENT.kb.us-central1.gcp.cloud.es.io` |
| **Auth** | API key in header `Authorization` |
| **Icon** | Elastic (verified) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `detection-rules` | `elastic-detection-rules` | read | GET | `/api/detection_engine/rules/_find` | `filter`, `page`, `perPage` |
| `detection-rule` | `elastic-detection-rule` | read | GET | `/api/detection_engine/rules` | `ruleId` |
| `signals-index` | `elastic-signals-index` | read | GET | `/api/detection_engine/index` | - |
| `fleet-agents` | `elastic-fleet-agents` | read | GET | `/api/fleet/agents` | `kuery`, `perPage` |
| `endpoint-metadata` | `elastic-endpoint-metadata` | read | GET | `/api/endpoint/metadata` | - |

## Tools Exposed

- `elastic-detection-rules`
- `elastic-detection-rule`
- `elastic-signals-index`
- `elastic-fleet-agents`
- `elastic-endpoint-metadata`
