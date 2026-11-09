-- R6.4 disposable rebootstrap replay test table.
CREATE TABLE IF NOT EXISTS ox_r64_rebootstrap_probe(
 tenant varchar(24) NOT NULL CHECK(tenant ~ '^[a-f0-9]{24}$'),
 probe_id varchar(32) NOT NULL CHECK(probe_id ~ '^[a-f0-9]{32}$'),
 payload_sha varchar(64) NOT NULL CHECK(payload_sha ~ '^[a-f0-9]{64}$'),
 PRIMARY KEY(tenant,probe_id)
);
REVOKE ALL ON ox_r64_rebootstrap_probe FROM PUBLIC;
