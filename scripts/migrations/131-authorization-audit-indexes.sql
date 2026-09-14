/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Index bounded global, application and tenant authorization audit pagination.
 */
BEGIN;
CREATE INDEX IF NOT EXISTS authorization_audit_revision ON oshal_authorization_audit(revision DESC,id DESC);
CREATE INDEX IF NOT EXISTS authorization_audit_app_revision ON oshal_authorization_audit((payload #>> '{change,app}'),revision DESC,id DESC);
CREATE INDEX IF NOT EXISTS authorization_audit_tenant_revision ON oshal_authorization_audit((payload #>> '{change,app}'),(payload #>> '{change,tenantId}'),revision DESC,id DESC);
COMMIT;
