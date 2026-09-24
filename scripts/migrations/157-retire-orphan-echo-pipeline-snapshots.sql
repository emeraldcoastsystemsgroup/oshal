-- CHANGE LOG
-- -----------------------------------------------------------------------------
-- SEQ | AUTHOR                                    | DESCRIPTION
-- -----------------------------------------------------------------------------
-- 1   | maintainer@emeraldcoastsystemsgroup.com   | Retire orphan table echo_pipeline_snapshots per operator decision 2026-09-22. The April 2026 writer was never carried into trunk and lives only in private archive; no tracked source declares or writes it. Retiring this table eliminates undeclared live tables from schema documentation.

DROP TABLE IF EXISTS echo_pipeline_snapshots CASCADE;
