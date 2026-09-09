# RingCentral connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `ringcentral` |
| **Version** | 1.0.0 |
| **Base URL** | `https://platform.ringcentral.com` |
| **Auth** | OAuth2 (bearer) |
| **Description** | RingCentral cloud phone: live active-call state for CRM screen-pop, call log, recordings, presence, extensions, and the SMS/voicemail message store. |
| **Rate limit** | burst 5, 5/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `account` | `ringcentral-account` | read | GET | `/restapi/v1.0/account/~` | - |
| `extension` | `ringcentral-extension` | read | GET | `/restapi/v1.0/account/~/extension/~` | - |
| `list-extensions` | `ringcentral-list-extensions` | read | GET | `/restapi/v1.0/account/~/extension` | `page`, `perPage`, `status`, `type` |
| `phone-numbers` | `ringcentral-phone-numbers` | read | GET | `/restapi/v1.0/account/~/phone-number` | `page`, `perPage` |
| `active-calls` | `ringcentral-active-calls` | read | GET | `/restapi/v1.0/account/~/extension/~/active-calls` | `view`, `page`, `perPage` |
| `company-active-calls` | `ringcentral-company-active-calls` | read | GET | `/restapi/v1.0/account/~/active-calls` | `page`, `perPage` |
| `presence` | `ringcentral-presence` | read | GET | `/restapi/v1.0/account/~/extension/~/presence` | `detailedTelephonyState` |
| `call-log` | `ringcentral-call-log` | read | GET | `/restapi/v1.0/account/~/extension/~/call-log` | `dateFrom`, `dateTo`, `direction`, `type`, `phoneNumber`, `view`, `page`, `perPage` |
| `company-call-log` | `ringcentral-company-call-log` | read | GET | `/restapi/v1.0/account/~/call-log` | `dateFrom`, `dateTo`, `direction`, `extensionNumber`, `phoneNumber`, `view`, `page`, `perPage` |
| `call-log-record` | `ringcentral-call-log-record` | read | GET | `/restapi/v1.0/account/~/extension/~/call-log/{recordId}` | `recordId` |
| `call-recording` | `ringcentral-call-recording` | read | GET | `/restapi/v1.0/account/~/recording/{recordingId}` | `recordingId` |
| `message-store` | `ringcentral-message-store` | read | GET | `/restapi/v1.0/account/~/extension/~/message-store` | `dateFrom`, `dateTo`, `messageType`, `direction`, `phoneNumber`, `page`, `perPage` |
| `message` | `ringcentral-message` | read | GET | `/restapi/v1.0/account/~/extension/~/message-store/{messageId}` | `messageId` |

## Tools Exposed

- `ringcentral-account`
- `ringcentral-extension`
- `ringcentral-list-extensions`
- `ringcentral-phone-numbers`
- `ringcentral-active-calls`
- `ringcentral-company-active-calls`
- `ringcentral-presence`
- `ringcentral-call-log`
- `ringcentral-company-call-log`
- `ringcentral-call-log-record`
- `ringcentral-call-recording`
- `ringcentral-message-store`
- `ringcentral-message`
