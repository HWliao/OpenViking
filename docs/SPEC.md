# Spec: OpenCode Plugin Peer Project Identity Follow-Up

## Objective

Implement only the follow-up items listed under the `## 下一步待改动点` sections in `docs/issues/opencode-plugin-peer-id-migration-issue.md`.

The change targets `examples/opencode-plugin` and closes the remaining gaps after the initial peer session state migration:

- `projectID=global` must not become the persisted project identity.
- Auto `peerId` generation must support short but valid non-global project ids.
- Existing OpenCode sessions that missed `session.created` must lazily initialize local session state.
- OpenCode SDK calls used for session/project lookup must use the v2 client surface where available.
- Session mapping JSON files under `openviking-sessions/sessions/` currently contain unexpected `peerId: null` values because `projectID=global` is treated as the effective project identity and skips auto peer derivation; the fix must prevent resolvable sessions from reaching that null-peer path.
- `openviking-memory.log` must rotate at most once per day, not on every plugin startup.

The user is the OpenCode plugin runtime: automatic recall, memory tools, session message capture, and commit/finalization paths must continue to route OpenViking requests through a stable project-scoped peer id.

## Tech Stack

- Runtime: Node.js ESM modules.
- Test framework: built-in `node:test` with `node:assert/strict`.
- Package: `examples/opencode-plugin`, currently published as `@openviking/opencode-plugin`.
- OpenCode dependency: `@opencode-ai/plugin`; upgrade only as needed to access and test the v2 API surface.
- State storage: JSON files under `<runtimeDataDir>/openviking-sessions/`.

## Commands

Run these commands from `D:\develop\source-workspace\OpenViking\examples\opencode-plugin`:

```powershell
npm run check
npm test
```

Repository-level sanity checks before committing:

```powershell
git status --short
git diff --check
```

## Project Structure

Relevant implementation files:

```text
examples/opencode-plugin/index.mjs
  Plugin entrypoint and OpenCode event/tool integration.

examples/opencode-plugin/lib/memory-session.mjs
  OpenCode session to OpenViking session state, peer routing, message staging, flush, commit, and finalization.

examples/opencode-plugin/lib/utils.mjs
  Config parsing, peer id validation, identifier normalization, auto peer id derivation, and logging helpers.

examples/opencode-plugin/lib/memory-tools.mjs
  Memory tool request paths that must propagate the resolved peer actor.

examples/opencode-plugin/tests/*.test.mjs
  Focused node:test coverage for config, peer identifiers, session state, finalization, memory tools, and request headers.

docs/issues/opencode-plugin-peer-id-migration-issue.md
  Source of truth for this spec only in its `## 下一步待改动点` sections; earlier sections are background constraints, not new implementation scope.
```

State layout remains:

```text
openviking-sessions/
  meta.json
  projects/<safe_project_id>.json
  sessions/<safe_oc_session_id>.json
  finalizing/<safe_oc_session_id>.<pid>.<timestamp>.json
  abandoned/<name>.<timestamp>.json
```

## Code Style

Prefer small, direct ESM functions. Keep defensive SDK checks close to the call site and return structured failure details instead of throwing through event handlers.

Example style:

```javascript
async function getOpenCodeSessionV2(client, sessionID, context = {}) {
  const sessionApi = client?.session
  if (!sessionApi || typeof sessionApi.get !== "function") {
    return { session: null, warning: "OpenCode v2 session API is unavailable" }
  }

  const request = { sessionID }
  if (context.directory) request.directory = context.directory
  if (context.workspace) request.workspace = context.workspace

  return { session: await sessionApi.get(request), warning: null }
}
```

Conventions:

- Keep identifier normalization centralized in `lib/utils.mjs`.
- Do not introduce compatibility branches for `agentId`, `agentIdMode`, `OPENVIKING_AGENT_ID`, or `OPENVIKING_AGENT_ID_MODE`.
- Treat warnings as operational diagnostics; do not fail plugin startup for peer auto-derivation failures.
- Preserve existing state file readability. Do not hash `safe_oc_session_id` or fallback project ids unless a future spec explicitly changes that.

## Functional Requirements

### Project Identity Resolution

- For non-global `projectID`, normalize it and allow it as the project identity even when its safe form is shorter than 8 characters.
- For `projectID=global`, do not write `projects/global.json` and do not derive `global`-based peer ids.
- When `projectID=global`, derive a fallback project identity from the basename of the target OpenCode session-bound directory/cwd/project path obtained through the OpenCode session/project APIs.
- Do not fallback to the plugin initialization directory, `process.cwd()`, or unrelated process-global state for project identity derivation.
- Skip empty, invalid, or `global` project ids before using fallback identity.
- If no stable session-bound source exists, auto peer derivation fails and existing fallback order applies: existing session peer id, explicit configured `peerId`, then no actor peer.

### Peer ID Generation

- Preserve `peerIdMode=auto` semantics: derive a project-scoped peer id, not a workspace, worktree, branch, or single-session peer id.
- Preserve readable peer shape `<slug>_<short_project_id>` when a stable project identity exists.
- Reuse an existing valid project file `peerId` before generating a new one.
- If an existing project file contains an invalid `peerId`, warn, record it in `previousPeerIds`, and regenerate.

### Lazy Session State Initialization

- If `message.updated`, `message.part.updated`, `memcommit`, or a tool path sees an OpenCode session id without a local session file, initialize the mapping lazily.
- Lazy initialization only applies when the path has an OpenCode session id/context; an explicit OpenViking `session_id` argument must not be reinterpreted as an OpenCode session id.
- Lazy initialization must first query the OpenCode session API for that session id, then resolve project/peer state from the returned session-bound metadata.
- Lazy initialization failure must not drop buffered message role/text data. Later events or explicit `memcommit` can retry.
- On successful lazy initialization, write the session file immediately and continue processing the pending event or tool request.

### Session State Peer Integrity Fix

- Treat `projectID=global` as an unusable project identity even though it is a non-empty string.
- Do not let event-provided `projectID=global` override a real project id returned by the OpenCode session or project APIs.
- Resolve the project identity from the first usable non-global source: session API project id, project API id, then basename-derived session-bound directory/cwd/project fallback.
- Use the resolved project identity to derive and persist `peerId` before building `ovSessionId` and before saving session state.
- If a session truly cannot resolve a valid peer, keep that path explicit with a warning and test coverage so it is distinguishable from the current `projectID=global` regression.

### OpenCode SDK v2 Usage

- Use only v2 APIs for session/project lookup, using request-object call shapes equivalent to `session.get({ sessionID, directory?, workspace? })` and `project.current({ directory?, workspace? })`.
- Keep explicit defensive checks for the runtime client shape. If the v2 client is unavailable, warn and let peer auto-derivation fail through the normal fallback path.
- Do not fallback to legacy `path/query` calls that can produce `projectID=global` for project-bound sessions.

### Request Propagation

- OpenViking HTTP requests must continue to send `X-OpenViking-Actor-Peer` when a valid peer id is resolved.
- Requests must not send `X-OpenViking-Agent`.
- Session message bodies must continue to use `peer_id` when a valid peer id is resolved.

### Daily Log Rotation

- Keep the active log filename as `openviking-memory.log`.
- On plugin startup, inspect the active log file's local modified date.
- Rotate the active log only when it is non-empty and its modified date is before the current local date, so repeated restarts on the same day do not create repeated backups.
- Use the existing historical filename shape `openviking-memory.YYYYMMDD-HHMMSS.log`, with numeric suffixes for collisions.
- If rotation fails, log the error and continue writing to `openviking-memory.log`.

## Testing Strategy

Add or update focused tests under `examples/opencode-plugin/tests/`:

- `utils-peer-identifiers.test.mjs`: short non-global project ids are accepted; `global` is rejected as direct project identity; directory-derived fallback uses the existing normalization rules.
- `memory-session-state.test.mjs`: `projectID=global` uses session-bound directory/project metadata to write project and session state and derive `<readable>_<short_fallback>` peer ids.
- `memory-session-state.test.mjs`: `projectID=global` with SDK session returning a real project id uses the SDK session project id.
- `memory-session-state.test.mjs`: `projectID=global` with SDK session still global but project API returning a real id uses the project API id.
- `memory-session-state.test.mjs`: directory/cwd fallback uses the basename of the session-bound path, not the full path.
- `memory-session-state.test.mjs`: missing local mapping during message events lazily initializes state and preserves buffered message data.
- `memory-tools-write.test.mjs` or `memory-session-state.test.mjs`: explicit OpenViking `session_id` arguments do not trigger OpenCode lazy initialization.
- `memory-session-state.test.mjs` or a new focused test: lazy initialization failure keeps buffers and can retry.
- `memory-session-state.test.mjs`: reproduce the current `projectID=global` path that writes `peerId: null`, then prove the fix uses a real project/session-bound identity and writes a valid peer id.
- SDK call-shape test: v2 `session.get` and `project.current` receive request-object arguments with the expected session id, directory, and workspace fields.
- `utils-log-rotation.test.mjs`: startup rotates `openviking-memory.log` only when the active log date is before today; multiple same-day starts keep the same active log.
- Regression tests: non-global short project ids write project files and produce peer ids; `projectID=global` never writes `projects/global.json`.

Run `npm run check` and `npm test` from `examples/opencode-plugin` before considering the change complete.

## Boundaries

- Always: use `peerId` and `peerIdMode`; keep request actor propagation on `X-OpenViking-Actor-Peer`.
- Always: derive fallback project identity only from the target OpenCode session/project data.
- Always: use basename, not the full path, when deriving fallback identity from session-bound directory/cwd/project paths.
- Always: preserve pending message buffers when lazy initialization fails.
- Always: treat `global` as unusable for peer project identity, even if it arrives from the OpenCode event payload.
- Always: rotate `openviking-memory.log` by local day, not by startup count.
- Always: keep state writes atomic where the current implementation already uses temp file plus rename.
- Ask first: changing the persisted session/project JSON schema version beyond additive fields.
- Ask first: changing the public plugin configuration surface beyond the v2 SDK dependency update.
- Ask first: adding dependencies other than an OpenCode SDK/plugin version bump.
- Never: restore `agentId` runtime compatibility or old `OPENVIKING_AGENT_ID` environment fallbacks.
- Never: migrate old `viking://agent/...` server/storage data.
- Never: reopen already-completed migration work from earlier issue sections unless it is required by a `## 下一步待改动点` item.
- Never: use plugin initialization directory, process cwd, or OpenCode server process state as a fallback project identity.
- Never: delete unrelated user changes or rewrite archived planning docs as part of this work.

## Success Criteria

- `projectID=global` no longer produces a `global` project file or `global`-based peer id.
- Short non-global project ids can create project files and stable auto peer ids.
- Existing sessions that did not emit `session.created` can still create local session state from later events or explicit tool/commit paths.
- Explicit OpenViking `session_id` arguments are not treated as OpenCode session ids for lazy initialization.
- Lazy initialization failures are retryable and do not discard buffered message content.
- The known `projectID=global` root cause is covered by a regression test.
- After the fix, sessions with SDK/project/directory metadata do not write or overwrite `peerId` with null.
- OpenCode session/project lookups use v2 request-object API shapes when available.
- OpenViking requests still propagate the resolved peer through `X-OpenViking-Actor-Peer` and `peer_id` message bodies.
- `openviking-memory.log` creates at most one rollover backup per local day, even if the plugin restarts multiple times.
- Focused tests cover the new global fallback, short project id, lazy initialization, null peer root cause regression, daily log rotation, and v2 call-shape behavior.
- `npm run check`, `npm test`, and `git diff --check` pass.

## Open Questions

None for this spec. If a conflict appears during implementation, use only the issue document's `## 下一步待改动点` sections as this spec's scope authority; earlier sections remain background unless explicitly referenced by those follow-up items.
