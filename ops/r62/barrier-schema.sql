-- R6.2 isolated WAL challenge table. Do not add to live customer PG.
CREATE TABLE IF NOT EXISTS ox_r62_sync_barrier(
  tenant varchar(24) NOT NULL CHECK(tenant ~ '^[a-f0-9]{24}$'),
  challenge_id varchar(32) NOT NULL CHECK(challenge_id ~ '^[a-f0-9]{32}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(tenant,challenge_id)
);
REVOKE ALL ON ox_r62_sync_barrier FROM PUBLIC;
COMMENT ON TABLE ox_r62_sync_barrier IS 'Disposable R6.2 synchronous replay challenge; not a production leader election or STONITH';
