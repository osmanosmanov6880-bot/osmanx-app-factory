-- R5.9: append-only, HMAC chained operator evidence on disposable PostgreSQL.
CREATE TABLE IF NOT EXISTS ox_r59_audit_tip(
  tenant varchar(24) PRIMARY KEY CHECK(tenant ~ '^[a-f0-9]{24}$'),
  seq bigint NOT NULL DEFAULT 0 CHECK(seq BETWEEN 0 AND 1000000),
  mac varchar(64) NOT NULL DEFAULT
    '0000000000000000000000000000000000000000000000000000000000000000',
  modified_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK(mac ~ '^[a-f0-9]{64}$')
);
CREATE TABLE IF NOT EXISTS ox_r59_audit_chain(
  tenant varchar(24) NOT NULL CHECK(tenant ~ '^[a-f0-9]{24}$'),
  seq bigint NOT NULL CHECK(seq BETWEEN 1 AND 1000000),
  prev_mac varchar(64) NOT NULL CHECK(prev_mac ~ '^[a-f0-9]{64}$'),
  mac varchar(64) NOT NULL CHECK(mac ~ '^[a-f0-9]{64}$'),
  kind varchar(48) NOT NULL,
  actor varchar(64) NOT NULL,
  evidence_sha varchar(64) NOT NULL CHECK(evidence_sha ~ '^[a-f0-9]{64}$'),
  event_nonce varchar(32) NOT NULL CHECK(event_nonce ~ '^[a-f0-9]{32}$'),
  at_ms bigint NOT NULL CHECK(at_ms > 0),
  PRIMARY KEY(tenant,seq)
);
CREATE OR REPLACE FUNCTION ox_r59_reject_audit_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'R5.9 audit chain is append-only';
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS ox_r59_immutable_audit ON ox_r59_audit_chain;
CREATE TRIGGER ox_r59_immutable_audit
BEFORE UPDATE OR DELETE ON ox_r59_audit_chain
FOR EACH ROW EXECUTE FUNCTION ox_r59_reject_audit_mutation();
REVOKE ALL ON ox_r59_audit_chain FROM PUBLIC;
REVOKE ALL ON ox_r59_audit_tip FROM PUBLIC;
COMMENT ON TABLE ox_r59_audit_chain IS
  'R5.9 audit HMAC chain; owner/admin controls and independent offsite anchoring still required';
