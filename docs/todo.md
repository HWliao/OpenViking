# Todo: OpenCode Plugin Peer Project Identity Follow-Up

- [x] Task 1: Update identifier and log utility behavior
  - Acceptance: short non-global project ids derive valid peer ids; `global` is rejected as direct identity; basename fallback is used; same-day log startup does not rotate repeatedly.
  - Verify: `npm test -- tests/utils-peer-identifiers.test.mjs tests/utils-log-rotation.test.mjs`
  - Files: `examples/opencode-plugin/lib/utils.mjs`, `examples/opencode-plugin/tests/utils-peer-identifiers.test.mjs`, `examples/opencode-plugin/tests/utils-log-rotation.test.mjs`

- [x] Task 2: Migrate OpenCode session/project lookup to v2 request objects
  - Acceptance: session/project lookup uses v2 request-object calls only; no legacy `path/query` fallback remains for peer derivation; missing v2 APIs warn and fail auto derivation normally.
  - Verify: `npm test -- tests/memory-session-state.test.mjs`; `npm run check`
  - Files: `examples/opencode-plugin/lib/memory-session.mjs`, `examples/opencode-plugin/tests/memory-session-state.test.mjs`, `examples/opencode-plugin/package.json`, `examples/opencode-plugin/package-lock.json`

- [x] Task 3: Fix `projectID=global` identity resolution and null peer state
  - Acceptance: event `global` cannot override real SDK/project identity; basename fallback works; resolvable sessions persist valid `peerId` and peer-derived `ovSessionId`; `projects/global.json` is never written.
  - Verify: `npm test -- tests/memory-session-state.test.mjs`
  - Files: `examples/opencode-plugin/lib/memory-session.mjs`, `examples/opencode-plugin/tests/memory-session-state.test.mjs`

- [x] Task 4: Add lazy initialization for existing OpenCode sessions
  - Acceptance: missing local mapping during message events initializes from OpenCode session metadata; buffered role/text survives; failure keeps buffers for retry.
  - Verify: `npm test -- tests/memory-session-state.test.mjs`
  - Files: `examples/opencode-plugin/lib/memory-session.mjs`, `examples/opencode-plugin/tests/memory-session-state.test.mjs`

- [x] Task 5: Enforce memory tool and memcommit lazy-init boundaries
  - Acceptance: current OpenCode context can lazy initialize; explicit OpenViking `session_id` does not trigger OpenCode lookup; actor peer still propagates when context resolves a peer.
  - Verify: `npm test -- tests/memory-tools-write.test.mjs tests/memory-session-state.test.mjs`
  - Files: `examples/opencode-plugin/lib/memory-session.mjs`, `examples/opencode-plugin/lib/memory-tools.mjs`, `examples/opencode-plugin/tests/memory-tools-write.test.mjs`, `examples/opencode-plugin/tests/memory-session-state.test.mjs`

- [x] Task 6: Run full plugin regression and update user-facing plugin docs if needed
  - Acceptance: full plugin checks pass; docs are updated only if they contradict changed behavior; root `git diff --check` passes.
  - Verify: `npm run check`; `npm test`; `git diff --check`
  - Files: `examples/opencode-plugin/README.md`, `examples/opencode-plugin/INSTALL.md`, `examples/opencode-plugin/INSTALL-ZH.md`, `docs/issues/opencode-plugin-peer-id-migration-issue.md`
