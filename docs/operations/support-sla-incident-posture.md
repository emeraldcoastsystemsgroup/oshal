# OSHAL Support, SLA, And Incident Posture

Prepared: 2026-06-23

Status: design-partner operating posture. This is a starting support/SLA model for pilots and procurement review. It is not yet a public SaaS SLA.

## Scope

This posture applies to design-partner hosted deployments and operated pilots. Local self-host users are responsible for their own host, credentials, storage, network, and backups unless a managed support agreement says otherwise.

## Support Channels

| Channel | Use | Target Response |
|---|---|---|
| Operator email or ticket | Normal product questions, setup help, connector issues | 1 business day for pilots. |
| Incident channel | Security incident, outage, data-access concern, failed high-risk action guard | Same day for pilots. |
| Live working session | Onboarding, connector setup, deployment repair | Scheduled with design partner. |

Public self-serve support channels are not ready yet. Before public launch, add in-product support, email automation, status page, and documented escalation paths.

## Severity Model

| Severity | Definition | Pilot Response Target | Examples |
|---|---|---:|---|
| Sev 1 | Active security issue, cross-user data exposure, production unavailable | 4 hours | Isolation failure, auth bypass, full outage. |
| Sev 2 | Major feature unavailable or queue/worker stuck for live users | 1 business day | Connector runtime down, workflows not completing, hosted tunnel down. |
| Sev 3 | Degraded feature or recoverable user issue | 2 business days | Failed connector setup, slow screen, broken non-critical app. |
| Sev 4 | Question, enhancement, doc gap | Best effort | New connector request, UX suggestion. |

## Availability Target

Design-partner hosted target:

- Best-effort availability with documented maintenance windows.
- No public uptime SLA yet.
- Outages are handled through operator monitoring and incident response until managed monitoring is in place.

Public SaaS target before launch:

- Define uptime objective.
- Define error budget.
- Publish status page.
- Add automated monitoring and paging.
- Add tenant-visible incident notices.

## Incident Response

1. Triage impact: auth, isolation, data loss, connector write, payment/trading/social/home mutation, availability, or performance.
2. Contain: disable affected connector/app/tool, block risky writes, revoke tokens, or take hosted route offline if needed.
3. Preserve evidence: logs, audit export, task IDs, connector IDs, timestamps, screenshots, and affected user/tenant IDs.
4. Communicate: notify affected design partner with scope, mitigation, and next update time.
5. Remediate: patch code/config, rotate secrets if needed, rerun the relevant evidence proof.
6. Review: document root cause, blast radius, prevention, and updated tests.

## Backup And Recovery

Current proof:

- `docs/evidence/backup-restore-2026-06-22.md`

Pilot posture:

- Operator is responsible for backup schedule, restore verification, and storage location.
- Recovery target must be agreed per deployment.

Before public SaaS:

- Automated scheduled backups.
- Periodic restore test.
- RPO/RTO targets.
- Backup encryption and access policy.
- Tenant export and deletion workflow tied to audit.

## Maintenance

Design-partner posture:

- Maintenance is coordinated with the design partner.
- Breaking changes require preflight, backup, deployment note, and post-deploy smoke proof.

Public SaaS requirement:

- Published maintenance windows.
- Rollback plan.
- Versioned release notes.
- Public incident/status communication.

## Operational Proof Required For Upgrade

To move from design-partner posture to public SaaS posture, produce evidence for:

- Managed database and migration/rollback path.
- Worker/queue health and autoscale or capacity model.
- Monitoring dashboard.
- Alert rules and notification routing.
- Status page or incident communication channel.
- Backup and restore proof under hosted profile.
- RBAC-enforced admin audit export.
- Synthetic first-run and connector setup probes.

## Procurement Answer

Current buyer answer:

OSHAL can be operated for a design-partner pilot with explicit support expectations and operator involvement. It does not yet offer a public SaaS SLA. A public SLA requires managed hosting, monitoring, alerting, status communication, and a formal support process.
