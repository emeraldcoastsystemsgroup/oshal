# Finnhub connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `finnhub` |
| **Version** | 1.0.0 |
| **Base URL** | `https://finnhub.io/api/v1` |
| **Auth** | API key in query param `token` |
| **Description** | Earnings actual-vs-consensus surprises, forward earnings + economic calendars with estimates. The consensus half of the fundamental event overlay. |
| **Tags** | `finance`, `market-data`, `fundamentals`, `events` |
| **Icon** | Finnhub |
| **Rate limit** | burst 30, 1/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `earnings-surprise` | `finnhub-earnings-surprise` | read | GET | `/stock/earnings` | `symbol` |
| `earnings-calendar` | `finnhub-earnings-calendar` | read | GET | `/calendar/earnings` | `from`, `to` |
| `economic-calendar` | `finnhub-economic-calendar` | read | GET | `/calendar/economic` | - |
| `company-metrics` | `finnhub-company-metrics` | read | GET | `/stock/metric` | `symbol` |

## Tools Exposed

- `finnhub-earnings-surprise`
- `finnhub-earnings-calendar`
- `finnhub-economic-calendar`
- `finnhub-company-metrics`
