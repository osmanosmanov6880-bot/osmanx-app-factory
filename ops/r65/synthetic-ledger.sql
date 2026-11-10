-- R6.5 synthetic-only, tenant-scoped acknowledged PostgreSQL ledger.
-- The application source SQLite is not represented here; RPO from these
-- markers cannot certify a production commit-to-WORM delivery bound.
CREATE TABLE IF NOT EXISTS ox_r65_commit_ledger(
  tenant varchar(24) NOT NULL CHECK (tenant ~ '^[a-f0-9]{24}$'),
  seq integer NOT NULL CHECK (seq BETWEEN 1 AND 250),
  payload_sha varchar(64) NOT NULL CHECK (payload_sha ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(tenant,seq)
);
REVOKE ALL ON ox_r65_commit_ledger FROM PUBLIC;
COMMENT ON TABLE ox_r65_commit_ledger IS 'Disposable PG 15/16 acknowledged transaction witness, not source SQLite or industrial RPO proof';
