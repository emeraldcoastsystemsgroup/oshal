# Tenant provisioning (isolated tier)

`scripts/governance/provision-tenant.sh` renders the database policy and the namespace policy for
one tenant. It covers one tenancy, `isolated`: each tenant gets its own database
([ADR-035](../adr/035-multi-tenant-saas-foundation.md), as amended on 2026-09-21). The script
connects to nothing. It writes two files, and you apply them with `psql` and `kubectl`.

The shared tier is **not commissioned**. `--tenancy=shared` is refused with exit 2 and renders
nothing. The operator decision of 2026-09-21 says the shared tier is revisited only for "a real
customer whose economics require sharing one database".

## Render

```bash
bash scripts/governance/provision-tenant.sh acme --tenancy=isolated \
  --db-host=oshal-db.oshal.svc.cluster.local \
  --apiserver-cidr="$(kubectl get endpoints kubernetes -o jsonpath='{.subsets[0].addresses[0].ip}')/32" \
  --out=./tenant-acme
```

| Argument | Required | Meaning |
|---|---|---|
| `<name>` | yes | Tenant slug: lower-case letters, digits and hyphens, 1-40 characters. It must start with a letter and must not end with a hyphen. |
| `--tenancy=isolated` | yes | The only accepted value. `shared` is refused as not commissioned, and any other value is refused as unknown. |
| `--db-host=<host>` | yes | The PostgreSQL server that holds the tenant's database. It is written into the ConfigMap. |
| `--apiserver-cidr=<a.b.c.d/n>` | yes | The kube-apiserver endpoint. Argo's wait sidecar needs it, and a namespace selector cannot match it. |
| `--out=<dir>` | yes | The directory the two files are written to. If `database.sql` or `namespace.yaml` already exists there, the script refuses and does not overwrite it. |
| `--db-port=<n>` | no (5432) | Written into the ConfigMap. |
| `--connection-limit=<n>` | no (24) | `CONNECTION LIMIT` on the tenant's role, so one tenant cannot use up the server's connections. |

Every identifier comes from the name and from nothing else:

| Object | Name for tenant `acme` | Name for tenant `north-1` |
|---|---|---|
| PostgreSQL role and database | `oshal_tenant_acme` | `oshal_tenant_north_1` |
| Kubernetes namespace | `oshal-tenant-acme` | `oshal-tenant-north-1` |

Exit codes: 0 means rendered. 2 means refused: bad usage or input, the shared tier, or output
already present. Both files are staged and then moved into place, so a refused or failed run
leaves neither file behind.

## What `database.sql` does

You run it with `psql` as a superuser on the tenant's server. Running it again repeats every
statement and removes any drift.

1. **Password guard.** The password comes from `OSHAL_TENANT_DB_PASSWORD`, read with `\getenv`,
   or from `psql -v tenant_password=...`. It is never written into the file. If the password is
   missing or shorter than 16 characters, the script raises an error before it creates anything.
2. **The tenant's own role.** The role is `LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
   NOREPLICATION NOBYPASSRLS NOINHERIT` with a connection limit. The script revokes every
   membership the role holds and every membership another role holds in it, using `GRANTED BY`
   the original grantor. Either kind of membership would let one tenant `SET ROLE` into another.
3. **The tenant's own database.** The database is created from `template0` and owned by the
   tenant's role.
4. **Connection policy.** The script revokes `CONNECT` and `TEMPORARY` from `PUBLIC`, which holds
   both on a new database by default. It also revokes them from every other grantee. It then
   grants them to the tenant's role only.
5. **Schema policy.** Inside the database, the `public` schema is owned by the tenant's role, and
   `PUBLIC` loses `USAGE` and `CREATE` on it. A role that somehow reached this database could not
   name a table in it, even a table the tenant itself granted to `PUBLIC`.

## What `namespace.yaml` contains

The objects follow the ADR-078 per-tenant layout
(`ops/deployment/argo/tenant-namespace.example.yaml`):

- `Namespace` `oshal-tenant-<name>`, labelled `oshal.io/tenant` and `oshal.io/tenancy: isolated`.
- `ResourceQuota` and `LimitRange`, with the ADR-078 example values. To resize, edit the
  rendered file.
- `NetworkPolicy` `default-deny-all` and `NetworkPolicy` `allow-same-tenant`. These are the
  names `scripts/governance/verify-tenant-isolation.sh` asserts. `allow-same-tenant` allows
  traffic only to and from:
  - the same tenant
  - kube-dns
  - the `oshal` control-plane namespace, which serves the database in this layout
  - the `oshal-model` namespace
  - the apiserver `ipBlock`

  No peer in another tenant's namespace is allowed. A database server outside the cluster needs
  its own `ipBlock` egress rule added to `allow-same-tenant`.
- The `oshal-workflow` ServiceAccount, with a Role and RoleBinding over its own pods and Argo
  task results.
- `ConfigMap` `oshal-tenant-db`. It binds the namespace to its own database with the keys
  `OSHAL_TENANT`, `OSHAL_TENANCY`, `TENANT_DB_HOST`, `TENANT_DB_PORT`, `TENANT_DB_NAME` and
  `TENANT_DB_USER`. It holds no password, and no password Secret is rendered or created:
  nothing in a tenant namespace uses the tenant database yet (see [Not built](#not-built)).

## Apply

```bash
export OSHAL_TENANT_DB_PASSWORD="$(openssl rand -hex 24)"   # keep it in your secret store
psql "<superuser connection to the tenant's server>" -X -v ON_ERROR_STOP=1 -f ./tenant-acme/database.sql
kubectl apply -f ./tenant-acme/namespace.yaml
```

`database.sql` needs psql 15 or newer, for `\getenv`. The proof applies it with the psql 16
inside `postgres:16-alpine`, as the superuser `postgres`.

## Accept on a cluster

`scripts/governance/accept-tenant-isolation.sh` is the automated cluster acceptance for the
namespace half. Run it on a cluster whose CNI enforces NetworkPolicy:

```bash
bash scripts/governance/accept-tenant-isolation.sh --context <kube-context>   --apiserver-cidr "$(kubectl --context <kube-context> get endpoints kubernetes -o jsonpath='{.subsets[0].addresses[0].ip}')/32"   --db-host oshal-db.oshal.svc.cluster.local --image nginx:alpine
```

Every kubectl call carries `--context`. The script:

1. Refuses, creating nothing, unless kubectl is present, an API server answers at the context, and
   both namespaces it is about to create answer `NotFound`.
2. Renders tenants `acc-<run>-a` and `acc-<run>-b` with `provision-tenant.sh`, where `<run>` is
   8 random hex digits.
3. Applies each `namespace.yaml` and starts pod `web` (label `app=web`, port 80) in each.
4. Waits for both pods to be Ready, then runs
   `verify-tenant-isolation.sh --namespaces oshal-tenant-acc-<run>-a,oshal-tenant-acc-<run>-b`:
   same-namespace traffic must flow, cross-namespace traffic must be refused both ways, and both
   policies and the dependency grants must be present.
5. Deletes exactly the two namespaces it created and confirms each answers `NotFound`.

Exit 0 means isolation was proven and both namespaces are gone. Exit 1 means isolation was not
proven, a pod never became Ready, or cleanup was incomplete. An incomplete cleanup is red even
when isolation passed, and the output names the namespaces still present. Exit 2 means it refused
before creating anything. `--image` must serve HTTP on port 80 and carry `timeout` and `wget`;
`--timeout` (default 180 seconds) bounds each pod wait and each deletion.

`verify-tenant-isolation.sh` takes the two namespaces as `--namespaces <a>,<b>`. Without it, it
judges `tenant-a` and `tenant-b`, as `scripts/ci/check-cluster-gates.sh` expects.

## What is proven, and where

`tests/unit/provision-tenant-isolation-postgres.spec.ts` runs the shipped script in Git Bash. It
applies each rendered `database.sql` with the real psql inside a PostgreSQL 16 container that it
starts and destroys, and it never touches a running stack. It then connects over TCP as each
tenant's own role and checks the following:

- Each tenant connects to its own database and reads its own rows. Each role is
  non-privileged and has the connection limit. `PUBLIC` has no `CONNECT` on either database.
- **A cross-tenant database connection is refused in both directions**: `42501 permission
  denied for database`.
- **A cross-tenant row read is refused.** A cross-database reference from the tenant's own
  session fails with `0A000`. The test then grants the other tenant's database `CONNECT` to this
  tenant, so that the connection layer has drifted open. The read of the other tenant's rows is
  still refused at the schema with `42501 permission denied for schema public`, even for a table
  that tenant granted to `PUBLIC`. Re-applying the rendered file closes the connection again.
- Re-applying removes a membership in either direction that let one tenant `SET ROLE` into the
  other, and the tenant's data survives.
- Applying without a password, or with a short one, creates no role and no database.
- `--tenancy=shared` is refused and writes nothing. Every malformed input is refused, and an
  existing rendering is not overwritten.
- The namespace objects match the structure described above. Two tenants' renderings differ
  only in their names. A tenant name that YAML would read as another type, such as `no`, stays a
  string.

- The rendering governs only the databases it creates. The server's other databases keep
  PostgreSQL's default `PUBLIC` `CONNECT`, so the tenant's role can open them: the case connects
  to `postgres` and to the fixture's own database. See [Not built](#not-built).

These statements are mutation-checked: removing any one of them turns at least one case red.

- the missing-password guard and the 16-character minimum
- `NOINHERIT` and `CONNECTION LIMIT` on the role
- both membership revokes
- the `PUBLIC` connect revoke and the other-grantee connect revoke
- the `public` schema revoke

Collapsing the role name so it no longer comes from the tenant name, or accepting `shared`, also
turns cases red. No other statement is claimed as guarded. In particular, removing
`GRANT CONNECT, TEMPORARY ON DATABASE ... TO <role>` leaves every case green, because the
database owner already holds those rights.

`tests/unit/accept-tenant-isolation.spec.ts` proves the acceptance script's logic against a
stateful kubectl stand-in, with `provision-tenant.sh` and `verify-tenant-isolation.sh` running for
real. It covers the accepting run, which deletes exactly the two namespaces it created, and the
cases that must not accept: cross-namespace traffic flowing, a pod that cannot reach itself, a pod
that never becomes Ready, and an incomplete cleanup. It also covers the refusals that create
nothing. It reaches no cluster, so it is not cluster evidence.

Both suites run in the isolated nightly runner (`npm run test:nightly-isolated`). Both are
registered in the AI Test Lab under **Isolated nightly regressions**.

Not proven yet: a run of `accept-tenant-isolation.sh` on a real NetworkPolicy-enforcing cluster.

## Not built

- **Running oshal inside a tenant database.** The rendered database is empty. This script does
  not apply oshal's migrations to it or provision runtime roles in it. The runtime-role
  provisioner `scripts/governance/provision-app-role.mjs` requires the exact cluster-wide role
  names `oshal_app` and `oshal_bot` (lines 253-257), and PostgreSQL roles span the whole server.
  As built, two tenants' stacks on one server would share those two roles.
- **Isolation from the server's other databases.** The rendering closes only the tenant's own
  database. Any other database on the same server that keeps the default `PUBLIC` `CONNECT`
  (`postgres`, or the control-plane `oshal` database if it shares the server) can be opened by a
  tenant's role. Closing that means revoking `PUBLIC` `CONNECT` on those databases and granting
  it to the roles that need it, which changes the control plane's database. It is not done here.
- **Tenant root entity, realm per tenant and seat licensing.** These are ADR-035 pillars 2-4 and
  remain unbuilt.
