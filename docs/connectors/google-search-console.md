# Google Search Console connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `google-search-console` |
| **Version** | 1.0.0 |
| **Base URL** | `https://www.googleapis.com/webmasters/v3` |
| **Auth** | OAuth2 (bearer) - scopes: https://www.googleapis.com/auth/webmasters.readonly |
| **Description** | Google Search Console — verified sites and search-analytics rows (clicks, impressions, queries) for the connected Google account. Requires the https://www.googleapis.com/auth/webmasters.readonly scope: add it to GOOGLE_CONNECT_SCOPES and RECONNECT the Google connection (scopes are fixed at connect time, not by this spec). |
| **Icon** | Google Search Console (verified) |
| **Rate limit** | burst 5, 5/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `sites` | `gsc-sites` | read | GET | `/sites` | - |
| `searchanalytics` | `gsc-search-analytics` | read | POST | `/sites/{siteUrl}/searchAnalytics/query` | `siteUrl`, `startDate`, `endDate`, `dimensions`, `rowLimit` |

## Tools Exposed

- `gsc-sites`
- `gsc-search-analytics`
