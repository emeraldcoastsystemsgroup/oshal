# Requests and defects

OSHAL uses GitHub Issues as the user-facing request record and projects new issues into its internal
backlog through signed native webhooks. No GitHub Actions workflow or hosted runner is involved.

## Choose the queue

| What needs to change | Preferred issue queue | Internal destination |
| --- | --- | --- |
| Installed applications, package behavior, or app/mobile UX | [Application requests](https://github.com/emeraldcoastsystemsgroup/oshal-applications/issues/new) | GitHub Application Requests / `build` |
| Core platform, cockpit, orchestration, connectors, or runtime | [Core requests](https://github.com/emeraldcoastsystemsgroup/open-shal/issues/new) | GitHub Core Requests / `oshal-dev` |
| Release-repository compatibility intake | [OSHAL release issues](https://github.com/emeraldcoastsystemsgroup/oshal/issues/new) | The same GitHub Core Requests queue |

During prerelease these repositories require collaborator access. The links become the public intake
path when repository visibility opens. Security vulnerabilities never belong in an issue; follow
[SECURITY.md](../../SECURITY.md) and email `maintainer@emeraldcoastsystemsgroup.com` privately.

## What happens after submission

1. GitHub signs and pushes the issue event to `POST /api/hooks/github/issues`.
2. OSHAL verifies the HMAC, deduplicates the delivery, checks the trusted repository list, and creates
   one backlog ticket keyed by `owner/repository#number`.
3. Application work stays in `oshal-applications`. Core work happens in `open-shal`; proven core
   releases land in `oshal`.
4. Later GitHub edits, closes, and reopens update the same internal projection. Optional read-only
   REST reconciliation can recover a missed webhook without consuming Actions minutes.

`request-only` describes the queue contract; it does not exclude bugs. With the default empty
required-label filter, every new issue after the fixed cutover is eligible for intake.

## Closure policy

- Intake, execution, internal completion, and ordinary writeback do not close GitHub issues.
- `bug` or `defect` always vetoes automated closure so a human can verify the repair.
- A non-defect issue becomes release-close eligible only when a maintainer applies the exact
  `code-write` label.
- The closing directive is allowed only on a pull request into the feed's configured release
  repository. Direct pushes, tags, unreadable labels, and the wrong release repository leave the
  issue open.

Human source closures are mirrored internally. That is separate from OSHAL autonomously closing an
issue; only a policy-approved release PR may do that.

## No-history boundary

The default feeds use the fixed cutover `2026-07-20T02:00:00Z`. Issues created before that instant are
not bulk-imported, even if someone edits them later. Accepted issues persist the title, body, labels,
URL, repository/number, actor, and lifecycle metadata needed to route and audit the work. "No history"
means no pre-cutover import, not that accepted request data is ephemeral.

Operator setup and recovery commands live in the [connector runbook](../connectors/RUNBOOK.md).
