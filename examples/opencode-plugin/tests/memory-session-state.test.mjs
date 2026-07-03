import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { createMemorySessionManager } from "../lib/memory-session.mjs"

function makeConfig() {
  return {
    endpoint: "http://openviking.test",
    apiKey: "",
    account: "",
    user: "",
    peerId: "",
    peerIdMode: "auto",
    timeoutMs: 1000,
  }
}

function installFetchMock(calls) {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, options = {}) => {
    const urlString = String(url)
    calls.push({ url: urlString, options })
    if (urlString.includes("/api/v1/tasks")) {
      return jsonResponse({ status: "ok", result: [] })
    }
    if (options.method === "GET" && urlString.includes("/api/v1/sessions/")) {
      return jsonResponse({ status: "ok", result: { session_id: decodeURIComponent(urlString.split("/api/v1/sessions/")[1] ?? "") } })
    }
    if (options.method === "POST" && urlString.endsWith("/api/v1/sessions")) {
      const body = JSON.parse(String(options.body || "{}"))
      return jsonResponse({ status: "ok", result: { session_id: body.session_id ?? "server-generated" } })
    }
    if (options.method === "POST" && urlString.includes("/messages")) {
      return jsonResponse({ status: "ok", result: { added: 1 } })
    }
    if (options.method === "POST" && urlString.includes("/commit")) {
      return jsonResponse({ status: "ok", result: {} })
    }
    return jsonResponse({ status: "ok", result: {} })
  }
  return () => {
    globalThis.fetch = originalFetch
  }
}

function jsonResponse(body, init = { status: 200 }) {
  return new Response(JSON.stringify(body), init)
}

function sessionCreatedEvent({ id = "ses:/one", projectID = "project:abcdef123456", directory }) {
  return {
    type: "session.created",
    properties: {
      info: {
        id,
        projectID,
        directory,
      },
    },
  }
}

test("session manager creates split state directories and stable project peer file", async () => {
  const root = await mkdtemp(join(tmpdir(), "openviking-session-state-"))
  const calls = []
  const restoreFetch = installFetchMock(calls)
  try {
    const directory = join(root, "OpenViking Worktree")
    const manager = createMemorySessionManager({ config: makeConfig(), pluginRoot: root })
    await manager.init()
    await manager.handleEvent(sessionCreatedEvent({ directory }))
    await manager.flushAll()

    const stateRoot = join(root, "openviking-sessions")
    assert.deepEqual((await readdir(stateRoot)).sort(), ["abandoned", "finalizing", "meta.json", "projects", "sessions"].sort())

    const projectFile = join(stateRoot, "projects", "project_abcdef123456.json")
    const projectState = JSON.parse(await readFile(projectFile, "utf8"))
    assert.equal(projectState.peerId, `${basename(directory).replace(/ /g, "_")}_project_abcd`)
    assert.equal(projectState.safeProjectId, "project_abcdef123456")
  } finally {
    restoreFetch()
    await rm(root, { recursive: true, force: true })
  }
})

test("init backs up old session map without migrating its contents", async () => {
  const root = await mkdtemp(join(tmpdir(), "openviking-session-state-"))
  const restoreFetch = installFetchMock([])
  try {
    await writeFile(join(root, "openviking-session-map.json"), JSON.stringify({ version: 1, sessions: { legacy: { ovSessionId: "old" } } }), "utf8")
    const manager = createMemorySessionManager({ config: makeConfig(), pluginRoot: root })
    await manager.init()

    const files = await readdir(root)
    assert.equal(files.includes("openviking-session-map.json"), false)
    assert.equal(files.some((file) => /^openviking-session-map\.v1-backup-\d{8}-\d{6}.*\.json$/.test(file)), true)
    assert.equal(manager.getMappedSessionId("legacy"), undefined)
  } finally {
    restoreFetch()
    await rm(root, { recursive: true, force: true })
  }
})

test("session file persists routing, staged messages, captured ids, and commit hints", async () => {
  const root = await mkdtemp(join(tmpdir(), "openviking-session-state-"))
  const calls = []
  const restoreFetch = installFetchMock(calls)
  try {
    const manager = createMemorySessionManager({ config: makeConfig(), pluginRoot: root })
    await manager.init()
    await manager.handleEvent(sessionCreatedEvent({ id: "ses:/two", directory: join(root, "Repo") }))
    await manager.handleEvent({
      type: "message.updated",
      properties: { info: { id: "msg-1", sessionID: "ses:/two", role: "user" } },
    })
    await manager.handleEvent({
      type: "message.part.updated",
      properties: { part: { sessionID: "ses:/two", messageID: "msg-1", type: "text", text: "hello" } },
    })

    const sessionFile = join(root, "openviking-sessions", "sessions", "ses_two.json")
    const beforeFlushState = JSON.parse(await readFile(sessionFile, "utf8"))
    assert.deepEqual(beforeFlushState.pendingMessages, [])

    await manager.flushAll()

    const sessionState = JSON.parse(await readFile(sessionFile, "utf8"))
    assert.equal(sessionState.openCodeSessionId, "ses:/two")
    assert.equal(sessionState.safeOpenCodeSessionId, "ses_two")
    assert.equal(sessionState.peerId, "Repo_project_abcd")
    assert.equal(sessionState.ovSessionId, "Repo_project_abcd_ses_two")
    assert.deepEqual(sessionState.capturedMessages, ["msg-1"])
    assert.deepEqual(sessionState.pendingMessages, [])
    assert.equal(sessionState.commit.inFlight, false)
    assert.equal(Object.hasOwn(sessionState, "sendingMessages"), false)
  } finally {
    restoreFetch()
    await rm(root, { recursive: true, force: true })
  }
})
