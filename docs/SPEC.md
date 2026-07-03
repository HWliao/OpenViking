# Spec: OpenCode Plugin peerId Session State

## Objective

Build the next OpenViking OpenCode plugin runtime behavior inside `examples/opencode-plugin` only.

The plugin should stop using runtime `agentId` semantics, resolve and propagate `peerId`, persist local project/session state without a single global map file, finalize expired session state by pushing staged messages and triggering server commit, and rotate the plugin log on startup.

This spec intentionally excludes server/storage migration of old `viking://agent/...` data. That legacy data migration is not part of this change.

Detailed design decisions already captured in:

`docs/issues/opencode-plugin-peer-id-migration-issue.md`

## Tech Stack

Language: JavaScript ESM on Node.js.

Package: `examples/opencode-plugin`.

Runtime integration: `@opencode-ai/plugin`.

State storage: local JSON files under the plugin runtime data directory.

No new dependency should be added for this scope.

## Commands

Working directory for all commands:

`examples/opencode-plugin`

Focused log rotation test:

```powershell
node --check lib/utils.mjs && node --check tests/utils-log-rotation.test.mjs && node --test tests/utils-log-rotation.test.mjs
```

Windows-safe full syntax and test command:

```powershell
node --check index.mjs && node --check lib/runtime.mjs && node --check lib/repo-context.mjs && node --check lib/memory-session.mjs && node --check lib/memadd-local.mjs && node --check lib/memory-tools.mjs && node --check lib/code-tools.mjs && node --check lib/memory-recall.mjs && node --check lib/viking-uri-guard.mjs && node --check lib/utils.mjs && node --check tests/code-tools-request-options.test.mjs && node --check tests/memory-tools-write.test.mjs && node --check tests/utils-log-rotation.test.mjs && node --check tests/viking-uri-guard.test.mjs && node --test tests/code-tools-request-options.test.mjs tests/memory-tools-write.test.mjs tests/utils-log-rotation.test.mjs tests/viking-uri-guard.test.mjs
```

Package scripts:

```powershell
npm run check
npm test
```

`npm run check` is in scope for this change. Replace the shell glob with a Windows-safe `scripts/check.mjs` runner that enumerates the fixed source files and `tests/*.test.mjs` itself.

## Project Structure

Plugin entrypoint:

`examples/opencode-plugin/index.mjs`

Runtime/config/log/request helpers:

`examples/opencode-plugin/lib/utils.mjs`

Session capture, staging, commit, and local state:

`examples/opencode-plugin/lib/memory-session.mjs`

Memory tools and peer propagation:

`examples/opencode-plugin/lib/memory-tools.mjs`

Code tools and peer propagation:

`examples/opencode-plugin/lib/code-tools.mjs`

Recall behavior:

`examples/opencode-plugin/lib/memory-recall.mjs`

Tests:

`examples/opencode-plugin/tests/*.test.mjs`

Check script:

`examples/opencode-plugin/scripts/check.mjs`

Spec:

`docs/SPEC.md`

## Code Style

Keep the plugin direct and dependency-free. Prefer small local helpers over new classes unless state boundaries require it.

Use synchronous filesystem operations only in startup-only paths where simple failure handling is more valuable than extra async plumbing. Use async filesystem operations for runtime state operations that may happen during event handling.

Example style:

```javascript
function normalizeIdentifierPart(value) {
  return String(value ?? "")
    .replace(/[^A-Za-z0-9_-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
}
```

Logging must be best effort. Log failures should not break OpenCode plugin startup or event handling.

## Requirements

Use `peerId` as the runtime identity.

Remove `agentId` and `agentIdMode` from config defaults, env handling, and runtime branches. Runtime requests must use `peerId`, `peerIdMode`, `peer_id`, and `X-OpenViking-Actor-Peer`.

`peerIdMode` defaults to `auto`. Invalid `peerIdMode` values warn and fall back to `auto`.

New env precedence is:

```text
OPENVIKING_PEER_ID > config.peerId
OPENVIKING_PEER_ID_MODE > config.peerIdMode
```

Do not read `OPENVIKING_AGENT_ID` or `OPENVIKING_AGENT_ID_MODE`. Do not treat old `agentId` as a `peerId` fallback.

Runtime requests must only send `X-OpenViking-Actor-Peer`; never send `X-OpenViking-Agent`.

Session message bodies must use `peer_id`, matching the resolved peer sent in the request header.

Auto peer id derivation uses:

```text
peerId = <slug>_<short_project_id>
```

`slug` comes from `basename(project.worktree)`, falling back to `basename(session.directory)`.

`project.name` must not be used.

`short_project_id` is the first 12 characters of the normalized `projectID`. If normalized `projectID` has fewer than 8 characters, auto derivation fails.

In `peerIdMode=auto`, first reuse a valid `peerId` already stored in `projects/<safe_project_id>.json`. Do not re-derive when that cached project peer is valid.

If the cached project peer is invalid, warn, discard it, store the invalid value in `previousPeerIds`, and re-derive.

If auto derivation fails, fallback order is: existing session state peer, explicit `peerId`, then no actor peer. When explicit `peerId` is used only as an auto fallback, write it to session state only, not to the project file.

If SDK session/project lookup fails, warn every time; do not add throttling.

In `peerIdMode=fixed`, use only the explicit `peerId`. If it is missing or invalid, warn, keep plugin startup non-fatal, and disable peer propagation. Do not fallback to auto.

Identifier normalization replaces non `A-Z a-z 0-9 _ -` characters with `_`, collapses repeated `_`, and trims leading/trailing `_`.

`peerId` max length is 128.

`ovSessionId` max length is 512 and uses:

```text
<safe_peer_id>_<safe_oc_session_id>
```

If no valid peer exists, `ovSessionId` falls back to:

```text
opencode_<safe_oc_session_id>
```

The local state root is:

```text
<runtimeDataDir>/openviking-sessions/
```

Directory layout:

```text
openviking-sessions/
  meta.json
  projects/
    <safe_project_id>.json
  sessions/
    <safe_oc_session_id>.json
  finalizing/
    <safe_oc_session_id>.<pid>.<timestamp>.json
  abandoned/
    <safe_oc_session_id>.<timestamp>.json
```

Project files store stable project-to-peer state. Session files store routing, message staging, and commit recovery state.

`meta.json` is only for low-frequency schema/migration information. Do not store dynamic counters, `lastSaved`, or cleanup timestamps there. Missing or failed `meta.json` creation warns but does not block plugin startup.

If `openviking-sessions/` directory initialization fails, disable local persistent state and continue with in-memory state. Print this degradation warning once because pending messages and routing state will be lost on process exit.

Project file rules:

- Path: `projects/<safe_project_id>.json`.
- `safe_project_id = normalize(projectID)`.
- Different project IDs that normalize to the same `safe_project_id` are treated as the same project identity.
- If `safe_project_id` has fewer than 8 characters, do not write a project file and do not generate an auto peer id.
- Initial project file creation uses no-overwrite write, for example `fs.promises.writeFile(path, json, { flag: "wx" })`.
- If initial creation hits `EEXIST`, read the existing project file and reuse an existing valid `peerId`.
- Before writing, do a lightweight read-before-write; if an existing valid `peerId` is present, use it and skip this write.
- Updates to existing project files use temp file plus rename.
- Bad project JSON moves to `abandoned/project-<safe_project_id>.<timestamp>.json`, then the project state is regenerated.
- TTL does not clean project files.

Session file rules:

- Path: `sessions/<safe_oc_session_id>.json`.
- `safe_oc_session_id = normalize(openCodeSessionId)`.
- Do not hash `safe_oc_session_id`; keep it readable.
- Different OpenCode session IDs that normalize to the same `safe_oc_session_id` are treated as the same session.
- If normalization is empty, use `unknown_session_<timestamp>`.
- Bad session JSON moves to `abandoned/<safe_oc_session_id>.<timestamp>.json`, then a fresh session state is created. Do not try to recover pending messages from bad JSON.
- Initial session file creation does not require `wx`; write the current in-memory state for the same process.
- Session file writes use temp file plus rename.
- Session state writes do not attempt complex cross-process merge. Normal operation should not have multiple processes handling the same session.
- Do not persist `sendingMessages`; it is process-local anti-reentry state only.
- Persist `pendingMessages` and `messageRoles` as array pairs.
- Persist `capturedMessages` as message id arrays only.
- Persist `commit.inFlight`, `commit.taskId`, `commit.startedAt`, `commit.pendingCleanup`, and `commit.lastCommitTime` as recovery hints only. They must not permanently block future flush/commit attempts.
- `commit.pendingCleanup` means the session was deleted or errored and local state should be removed after required flush/commit completes.

Session state shape:

```json
{
  "version": 1,
  "openCodeSessionId": "ses_xxx",
  "safeOpenCodeSessionId": "ses_xxx",
  "projectID": "project_xxx",
  "safeProjectId": "project_xxx",
  "peerId": "OpenViking_project_xxx",
  "ovSessionId": "OpenViking_project_xxx_ses_xxx",
  "createdAt": 1783000000000,
  "updatedAt": 1783000000000,
  "lastSeenAt": 1783000000000,
  "expiresAt": 1783086400000,
  "capturedMessages": [],
  "messageRoles": [],
  "pendingMessages": [],
  "commit": {
    "lastCommitTime": null,
    "inFlight": false,
    "taskId": null,
    "startedAt": null,
    "pendingCleanup": false
  }
}
```

Do not keep using `openviking-session-map.json` as active state. If the old file exists, try to rename it to `openviking-session-map.v1-backup-YYYYMMDD-HHMMSS.json`; if that fails, warn and continue with `openviking-sessions/`.

Do not migrate old `openviking-session-map.json` contents. If the old file still exists, attempt this backup on every startup. Do not submit old pending messages; warning is enough.

Session TTL uses `lastSeenAt + 1 day`. Expired session state runs finalization rather than blind deletion.

Update `lastSeenAt` and `expiresAt` on session events, message staging updates, successful flushes, and commit triggers.

TTL finalization is opportunistic; do not add a resident timer. Trigger scans at plugin startup/load state, after each `memcommit`, at session deleted/error/compacted boundaries, and during shutdown/`flushAll`.

Finalization must flush `pendingMessages` to server, trigger commit if messages were pushed or `capturedMessages` exist, and then remove local session state according to these rules:

- If `pendingMessages` and `capturedMessages` are both empty, delete local session state.
- If pending message push fails, keep session state for retry.
- If commit has a transport failure or no server response, keep session state for retry.
- If the commit request receives any server response, even a business error, delete local session state and leave follow-up to server logs or user investigation.
- Finalization still needs to trigger commit because current server memory extraction hangs off session commit; add-message alone does not extract memories.

Use atomic rename claiming for finalization:

```text
sessions/<id>.json -> finalizing/<id>.<pid>.<timestamp>.json
```

Recover stale finalizing files on startup/load after 10 minutes.

When retry is needed after push or commit transport failure, restore the finalizing file back to `sessions/<id>.json`.

If stale finalizing recovery finds an active session file already exists, compare `lastSeenAt` and `updatedAt`; keep the newer active file and move the older file to `abandoned/`.

Plugin log rotation happens during `initLogger`: if `openviking-memory.log` exists and is non-empty, rename it to `openviking-memory.YYYYMMDD-HHMMSS.log` before writing a fresh active log. If the timestamp collides, append `-1`, `-2`, and so on. Do not add a retention cap.

## Testing Strategy

Use Node's built-in `node:test` and `node:assert/strict`.

Add focused tests for pure helper behavior where possible. Existing tests often inspect source text; prefer real behavior tests for new helpers when practical.

Required coverage for implementation:

- peerId config precedence and fixed-mode invalid peer behavior.
- auto peer derivation from `project.worktree`, `session.directory`, and `projectID`.
- project file stability and no-overwrite initial create behavior.
- session file serialization for `pendingMessages`, `messageRoles`, `capturedMessages`, and commit state.
- old `openviking-session-map.json` backup behavior without migration.
- local persistence degradation to in-memory state when state directory initialization fails.
- finalization claim, stale finalizing recovery, and abandoned bad JSON behavior.
- TTL finalization flush and commit-trigger decisions.
- log startup rotation.
- Windows-safe `npm run check` behavior through `scripts/check.mjs`.

Documentation updates required:

- `examples/opencode-plugin/README.md`
- `examples/opencode-plugin/INSTALL.md`
- `examples/opencode-plugin/INSTALL-ZH.md`

## Boundaries

Always: keep changes inside `examples/opencode-plugin` for this spec.

Always: preserve active filename `openviking-memory.log` for current logs.

Always: keep local persistence failures non-fatal unless a caller explicitly requires the state operation to succeed.

Always: prefer simple JSON files and direct helper functions over new dependencies or framework-level abstractions.

Ask first: changing OpenViking server APIs, storage paths, or memory extraction semantics.

Ask first: adding npm dependencies.

Ask first: changing package scripts beyond fixing the Windows glob issue with `scripts/check.mjs`.

Never: migrate or delete old `viking://agent/...` server data as part of this scope.

Never: use `project.name` in auto peer id derivation.

Never: reintroduce runtime `X-OpenViking-Agent` propagation.

Never: store all project/session state in one global map JSON file.

## Success Criteria

- Runtime requests use `X-OpenViking-Actor-Peer` and message body `peer_id` when a valid peer is resolved.
- Runtime no longer depends on active `agentId` routing semantics, config fields, or old env vars.
- The plugin creates and uses `openviking-sessions/` state files instead of active `openviking-session-map.json`.
- One project file stabilizes peer id across sessions for the same normalized `projectID`.
- One session file contains routing, message staging, and commit recovery state for the normalized OpenCode session id.
- Expired sessions flush staged messages and trigger commit according to the confirmed finalization rules.
- Concurrent finalization uses atomic rename claiming and can recover stale finalizing files.
- Startup log rotation preserves the old non-empty log and writes new entries to `openviking-memory.log`.
- `npm run check` works on Windows without relying on shell glob expansion.
- README, INSTALL, and INSTALL-ZH describe only `peerId` / `peerIdMode`, the new session state directory, and startup log rotation.
- Focused tests for changed behavior pass.

## Open Questions

- The user will later verify whether `project.worktree` satisfies the desired same-project identity across workspace/worktree scenarios.
