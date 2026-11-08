-- R5.9: monotonic per-tenant signed certificate manifest generation.
CREATE TABLE IF NOT EXISTS ox_r59_cert_generation(
  tenant varchar(24) PRIMARY KEY CHECK(tenant ~ '^[a-f0-9]{24}$'),
  generation bigint NOT NULL CHECK(generation BETWEEN 0 AND 1000000),
  manifest_sha varchar(64) NOT NULL CHECK(manifest_sha ~ '^[a-f0-9]{64}$'),
  modified_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
REVOKE ALL ON ox_r59_cert_generation FROM PUBLIC;
COMMENT ON TABLE ox_r59_cert_generation IS
  'R5.9 monotonic trust generation; only restricted coordinator may activate offline-signed manifest';
