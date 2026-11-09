-- R6.4 disposable PITR transaction markers, never customer data.
CREATE TABLE IF NOT EXISTS ox_r64_pitr_markers(
  tenant varchar(24) NOT NULL CHECK (tenant ~ '^[a-f0-9]{24}$'),
  marker varchar(16) NOT NULL CHECK (marker IN
    ('baseline','selected','excluded')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(tenant,marker)
);
REVOKE ALL ON ox_r64_pitr_markers FROM PUBLIC;
COMMENT ON TABLE ox_r64_pitr_markers IS 'Synthetic WAL recovery markers to assert exact selected/excluded transaction boundary';
