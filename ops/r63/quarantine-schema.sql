-- R6.3 disposable PG node quarantine: no automatic unquarantine path.
CREATE TABLE IF NOT EXISTS ox_r63_node_quarantine(
  tenant varchar(24) NOT NULL CHECK(tenant ~ '^[a-f0-9]{24}$'),
  cluster_id varchar(24) NOT NULL CHECK(cluster_id ~ '^[a-f0-9]{24}$'),
  incident_id varchar(32) NOT NULL CHECK(incident_id ~ '^[a-f0-9]{32}$'),
  node_id varchar(64) NOT NULL CHECK(node_id ~ '^[a-z][a-z0-9-]{2,48}$'),
  system_id varchar(32) NOT NULL CHECK(system_id ~ '^[0-9]{10,32}$'),
  old_timeline integer NOT NULL CHECK(old_timeline BETWEEN 1 AND 65535),
  selected_timeline integer NOT NULL CHECK(selected_timeline BETWEEN 1 AND 65535),
  evidence_sha varchar(64) NOT NULL CHECK(evidence_sha ~ '^[a-f0-9]{64}$'),
  opened_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(tenant,cluster_id,incident_id,node_id)
);
CREATE TABLE IF NOT EXISTS ox_r63_quarantine_review(
  tenant varchar(24) NOT NULL,
  cluster_id varchar(24) NOT NULL,
  incident_id varchar(32) NOT NULL,
  node_id varchar(64) NOT NULL,
  seq bigint NOT NULL CHECK(seq BETWEEN 1 AND 1000000),
  action varchar(32) NOT NULL CHECK(action IN
    ('inspect','rebootstrap-required')),
  actor varchar(64) NOT NULL CHECK(actor ~ '^[a-z][a-z0-9._-]{5,63}$'),
  evidence_sha varchar(64) NOT NULL CHECK(evidence_sha ~ '^[a-f0-9]{64}$'),
  prev_mac varchar(64) NOT NULL CHECK(prev_mac ~ '^[a-f0-9]{64}$'),
  event_mac varchar(64) NOT NULL CHECK(event_mac ~ '^[a-f0-9]{64}$'),
  at_ms bigint NOT NULL CHECK(at_ms>0),
  PRIMARY KEY(tenant,cluster_id,incident_id,node_id,seq),
  FOREIGN KEY(tenant,cluster_id,incident_id,node_id)
    REFERENCES ox_r63_node_quarantine(tenant,cluster_id,incident_id,node_id)
);
CREATE OR REPLACE FUNCTION ox_r63_forbid_quarantine_edit()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'R6.3 node quarantine evidence is immutable';
END
$$;
DROP TRIGGER IF EXISTS ox_r63_quarantine_no_edit ON ox_r63_node_quarantine;
CREATE TRIGGER ox_r63_quarantine_no_edit BEFORE UPDATE OR DELETE ON
 ox_r63_node_quarantine FOR EACH ROW EXECUTE FUNCTION ox_r63_forbid_quarantine_edit();
DROP TRIGGER IF EXISTS ox_r63_review_no_edit ON ox_r63_quarantine_review;
CREATE TRIGGER ox_r63_review_no_edit BEFORE UPDATE OR DELETE ON
 ox_r63_quarantine_review FOR EACH ROW EXECUTE FUNCTION ox_r63_forbid_quarantine_edit();
REVOKE ALL ON ox_r63_node_quarantine,ox_r63_quarantine_review FROM PUBLIC;
COMMENT ON TABLE ox_r63_node_quarantine IS 'Synthetic-only append-once old-primary quarantine; no automatic clearance or production fencing';
