# Mux connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `mux` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.mux.com` |
| **Auth** | HTTP Basic (username/password) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `assets` | `mux-assets` | read | GET | `/video/v1/assets` | `limit`, `page` |
| `asset` | `mux-asset` | read | GET | `/video/v1/assets/{ASSET_ID}` | `ASSET_ID` |
| `live-streams` | `mux-live-streams` | read | GET | `/video/v1/live-streams` | `limit`, `page` |
| `metrics-breakdown` | `mux-metrics-breakdown` | read | GET | `/data/v1/metrics/{METRIC_ID}/breakdown` | `METRIC_ID`, `group_by` |

## Tools Exposed

- `mux-assets`
- `mux-asset`
- `mux-live-streams`
- `mux-metrics-breakdown`
