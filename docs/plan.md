# Implementation Plan: OpenCode Plugin Peer Project Identity Follow-Up

## Overview

This plan implements only the `## 下一步待改动点` follow-up items from `docs/issues/opencode-plugin-peer-id-migration-issue.md`. The work stays inside `examples/opencode-plugin` and fixes the remaining peer identity problems: `projectID=global`, short project ids, missing session mapping lazy initialization, OpenCode v2 API usage, unexpected `peerId: null` session state, and daily log rotation.

## Architecture Decisions

- `global` is never a usable project identity. It must be skipped even when it arrives from the OpenCode event payload.
- Auto peer identity is resolved from the first usable non-global source: v2 session API project id, v2 project API id, then basename of session-bound directory/cwd/project path.
- Directory fallback uses `basename`, not the full path. The fallback must still come from target session/project metadata, not plugin startup directory or `process.cwd()`.
- OpenCode session/project lookup uses only v2 request-object calls. If v2 APIs are unavailable, log a warning and let auto peer derivation follow the existing fallback order.
- Lazy initialization applies only when an OpenCode session id/context exists. An explicit OpenViking `session_id` argument is not an OpenCode session id.
- `openviking-memory.log` remains the active log file and rotates only when the existing active log belongs to a prior local date.

## Dependency Graph

```text
Identifier/log utilities
  ├── short project id and global validation tests
  ├── daily log rotation tests
  └── peer/project identity helpers
        │
        ├── v2 OpenCode session/project lookup
        │     └── projectID=global and peerId:null fix
        │           └── session state persistence / ovSessionId correctness
        │
        └── lazy session initialization
              ├── message event replay and buffer preservation
              └── memory tool / memcommit boundary behavior
```

## Task List

### Phase 1: Foundation

#### Task 1: Update identifier and log utility behavior

**Description:** Adjust utility-level behavior for short project ids, unusable project ids, basename fallback, and daily log rotation. This creates safe primitives before changing session state flow.

**Acceptance criteria:**
- [ ] Short non-global project ids can produce valid derived peer ids.
- [ ] Empty, invalid, and `global` project ids are rejected as direct project identities.
- [ ] Directory/cwd fallback uses basename normalization, not full path normalization.
- [ ] `openviking-memory.log` rotates only when the active log mtime is before the current local date.

**Verification:**
- [ ] Run `npm test -- tests/utils-peer-identifiers.test.mjs tests/utils-log-rotation.test.mjs` from `examples/opencode-plugin`.
- [ ] Confirm same-day log initialization does not create repeated backups.

**Dependencies:** None.

**Files likely touched:**
- `examples/opencode-plugin/lib/utils.mjs`
- `examples/opencode-plugin/tests/utils-peer-identifiers.test.mjs`
- `examples/opencode-plugin/tests/utils-log-rotation.test.mjs`

**Estimated scope:** Medium.

#### Task 2: Migrate OpenCode session/project lookup to v2 request objects

**Description:** Replace legacy `path/query` calls in session/project lookup with v2 request-object calls and explicit runtime-shape warnings.

**Acceptance criteria:**
- [ ] Session lookup calls `session.get({ sessionID, directory?, workspace? })` or equivalent v2 shape.
- [ ] Project lookup calls `project.current({ directory?, workspace? })` or equivalent v2 shape.
- [ ] Legacy `path/query` fallback is not used for peer derivation.
- [ ] Missing v2 APIs warn and allow auto peer derivation to fail through the normal fallback path.

**Verification:**
- [ ] Add focused call-shape tests and run `npm test -- tests/memory-session-state.test.mjs`.
- [ ] Run `npm run check` from `examples/opencode-plugin`.

**Dependencies:** Task 1.

**Files likely touched:**
- `examples/opencode-plugin/lib/memory-session.mjs`
- `examples/opencode-plugin/tests/memory-session-state.test.mjs`
- `examples/opencode-plugin/package.json`
- `examples/opencode-plugin/package-lock.json`

**Estimated scope:** Medium.

### Checkpoint: Foundation

- [ ] `npm run check` passes in `examples/opencode-plugin`.
- [ ] Utility and v2 call-shape tests pass.
- [ ] No legacy `path/query` calls remain in peer session/project lookup.

### Phase 2: Peer Identity and Session State

#### Task 3: Fix `projectID=global` identity resolution and null peer state

**Description:** Change project identity selection so event-provided `projectID=global` cannot override real v2 session/project metadata, and resolvable sessions persist valid `peerId` and peer-derived `ovSessionId`.

**Acceptance criteria:**
- [ ] Event `projectID=global` with v2 session returning a real project id uses the session API project id.
- [ ] Event and v2 session `projectID=global` with project API returning a real id uses the project API id.
- [ ] If only session-bound directory/cwd/project path is available, basename fallback is used.
- [ ] Resolvable sessions no longer persist `peerId: null` or `opencode_<session>` fallback `ovSessionId`.
- [ ] `projects/global.json` is never written.

**Verification:**
- [ ] Run `npm test -- tests/memory-session-state.test.mjs`.
- [ ] Inspect test-created session JSON assertions for `peerId`, `projectID`, `safeProjectId`, and `ovSessionId`.

**Dependencies:** Tasks 1 and 2.

**Files likely touched:**
- `examples/opencode-plugin/lib/memory-session.mjs`
- `examples/opencode-plugin/tests/memory-session-state.test.mjs`

**Estimated scope:** Medium.

#### Task 4: Add lazy initialization for existing OpenCode sessions

**Description:** When message events or current-session tool paths encounter an OpenCode session id without local mapping, lazily fetch session/project metadata, create session state, replay buffered message data, and continue the original operation.

**Acceptance criteria:**
- [ ] `message.updated` without prior `session.created` initializes session state when v2 session metadata is available.
- [ ] `message.part.updated` without prior `session.created` buffers content, initializes mapping, and preserves buffered role/text after successful initialization.
- [ ] Lazy initialization failure keeps buffers for retry and does not write broken session state.
- [ ] Lazy initialization writes the session file immediately after successful mapping creation.

**Verification:**
- [ ] Run `npm test -- tests/memory-session-state.test.mjs`.
- [ ] Confirm tests cover success and retryable failure paths.

**Dependencies:** Task 3.

**Files likely touched:**
- `examples/opencode-plugin/lib/memory-session.mjs`
- `examples/opencode-plugin/tests/memory-session-state.test.mjs`

**Estimated scope:** Medium.

#### Task 5: Enforce memory tool and memcommit lazy-init boundaries

**Description:** Ensure memory tools can use lazy initialization only when current OpenCode context exists, and explicit OpenViking `session_id` arguments are not treated as OpenCode session ids.

**Acceptance criteria:**
- [ ] Current OpenCode session context can trigger lazy initialization before tool request config or mapped session lookup needs peer routing.
- [ ] Explicit OpenViking `session_id` in `memcommit` bypasses OpenCode lazy initialization and commits that OpenViking session id directly.
- [ ] `memsearch` deep mode with explicit OpenViking `session_id` does not trigger OpenCode session lookup.
- [ ] Request config still propagates `X-OpenViking-Actor-Peer` when current OpenCode context resolves a valid peer.

**Verification:**
- [ ] Run `npm test -- tests/memory-tools-write.test.mjs tests/memory-session-state.test.mjs`.
- [ ] Confirm fetch/client mocks show no OpenCode lazy init for explicit OpenViking ids.

**Dependencies:** Task 4.

**Files likely touched:**
- `examples/opencode-plugin/lib/memory-session.mjs`
- `examples/opencode-plugin/lib/memory-tools.mjs`
- `examples/opencode-plugin/tests/memory-tools-write.test.mjs`
- `examples/opencode-plugin/tests/memory-session-state.test.mjs`

**Estimated scope:** Medium.

### Checkpoint: Core Session Flow

- [ ] `npm run check` passes in `examples/opencode-plugin`.
- [ ] `npm test -- tests/memory-session-state.test.mjs tests/memory-tools-write.test.mjs` passes.
- [ ] Global project id, short project id, lazy initialization, and explicit OpenViking session id boundaries are all covered.

### Phase 3: Final Regression and Documentation

#### Task 6: Run full plugin regression and update user-facing plugin docs if needed

**Description:** Run full plugin verification and update only docs that describe changed behavior, such as SDK/v2 expectations, daily log rotation, or peer auto derivation behavior.

**Acceptance criteria:**
- [ ] Full plugin `npm run check` passes.
- [ ] Full plugin `npm test` passes.
- [ ] User-facing docs are updated only if existing README/INSTALL content contradicts the new behavior.
- [ ] `git diff --check` passes.

**Verification:**
- [ ] Run `npm run check` from `examples/opencode-plugin`.
- [ ] Run `npm test` from `examples/opencode-plugin`.
- [ ] Run `git diff --check` from repository root.

**Dependencies:** Tasks 1-5.

**Files likely touched:**
- `examples/opencode-plugin/README.md`
- `examples/opencode-plugin/INSTALL.md`
- `examples/opencode-plugin/INSTALL-ZH.md`
- `docs/issues/opencode-plugin-peer-id-migration-issue.md`

**Estimated scope:** Small.

### Checkpoint: Complete

- [ ] All tasks meet acceptance criteria.
- [ ] Full plugin check and tests pass.
- [ ] `git diff --check` passes.
- [ ] Worktree diff only includes intended plugin/docs changes.
- [ ] Human review confirms scope stayed within the issue's `## 下一步待改动点` sections.

## Risks and Mitigations

| Risk | Impact | Mitigation |
| --- | --- | --- |
| OpenCode plugin SDK v2 shape differs from expected request-object examples | High | Add defensive runtime checks and focused call-shape tests; fail auto derivation with warning instead of silently using legacy calls. |
| `projectID=global` appears in multiple event/API combinations | High | Test event-only global, session API real id, project API real id, and basename fallback paths. |
| Lazy initialization duplicates session creation or loses buffered messages | High | Reuse existing buffer merge logic and assert preserved role/text before and after initialization. |
| Explicit OpenViking `session_id` is confused with OpenCode session id | Medium | Keep this as a dedicated boundary test in memory tool or session manager tests. |
| Log rotation tests are date-sensitive | Medium | Use controlled file mtimes in tests rather than relying on wall-clock sleeps. |

## Parallelization Opportunities

- Task 1 log rotation tests can be developed independently from Task 2 v2 lookup tests after agreeing on helper names.
- Task 6 documentation checks can start after Tasks 1-5 define final behavior.
- Tasks 3-5 should stay sequential because lazy initialization depends on correct peer identity resolution.

## Open Questions

None. The plan follows the confirmed scope and boundaries in `docs/SPEC.md`.
