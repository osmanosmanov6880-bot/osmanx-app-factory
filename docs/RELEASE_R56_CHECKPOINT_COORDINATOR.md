# OSMANX APP FACTORY R5.6 — checkpoint coordinator (experimental)

This change is deliberately **synthetic-only**, off production, and must not be
merged into main before an independent security and failure-injection review.

## Five work packages
1. Durable checkpoint intent and completed receipt, fsync + directory sync.
2. Coordinator-owned conditional S3 pointer writes, with one per-tenant in-process critical section.
3. R5.3 signed encrypted CDC integration through a `publishFence.publishPointer` opt-in callback.
4. Fault simulations: expiring lease while S3 PUT is blocked; lost response after write;
   stale worker; CAS conflict; crash after intent; replay of completed operations.
5. Two-version Node.js CI workflow and release gates.

## Important security limits
- **NOT distributed HA:** serialization is an in-memory promise queue. Two separate
  coordinator processes sharing a directory are **not** locked against each other.
  The storage directory must only be used by **one** coordinator instance; external
  clustering/failover requires an independently audited transactional store, lock or consensus.
- **NOT isolated from bypass:** clients must have zero direct IAM permissions to
  overwrite `r53/head.json`. The synthetic coordinator receives a trusted S3
  adapter. This API is not yet a remote authenticated service or production identity.
- A coordinator crash after an intent but before a write produces an
  **ambiguous** state. The system fails closed. Investigate provider object-version
  history and witness state before any reset; a current HEAD read is not enough.
- Lease time may expire during the coordinator's critical section. A new lease
  cannot be granted by this process until the write ends, but the old operation
  can still finish. This is serialized, not a hard physical expiry cancellation.
- S3 and an independent witness do not share an ACID transaction. Lost witness
  acknowledgements require existing R5.5 row-by-row recovery.
- Weakly consistent or untrusted S3 emulators, corrupted state files, host
  compromise, clock jumps and power-loss behavior are not certified.
- `productionCutoverAllowed` stays false, no zero-RPO guarantee, no live
  customers or payment settlement, and no changes to deployed SQLite.

## Acceptance
```bash
npm ci --ignore-scripts
node --test tests/r56_coordinator.test.mjs
npm run test:r55
```

### Additional release blockers
- Move coordinator protocol behind authenticated TLS with credential separation.
- Prove only the coordinator IAM role can mutate the pointer.
- Add cross-process / cross-machine leader election and fencing of the actual
  storage write, not only an in-process queue.
- Crash/restart against real versioned COMPLIANCE MinIO under concurrent hosts.
- Verify full prior version history, independent witness and deterministic
  operator recovery with explicit signed audit evidence.
- Run an independent security assessment and real backup/restore drills.
