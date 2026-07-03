# Todo: OpenCode Plugin peerId Session State

## Phase 1: Verification Foundation

- [x] Task 1: Add Windows-safe `scripts/check.mjs` and update `npm run check`.
- [x] Checkpoint: `npm run check` no longer depends on shell glob expansion.

## Phase 2: Peer Runtime Basics

- [x] Task 2: Replace config/env `agentId` identity with `peerId` / `peerIdMode`.
- [x] Task 3: Implement peer/session identifier helpers and focused tests.
- [x] Checkpoint: request headers and identifier tests prove peer runtime basics.

## Phase 3: Local State Split

- [x] Task 4: Add `openviking-sessions/` directory and project state files.
- [x] Task 5: Add session state files and legacy `openviking-session-map.json` backup.
- [x] Checkpoint: active state no longer uses one global map file.

## Phase 4: Runtime Wiring

- [x] Task 6: Wire peer identity through session capture and message flush.
- [x] Task 7: Update memory, code, and recall tool peer propagation.
- [x] Checkpoint: runtime request paths use peer identity only.

## Phase 5: Finalization and Recovery

- [x] Task 8: Implement TTL finalization, atomic claim, retry restore, and stale recovery.
- [x] Task 9: Confirm startup log rotation behavior remains aligned with spec.
- [x] Checkpoint: expired sessions finalize safely and log rotation still passes.

## Phase 6: Documentation and Final Verification

- [x] Task 10: Update README, INSTALL, and INSTALL-ZH.
- [x] Task 11: Run focused verification and package verification.
- [x] Checkpoint: all `docs/SPEC.md` success criteria are met or blockers are documented.
