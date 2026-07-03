# Implementation Plan: OpenCode Plugin peerId Session State

## Overview

Implement the OpenCode plugin peer runtime from `docs/SPEC.md` inside `examples/opencode-plugin` only. The work removes active `agentId` runtime semantics, resolves and propagates `peerId`, splits local project/session state into `openviking-sessions/`, finalizes expired sessions safely, keeps startup log rotation, fixes the Windows `npm run check` glob issue, and updates plugin docs.

## Dependency Graph

```text
Windows-safe check script
  -> reliable verification command

Config/env normalization and request headers
  -> peer resolution helpers
  -> memory/code/recall request propagation

State directory helpers
  -> project peer file
  -> session state file
  -> TTL finalization and stale recovery

Session routing and message staging
  -> flush pending messages with peer_id
  -> commit/finalization recovery

Docs and final verification
```

## Architecture Decisions

- Keep implementation dependency-free and local to `examples/opencode-plugin`.
- Put identifier normalization and peer-mode validation in small direct helpers, not a new framework layer.
- Use JSON files under `<runtimeDataDir>/openviking-sessions/` for local state, with temp-file plus rename writes.
- Preserve local persistence failures as non-fatal unless the caller explicitly requires a state operation to succeed.
- Use atomic rename claiming for finalization instead of locks or long-running timers.
- Keep `openviking-memory.log` as the active log filename and rotate only on startup.

## Task List

### Phase 1: Verification Foundation

## Task 1: Add Windows-safe check runner

**Description:** Replace shell glob expansion in `npm run check` with a Node script that enumerates fixed source files and `tests/*.test.mjs` itself.

**Acceptance criteria:**
- [ ] `examples/opencode-plugin/scripts/check.mjs` exists and uses Node built-ins only.
- [ ] `package.json` uses `node scripts/check.mjs` for `check`.
- [ ] The script checks the same source files plus all plugin test files without relying on shell glob expansion.

**Verification:**
- [ ] Run `npm run check` from `examples/opencode-plugin`.
- [ ] If unrelated tests still fail, record the exact failing test and confirm syntax checks ran.

**Dependencies:** None.

**Files likely touched:**
- `examples/opencode-plugin/package.json`
- `examples/opencode-plugin/scripts/check.mjs`

**Estimated scope:** Small.

### Checkpoint: Verification Foundation
- [ ] `npm run check` no longer fails because of Windows glob expansion.
- [ ] No npm dependencies were added.

### Phase 2: Peer Runtime Basics

## Task 2: Replace config/env agent identity with peer identity

**Description:** Update config loading and request header helpers so runtime identity is `peerId`/`peerIdMode` only.

**Acceptance criteria:**
- [ ] `agentId` and `agentIdMode` are removed from defaults, merge keys, env handling, and active runtime branches.
- [ ] `OPENVIKING_AGENT_ID` and `OPENVIKING_AGENT_ID_MODE` are ignored.
- [ ] `OPENVIKING_PEER_ID > config.peerId` and `OPENVIKING_PEER_ID_MODE > config.peerIdMode` are implemented.
- [ ] `peerIdMode` defaults to `auto`; invalid values warn and fallback to `auto`.
- [ ] `makeRequest` never sends `X-OpenViking-Agent` and sends `X-OpenViking-Actor-Peer` only when a valid peer is provided.

**Verification:**
- [ ] Add or update focused tests for config precedence and header behavior.
- [ ] Run `node --check lib/utils.mjs` and related tests.

**Dependencies:** Task 1 for stable check command is useful but not required.

**Files likely touched:**
- `examples/opencode-plugin/lib/utils.mjs`
- `examples/opencode-plugin/tests/*.test.mjs`

**Estimated scope:** Medium.

## Task 3: Implement peer and session identifier helpers

**Description:** Add the normalization, `peerIdMode=fixed`, `peerIdMode=auto`, and `ovSessionId` derivation rules as testable helpers.

**Acceptance criteria:**
- [ ] Normalization replaces invalid characters, collapses `_`, and trims leading/trailing `_`.
- [ ] `peerId` max length 128 and `ovSessionId` max length 512 are enforced.
- [ ] Auto peer derives `<slug>_<short_project_id>` from `basename(project.worktree)`, fallback `basename(session.directory)`, and normalized `projectID.slice(0, 12)`.
- [ ] Auto derivation fails when normalized `projectID` is shorter than 8.
- [ ] `project.name` is not used.
- [ ] Fixed mode requires explicit valid `peerId`; invalid fixed mode disables peer propagation without auto fallback.
- [ ] If no valid peer exists, `ovSessionId` falls back to `opencode_<safe_oc_session_id>`.

**Verification:**
- [ ] Add focused tests for fixed mode, auto mode, invalid IDs, empty session IDs, length limits, and no-hash session IDs.
- [ ] Run the focused helper tests.

**Dependencies:** Task 2.

**Files likely touched:**
- `examples/opencode-plugin/lib/utils.mjs`
- `examples/opencode-plugin/lib/memory-session.mjs`
- `examples/opencode-plugin/tests/*.test.mjs`

**Estimated scope:** Medium.

### Checkpoint: Peer Runtime Basics
- [ ] Config no longer exposes active `agentId` behavior.
- [ ] Header and identifier helper tests pass.
- [ ] No runtime request path can send `X-OpenViking-Agent`.

### Phase 3: Local State Split

## Task 4: Add openviking-sessions directory and project state files

**Description:** Replace project identity persistence in the global map with project files under `openviking-sessions/projects/`.

**Acceptance criteria:**
- [ ] State root is `<runtimeDataDir>/openviking-sessions/` with `meta.json`, `projects/`, `sessions/`, `finalizing/`, and `abandoned/`.
- [ ] `meta.json` stores only low-frequency schema/migration data and creation failure is non-fatal.
- [ ] Directory initialization failure degrades to in-memory state and logs one warning.
- [ ] Project files use `projects/<safe_project_id>.json` and no-overwrite initial write with `flag: "wx"`.
- [ ] `EEXIST` and read-before-write reuse an existing valid project `peerId`.
- [ ] Invalid cached peer is warned, moved to `previousPeerIds`, and replaced.
- [ ] Bad project JSON moves to `abandoned/project-<safe_project_id>.<timestamp>.json`.
- [ ] Project files are not removed by TTL cleanup.

**Verification:**
- [ ] Add focused tests for project file stability, invalid cached peer replacement, `EEXIST`, bad JSON abandoned, and in-memory degradation.

**Dependencies:** Task 3.

**Files likely touched:**
- `examples/opencode-plugin/lib/memory-session.mjs`
- `examples/opencode-plugin/tests/*.test.mjs`

**Estimated scope:** Medium.

## Task 5: Add session state files and old map backup

**Description:** Replace active `openviking-session-map.json` persistence with per-session JSON files and one-time legacy backup attempts.

**Acceptance criteria:**
- [ ] Active session state path is `sessions/<safe_oc_session_id>.json`.
- [ ] `safe_oc_session_id = normalize(openCodeSessionId)`, no hash, and empty normalization uses `unknown_session_<timestamp>`.
- [ ] Bad session JSON moves to `abandoned/<safe_oc_session_id>.<timestamp>.json` and does not recover pending messages.
- [ ] Session file writes use temp file plus rename.
- [ ] `sendingMessages` is not persisted.
- [ ] `pendingMessages` and `messageRoles` persist as array pairs.
- [ ] `capturedMessages` persists as message id arrays only.
- [ ] `commit.inFlight`, `commit.taskId`, `commit.startedAt`, `commit.pendingCleanup`, and `commit.lastCommitTime` persist as recovery hints only.
- [ ] Existing `openviking-session-map.json` is renamed to `openviking-session-map.v1-backup-YYYYMMDD-HHMMSS.json` when possible, with no content migration.
- [ ] If legacy map backup fails or the old map remains, warn and retry backup on later startup.

**Verification:**
- [ ] Add focused tests for serialization, bad JSON abandoned, old map backup without migration, and recovery-hint persistence.

**Dependencies:** Task 4.

**Files likely touched:**
- `examples/opencode-plugin/lib/memory-session.mjs`
- `examples/opencode-plugin/tests/*.test.mjs`

**Estimated scope:** Medium.

### Checkpoint: State Split
- [ ] Plugin creates `openviking-sessions/` and does not use active `openviking-session-map.json`.
- [ ] Project state and session state tests pass.
- [ ] Legacy map content is not migrated or submitted.

### Phase 4: Runtime Wiring

## Task 6: Wire peer identity through session capture and message flush

**Description:** Make session creation, routing, staged messages, flush, and commit use resolved peer identity and new `ovSessionId` rules.

**Acceptance criteria:**
- [ ] OpenCode session/project lookup feeds auto peer derivation.
- [ ] SDK lookup failures warn every time and do not throttle.
- [ ] Session mappings use `peerId`, `ovSessionId`, project state, and session state instead of active `agentId` routing.
- [ ] Message body uses `peer_id` matching the resolved header peer.
- [ ] Existing session state peer is used as auto fallback before explicit peer.
- [ ] Explicit peer fallback in auto mode writes only to session state, not project file.

**Verification:**
- [ ] Add or update tests for session create/update, pending message flush body, and `ovSessionId` derivation.

**Dependencies:** Tasks 3, 4, and 5.

**Files likely touched:**
- `examples/opencode-plugin/lib/memory-session.mjs`
- `examples/opencode-plugin/tests/*.test.mjs`

**Estimated scope:** Medium.

## Task 7: Update memory, code, and recall tool peer propagation

**Description:** Remove remaining runtime `agentId` propagation from tool request paths and align memory/code/recall tools with `peerId` semantics.

**Acceptance criteria:**
- [ ] `memsearch`, `memread`, `membrowse`, `memwrite`, and `memcommit` use resolved peer context where required.
- [ ] Code tools use `X-OpenViking-Actor-Peer` and do not rely on `X-OpenViking-Agent`.
- [ ] Recall behavior and trace/log fields no longer describe active `agentId` routing.
- [ ] Existing unrelated test failure in `code-tools-request-options.test.mjs` is not fixed unless this task touches that behavior.

**Verification:**
- [ ] Run focused memory tool, code tool, and recall tests.
- [ ] Confirm request bodies include `peer_id` where specified.

**Dependencies:** Task 6.

**Files likely touched:**
- `examples/opencode-plugin/lib/memory-tools.mjs`
- `examples/opencode-plugin/lib/code-tools.mjs`
- `examples/opencode-plugin/lib/memory-recall.mjs`
- `examples/opencode-plugin/tests/*.test.mjs`

**Estimated scope:** Medium.

### Checkpoint: Runtime Wiring
- [ ] Runtime request paths use peer identity only.
- [ ] Focused tool tests pass or known unrelated failures are documented.

### Phase 5: Finalization and Recovery

## Task 8: Implement TTL finalization, atomic claim, and stale recovery

**Description:** Finalize expired or cleanup-pending sessions by flushing pending messages, triggering commit when needed, and recovering safely from process crashes.

**Acceptance criteria:**
- [ ] TTL is `lastSeenAt + 1 day` and updates on session events, message staging, successful flushes, and commit triggers.
- [ ] Finalization scans are opportunistic at startup/load, after `memcommit`, session deleted/error/compacted boundaries, and shutdown/`flushAll`.
- [ ] Claiming uses atomic rename from `sessions/<id>.json` to `finalizing/<id>.<pid>.<timestamp>.json`.
- [ ] Empty `pendingMessages` and empty `capturedMessages` deletes local state.
- [ ] Pending push failure restores or preserves state for retry.
- [ ] Commit transport failure or no server response preserves state for retry.
- [ ] Any server response to commit, including business error, deletes local state.
- [ ] Stale finalizing files older than 10 minutes recover on startup/load.
- [ ] Active-file conflicts during stale recovery compare `lastSeenAt` and `updatedAt`, keeping the newer file and moving older state to `abandoned/`.

**Verification:**
- [ ] Add focused tests for claim, retry restore, stale recovery, timestamp conflict, and finalization delete/preserve rules.

**Dependencies:** Tasks 5 and 6.

**Files likely touched:**
- `examples/opencode-plugin/lib/memory-session.mjs`
- `examples/opencode-plugin/tests/*.test.mjs`

**Estimated scope:** Medium.

## Task 9: Confirm startup log rotation behavior

**Description:** Keep the already-started startup log rotation behavior aligned with the final spec.

**Acceptance criteria:**
- [ ] Non-empty `openviking-memory.log` rotates during `initLogger`.
- [ ] History filename is `openviking-memory.YYYYMMDD-HHMMSS.log`.
- [ ] Same-second conflicts append `-1`, `-2`, and so on.
- [ ] Rotation failure logs an error but does not block startup.
- [ ] No retention cap is added.

**Verification:**
- [ ] Run `node --check lib/utils.mjs && node --check tests/utils-log-rotation.test.mjs && node --test tests/utils-log-rotation.test.mjs`.

**Dependencies:** None, but run after Task 2 if `utils.mjs` changed.

**Files likely touched:**
- `examples/opencode-plugin/lib/utils.mjs`
- `examples/opencode-plugin/tests/utils-log-rotation.test.mjs`

**Estimated scope:** Small.

### Checkpoint: Finalization and Recovery
- [ ] Expired sessions do not disappear without required flush/commit behavior.
- [ ] Crash recovery and retry paths are covered by focused tests.
- [ ] Log rotation test still passes.

### Phase 6: Documentation and Final Verification

## Task 10: Update plugin README and install docs

**Description:** Update user-facing plugin docs to describe only peer runtime configuration and new local runtime files.

**Acceptance criteria:**
- [ ] `README.md`, `INSTALL.md`, and `INSTALL-ZH.md` remove `agentId`, `agentIdMode`, `OPENVIKING_AGENT_ID`, and `OPENVIKING_AGENT_ID_MODE` guidance.
- [ ] Docs describe `peerId`, `peerIdMode`, `OPENVIKING_PEER_ID`, and `OPENVIKING_PEER_ID_MODE`.
- [ ] Docs describe `openviking-sessions/` and legacy `openviking-session-map.json` backup behavior.
- [ ] Docs describe startup log rotation and preserved active filename `openviking-memory.log`.

**Verification:**
- [ ] Search plugin docs for stale `agentId` references and confirm only historical/removal context remains if any.

**Dependencies:** Tasks 2, 4, 5, and 9.

**Files likely touched:**
- `examples/opencode-plugin/README.md`
- `examples/opencode-plugin/INSTALL.md`
- `examples/opencode-plugin/INSTALL-ZH.md`

**Estimated scope:** Small.

## Task 11: Run focused and package verification

**Description:** Run the smallest useful verification set after implementation and document any known unrelated failures.

**Acceptance criteria:**
- [ ] Syntax checks pass for changed source and test files.
- [ ] Focused tests for peer config, state split, finalization, and log rotation pass.
- [ ] `npm run check` works on Windows without shell glob expansion.
- [ ] `npm test` result is recorded; unrelated pre-existing failures are called out separately.

**Verification:**
- [ ] Run `npm run check` from `examples/opencode-plugin`.
- [ ] Run focused `node --test` commands for changed behavior.
- [ ] Run `npm test` if focused tests pass and time permits.

**Dependencies:** Tasks 1 through 10.

**Files likely touched:**
- None unless verification reveals a defect in scoped changes.

**Estimated scope:** Small.

### Checkpoint: Complete
- [ ] All success criteria from `docs/SPEC.md` are met.
- [ ] No new dependency is added.
- [ ] Changes stay inside `examples/opencode-plugin` except docs under `docs/`.
- [ ] Known unrelated test failures are documented and not hidden.

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| `memory-session.mjs` is large and currently owns capture, flush, commit, and persistence together. | High | Keep changes in thin slices and add helper-level tests before wiring runtime events. |
| Replacing single-map persistence can lose pending messages if degradation paths are wrong. | High | Test bad JSON, directory init failure, pending push failure, and commit transport failure explicitly. |
| Auto peer derivation depends on OpenCode SDK session/project shape. | Medium | Keep lookup failures non-fatal and warn every time, as specified. |
| Existing source-text tests may fail after legitimate wording changes. | Medium | Prefer behavior tests for new helpers and update brittle tests only when they cover changed behavior. |
| Known unrelated `code-tools-request-options.test.mjs` failure may obscure new regressions. | Medium | Run focused tests first and report unrelated full-suite failures separately. |

## Parallelization Opportunities

- Task 1 can run independently.
- Task 9 can run independently if `utils.mjs` is not being edited at the same time.
- Task 10 can start after API/config wording stabilizes, but final doc verification should wait until runtime behavior is complete.
- Tasks 4, 5, 6, and 8 should stay sequential because they share `memory-session.mjs` state contracts.

## Open Questions

- The user will later verify whether `project.worktree` satisfies the desired same-project identity across workspace/worktree scenarios.
