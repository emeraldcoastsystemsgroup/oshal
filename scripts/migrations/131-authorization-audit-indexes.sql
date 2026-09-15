/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Index bounded global, application and tenant authorization audit pagination.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Drop the top-level BEGIN;/COMMIT; pair: the migration runner wraps each file and its app_migrations history INSERT in one transaction on one client, so the file-level COMMIT ended that transaction early and left the history row outside it. Every statement here runs inside a transaction block, so no no-transaction pragma is needed.
 */
CREATE INDEX IF NOT EXISTS authorization_audit_revision ON oshal_authorization_audit(revision DESC,id DESC);
CREATE INDEX IF NOT EXISTS authorization_audit_app_revision ON oshal_authorization_audit((payload #>> '{change,app}'),revision DESC,id DESC);
CREATE INDEX IF NOT EXISTS authorization_audit_tenant_revision ON oshal_authorization_audit((payload #>> '{change,app}'),(payload #>> '{change,tenantId}'),revision DESC,id DESC);
