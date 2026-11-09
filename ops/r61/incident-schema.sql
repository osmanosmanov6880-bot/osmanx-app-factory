-- R6.1 incident dossier: append-only evidence. Nothing here clears a
-- checkpoint lease, pending S3 intent, witness or live customer data.
CREATE TABLE IF NOT EXISTS ox_r61_incident(
  tenant varchar(24) NOT NULL CHECK(tenant ~ '^[a-f0-9]{24}$'),
  incident_id varchar(32) NOT NULL CHECK(incident_id ~ '^[a-f0-9]{32}$'),
  evidence_sha varchar(64) NOT NULL CHECK(evidence_sha ~ '^[a-f0-9]{64}$'),
  checkpoint_epoch bigint NOT NULL CHECK(checkpoint_epoch BETWEEN 1 AND 1000000),
  s3_version text,
  actor varchar(64) NOT NULL,
  opened_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(tenant,incident_id)
);
CREATE TABLE IF NOT EXISTS ox_r61_incident_event(
  tenant varchar(24) NOT NULL,
  incident_id varchar(32) NOT NULL,
  seq bigint NOT NULL CHECK(seq BETWEEN 1 AND 1000000),
  action varchar(32) NOT NULL CHECK(action IN
    ('investigate','export-evidence','close-readonly')),
  actor varchar(64) NOT NULL,
  approval_sha varchar(64) NOT NULL CHECK(approval_sha ~ '^[a-f0-9]{64}$'),
  prev_mac varchar(64) NOT NULL CHECK(prev_mac ~ '^[a-f0-9]{64}$'),
  event_mac varchar(64) NOT NULL CHECK(event_mac ~ '^[a-f0-9]{64}$'),
  at_ms bigint NOT NULL CHECK(at_ms > 0),
  PRIMARY KEY(tenant,incident_id,seq),
  UNIQUE(tenant,incident_id,approval_sha),
  FOREIGN KEY(tenant,incident_id) REFERENCES ox_r61_incident(tenant,incident_id)
);
CREATE OR REPLACE FUNCTION ox_r61_immutable_incident()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'R6.1 incident evidence is immutable';
END;
$$;
DROP TRIGGER IF EXISTS ox_r61_no_case_mutation ON ox_r61_incident;
CREATE TRIGGER ox_r61_no_case_mutation BEFORE UPDATE OR DELETE
  ON ox_r61_incident FOR EACH ROW EXECUTE FUNCTION ox_r61_immutable_incident();
DROP TRIGGER IF EXISTS ox_r61_no_event_mutation ON ox_r61_incident_event;
CREATE TRIGGER ox_r61_no_event_mutation BEFORE UPDATE OR DELETE
  ON ox_r61_incident_event FOR EACH ROW EXECUTE FUNCTION ox_r61_immutable_incident();
REVOKE ALL ON ox_r61_incident,ox_r61_incident_event FROM PUBLIC;
COMMENT ON TABLE ox_r61_incident_event IS
 'Operator case HMAC chain with external key; append-only PostgreSQL is not an external WORM witness';
