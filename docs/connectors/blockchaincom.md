# Blockchain.com connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `blockchaincom` |
| **Version** | 1.0.0 |
| **Base URL** | `https://blockchain.info` |
| **Auth** | None |
| **Icon** | Blockchain.com (verified) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `rawaddr` | `blockchaincom-rawaddr` | read | GET | `/rawaddr/{address}` | `address` |
| `rawtx` | `blockchaincom-rawtx` | read | GET | `/rawtx/{tx_hash}` | `tx_hash` |
| `ticker` | `blockchaincom-ticker` | read | GET | `/ticker` | - |

## Tools Exposed

- `blockchaincom-rawaddr`
- `blockchaincom-rawtx`
- `blockchaincom-ticker`
