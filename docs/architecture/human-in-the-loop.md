# Human-in-the-Loop (approval gates) + super-admin / dev access

How authored workflows pause for a human, how a human (or the dev/admin) approves them, and
how super-admin access works in the dev sandbox vs. the secure tenant-user flow.

---

## 1. Approval gates pause the workflow

Authored workflows run on the graph engine (the `graph` queue-manager dispatch path →
`ProcessDefinitionExecutionEngine`). When the engine walks an **`approval-gate`** node:

1. The engine **suspends** the run and returns `outcome: 'suspended'` + `resumeNodeId`
   (the gate's successor node).
2. The graph dispatcher persists the resume point on the ticket
   (`metadata.graphResumeNode`) and parks the ticket at status **`approval_required`**.
3. The queue manager only polls `approved` tickets, so the ticket **waits** here — no bot
   runs the rest of the workflow until a human approves.
4. On approval the ticket flips to `approved`, the next poll re-dispatches it, and the engine
   **resumes from the gate's successor** — completed stages are not re-run.

Stages before the gate have already dispatched to their bots; stages after the gate only run
after approval. This is the human checkpoint.

---

## 2. How to approve a parked ticket (three ways)

A ticket sitting at `approval_required` is resumed by moving it back to `approved`:

- **Cockpit UI** — the ticket's resume/approve action.
- **API** — `PUT /api/tickets/:ticketId/resume` (allowed for the ticket **owner** or an
  **operator**; see §3). Returns `{ status: 'approved' }`; the next poll resumes it.
- **Dev/admin break-glass (sandbox)** — flip the row directly in Postgres. As the sandbox
  super-admin you can drive the whole loop headless, e.g.:

  ```sql
  UPDATE tickets SET status = 'approved' WHERE ticket_id = '<uuid>';
  ```

  Use this to self-test gate workflows end-to-end without a UI. It is a dev convenience, not a
  production path — real approvals go through the API/UI with auth.

---

## 3. Super-admin / dev access vs. secure tenant users

Two distinct planes — keep them separate:

- **Secure tenant-user plane (production):** real users authenticate via **OIDC** (Keycloak),
  sessions/state backed by **Redis**, scoped to their own data (`ownerSub`) and tenant. Users
  are **not** admins. This is the system we are hardening (and where credential rotation etc.
  will live).
- **Super-admin / operator plane (devs):** an **operator** can approve/override any ticket,
  see all queues, publish public/tenant workflows, and read operator-gated routes. Operator
  status is an explicit allowlist (fail-closed) in `src/shared/middleware/authz.ts`:

  ```bash
  # Become super-admin in the dev sandbox — match the MOCK_OIDC dev identity:
  OSHAL_OPERATOR_EMAILS=alex@demo.local
  # or by subject:
  OSHAL_OPERATOR_SUBS=mock-user-001
  ```

  (`isOperator()` matches the caller's OIDC `sub`/`email` against these. Empty allowlist =
  no operators, so operator-gated views simply scope to the caller — they never leak.)

In the dev sandbox **the dev is the god** of the system: set the allowlist to your identity
and you can drive every human-in-the-loop step (approve gates, resume/override tickets,
publish at any scope). Establishing OIDC + Redis (secure user auth) is one thing; making sure
**super-admin devs can actually operate** is a separate, required capability — that is the
operator allowlist above.

---

## 4. Drive a gate workflow end-to-end (dev-admin)

1. **Publish** a 2-stage workflow with a gate (Workflow Studio → Publish, or
   `POST /api/swarm/apps/publish` with a `staged` spec where a stage has `approvalAfter: true`).
   Publish compiles it to a `graph` workflow (`start → execute-agent → approval-gate →
   execute-agent → deliver`).
2. **Create a ticket** of that workflow's `ticketType` (status `approved`).
3. The poll cycle dispatches it: stage 1's bot runs, then the ticket **parks at
   `approval_required`** with `metadata.graphResumeNode` set.
4. **Approve** it (§2) → stage 2's bot runs → `deliver` → status `complete`.

Unit coverage for the suspend/resume control flow:
`tests/unit/process-definition-engine-suspend.spec.ts`.

---

## 5. Backlog

- Finer-grained admin roles (beyond the binary operator allowlist).
- Credential rotation for the super-admin / broker planes.
- Surfacing parked-at-gate tickets prominently in the cockpit with one-click approve.
