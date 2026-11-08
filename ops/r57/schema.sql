-- R5.7 isolated synthetic checkpoint authority. Run in a disposable
-- PostgreSQL database owned by a dedicated coordinator role.
-- The coordinator alone must have write privileges on this table.
CREATE TABLE IF NOT EXISTS ox_r57_checkpoint_control (
  tenant varchar(24) PRIMARY KEY CHECK (tenant ~ '^[a-f0-9]{24}$'),
  epoch bigint NOT NULL DEFAULT 0 CHECK (epoch BETWEEN 0 AND 1000000),
  holder varchar(24),
  lease_id varchar(32),
  expires_at timestamptz,
  pending_op varchar(32),
  pending_sha varchar(64),
  pending_if_match text,
  pending_create boolean,
  pending_epoch bigint,
  pending_before_version text,
  committed_op varchar(32),
  committed_sha varchar(64),
  committed_version text,
  committed_epoch bigint,
  modified_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT ox_r57_lease_complete CHECK (
    (holder IS NULL AND lease_id IS NULL AND expires_at IS NULL)
    OR (holder IS NOT NULL AND lease_id IS NOT NULL AND expires_at IS NOT NULL)
  ),
  CONSTRAINT ox_r57_intent_complete CHECK (
    (pending_op IS NULL AND pending_sha IS NULL AND pending_create IS NULL
      AND pending_epoch IS NULL)
    OR (pending_op IS NOT NULL AND pending_sha IS NOT NULL
      AND pending_create IS NOT NULL AND pending_epoch IS NOT NULL)
  )
);
COMMENT ON TABLE ox_r57_checkpoint_control IS
  'R5.7 synthetic single-checkpoint per tenant: persisted intent must be resolved before lease takeover';
