# Tenable connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `tenable` |
| **Version** | 1.0.0 |
| **Base URL** | `https://cloud.tenable.com` |
| **Auth** | API key in header `X-ApiKeys` |
| **Rate limit** | burst 5, 5/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `scans` | `tenable-scans` | read | GET | `/scans` | - |
| `scan` | `tenable-scan` | read | GET | `/scans/{scanId}` | `scanId` |
| `assets` | `tenable-assets` | read | GET | `/assets` | - |
| `vulnerabilities` | `tenable-vulnerabilities` | read | GET | `/workbenches/vulnerabilities` | `dateRange`, `filterField`, `filterOp`, `filterValue` |
| `asset-vulnerabilities` | `tenable-asset-vulnerabilities` | read | GET | `/workbenches/assets/{assetId}/vulnerabilities` | `assetId` |

## Tools Exposed

- `tenable-scans`
- `tenable-scan`
- `tenable-assets`
- `tenable-vulnerabilities`
- `tenable-asset-vulnerabilities`
