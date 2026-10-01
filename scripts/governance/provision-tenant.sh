#!/usr/bin/env bash
#
# CHANGE LOG
# -----------------------------------------------------------------------------
# SEQ                 | AUTHOR                      | DESCRIPTION
# -----------------------------------------------------------------------------
# 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — render one tenant's database and namespace policy for the ISOLATED tier only (ADR-035 as amended 2026-09-21: a database per tenant). The database half gives the tenant its own LOGIN role (no superuser, no RLS bypass, no role/database creation, inherits nothing, belongs to no other role and held by none) and its own database owned by that role, with CONNECT and TEMPORARY revoked from PUBLIC and from every other grantee, and USAGE/CREATE on the public schema revoked from PUBLIC inside it - so another tenant's role can neither open the database nor, if that layer ever drifted open, name a table in it. The password is read at apply time (psql variable or OSHAL_TENANT_DB_PASSWORD via \getenv) and never written to disk. Re-applying converges drift. The namespace half is the ADR-078 per-tenant shape (quota, limits, default-deny plus same-tenant NetworkPolicy under the names verify-tenant-isolation.sh asserts, workflow ServiceAccount/RBAC) and a ConfigMap binding the namespace to its own database. --tenancy=shared is refused: that tier is not commissioned. Proven by tests/unit/provision-tenant-isolation-postgres.spec.ts on a disposable PostgreSQL.
# 2 | maintainer@emeraldcoastsystemsgroup.com   | Split the network and access renderers so every function stays under 50 lines (default-deny, allow-same-tenant with its egress block, workflow RBAC, and the database-binding ConfigMap each render alone; the output is byte-identical). The ConfigMap's comment now says plainly that no password Secret is rendered or created, because nothing in a tenant namespace uses the tenant database yet - it used to promise a runbook step that does not exist.
# 3 | maintainer@emeraldcoastsystemsgroup.com   | The --tenancy=shared refusal follows the operator decision of 2026-10-01: it no longer says the shared tier is revisited only for a customer whose economics require one database. It says the shared tier is not built, isolated is the only tenancy today, and a shared mode is planned under the backlog enhancement "Tenancy modes: shared, isolated and federated". Behaviour is unchanged: exit 2, nothing written.
#
# Usage:
#   bash scripts/governance/provision-tenant.sh <name> --tenancy=isolated \
#     --db-host=<host> --apiserver-cidr=<a.b.c.d/n> --out=<dir> \
#     [--db-port=5432] [--connection-limit=24]
#
#   <name>  the tenant slug: lower-case letters, digits and hyphens, 1-40 characters, starting
#           with a letter and not ending with a hyphen. Every identifier below derives from it
#           and from nothing else: role and database oshal_tenant_<name with - as _>,
#           namespace oshal-tenant-<name>.
#
# Writes into <dir> (created when missing; an existing database.sql or namespace.yaml is refused,
# never overwritten):
#   database.sql    psql script for the tenant's PostgreSQL server.
#   namespace.yaml  Kubernetes objects for the tenant's namespace.
#
# Apply them (see docs/runbooks/tenant-provisioning.md):
#   OSHAL_TENANT_DB_PASSWORD="$(openssl rand -hex 24)" \
#     psql "<superuser connection>" -X -v ON_ERROR_STOP=1 -f <dir>/database.sql
#   kubectl apply -f <dir>/namespace.yaml
#
# --tenancy is required and takes one value today, `isolated`. `shared` is refused: the operator
# decision of 2026-09-21 (docs/BACKLOG.md "Two-tier tenant provisioning", ADR-035 amendment)
# records the shared tier as not commissioned. The flag keeps its name so that tier can be added
# later without changing the interface. A shared mode is planned under the backlog enhancement
# "Tenancy modes: shared, isolated and federated" (operator, 2026-10-01); none of it is built.
#
# Exit: 0 rendered. 2 refused: usage, invalid input, the shared tier, or output already present.

set -euo pipefail

# Resource ceilings per tenant namespace: the ADR-078 example values
# (ops/deployment/argo/tenant-namespace.example.yaml). Resize in the rendered file.
readonly QUOTA_REQUESTS_CPU='8'
readonly QUOTA_REQUESTS_MEMORY='16Gi'
readonly QUOTA_LIMITS_CPU='16'
readonly QUOTA_LIMITS_MEMORY='32Gi'
readonly QUOTA_PODS='50'
readonly QUOTA_WORKFLOWS='100'
# The shared namespaces a tenant workload may reach (ADR-078 layout; verify-tenant-isolation.sh
# asserts both grants).
readonly CONTROL_NAMESPACE='oshal'
readonly MODEL_NAMESPACE='oshal-model'

refuse() { echo "provision-tenant: refused: $*" >&2; exit 2; }

usage() {
  echo "usage: provision-tenant.sh <name> --tenancy=isolated --db-host=<host> --apiserver-cidr=<a.b.c.d/n> --out=<dir> [--db-port=5432] [--connection-limit=24]" >&2
}

NAME=''; TENANCY=''; DB_HOST=''; DB_PORT='5432'; CIDR=''; OUT=''; CONN_LIMIT='24'

# @description Read the command line into the globals above, refusing anything unrecognised.
# @param $@ The script's arguments.
# @returns Nothing; exits 2 on a malformed command line.
parse_args() {
  [ "$#" -gt 0 ] || { usage; refuse "a tenant name is required"; }
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --tenancy=*) TENANCY="${1#*=}" ;;
      --db-host=*) DB_HOST="${1#*=}" ;;
      --db-port=*) DB_PORT="${1#*=}" ;;
      --apiserver-cidr=*) CIDR="${1#*=}" ;;
      --out=*) OUT="${1#*=}" ;;
      --connection-limit=*) CONN_LIMIT="${1#*=}" ;;
      -h|--help) usage; exit 0 ;;
      -*) usage; refuse "unknown argument: $1" ;;
      *) [ -z "$NAME" ] || { usage; refuse "one tenant name only (got '$NAME' and '$1')"; }
         NAME="$1" ;;
    esac
    shift
  done
}

# @description Refuse every tenancy but `isolated`, naming why `shared` is not available.
# @returns Nothing; exits 2 unless the tenancy is `isolated`.
check_tenancy() {
  case "$TENANCY" in
    isolated) ;;
    shared) refuse "--tenancy=shared is not built: isolated (a database per tenant) is the only tenancy today. A shared mode is planned under the backlog enhancement \"Tenancy modes: shared, isolated and federated\" (operator, 2026-10-01); none of it exists yet." ;;
    '') usage; refuse "--tenancy is required (isolated)" ;;
    *) refuse "unknown tenancy '$TENANCY' (isolated)" ;;
  esac
}

# @description Validate an IPv4 CIDR, octet by octet.
# @param $1 The candidate CIDR.
# @returns 0 when it is a well-formed IPv4 CIDR, 1 otherwise.
valid_cidr() {
  [[ "$1" =~ ^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})/([0-9]{1,2})$ ]] || return 1
  local octet
  for octet in "${BASH_REMATCH[@]:1:4}"; do [ "$((10#$octet))" -le 255 ] || return 1; done
  [ "$((10#${BASH_REMATCH[5]}))" -le 32 ]
}

# @description Validate every input before anything is written.
# @returns Nothing; exits 2 on the first invalid value.
check_inputs() {
  [ -n "$NAME" ] || { usage; refuse "a tenant name is required"; }
  [[ "$NAME" =~ ^[a-z]([a-z0-9-]{0,38}[a-z0-9])?$ ]] \
    || refuse "invalid tenant name '$NAME': lower-case letters, digits and hyphens, 1-40 characters, starting with a letter, not ending with a hyphen"
  check_tenancy
  [ -n "$DB_HOST" ] || refuse "--db-host is required (the PostgreSQL server that holds the tenant's database)"
  [[ "$DB_HOST" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$ ]] || refuse "invalid --db-host '$DB_HOST'"
  [[ "$DB_PORT" =~ ^[0-9]{1,5}$ ]] && [ "$((10#$DB_PORT))" -ge 1 ] && [ "$((10#$DB_PORT))" -le 65535 ] \
    || refuse "invalid --db-port '$DB_PORT'"
  [ -n "$CIDR" ] || refuse "--apiserver-cidr is required (kubectl get endpoints kubernetes)"
  valid_cidr "$CIDR" || refuse "invalid --apiserver-cidr '$CIDR' (expected an IPv4 CIDR such as a.b.c.d/32)"
  [[ "$CONN_LIMIT" =~ ^[0-9]{1,5}$ ]] && [ "$((10#$CONN_LIMIT))" -ge 1 ] \
    || refuse "invalid --connection-limit '$CONN_LIMIT' (a positive integer)"
  [ -n "$OUT" ] || refuse "--out is required (the directory the two files are written to)"
  local file
  for file in database.sql namespace.yaml; do
    [ ! -e "$OUT/$file" ] || refuse "$OUT/$file already exists; render into an empty directory"
  done
}

# @description The role half of database.sql: the password guard, the tenant's own LOGIN role,
# and its memberships cleared in both directions.
# @returns The SQL on stdout.
render_role_sql() {
  cat <<SQL
\\set ON_ERROR_STOP on
-- The password is supplied at apply time and never written into this file.
\\if :{?tenant_password}
\\else
\\getenv tenant_password OSHAL_TENANT_DB_PASSWORD
\\endif
\\if :{?tenant_password}
SELECT length(:'tenant_password') < 16 AS tenant_password_too_short \\gset
\\if :tenant_password_too_short
DO \$\$ BEGIN RAISE EXCEPTION 'refused: the tenant password must be at least 16 characters'; END \$\$;
\\endif
\\else
DO \$\$ BEGIN RAISE EXCEPTION 'refused: set OSHAL_TENANT_DB_PASSWORD (or psql -v tenant_password=...)'; END \$\$;
\\endif

-- 1. The tenant's own login role. No superuser, no row-level-security bypass, no role or
--    database creation, no replication, and it inherits nothing.
SELECT format('CREATE ROLE %I', '${ROLE}')
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${ROLE}') \\gexec
ALTER ROLE ${ROLE} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
  NOINHERIT CONNECTION LIMIT ${CONN_LIMIT} PASSWORD :'tenant_password';
-- It belongs to no other role and no other role holds it: either membership would let one
-- tenant SET ROLE into another.
SELECT format('REVOKE %I FROM %I GRANTED BY %I', r.rolname, '${ROLE}', g.rolname)
  FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.roleid JOIN pg_roles g ON g.oid = m.grantor
 WHERE m.member = '${ROLE}'::regrole \\gexec
SELECT format('REVOKE %I FROM %I GRANTED BY %I', '${ROLE}', r.rolname, g.rolname)
  FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member JOIN pg_roles g ON g.oid = m.grantor
 WHERE m.roleid = '${ROLE}'::regrole \\gexec
SQL
}

# @description The database half of database.sql: the tenant's own database, who may connect to
# it, and its public schema closed to PUBLIC.
# @returns The SQL on stdout.
render_database_sql() {
  cat <<SQL

-- 2. The tenant's own database, owned by its role, created from the pristine template.
SELECT format('CREATE DATABASE %I OWNER %I TEMPLATE template0', '${DATABASE}', '${ROLE}')
 WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = '${DATABASE}') \\gexec
ALTER DATABASE ${DATABASE} OWNER TO ${ROLE};

-- 3. Only the tenant's own role may connect. A new database grants CONNECT and TEMPORARY to
--    PUBLIC by default, and that default is what would let another tenant's role in. Any other
--    grantee is removed too, so re-applying this file repairs drift.
REVOKE ALL ON DATABASE ${DATABASE} FROM PUBLIC;
SELECT DISTINCT format('REVOKE ALL ON DATABASE %I FROM %I', d.datname, g.rolname)
  FROM pg_database d CROSS JOIN LATERAL aclexplode(d.datacl) a JOIN pg_roles g ON g.oid = a.grantee
 WHERE d.datname = '${DATABASE}' AND g.rolname <> '${ROLE}' \\gexec
GRANT CONNECT, TEMPORARY ON DATABASE ${DATABASE} TO ${ROLE};

-- 4. Inside the database the public schema belongs to the tenant, and PUBLIC loses USAGE and
--    CREATE on it: a role that ever reached this database could not name a table in it, even a
--    table the tenant itself granted to PUBLIC.
\\connect ${DATABASE}
ALTER SCHEMA public OWNER TO ${ROLE};
REVOKE ALL ON SCHEMA public FROM PUBLIC;
SQL
}

# @description The whole database.sql, header first.
# @returns The SQL on stdout.
render_database_file() {
  cat <<SQL
-- =============================================================================
-- Tenant "${NAME}" - database policy (tenancy: isolated, a database per tenant)
-- Rendered by scripts/governance/provision-tenant.sh. Re-render rather than edit.
--
-- Apply as a superuser on the tenant's PostgreSQL server:
--   OSHAL_TENANT_DB_PASSWORD=<at least 16 characters> \\
--     psql "<superuser connection>" -X -v ON_ERROR_STOP=1 -f database.sql
-- Role and database: ${ROLE}. Re-applying converges: every statement below is re-asserted.
-- =============================================================================
SQL
  render_role_sql
  render_database_sql
}

# @description The namespace, its resource ceilings and per-pod defaults.
# @returns YAML documents on stdout.
render_namespace_yaml() {
  cat <<YAML
---
apiVersion: v1
kind: Namespace
metadata:
  name: ${NAMESPACE}
  labels:
    app.kubernetes.io/part-of: oshal
    oshal.io/tenant: "${NAME}"
    oshal.io/tenancy: isolated
    kubernetes.io/metadata.name: ${NAMESPACE}
---
apiVersion: v1
kind: ResourceQuota
metadata:
  name: oshal-tenant-quota
  namespace: ${NAMESPACE}
spec:
  hard:
    requests.cpu: "${QUOTA_REQUESTS_CPU}"
    requests.memory: ${QUOTA_REQUESTS_MEMORY}
    limits.cpu: "${QUOTA_LIMITS_CPU}"
    limits.memory: ${QUOTA_LIMITS_MEMORY}
    count/pods: "${QUOTA_PODS}"
    count/workflows.argoproj.io: "${QUOTA_WORKFLOWS}"
---
apiVersion: v1
kind: LimitRange
metadata:
  name: oshal-tenant-defaults
  namespace: ${NAMESPACE}
spec:
  limits:
    - type: Container
      default:
        cpu: "1"
        memory: 2Gi
      defaultRequest:
        cpu: 250m
        memory: 512Mi
YAML
}

# @description Deny all ingress and egress in the namespace unless a policy below allows it.
# @returns One YAML document on stdout.
render_default_deny_yaml() {
  cat <<YAML
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny-all
  namespace: ${NAMESPACE}
spec:
  podSelector: {}
  policyTypes: [Ingress, Egress]
YAML
}

# @description The same-tenant re-grant: ingress only from this tenant's namespace, then the egress
# rules below. No peer in another tenant namespace.
# @returns One YAML document on stdout.
render_allow_same_tenant_yaml() {
  cat <<YAML
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-same-tenant
  namespace: ${NAMESPACE}
spec:
  podSelector: {}
  policyTypes: [Ingress, Egress]
  ingress:
    - from:
        - namespaceSelector:
            matchLabels:
              oshal.io/tenant: "${NAME}"
YAML
  render_same_tenant_egress_yaml
}

# @description The egress half of allow-same-tenant: this tenant's namespace, DNS, the shared control
# plane (which serves the tenant's database in the ADR-078 layout), the model namespace, and the
# apiserver.
# @returns The egress block on stdout.
render_same_tenant_egress_yaml() {
  cat <<YAML
  egress:
    - to:
        - namespaceSelector:
            matchLabels:
              oshal.io/tenant: "${NAME}"
    - to:
        - namespaceSelector: {}
          podSelector:
            matchLabels:
              k8s-app: kube-dns
      ports:
        - protocol: UDP
          port: 53
        - protocol: TCP
          port: 53
    - to:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: ${CONTROL_NAMESPACE}
    - to:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: ${MODEL_NAMESPACE}
    - to:
        - ipBlock:
            cidr: ${CIDR}
      ports:
        - protocol: TCP
          port: 6443
        - protocol: TCP
          port: 443
YAML
}

# @description The workflow ServiceAccount, with rights over its own pods and Argo task results only.
# @returns YAML documents on stdout.
render_workflow_access_yaml() {
  cat <<YAML
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: oshal-workflow
  namespace: ${NAMESPACE}
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: oshal-workflow
  namespace: ${NAMESPACE}
rules:
  - apiGroups: [""]
    resources: [pods, pods/log]
    verbs: [get, list, watch, create, delete]
  - apiGroups: [argoproj.io]
    resources: [workflowtaskresults]
    verbs: [create, patch]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: oshal-workflow
  namespace: ${NAMESPACE}
subjects:
  - kind: ServiceAccount
    name: oshal-workflow
    namespace: ${NAMESPACE}
roleRef:
  kind: Role
  name: oshal-workflow
  apiGroup: rbac.authorization.k8s.io
YAML
}

# @description The ConfigMap that binds this namespace to its own database. No password Secret is
# rendered or created anywhere: nothing in a tenant namespace uses the tenant database yet (see
# "Not built" in docs/runbooks/tenant-provisioning.md).
# @returns One YAML document on stdout.
render_database_binding_yaml() {
  cat <<YAML
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: oshal-tenant-db
  namespace: ${NAMESPACE}
  labels:
    oshal.io/tenant: "${NAME}"
data:
  OSHAL_TENANT: "${NAME}"
  OSHAL_TENANCY: "isolated"
  TENANT_DB_HOST: "${DB_HOST}"
  TENANT_DB_PORT: "${DB_PORT}"
  TENANT_DB_NAME: "${DATABASE}"
  TENANT_DB_USER: "${ROLE}"
YAML
}

# @description The whole namespace.yaml, header first.
# @returns YAML on stdout.
render_namespace_file() {
  cat <<YAML
# =============================================================================
# Tenant "${NAME}" - namespace policy (tenancy: isolated, a database per tenant)
# Rendered by scripts/governance/provision-tenant.sh. Re-render rather than edit.
# Database: ${DATABASE} on ${DB_HOST}:${DB_PORT} as ${ROLE} (see ConfigMap oshal-tenant-db).
# =============================================================================
YAML
  render_namespace_yaml
  render_default_deny_yaml
  render_allow_same_tenant_yaml
  render_workflow_access_yaml
  render_database_binding_yaml
}

# @description Render both files into a staging directory beside the output, then move them into
# place, so a failure part-way leaves no half-written policy behind.
# @returns Nothing; prints the two paths written.
STAGE=''
write_outputs() {
  mkdir -p "$OUT"
  STAGE="$(mktemp -d "$OUT/.provision-tenant.XXXXXX")"
  trap '[ -z "$STAGE" ] || rm -f "$STAGE/database.sql" "$STAGE/namespace.yaml"; [ -z "$STAGE" ] || rmdir "$STAGE" 2>/dev/null || true' EXIT
  render_database_file > "$STAGE/database.sql"
  render_namespace_file > "$STAGE/namespace.yaml"
  mv "$STAGE/database.sql" "$OUT/database.sql"
  mv "$STAGE/namespace.yaml" "$OUT/namespace.yaml"
  echo "provision-tenant: rendered tenant '$NAME' (isolated): $OUT/database.sql $OUT/namespace.yaml"
}

parse_args "$@"
check_inputs
readonly ROLE="oshal_tenant_${NAME//-/_}"
readonly DATABASE="$ROLE"
readonly NAMESPACE="oshal-tenant-${NAME}"
write_outputs
