import test from "node:test"
import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createMemorySessionManager } from "../lib/memory-session.mjs"

function makeConfig() {
  return {
    endpoint: "http://openviking.test",
    peerIdMode: "auto",
    timeoutMs: 1000,
  }
}

async function writeSessionState(root, state) {
  const sessions = join(await ensureSessionStateDirs(root), "sessions")
  const file = join(sessions, `${state.safeOpenCodeSessionId}.json`)
  await writeFile(file, JSON.stringify(state, null, 2), "utf8")
  return file
}

async function writeFinalizingState(root, state) {
  const file = join(
    await ensureSessionStateDirs(root),
    "finalizing",
    `${state.safeOpenCodeSessionId}.999.1.json`,
  )
  await writeFile(file, JSON.stringify({ ...state, claimedAt: 1 }, null, 2), "utf8")
  return file
}

async function ensureSessionStateDirs(root) {
  const stateRoot = join(root, "openviking-sessions")
  for (const name of ["sessions", "projects", "finalizing", "abandoned"]) {
    await mkdir(join(stateRoot, name), { recursive: true })
  }
  return stateRoot
}

function expiredState(overrides = {}) {
  return {
    version: 1,
    openCodeSessionId: "ses:/expired",
    safeOpenCodeSessionId: "ses_expired",
    projectID: "project:abcdef123456",
    safeProjectId: "project_abcdef123456",
    peerId: "Repo_project_abcd",
    ovSessionId: "Repo_project_abcd_ses_expired",
    createdAt: 1,
    updatedAt: 1,
    lastSeenAt: 1,
    expiresAt: 1,
    capturedMessages: [],
    messageRoles: [],
    pendingMessages: [],
    commit: {
      lastCommitTime: null,
      inFlight: false,
      taskId: null,
      startedAt: null,
      pendingCleanup: false,
    },
    ...overrides,
  }
}

function installFetchMock(handler) {
  const originalFetch = globalThis.fetch
  globalThis.fetch = handler
  return () => {
    globalThis.fetch = originalFetch
  }
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status })
}

test("expired empty session state is deleted during startup finalization", async () => {
  const root = await mkdtemp(join(tmpdir(), "openviking-finalization-"))
  const file = await writeSessionState(root, expiredState())
  const restoreFetch = installFetchMock(async () => jsonResponse({ status: "ok", result: {} }))
  try {
    const manager = createMemorySessionManager({ config: makeConfig(), pluginRoot: root })
    await manager.init()

    assert.equal(existsSync(file), false)
  } finally {
    restoreFetch()
    await rm(root, { recursive: true, force: true })
  }
})

test("pending message push failure preserves expired session state for retry", async () => {
  const root = await mkdtemp(join(tmpdir(), "openviking-finalization-"))
  const file = await writeSessionState(root, expiredState({
    messageRoles: [["msg-1", "user"]],
    pendingMessages: [["msg-1", "hello"]],
  }))
  const restoreFetch = installFetchMock(async (url, options = {}) => {
    if (options.method === "POST" && String(url).includes("/messages")) {
      return jsonResponse({ error: "temporary" }, 503)
    }
    return jsonResponse({ status: "ok", result: {} })
  })
  try {
    const manager = createMemorySessionManager({ config: makeConfig(), pluginRoot: root })
    await manager.init()

    assert.equal(existsSync(file), true)
    const state = JSON.parse(await readFile(file, "utf8"))
    assert.deepEqual(state.pendingMessages, [["msg-1", "hello"]])
  } finally {
    restoreFetch()
    await rm(root, { recursive: true, force: true })
  }
})

test("commit server response during finalization deletes local session state", async () => {
  const root = await mkdtemp(join(tmpdir(), "openviking-finalization-"))
  const file = await writeSessionState(root, expiredState({ capturedMessages: ["msg-1"] }))
  const restoreFetch = installFetchMock(async (url, options = {}) => {
    if (options.method === "POST" && String(url).includes("/commit")) {
      return jsonResponse({ error: "business error" }, 500)
    }
    return jsonResponse({ status: "ok", result: {} })
  })
  try {
    const manager = createMemorySessionManager({ config: makeConfig(), pluginRoot: root })
    await manager.init()

    assert.equal(existsSync(file), false)
  } finally {
    restoreFetch()
    await rm(root, { recursive: true, force: true })
  }
})

test("stale finalizing state is restored to active sessions on startup", async () => {
  const root = await mkdtemp(join(tmpdir(), "openviking-finalization-"))
  await writeFinalizingState(root, expiredState({ expiresAt: Date.now() + 60_000 }))
  const activeFile = join(root, "openviking-sessions", "sessions", "ses_expired.json")
  const restoreFetch = installFetchMock(async () => jsonResponse({ status: "ok", result: {} }))
  try {
    const manager = createMemorySessionManager({ config: makeConfig(), pluginRoot: root })
    await manager.init()

    assert.equal(existsSync(activeFile), true)
  } finally {
    restoreFetch()
    await rm(root, { recursive: true, force: true })
  }
})
