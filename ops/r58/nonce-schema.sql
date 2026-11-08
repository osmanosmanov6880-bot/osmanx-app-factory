-- R5.8: durable anti-replay request IDs. A single coordinator role owns this
-- table. PG rejection is fail-closed and must precede the requested operation.
CREATE TABLE IF NOT EXISTS ox_r58_request_nonce (
  tenant varchar(24) NOT NULL CHECK (tenant ~ '^[a-f0-9]{24}$'),
  nonce varchar(32) NOT NULL CHECK (nonce ~ '^[a-f0-9]{32}$'),
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(tenant,nonce)
);
CREATE INDEX IF NOT EXISTS ox_r58_request_nonce_expiry_idx
 ON ox_r58_request_nonce(received_at);
COMMENT ON TABLE ox_r58_request_nonce IS
 'R5.8 irreversible per-tenant request ID consumption; expire only older than TLS request validity';
