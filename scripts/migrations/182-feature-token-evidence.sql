-- CHANGE LOG
-- -----------------------------------------------------------------------------
-- SEQ | AUTHOR                                    | DESCRIPTION
-- -----------------------------------------------------------------------------
-- 1 | maintainer@emeraldcoastsystemsgroup.com | Optional ADR-170 producer evidence on the existing cost-event row; legacy stays NULL and attributed measurements cannot be rewritten or adopted retrospectively. No owner policy or grant changes.

ALTER TABLE oshal_cost_events ADD COLUMN IF NOT EXISTS feature_evidence JSONB;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cost_feature_evidence_version'
      AND conrelid = 'oshal_cost_events'::regclass) THEN
    ALTER TABLE oshal_cost_events ADD CONSTRAINT cost_feature_evidence_version CHECK (
      feature_evidence IS NULL OR
      (jsonb_typeof(feature_evidence) = 'object' AND feature_evidence->>'version' = '1') IS TRUE
    );
  END IF;
END;
$$;

-- No SECURITY DEFINER, new policy, role, or grant. Existing ledger RLS still owns access.
CREATE OR REPLACE FUNCTION protect_feature_token_evidence() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (OLD.feature_evidence IS NOT NULL OR NEW.feature_evidence IS NOT NULL) AND
     ROW(OLD.feature_evidence, OLD.task_id, OLD.owner_sub, OLD.agent_id, OLD.provider_id,
         OLD.model_id, OLD.input_tokens, OLD.output_tokens, OLD.ts)
     IS DISTINCT FROM
     ROW(NEW.feature_evidence, NEW.task_id, NEW.owner_sub, NEW.agent_id, NEW.provider_id,
         NEW.model_id, NEW.input_tokens, NEW.output_tokens, NEW.ts) THEN
    RAISE EXCEPTION 'feature_token_evidence_immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS cost_feature_evidence_immutable ON oshal_cost_events;
CREATE TRIGGER cost_feature_evidence_immutable BEFORE UPDATE ON oshal_cost_events
FOR EACH ROW EXECUTE FUNCTION protect_feature_token_evidence();
