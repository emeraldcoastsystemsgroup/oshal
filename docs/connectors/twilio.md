# Twilio connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `twilio` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.twilio.com/2010-04-01` |
| **Auth** | HTTP Basic (username/password) |
| **Description** | Read Twilio SMS message and call logs, owned phone numbers, and account details. |
| **Icon** | Twilio (verified) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `messages` | `twilio-messages` | read | GET | `/Accounts/{AccountSid}/Messages.json` | `AccountSid` |
| `message` | `twilio-message` | read | GET | `/Accounts/{AccountSid}/Messages/{Sid}.json` | `AccountSid`, `Sid` |
| `calls` | `twilio-calls` | read | GET | `/Accounts/{AccountSid}/Calls.json` | `AccountSid` |
| `incoming-phone-numbers` | `twilio-incoming-phone-numbers` | read | GET | `/Accounts/{AccountSid}/IncomingPhoneNumbers.json` | `AccountSid` |
| `account` | `twilio-account` | read | GET | `/Accounts/{AccountSid}.json` | `AccountSid` |

## Tools Exposed

- `twilio-messages`
- `twilio-message`
- `twilio-calls`
- `twilio-incoming-phone-numbers`
- `twilio-account`
