# OpenSky Network connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `opensky` |
| **Version** | 1.0.0 |
| **Base URL** | `https://opensky-network.org/api` |
| **Auth** | None |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `states-all` | `opensky-states-all` | read | GET | `/states/all` | - |
| `flights-all` | `opensky-flights-all` | read | GET | `/flights/all` | `begin`, `end` |

## Tools Exposed

- `opensky-states-all`
- `opensky-flights-all`
