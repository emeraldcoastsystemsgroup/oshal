# Upstash connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `upstash` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.upstash.com/v2` |
| **Auth** | HTTP Basic (username/password) |
| **Icon** | Upstash (verified) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `redis-databases` | `upstash-redis-databases` | read | GET | `/redis/databases` | - |
| `redis-database` | `upstash-redis-database` | read | GET | `/redis/database/{id}` | `id` |
| `kafka-clusters` | `upstash-kafka-clusters` | read | GET | `/kafka/clusters` | - |

## Tools Exposed

- `upstash-redis-databases`
- `upstash-redis-database`
- `upstash-kafka-clusters`
