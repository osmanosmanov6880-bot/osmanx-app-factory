-- R6.4 synthetic named PITR target experiment only.
CREATE TABLE IF NOT EXISTS ox_r64_pitr_event(
 tenant varchar(24) NOT NULL CHECK(tenant ~ '^[a-f0-9]{24}$'),
 event_id varchar(32) NOT NULL CHECK(event_id ~ '^[a-f0-9]{32}$'),
 payload_sha varchar(64) NOT NULL CHECK(payload_sha ~ '^[a-f0-9]{64}$'),
 occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant,event_id)
);
REVOKE ALL ON ox_r64_pitr_event FROM PUBLIC;
COMMENT ON TABLE ox_r64_pitr_event IS
 'Synthetic-only pre/post target proof. Not customer data or production archive.';
