import test from "node:test"
import assert from "node:assert/strict"
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
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

function makeOpenCodeClient({ session = {}, project = {}, calls = [] } = {}) {
  return {
    session: {
      get: async (request) => {
        calls.push({ api: "session.get", request })
        if (session instanceof Error) throw session
        return { data: { ...session } }
      },
    },
    project: {
      current: async (request) => {
        calls.push({ api: "project.current", request })
        if (project instanceof Error) throw project
        return { data: { ...project } }
      },
    },
  }
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

async function writeSessionState(root, safeOpenCodeSessionId, state) {
  const sessions = join(root, "openviking-sessions", "sessions")
  await mkdir(sessions, { recursive: true })
  const file = join(sessions, `${safeOpenCodeSessionId}.json`)
  await writeFile(file, JSON.stringify(state, null, 2), "utf8")
  return file
}

test("session manager creates split state directories and stable project peer file", async () => {
  const root = await mkdtemp(join(tmpdir(), "openviking-session-state-"))
  const calls = []
  const restoreFetch = installFetchMock(calls)
  try {
    const directory = join(root, "OpenViking Worktree")
    const client = makeOpenCodeClient({
      session: { id: "ses:/one", projectID: "project:abcdef123456", directory },
      project: { id: "project:abcdef123456", worktree: directory },
    })
    const manager = createMemorySessionManager({ config: makeConfig(), pluginRoot: root, client })
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
    const client = makeOpenCodeClient({
      session: { id: "ses:/two", projectID: "project:abcdef123456", directory: join(root, "Repo") },
      project: { id: "project:abcdef123456", worktree: join(root, "Repo") },
    })
    const manager = createMemorySessionManager({ config: makeConfig(), pluginRoot: root, client })
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

test("global event project id uses real SDK session project id", async () => {
  const root = await mkdtemp(join(tmpdir(), "openviking-session-state-"))
  const restoreFetch = installFetchMock([])
  try {
    const directory = join(root, "Repo")
    const client = makeOpenCodeClient({
      session: { id: "ses:/global", projectID: "project:real1234567890", directory },
      project: { id: "project:real1234567890", worktree: directory },
    })
    const manager = createMemorySessionManager({ config: makeConfig(), pluginRoot: root, client })
    await manager.init()
    await manager.handleEvent(sessionCreatedEvent({ id: "ses:/global", projectID: "global", directory }))
    await manager.flushAll()

    const sessionState = JSON.parse(await readFile(join(root, "openviking-sessions", "sessions", "ses_global.json"), "utf8"))
    assert.equal(sessionState.projectID, "project:real1234567890")
    assert.equal(sessionState.safeProjectId, "project_real1234567890")
    assert.equal(sessionState.peerId, "Repo_project_real")
    assert.equal(sessionState.ovSessionId, "Repo_project_real_ses_global")
  } finally {
    restoreFetch()
    await rm(root, { recursive: true, force: true })
  }
})

test("global session project id uses real project API id", async () => {
  const root = await mkdtemp(join(tmpdir(), "openviking-session-state-"))
  const restoreFetch = installFetchMock([])
  try {
    const directory = join(root, "Repo")
    const client = makeOpenCodeClient({
      session: { id: "ses:/project", projectID: "global", directory },
      project: { id: "project:from-project-api", worktree: directory },
    })
    const manager = createMemorySessionManager({ config: makeConfig(), pluginRoot: root, client })
    await manager.init()
    await manager.handleEvent(sessionCreatedEvent({ id: "ses:/project", projectID: "global", directory }))
    await manager.flushAll()

    const sessionState = JSON.parse(await readFile(join(root, "openviking-sessions", "sessions", "ses_project.json"), "utf8"))
    assert.equal(sessionState.projectID, "project:from-project-api")
    assert.equal(sessionState.peerId, "Repo_project_from")
  } finally {
    restoreFetch()
    await rm(root, { recursive: true, force: true })
  }
})

test("global project id falls back to session-bound directory basename", async () => {
  const root = await mkdtemp(join(tmpdir(), "openviking-session-state-"))
  const restoreFetch = installFetchMock([])
  try {
    const directory = join(root, "Nested", "Fallback Repo")
    const client = makeOpenCodeClient({
      session: { id: "ses:/fallback", projectID: "global", directory },
      project: {},
    })
    const manager = createMemorySessionManager({ config: makeConfig(), pluginRoot: root, client })
    await manager.init()
    await manager.handleEvent(sessionCreatedEvent({ id: "ses:/fallback", projectID: "global", directory }))
    await manager.flushAll()

    const sessionState = JSON.parse(await readFile(join(root, "openviking-sessions", "sessions", "ses_fallback.json"), "utf8"))
    assert.equal(sessionState.projectID, "Fallback_Repo")
    assert.equal(sessionState.safeProjectId, "Fallback_Repo")
    assert.equal(sessionState.peerId, "Fallback_Repo_Fallback_Rep")
  } finally {
    restoreFetch()
    await rm(root, { recursive: true, force: true })
  }
})

test("message event without session.created lazily initializes mapping and preserves buffer", async () => {
  const root = await mkdtemp(join(tmpdir(), "openviking-session-state-"))
  const calls = []
  const restoreFetch = installFetchMock(calls)
  try {
    const directory = join(root, "Repo")
    const client = makeOpenCodeClient({
      session: { id: "ses:/lazy", projectID: "project:lazy123456", directory },
      project: { id: "project:lazy123456", worktree: directory },
    })
    const manager = createMemorySessionManager({ config: makeConfig(), pluginRoot: root, client })
    await manager.init()
    await manager.handleEvent({
      type: "message.updated",
      properties: { info: { id: "msg-1", sessionID: "ses:/lazy", role: "user" } },
    })
    await manager.handleEvent({
      type: "message.part.updated",
      properties: { part: { sessionID: "ses:/lazy", messageID: "msg-1", type: "text", text: "hello" } },
    })
    await manager.flushAll()

    const sessionState = JSON.parse(await readFile(join(root, "openviking-sessions", "sessions", "ses_lazy.json"), "utf8"))
    assert.equal(sessionState.peerId, "Repo_project_lazy")
    assert.deepEqual(sessionState.capturedMessages, ["msg-1"])
    assert.deepEqual(sessionState.pendingMessages, [])
  } finally {
    restoreFetch()
    await rm(root, { recursive: true, force: true })
  }
})

test("lazy initialization failure keeps buffered messages for retry", async () => {
  const root = await mkdtemp(join(tmpdir(), "openviking-session-state-"))
  const restoreFetch = installFetchMock([])
  const calls = []
  try {
    let fail = true
    const directory = join(root, "Repo")
    const client = {
      session: {
        get: async (request) => {
          calls.push({ api: "session.get", request })
          if (fail) throw new Error("temporary")
          return { data: { id: "ses:/retry", projectID: "project:retry123456", directory } }
        },
      },
      project: {
        current: async () => ({ data: { id: "project:retry123456", worktree: directory } }),
      },
    }
    const manager = createMemorySessionManager({ config: makeConfig(), pluginRoot: root, client })
    await manager.init()
    await manager.handleEvent({
      type: "message.updated",
      properties: { info: { id: "msg-1", sessionID: "ses:/retry", role: "user" } },
    })
    await manager.handleEvent({
      type: "message.part.updated",
      properties: { part: { sessionID: "ses:/retry", messageID: "msg-1", type: "text", text: "hello" } },
    })

    fail = false
    await manager.handleEvent({
      type: "message.part.updated",
      properties: { part: { sessionID: "ses:/retry", messageID: "msg-1", type: "text", text: "hello world" } },
    })
    await manager.flushAll()

    const sessionState = JSON.parse(await readFile(join(root, "openviking-sessions", "sessions", "ses_retry.json"), "utf8"))
    assert.equal(sessionState.peerId, "Repo_project_retr")
    assert.deepEqual(sessionState.capturedMessages, ["msg-1"])
    assert.deepEqual(sessionState.pendingMessages, [])
  } finally {
    restoreFetch()
    await rm(root, { recursive: true, force: true })
  }
})

test("v2 OpenCode API calls use request object shape", async () => {
  const root = await mkdtemp(join(tmpdir(), "openviking-session-state-"))
  const restoreFetch = installFetchMock([])
  try {
    const calls = []
    const directory = join(root, "Repo")
    const client = makeOpenCodeClient({
      session: { id: "ses:/shape", projectID: "project:shape123456", directory, workspaceID: "workspace-1" },
      project: { id: "project:shape123456", worktree: directory },
      calls,
    })
    const manager = createMemorySessionManager({ config: makeConfig(), pluginRoot: root, client })
    await manager.init()
    await manager.handleEvent({
      type: "session.created",
      properties: { info: { id: "ses:/shape", directory, workspaceID: "workspace-1" } },
    })

    assert.deepEqual(calls[0], { api: "session.get", request: { sessionID: "ses:/shape", directory, workspace: "workspace-1" } })
    assert.deepEqual(calls[1], { api: "project.current", request: { directory, workspace: "workspace-1" } })
  } finally {
    restoreFetch()
    await rm(root, { recursive: true, force: true })
  }
})

test("existing null peer session state is repaired from OpenCode session metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "openviking-session-state-"))
  const restoreFetch = installFetchMock([])
  try {
    const directory = join(root, "Repo")
    const sessionFile = await writeSessionState(root, "ses_repair", {
      version: 1,
      openCodeSessionId: "ses:/repair",
      safeOpenCodeSessionId: "ses_repair",
      projectID: "global",
      safeProjectId: "global",
      peerId: null,
      ovSessionId: "opencode_ses_repair",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      lastSeenAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      capturedMessages: [],
      messageRoles: [],
      pendingMessages: [],
      commit: { lastCommitTime: null, inFlight: false, taskId: null, startedAt: null, pendingCleanup: false },
    })
    const client = makeOpenCodeClient({
      session: { id: "ses:/repair", projectID: "project:repair123456", directory },
      project: { id: "project:repair123456", worktree: directory },
    })
    const manager = createMemorySessionManager({ config: makeConfig(), pluginRoot: root, client })
    await manager.init()
    await manager.ensureSessionInitialized("ses:/repair")

    const repaired = JSON.parse(await readFile(sessionFile, "utf8"))
    assert.equal(repaired.projectID, "project:repair123456")
    assert.equal(repaired.peerId, "Repo_project_repa")
    assert.equal(repaired.ovSessionId, "Repo_project_repa_ses_repair")
  } finally {
    restoreFetch()
    await rm(root, { recursive: true, force: true })
  }
})

test("explicit OpenViking session commit does not create local OpenCode mapping", async () => {
  const root = await mkdtemp(join(tmpdir(), "openviking-session-state-"))
  const restoreFetch = installFetchMock([])
  try {
    const manager = createMemorySessionManager({ config: makeConfig(), pluginRoot: root, client: makeOpenCodeClient() })
    await manager.init()
    const result = await manager.commitSession("explicit-ov-session", undefined)

    assert.equal(result.status, "completed")
    const sessionFiles = await readdir(join(root, "openviking-sessions", "sessions"))
    assert.equal(sessionFiles.length, 0)
  } finally {
    restoreFetch()
    await rm(root, { recursive: true, force: true })
  }
})

test("concurrent lifecycle and manual commits share one server commit request", async () => {
  const root = await mkdtemp(join(tmpdir(), "openviking-session-state-"))
  const calls = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, options = {}) => {
    const urlString = String(url)
    calls.push({ url: urlString, options })
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
      await new Promise((resolve) => setTimeout(resolve, 20))
      return jsonResponse({ status: "ok", result: { task_id: "task-1" } })
    }
    if (options.method === "GET" && urlString.includes("/api/v1/tasks/task-1")) {
      return jsonResponse({ status: "ok", result: { status: "completed", result: {} } })
    }
    return jsonResponse({ status: "ok", result: [] })
  }
  try {
    const directory = join(root, "Repo")
    const client = makeOpenCodeClient({
      session: { id: "ses:/race", projectID: "project:abcdef123456", directory },
      project: { id: "project:abcdef123456", worktree: directory },
    })
    const manager = createMemorySessionManager({ config: makeConfig(), pluginRoot: root, client })
    await manager.init()
    await manager.handleEvent(sessionCreatedEvent({ id: "ses:/race", directory }))
    await manager.handleEvent({
      type: "message.updated",
      properties: { info: { id: "msg-1", sessionID: "ses:/race", role: "user" } },
    })
    await manager.handleEvent({
      type: "message.part.updated",
      properties: { part: { sessionID: "ses:/race", messageID: "msg-1", type: "text", text: "hello" } },
    })
    await manager.flushAll()

    const ovSessionId = manager.getMappedSessionId("ses:/race")
    await Promise.all([
      manager.flushSession("ses:/race", { commit: true, reason: "test-boundary" }),
      manager.commitSession(ovSessionId, "ses:/race"),
    ])

    const commitPosts = calls.filter((call) => call.options.method === "POST" && call.url.includes("/commit")).length
    assert.equal(commitPosts, 1)
  } finally {
    globalThis.fetch = originalFetch
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
