/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Seed the native schema alarm admission rule without resetting operator edits. The lane always parks one ticket per digest transition and never authorizes automatic remediation.
 */

INSERT INTO oshal_alert_claim_rule
  (rule_id, enabled, priority, match_predicate, identity_fields, intake, autonomy_level, notes)
VALUES ('schema-drift', true, 100,
  '{"alertname":["SchemaDrift"]}'::jsonb,
  ARRAY['target','alertname','labels.schema_occurrence'], 'backlog', 'A0',
  'Internal schema detector. Enable/disable and predicate control admission. One ticket per digest transition; manual-only intake regardless of autonomy or intake edits.')
ON CONFLICT (rule_id) DO NOTHING;
