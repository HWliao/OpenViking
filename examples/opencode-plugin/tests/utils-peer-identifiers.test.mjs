import test from "node:test"
import assert from "node:assert/strict"
import {
  buildOpenVikingSessionId,
  deriveAutoPeerId,
  isValidPeerId,
  normalizeIdentifierPart,
  resolveFixedPeerId,
  resolveSafeOpenCodeSessionId,
} from "../lib/utils.mjs"

test("normalizeIdentifierPart keeps readable safe identifiers", () => {
  assert.equal(normalizeIdentifierPart("  Open Viking/项目@@main  "), "Open_Viking_main")
  assert.equal(normalizeIdentifierPart("a---b___c"), "a---b_c")
  assert.equal(normalizeIdentifierPart("###"), "")
})

test("deriveAutoPeerId uses worktree basename and normalized project id", () => {
  const result = deriveAutoPeerId({
    project: { worktree: "D:/work/OpenViking", name: "DoNotUse" },
    session: { directory: "D:/other/Fallback" },
    projectID: "project:abcdef1234567890",
  })

  assert.deepEqual(result, {
    peerId: "OpenViking_project_abcd",
    safeProjectId: "project_abcdef1234567890",
    shortProjectId: "project_abcd",
  })
})

test("deriveAutoPeerId falls back to session directory and rejects short project id", () => {
  assert.equal(deriveAutoPeerId({
    project: {},
    session: { directory: "D:/work/Fallback Name" },
    projectID: "project-abcdef",
  }).peerId, "Fallback_Name_project-abcd")

  assert.equal(deriveAutoPeerId({
    project: { worktree: "D:/work/OpenViking" },
    session: {},
    projectID: "abc",
  }).peerId, null)
})

test("fixed peer validation accepts only non-empty safe peer ids within length limit", () => {
  assert.equal(isValidPeerId("peer-123_OK"), true)
  assert.equal(isValidPeerId("bad peer"), false)
  assert.equal(isValidPeerId(""), false)
  assert.equal(isValidPeerId("a".repeat(129)), false)
  assert.equal(resolveFixedPeerId({ peerId: " peer-123_OK " }).peerId, "peer-123_OK")
  assert.equal(resolveFixedPeerId({ peerId: "bad peer" }).peerId, null)
})

test("buildOpenVikingSessionId keeps readable session id and enforces max length", () => {
  assert.equal(resolveSafeOpenCodeSessionId("ses:/abc 123", 1700000000000), "ses_abc_123")
  assert.equal(resolveSafeOpenCodeSessionId("###", 1700000000000), "unknown_session_1700000000000")

  assert.equal(buildOpenVikingSessionId({
    peerId: "peer_abc",
    openCodeSessionId: "session:/one",
    now: 1700000000000,
  }).ovSessionId, "peer_abc_session_one")

  const long = buildOpenVikingSessionId({
    peerId: "peer",
    openCodeSessionId: "s".repeat(600),
    now: 1700000000000,
  })
  assert.equal(long.ovSessionId.length, 512)
  assert.equal(long.ovSessionId.startsWith("peer_"), true)

  assert.equal(buildOpenVikingSessionId({
    peerId: null,
    openCodeSessionId: "session:/one",
    now: 1700000000000,
  }).ovSessionId, "opencode_session_one")
})
