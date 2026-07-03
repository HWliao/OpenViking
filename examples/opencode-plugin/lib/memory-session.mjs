import fs from "fs"
import path from "path"
import {
  basenameIdentifierFromPath,
  buildOpenVikingSessionId,
  deriveAutoPeerId,
  effectivePeerId,
  isValidPeerId,
  isUsableProjectIdentity,
  log,
  makeRequest,
  normalizeIdentifierPart,
  resolveFixedPeerId,
  resolveSafeOpenCodeSessionId,
  safeStringify,
  unwrapResponse,
} from "./utils.mjs"

const MAX_BUFFERED_MESSAGES_PER_SESSION = 100
const BUFFERED_MESSAGE_TTL_MS = 15 * 60 * 1000
const BUFFER_CLEANUP_INTERVAL_MS = 30 * 1000
const COMMIT_WAIT_TIMEOUT_MS = 180000
const SESSION_TTL_MS = 24 * 60 * 60 * 1000
const STALE_FINALIZING_MS = 10 * 60 * 1000

export function createMemorySessionManager({ config, pluginRoot, client }) {
  const sessionMap = new Map()
  const sessionMessageBuffer = new Map()
  const commitWatchers = new Map()
  const sessionSaveTimers = new Map()
  const oldSessionMapPath = path.join(pluginRoot, "openviking-session-map.json")
  const stateRoot = path.join(pluginRoot, "openviking-sessions")
  const statePaths = {
    root: stateRoot,
    meta: path.join(stateRoot, "meta.json"),
    projects: path.join(stateRoot, "projects"),
    sessions: path.join(stateRoot, "sessions"),
    finalizing: path.join(stateRoot, "finalizing"),
    abandoned: path.join(stateRoot, "abandoned"),
  }
  let persistenceEnabled = true
  let persistenceWarningEmitted = false
  let lastBufferCleanupAt = 0

  async function init() {
    await initializeStateDirectory()
    await backupLegacySessionMap()
    await recoverStaleFinalizingFiles()
    await loadSessionStates()
    await finalizeExpiredSessions()
    resumeBackgroundCommits()
  }

  async function initializeStateDirectory() {
    try {
      for (const dir of [statePaths.root, statePaths.projects, statePaths.sessions, statePaths.finalizing, statePaths.abandoned]) {
        await fs.promises.mkdir(dir, { recursive: true })
      }
      if (!fs.existsSync(statePaths.meta)) {
        await fs.promises.writeFile(statePaths.meta, JSON.stringify({ version: 1, createdAt: Date.now() }, null, 2), "utf8")
      }
    } catch (error) {
      persistenceEnabled = false
      warnPersistenceDegraded(error)
    }
  }

  function warnPersistenceDegraded(error) {
    if (persistenceWarningEmitted) return
    persistenceWarningEmitted = true
    log("WARN", "persistence", "OpenViking session state persistence disabled; pending messages and routing state will be lost on process exit", {
      error: error?.message,
    })
  }

  async function backupLegacySessionMap() {
    try {
      if (!fs.existsSync(oldSessionMapPath)) return
      await fs.promises.rename(oldSessionMapPath, nextLegacyBackupPath())
      log("WARN", "persistence", "Backed up legacy session map without migrating contents")
    } catch (error) {
      log("WARN", "persistence", "Failed to back up legacy session map; continuing with split state", { error: error?.message })
    }
  }

  function nextLegacyBackupPath() {
    const parsed = path.parse(oldSessionMapPath)
    const timestamp = formatTimestamp(new Date())
    for (let index = 0; index < 100; index += 1) {
      const suffix = index === 0 ? "" : `-${index}`
      const candidate = path.join(parsed.dir, `${parsed.name}.v1-backup-${timestamp}${suffix}${parsed.ext}`)
      if (!fs.existsSync(candidate)) return candidate
    }
    return path.join(parsed.dir, `${parsed.name}.v1-backup-${timestamp}-${process.pid}${parsed.ext}`)
  }

  async function loadSessionStates() {
    if (!persistenceEnabled) return
    let files = []
    try {
      files = await fs.promises.readdir(statePaths.sessions)
    } catch (error) {
      warnPersistenceDegraded(error)
      return
    }

    for (const file of files.filter((name) => name.endsWith(".json"))) {
      const filePath = path.join(statePaths.sessions, file)
      try {
        const state = JSON.parse(await fs.promises.readFile(filePath, "utf8"))
        const mapping = deserializeSessionState(state)
        sessionMap.set(mapping.openCodeSessionId, mapping)
      } catch (error) {
        log("WARN", "persistence", "Bad session state JSON moved to abandoned", { file, error: error?.message })
        await moveFileToAbandoned(filePath, file)
      }
    }
    log("INFO", "persistence", "Session states loaded", { count: sessionMap.size })
  }

  function serializeSessionState(mapping, extra = {}) {
    return {
      version: 1,
      openCodeSessionId: mapping.openCodeSessionId,
      safeOpenCodeSessionId: mapping.safeOpenCodeSessionId,
      projectID: mapping.projectID,
      safeProjectId: mapping.safeProjectId,
      peerId: mapping.peerId,
      ovSessionId: mapping.ovSessionId,
      createdAt: mapping.createdAt,
      updatedAt: mapping.updatedAt,
      lastSeenAt: mapping.lastSeenAt,
      expiresAt: mapping.expiresAt,
      capturedMessages: Array.from(mapping.capturedMessages),
      messageRoles: Array.from(mapping.messageRoles.entries()),
      pendingMessages: Array.from(mapping.pendingMessages.entries()),
      commit: {
        lastCommitTime: mapping.commit.lastCommitTime ?? null,
        inFlight: Boolean(mapping.commit.inFlight),
        taskId: mapping.commit.taskId ?? null,
        startedAt: mapping.commit.startedAt ?? null,
        pendingCleanup: Boolean(mapping.commit.pendingCleanup),
      },
      ...extra,
    }
  }

  function deserializeSessionState(state) {
    const now = Date.now()
    const safeOpenCodeSessionId = state.safeOpenCodeSessionId || resolveSafeOpenCodeSessionId(state.openCodeSessionId, now)
    return {
      openCodeSessionId: state.openCodeSessionId || safeOpenCodeSessionId,
      safeOpenCodeSessionId,
      projectID: state.projectID,
      safeProjectId: state.safeProjectId,
      peerId: isValidPeerId(state.peerId) ? String(state.peerId).trim() : null,
      ovSessionId: state.ovSessionId || buildOpenVikingSessionId({ peerId: state.peerId, openCodeSessionId: state.openCodeSessionId, now }).ovSessionId,
      createdAt: state.createdAt ?? now,
      updatedAt: state.updatedAt ?? now,
      lastSeenAt: state.lastSeenAt ?? state.updatedAt ?? now,
      expiresAt: state.expiresAt ?? ((state.lastSeenAt ?? now) + SESSION_TTL_MS),
      capturedMessages: new Set(state.capturedMessages ?? []),
      messageRoles: new Map(state.messageRoles ?? []),
      pendingMessages: new Map(state.pendingMessages ?? []),
      sendingMessages: new Set(),
      commit: deserializeCommitState(state),
    }
  }

  function createCommitState(overrides = {}) {
    return {
      lastCommitTime: null,
      inFlight: false,
      taskId: null,
      startedAt: null,
      pendingCleanup: false,
      ...overrides,
    }
  }

  function deserializeCommitState(state) {
    return createCommitState({
      lastCommitTime: state.commit?.lastCommitTime ?? state.lastCommitTime ?? null,
      inFlight: Boolean(state.commit?.inFlight ?? state.commitInFlight),
      taskId: state.commit?.taskId ?? state.commitTaskId ?? null,
      startedAt: state.commit?.startedAt ?? state.commitStartedAt ?? null,
      pendingCleanup: Boolean(state.commit?.pendingCleanup ?? state.pendingCleanup),
    })
  }

  async function saveSessionState(mapping, { touch = true } = {}) {
    if (touch) touchMapping(mapping)
    sessionMap.set(mapping.openCodeSessionId, mapping)
    if (!persistenceEnabled) return
    const filePath = getSessionStatePath(mapping.safeOpenCodeSessionId)
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`
    try {
      await fs.promises.writeFile(tempPath, JSON.stringify(serializeSessionState(mapping), null, 2), "utf8")
      await fs.promises.rename(tempPath, filePath)
    } catch (error) {
      await rmQuiet(tempPath)
      warnPersistenceDegraded(error)
    }
  }

  function debouncedSaveSessionState(mapping) {
    const key = mapping.safeOpenCodeSessionId
    const existing = sessionSaveTimers.get(key)
    if (existing) clearTimeout(existing.timer)
    const timer = setTimeout(() => {
      sessionSaveTimers.delete(key)
      saveSessionState(mapping).catch((error) => {
        log("ERROR", "persistence", "Debounced session state save failed", { error: error?.message })
      })
    }, 300)
    timer.unref?.()
    sessionSaveTimers.set(key, { timer, mapping })
  }

  function clearDebouncedSessionSave(mapping) {
    const existing = sessionSaveTimers.get(mapping.safeOpenCodeSessionId)
    if (!existing) return
    clearTimeout(existing.timer)
    sessionSaveTimers.delete(mapping.safeOpenCodeSessionId)
  }

  async function flushDebouncedSessionSaves({ touch = false } = {}) {
    const pending = Array.from(sessionSaveTimers.values())
    sessionSaveTimers.clear()
    for (const entry of pending) {
      clearTimeout(entry.timer)
      await saveSessionState(entry.mapping, { touch })
    }
  }

  async function deleteSessionState(mapping) {
    clearDebouncedSessionSave(mapping)
    sessionMap.delete(mapping.openCodeSessionId)
    sessionMessageBuffer.delete(mapping.openCodeSessionId)
    if (!persistenceEnabled) return
    await rmQuiet(getSessionStatePath(mapping.safeOpenCodeSessionId))
  }

  function getSessionStatePath(safeOpenCodeSessionId) {
    return path.join(statePaths.sessions, `${safeOpenCodeSessionId}.json`)
  }

  function getProjectStatePath(safeProjectId) {
    return path.join(statePaths.projects, `${safeProjectId}.json`)
  }

  function getMappedSessionId(opencodeSessionId) {
    return sessionMap.get(opencodeSessionId)?.ovSessionId
  }

  function getMappedAgentId(opencodeSessionId) {
    return sessionMap.get(opencodeSessionId)?.peerId
  }

  function getRequestConfig(opencodeSessionId) {
    const peerId = sessionMap.get(opencodeSessionId)?.peerId ?? effectivePeerId(config)
    return peerId ? { ...config, peerId } : config
  }

  async function handleEvent(event) {
    if (!event?.type || event.type === "session.diff") return

    if (event.type === "session.created") {
      await handleSessionCreated(event)
    } else if (event.type === "session.deleted") {
      await handleSessionDeleted(event)
    } else if (event.type === "session.error") {
      await handleSessionError(event)
    } else if (event.type === "session.compacted") {
      await handleSessionCompacted(event)
    } else if (event.type === "message.updated") {
      await handleMessageUpdated(event)
    } else if (event.type === "message.part.updated") {
      await handleMessagePartUpdated(event)
    }
  }

  async function handleSessionCreated(event) {
    const sessionId = resolveEventSessionId(event)
    if (!sessionId) {
      log("ERROR", "event", "session.created event missing sessionId", { event: safeStringify(event) })
      return
    }

    const mapping = await establishSessionMapping(sessionId, event)
    if (!mapping) return
    await applyBufferedMessages(sessionId, mapping)
    await saveSessionState(mapping)
  }

  async function establishSessionMapping(sessionId, event = {}, { requirePeer = false, reason = "session.created" } = {}) {
    const existing = sessionMap.get(sessionId)
    const peerContext = await resolvePeerContext(sessionId, event, existing)
    if (requirePeer && !isValidPeerId(peerContext.peerId)) return null

    const sessionIds = buildOpenVikingSessionId({ peerId: peerContext.peerId, openCodeSessionId: sessionId })
    const ovSessionId = await ensureOpenVikingSession(sessionIds.ovSessionId, peerContext.peerId)
    if (!ovSessionId) return null

    const mapping = existing ?? createSessionMapping({
      openCodeSessionId: sessionId,
      safeOpenCodeSessionId: sessionIds.safeOpenCodeSessionId,
      ovSessionId,
      peerId: peerContext.peerId,
      projectID: peerContext.projectID,
      safeProjectId: peerContext.safeProjectId,
    })
    Object.assign(mapping, {
      safeOpenCodeSessionId: sessionIds.safeOpenCodeSessionId,
      ovSessionId,
      peerId: peerContext.peerId,
      projectID: peerContext.projectID,
      safeProjectId: peerContext.safeProjectId,
    })
    sessionMap.set(sessionId, mapping)
    log("INFO", "event", "Session mapping established", {
      opencode_session: sessionId,
      openviking_session: ovSessionId,
      peer_id: peerContext.peerId ?? "none",
      peer_id_source: peerContext.source,
      reason,
    })
    return mapping
  }

  async function applyBufferedMessages(sessionId, mapping) {
    const bufferedMessages = sessionMessageBuffer.get(sessionId)
    if (!bufferedMessages?.length) return
    for (const buffered of bufferedMessages) {
      if (buffered.role) mapping.messageRoles.set(buffered.messageId, buffered.role)
      if (buffered.content) {
        mapping.pendingMessages.set(
          buffered.messageId,
          mergeMessageContent(mapping.pendingMessages.get(buffered.messageId), buffered.content),
        )
      }
    }
    sessionMessageBuffer.delete(sessionId)
    await flushPendingMessages(sessionId, mapping)
  }

  async function ensureSessionInitialized(sessionId) {
    if (!sessionId) return null
    const existing = sessionMap.get(sessionId)
    if (existing && isValidPeerId(existing.peerId)) return existing
    const mapping = await establishSessionMapping(sessionId, { properties: { info: { id: sessionId } } }, { requirePeer: true, reason: existing ? "repair" : "lazy" })
    if (!mapping) return null
    await applyBufferedMessages(sessionId, mapping)
    await saveSessionState(mapping)
    return mapping
  }

  async function resolvePeerContext(sessionId, event, existing) {
    const eventSession = event?.properties?.info ?? {}
    const sdkSession = await fetchOpenCodeSession(sessionId, eventSession)
    const session = { ...eventSession, ...(sdkSession ?? {}) }
    const project = await fetchOpenCodeProject(session)
    const identity = resolveProjectIdentity({ session, project })
    const { projectID, safeProjectId } = identity

    if (config.peerIdMode === "fixed") {
      const fixed = resolveFixedPeerId(config).peerId
      if (!fixed) {
        log("WARN", "session", "peerIdMode=fixed requires a valid peerId; peer propagation disabled")
      }
      return { peerId: fixed, projectID, safeProjectId, source: fixed ? "fixed" : "none" }
    }

    if (isUsableProjectIdentity(safeProjectId)) {
      const projectState = await readProjectState(safeProjectId)
      if (isValidPeerId(projectState?.peerId)) {
        return { peerId: String(projectState.peerId).trim(), projectID, safeProjectId, source: "project-file" }
      }

      const previousPeerIds = Array.isArray(projectState?.previousPeerIds) ? [...projectState.previousPeerIds] : []
      if (projectState?.peerId && !isValidPeerId(projectState.peerId)) {
        log("WARN", "session", "Discarding invalid cached project peerId", { safeProjectId, peerId: projectState.peerId })
        previousPeerIds.push(projectState.peerId)
      }

      const derived = deriveAutoPeerId({ project, session, projectID })
      if (isValidPeerId(derived.peerId)) {
        const state = await writeProjectState(safeProjectId, {
          version: 1,
          projectID,
          safeProjectId,
          peerId: derived.peerId,
          previousPeerIds: [...new Set(previousPeerIds)].filter(Boolean),
          createdAt: projectState?.createdAt ?? Date.now(),
          updatedAt: Date.now(),
        })
        return { peerId: state.peerId, projectID, safeProjectId, source: "auto" }
      }
    }

    if (isValidPeerId(existing?.peerId)) return { peerId: existing.peerId, projectID, safeProjectId, source: "session-state" }
    const explicit = effectivePeerId(config)
    if (explicit) return { peerId: explicit, projectID, safeProjectId, source: "explicit-fallback" }
    log("WARN", "session", "Unable to resolve OpenCode project peer identity; peer propagation disabled", {
      session_id: sessionId,
      project_id: projectID,
      safe_project_id: safeProjectId,
      identity_source: identity.source,
    })
    return { peerId: null, projectID, safeProjectId, source: "none" }
  }

  function resolveProjectIdentity({ session, project }) {
    const sessionProjectId = usableProjectId(session?.projectID)
    if (sessionProjectId) return { projectID: sessionProjectId, safeProjectId: normalizeIdentifierPart(sessionProjectId), source: "session-api" }

    const projectId = usableProjectId(project?.id)
    if (projectId) return { projectID: projectId, safeProjectId: normalizeIdentifierPart(projectId), source: "project-api" }

    const fallbackPath = project?.worktree || project?.directory || session?.directory || session?.cwd || session?.path
    const fallbackId = basenameIdentifierFromPath(fallbackPath)
    if (isUsableProjectIdentity(fallbackId)) return { projectID: fallbackId, safeProjectId: fallbackId, source: "path-basename" }

    const rawProjectId = session?.projectID ?? project?.id
    return { projectID: rawProjectId, safeProjectId: normalizeIdentifierPart(rawProjectId), source: "none" }
  }

  function usableProjectId(value) {
    return isUsableProjectIdentity(value) ? String(value).trim() : null
  }

  function makeOpenCodeLookupRequest(base = {}) {
    const request = { ...base }
    const directory = base.directory
    const workspace = base.workspace ?? base.workspaceID
    delete request.directory
    delete request.workspace
    delete request.workspaceID
    if (directory) request.directory = directory
    if (workspace) request.workspace = workspace
    return request
  }

  async function fetchOpenCodeSession(sessionId, context = {}) {
    if (typeof client?.session?.get !== "function") {
      log("WARN", "session", "OpenCode v2 session API is unavailable for peer derivation", { session_id: sessionId })
      return null
    }
    try {
      const result = await client.session.get(makeOpenCodeLookupRequest({
        sessionID: sessionId,
        directory: context.directory,
        workspace: context.workspace ?? context.workspaceID,
      }))
      return unwrapClientResult(result)
    } catch (error) {
      log("WARN", "session", "Failed to query OpenCode session for peer derivation", { session_id: sessionId, error: error?.message })
      return null
    }
  }

  async function fetchOpenCodeProject(context = {}) {
    if (typeof client?.project?.current !== "function") {
      log("WARN", "session", "OpenCode v2 project API is unavailable for peer derivation")
      return null
    }
    try {
      const result = await client.project.current(makeOpenCodeLookupRequest({
        directory: context.directory,
        workspace: context.workspace ?? context.workspaceID,
      }))
      return unwrapClientResult(result)
    } catch (error) {
      log("WARN", "session", "Failed to query OpenCode project for peer derivation", { directory: context.directory, error: error?.message })
      return null
    }
  }

  function unwrapClientResult(result) {
    return result?.data ?? result?.result ?? result
  }

  async function readProjectState(safeProjectId) {
    if (!persistenceEnabled || !isUsableProjectIdentity(safeProjectId)) return null
    const filePath = getProjectStatePath(safeProjectId)
    try {
      if (!fs.existsSync(filePath)) return null
      return JSON.parse(await fs.promises.readFile(filePath, "utf8"))
    } catch (error) {
      log("WARN", "persistence", "Bad project state JSON moved to abandoned", { safeProjectId, error: error?.message })
      await moveFileToAbandoned(filePath, `project-${safeProjectId}.json`)
      return null
    }
  }

  async function writeProjectState(safeProjectId, state) {
    if (!persistenceEnabled || !isUsableProjectIdentity(safeProjectId)) return state
    const filePath = getProjectStatePath(safeProjectId)
    const json = JSON.stringify(state, null, 2)
    try {
      if (!fs.existsSync(filePath)) {
        try {
          await fs.promises.writeFile(filePath, json, { encoding: "utf8", flag: "wx" })
          return state
        } catch (error) {
          if (error?.code !== "EEXIST") throw error
        }
      }

      const existing = await readProjectState(safeProjectId)
      if (isValidPeerId(existing?.peerId)) return existing

      const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`
      await fs.promises.writeFile(tempPath, json, "utf8")
      await fs.promises.rename(tempPath, filePath)
      return state
    } catch (error) {
      log("WARN", "persistence", "Failed to write project peer state", { safeProjectId, error: error?.message })
      return state
    }
  }

  async function ensureOpenVikingSession(ovSessionId, peerId) {
    try {
      const response = await makeRequest(config, {
        method: "GET",
        endpoint: `/api/v1/sessions/${encodeURIComponent(ovSessionId)}`,
        timeoutMs: 5000,
        actorPeerId: peerId,
      })
      if (unwrapResponse(response)) return ovSessionId
    } catch (error) {
      log("INFO", "session", "OpenViking session unavailable, creating it", {
        openviking_session: ovSessionId,
        error: error?.message,
      })
    }

    try {
      const response = await makeRequest(config, {
        method: "POST",
        endpoint: "/api/v1/sessions",
        body: { session_id: ovSessionId },
        timeoutMs: 5000,
        actorPeerId: peerId,
      })
      return unwrapResponse(response)?.session_id ?? ovSessionId
    } catch (error) {
      log("ERROR", "session", "Failed to create OpenViking session", {
        openviking_session: ovSessionId,
        error: error?.message,
      })
      return null
    }
  }

  async function handleSessionDeleted(event) {
    const sessionId = resolveEventSessionId(event)
    if (!sessionId) return

    const mapping = sessionMap.get(sessionId)
    if (!mapping) {
      sessionMessageBuffer.delete(sessionId)
      await finalizeExpiredSessions()
      return
    }

    await flushPendingMessages(sessionId, mapping)
    if (mapping.capturedMessages.size > 0 || mapping.commit.inFlight) {
      mapping.commit.pendingCleanup = true
      await saveSessionState(mapping)
      if (!mapping.commit.inFlight) await startBackgroundCommit(mapping, sessionId)
    } else {
      await deleteSessionState(mapping)
    }
    await finalizeExpiredSessions()
  }

  async function handleSessionError(event) {
    const sessionId = resolveEventSessionId(event)
    if (!sessionId) return
    log("ERROR", "event", "OpenCode session error", { session_id: sessionId, error: safeStringify(event.error) })
    await handleSessionDeleted(event)
  }

  async function handleSessionCompacted(event) {
    await commitSessionBoundary(event, "session.compacted")
    await finalizeExpiredSessions()
  }

  async function commitSessionBoundary(event, reason) {
    const sessionId = resolveEventSessionId(event)
    if (!sessionId) return

    const mapping = sessionMap.get(sessionId)
    if (!mapping) return

    await flushPendingMessages(sessionId, mapping)
    if (mapping.commit.inFlight) {
      monitorBackgroundCommit(mapping, sessionId)
      return
    }
    if (mapping.capturedMessages.size > 0) {
      log("INFO", "session", "Committing OpenViking session at lifecycle boundary", {
        opencode_session: sessionId,
        openviking_session: mapping.ovSessionId,
        reason,
      })
      await startBackgroundCommit(mapping, sessionId)
    }
  }

  async function handleMessageUpdated(event) {
    const message = event.properties?.info
    if (!message) return

    const sessionId = message.sessionID
    const messageId = message.id
    const role = message.role
    const finish = message.finish
    if (!sessionId || !messageId) return

    let mapping = sessionMap.get(sessionId)
    if (!mapping) {
      upsertBufferedMessage(sessionId, messageId, role ? { role } : {})
      mapping = await ensureSessionInitialized(sessionId)
      if (mapping) await flushPendingMessages(sessionId, mapping)
      return
    }

    if (role === "user") {
      mapping.messageRoles.set(messageId, role)
    } else if (role === "assistant" && finish === "stop") {
      mapping.messageRoles.set(messageId, role)
    }
    await saveSessionState(mapping)
    await flushPendingMessages(sessionId, mapping)
  }

  async function handleMessagePartUpdated(event) {
    const part = event.properties?.part
    if (!part) return

    const sessionId = part.sessionID
    const messageId = part.messageID
    if (!sessionId || !messageId || part.type !== "text" || !part.text?.trim()) return

    let mapping = sessionMap.get(sessionId)
    if (!mapping) {
      upsertBufferedMessage(sessionId, messageId, { content: part.text })
      mapping = await ensureSessionInitialized(sessionId)
      if (mapping) await flushPendingMessages(sessionId, mapping)
      return
    }

    if (mapping.capturedMessages.has(messageId)) return
    mapping.pendingMessages.set(messageId, mergeMessageContent(mapping.pendingMessages.get(messageId), part.text))
    debouncedSaveSessionState(mapping)
  }

  async function flushPendingMessages(opencodeSessionId, mapping, { persist = true } = {}) {
    if (mapping.commit.inFlight) return true
    let allSucceeded = true

    for (const messageId of Array.from(mapping.pendingMessages.keys())) {
      if (mapping.capturedMessages.has(messageId) || mapping.sendingMessages.has(messageId)) continue
      const role = mapping.messageRoles.get(messageId)
      const content = mapping.pendingMessages.get(messageId)
      if (!role || !content?.trim()) continue

      mapping.sendingMessages.add(messageId)
      try {
        const success = await addMessageToSession(mapping, role, content)
        if (success) {
          const latest = mapping.pendingMessages.get(messageId)
          if (latest && latest !== content) continue
          mapping.pendingMessages.delete(messageId)
          mapping.capturedMessages.add(messageId)
          if (persist) await saveSessionState(mapping)
        } else {
          allSucceeded = false
        }
      } finally {
        mapping.sendingMessages.delete(messageId)
      }
    }

    return allSucceeded
  }

  async function addMessageToSession(mapping, role, content) {
    try {
      const body = { role, content }
      if (isValidPeerId(mapping.peerId)) body.peer_id = mapping.peerId
      const response = await makeRequest(config, {
        method: "POST",
        endpoint: `/api/v1/sessions/${encodeURIComponent(mapping.ovSessionId)}/messages`,
        body,
        timeoutMs: 5000,
        actorPeerId: mapping.peerId,
      })
      unwrapResponse(response)
      return true
    } catch (error) {
      log("ERROR", "message", "Failed to add message to OpenViking session", {
        openviking_session: mapping.ovSessionId,
        role,
        error: error?.message,
      })
      return false
    }
  }

  async function startBackgroundCommit(mapping, opencodeSessionId, abortSignal) {
    if (mapping.commit.inFlight && mapping.commit.taskId) {
      if (!abortSignal) monitorBackgroundCommit(mapping, opencodeSessionId)
      return { mode: "background", taskId: mapping.commit.taskId }
    }

    try {
      const response = await makeRequest(config, {
        method: "POST",
        endpoint: `/api/v1/sessions/${encodeURIComponent(mapping.ovSessionId)}/commit`,
        timeoutMs: 10000,
        abortSignal,
        actorPeerId: mapping.peerId,
      })
      const result = unwrapResponse(response)
      const taskId = result?.task_id

      if (!taskId) {
        await finalizeCommitSuccess(mapping, opencodeSessionId)
        return { mode: "completed", result }
      }

      mapping.commit.inFlight = true
      mapping.commit.taskId = taskId
      mapping.commit.startedAt = Date.now()
      await saveSessionState(mapping)
      if (!abortSignal) monitorBackgroundCommit(mapping, opencodeSessionId)
      return { mode: "background", taskId }
    } catch (error) {
      if (error?.message?.includes("already has a commit in progress")) {
        const taskId = await findRunningCommitTaskId(mapping)
        if (taskId) {
          mapping.commit.inFlight = true
          mapping.commit.taskId = taskId
          mapping.commit.startedAt = mapping.commit.startedAt ?? Date.now()
          await saveSessionState(mapping)
          if (!abortSignal) monitorBackgroundCommit(mapping, opencodeSessionId)
          return { mode: "background", taskId }
        }
      }
      log("ERROR", "session", "Failed to start OpenViking commit", {
        openviking_session: mapping.ovSessionId,
        opencode_session: opencodeSessionId,
        error: error?.message,
      })
      return null
    }
  }

  async function waitForCommitCompletion(mapping, opencodeSessionId, abortSignal, timeoutMs = COMMIT_WAIT_TIMEOUT_MS) {
    const startedAt = Date.now()
    while (Date.now() - startedAt < timeoutMs) {
      if (abortSignal?.aborted) throw new Error("Operation aborted")
      if (!mapping.commit.inFlight) return null
      if (!mapping.commit.taskId) {
        mapping.commit.taskId = await findRunningCommitTaskId(mapping)
        if (!mapping.commit.taskId) {
          clearCommitState(mapping)
          await saveSessionState(mapping)
          return null
        }
      }

      const task = await getTask(mapping, abortSignal)
      if (task.status === "completed") {
        await finalizeCommitSuccess(mapping, opencodeSessionId)
        return task
      }
      if (task.status === "failed") {
        clearCommitState(mapping)
        await saveSessionState(mapping)
        throw new Error(task.error || "Background commit failed")
      }
      await sleep(2000, abortSignal)
    }
    return null
  }

  async function getTask(mapping, abortSignal) {
    const response = await makeRequest(config, {
      method: "GET",
      endpoint: `/api/v1/tasks/${encodeURIComponent(mapping.commit.taskId)}`,
      timeoutMs: 5000,
      abortSignal,
      actorPeerId: mapping.peerId,
    })
    return unwrapResponse(response)
  }

  async function findRunningCommitTaskId(mapping) {
    try {
      const response = await makeRequest(config, {
        method: "GET",
        endpoint: `/api/v1/tasks?task_type=session_commit&resource_id=${encodeURIComponent(mapping.ovSessionId)}&limit=10`,
        timeoutMs: 5000,
        actorPeerId: mapping.peerId,
      })
      const tasks = unwrapResponse(response) ?? []
      return tasks.find((task) => task.status === "pending" || task.status === "running")?.task_id
    } catch (error) {
      log("WARN", "session", "Failed to query running commit tasks", { error: error?.message })
      return undefined
    }
  }

  async function finalizeCommitSuccess(mapping, opencodeSessionId) {
    mapping.commit.lastCommitTime = Date.now()
    mapping.capturedMessages.clear()
    clearCommitState(mapping)
    await saveSessionState(mapping)

    await flushPendingMessages(opencodeSessionId, mapping)

    if (mapping.commit.pendingCleanup) {
      await deleteSessionState(mapping)
    }
  }

  function resumeBackgroundCommits() {
    for (const [opencodeSessionId, mapping] of sessionMap.entries()) {
      if (mapping.commit.inFlight) monitorBackgroundCommit(mapping, opencodeSessionId)
    }
  }

  function monitorBackgroundCommit(mapping, opencodeSessionId) {
    if (!mapping.commit.taskId) return
    if (commitWatchers.has(mapping.commit.taskId)) return

    const taskId = mapping.commit.taskId
    const watcher = waitForCommitCompletion(mapping, opencodeSessionId)
      .then((task) => {
        if (!task) {
          log("WARN", "session", "Background commit is still pending after the wait timeout", {
            task_id: taskId,
            openviking_session: mapping.ovSessionId,
            opencode_session: opencodeSessionId,
          })
        }
      })
      .catch((error) => {
        log("ERROR", "session", "Background commit watcher failed", {
          task_id: taskId,
          openviking_session: mapping.ovSessionId,
          opencode_session: opencodeSessionId,
          error: error?.message,
        })
      })
      .finally(() => {
        commitWatchers.delete(taskId)
      })
    commitWatchers.set(taskId, watcher)
  }

  async function flushAll({ commit = false } = {}) {
    await flushDebouncedSessionSaves({ touch: false })
    await finalizeExpiredSessions()
    for (const [sessionId, mapping] of sessionMap.entries()) {
      if (isFinalizationDue(mapping)) continue
      await flushPendingMessages(sessionId, mapping)
      if (commit) {
        if (mapping.commit.inFlight) {
          monitorBackgroundCommit(mapping, sessionId)
        } else if (mapping.capturedMessages.size > 0) {
          await startBackgroundCommit(mapping, sessionId)
        }
      }
      await saveSessionState(mapping)
    }
  }

  async function flushSession(opencodeSessionId, { commit = false, reason = "manual" } = {}) {
    const mapping = sessionMap.get(opencodeSessionId)
    if (!mapping) return false

    await flushPendingMessages(opencodeSessionId, mapping)
    if (commit) {
      if (mapping.commit.inFlight) {
        monitorBackgroundCommit(mapping, opencodeSessionId)
      } else if (mapping.capturedMessages.size > 0) {
        log("INFO", "session", "Committing OpenViking session at lifecycle boundary", {
          opencode_session: opencodeSessionId,
          openviking_session: mapping.ovSessionId,
          reason,
        })
        await startBackgroundCommit(mapping, opencodeSessionId)
      }
    }
    await saveSessionState(mapping)
    await finalizeExpiredSessions()
    return true
  }

  async function commitSession(sessionId, opencodeSessionId, abortSignal) {
    try {
      if (!opencodeSessionId) return await commitExplicitOpenVikingSession(sessionId, abortSignal)

      const mapped = opencodeSessionId ? sessionMap.get(opencodeSessionId) : undefined
      let mapping = mapped
      if (!mapping || mapping.ovSessionId !== sessionId) {
        mapping = createSessionMapping({
          openCodeSessionId: opencodeSessionId ?? sessionId,
          ovSessionId: sessionId,
          peerId: mapped?.peerId ?? effectivePeerId(config),
        })
      } else {
        await flushPendingMessages(opencodeSessionId, mapping)
      }

      if (mapping.commit.inFlight) {
        const task = await waitForCommitCompletion(mapping, opencodeSessionId ?? sessionId, abortSignal)
        if (task?.status === "completed") return { status: "completed", task }
      }

      const start = await startBackgroundCommit(mapping, opencodeSessionId ?? sessionId, abortSignal)
      if (!start) throw new Error("Failed to start OpenViking session commit")
      if (start.mode === "completed") return { status: "completed", result: start.result }

      const task = await waitForCommitCompletion(mapping, opencodeSessionId ?? sessionId, abortSignal)
      if (!task) return { status: "accepted", task_id: start.taskId }
      return { status: task.status, task }
    } finally {
      await flushDebouncedSessionSaves({ touch: false })
      await finalizeExpiredSessions()
    }
  }

  async function commitExplicitOpenVikingSession(sessionId, abortSignal) {
    const response = await makeRequest(config, {
      method: "POST",
      endpoint: `/api/v1/sessions/${encodeURIComponent(sessionId)}/commit`,
      timeoutMs: 10000,
      abortSignal,
      actorPeerId: effectivePeerId(config),
    })
    const result = unwrapResponse(response)
    const taskId = result?.task_id
    if (!taskId) return { status: "completed", result }

    const task = await waitForExplicitCommitCompletion(taskId, abortSignal)
    if (!task) return { status: "accepted", task_id: taskId }
    return { status: task.status, task }
  }

  async function waitForExplicitCommitCompletion(taskId, abortSignal, timeoutMs = COMMIT_WAIT_TIMEOUT_MS) {
    const startedAt = Date.now()
    while (Date.now() - startedAt < timeoutMs) {
      if (abortSignal?.aborted) throw new Error("Operation aborted")
      const response = await makeRequest(config, {
        method: "GET",
        endpoint: `/api/v1/tasks/${encodeURIComponent(taskId)}`,
        timeoutMs: 5000,
        abortSignal,
        actorPeerId: effectivePeerId(config),
      })
      const task = unwrapResponse(response)
      if (task.status === "completed") return task
      if (task.status === "failed") throw new Error(task.error || "Background commit failed")
      await sleep(2000, abortSignal)
    }
    return null
  }

  async function finalizeExpiredSessions() {
    const now = Date.now()
    for (const mapping of Array.from(sessionMap.values())) {
      if (!isFinalizationDue(mapping, now)) continue
      await finalizeMapping(mapping)
    }
  }

  function isFinalizationDue(mapping, now = Date.now()) {
    return mapping.expiresAt <= now || Boolean(mapping.commit.pendingCleanup)
  }

  async function finalizeMapping(mapping) {
    const claim = await claimFinalizing(mapping)
    if (!claim) return

    const pushSucceeded = await flushPendingMessages(mapping.openCodeSessionId, mapping, { persist: false })
    if (!pushSucceeded) {
      await restoreFinalizing(claim.path, mapping)
      return
    }

    await writeFinalizingState(claim.path, mapping)
    if (mapping.pendingMessages.size === 0 && mapping.capturedMessages.size === 0) {
      await removeFinalizing(claim.path, mapping)
      return
    }

    const commit = await triggerFinalizationCommit(mapping)
    if (commit.transportFailure) {
      await restoreFinalizing(claim.path, mapping)
      return
    }
    await removeFinalizing(claim.path, mapping)
  }

  async function claimFinalizing(mapping) {
    clearDebouncedSessionSave(mapping)
    sessionMap.delete(mapping.openCodeSessionId)
    if (!persistenceEnabled) return { path: null }
    await saveSessionState(mapping, { touch: false })
    sessionMap.delete(mapping.openCodeSessionId)
    const source = getSessionStatePath(mapping.safeOpenCodeSessionId)
    const target = path.join(statePaths.finalizing, `${mapping.safeOpenCodeSessionId}.${process.pid}.${Date.now()}.json`)
    try {
      await fs.promises.rename(source, target)
      await writeFinalizingState(target, mapping)
      return { path: target }
    } catch (error) {
      log("DEBUG", "session", "Skipped finalization because claim failed", { session: mapping.safeOpenCodeSessionId, error: error?.message })
      sessionMap.set(mapping.openCodeSessionId, mapping)
      return null
    }
  }

  async function triggerFinalizationCommit(mapping) {
    try {
      const response = await makeRequest(config, {
        method: "POST",
        endpoint: `/api/v1/sessions/${encodeURIComponent(mapping.ovSessionId)}/commit`,
        timeoutMs: 10000,
        actorPeerId: mapping.peerId,
      })
      unwrapResponse(response)
      return { transportFailure: false }
    } catch (error) {
      if (isTransportFailure(error)) {
        log("WARN", "session", "Finalization commit transport failure; keeping state for retry", { error: error?.message })
        return { transportFailure: true }
      }
      log("WARN", "session", "Finalization commit received server error; deleting local state", { error: error?.message })
      return { transportFailure: false }
    }
  }

  function isTransportFailure(error) {
    const message = String(error?.message ?? "")
    return message.includes("fetch failed")
      || message.includes("service unavailable")
      || message.includes("Request timeout")
      || message.includes("ECONNREFUSED")
      || error?.name === "AbortError"
  }

  async function writeFinalizingState(filePath, mapping) {
    if (!filePath) return
    await fs.promises.writeFile(filePath, JSON.stringify(serializeSessionState(mapping, { claimedAt: Date.now() }), null, 2), "utf8")
  }

  async function restoreFinalizing(filePath, mapping) {
    sessionMap.set(mapping.openCodeSessionId, mapping)
    if (!filePath || !persistenceEnabled) return saveSessionState(mapping, { touch: false })
    await writeFinalizingState(filePath, mapping)
    const activePath = getSessionStatePath(mapping.safeOpenCodeSessionId)
    if (fs.existsSync(activePath)) {
      await resolveActiveFinalizingConflict(activePath, filePath, mapping)
      return
    }
    await fs.promises.rename(filePath, activePath)
  }

  async function removeFinalizing(filePath, mapping) {
    clearDebouncedSessionSave(mapping)
    sessionMap.delete(mapping.openCodeSessionId)
    sessionMessageBuffer.delete(mapping.openCodeSessionId)
    if (filePath) await rmQuiet(filePath)
  }

  async function recoverStaleFinalizingFiles() {
    if (!persistenceEnabled) return
    let files = []
    try {
      files = await fs.promises.readdir(statePaths.finalizing)
    } catch {
      return
    }

    const now = Date.now()
    for (const file of files.filter((name) => name.endsWith(".json"))) {
      const filePath = path.join(statePaths.finalizing, file)
      try {
        const stat = await fs.promises.stat(filePath)
        const state = JSON.parse(await fs.promises.readFile(filePath, "utf8"))
        const claimedAt = Number(state.claimedAt || stat.mtimeMs)
        if (now - claimedAt < STALE_FINALIZING_MS) continue
        const mapping = deserializeSessionState(state)
        const activePath = getSessionStatePath(mapping.safeOpenCodeSessionId)
        if (fs.existsSync(activePath)) {
          await resolveActiveFinalizingConflict(activePath, filePath, mapping)
        } else {
          await fs.promises.rename(filePath, activePath)
          sessionMap.set(mapping.openCodeSessionId, mapping)
        }
      } catch (error) {
        log("WARN", "persistence", "Failed to recover finalizing state", { file, error: error?.message })
        await moveFileToAbandoned(filePath, file)
      }
    }
  }

  async function resolveActiveFinalizingConflict(activePath, finalizingPath, finalizingMapping) {
    try {
      const active = deserializeSessionState(JSON.parse(await fs.promises.readFile(activePath, "utf8")))
      const activeTime = Math.max(active.lastSeenAt ?? 0, active.updatedAt ?? 0)
      const finalizingTime = Math.max(finalizingMapping.lastSeenAt ?? 0, finalizingMapping.updatedAt ?? 0)
      if (activeTime >= finalizingTime) {
        await moveFileToAbandoned(finalizingPath, path.basename(finalizingPath))
        sessionMap.set(active.openCodeSessionId, active)
      } else {
        await moveFileToAbandoned(activePath, path.basename(activePath))
        await fs.promises.rename(finalizingPath, activePath)
        sessionMap.set(finalizingMapping.openCodeSessionId, finalizingMapping)
      }
    } catch (error) {
      log("WARN", "persistence", "Failed to resolve finalizing conflict", { error: error?.message })
      await moveFileToAbandoned(finalizingPath, path.basename(finalizingPath))
    }
  }

  return {
    init,
    handleEvent,
    getMappedSessionId,
    getMappedAgentId,
    getRequestConfig,
    ensureSessionInitialized,
    commitSession,
    flushAll,
    flushSession,
  }

  function createSessionMapping({ openCodeSessionId, safeOpenCodeSessionId, ovSessionId, peerId, projectID, safeProjectId }) {
    const now = Date.now()
    const safeSessionId = safeOpenCodeSessionId || resolveSafeOpenCodeSessionId(openCodeSessionId, now)
    return {
      openCodeSessionId,
      safeOpenCodeSessionId: safeSessionId,
      projectID,
      safeProjectId,
      peerId: isValidPeerId(peerId) ? String(peerId).trim() : null,
      ovSessionId: ovSessionId ?? buildOpenVikingSessionId({ peerId, openCodeSessionId, now }).ovSessionId,
      createdAt: now,
      updatedAt: now,
      lastSeenAt: now,
      expiresAt: now + SESSION_TTL_MS,
      capturedMessages: new Set(),
      messageRoles: new Map(),
      pendingMessages: new Map(),
      sendingMessages: new Set(),
      commit: createCommitState(),
    }
  }

  function resolveEventSessionId(event) {
    return event?.properties?.info?.id ?? event?.properties?.sessionID ?? event?.properties?.sessionId
  }

  function touchMapping(mapping) {
    const now = Date.now()
    mapping.updatedAt = now
    mapping.lastSeenAt = now
    mapping.expiresAt = now + SESSION_TTL_MS
  }

  function mergeMessageContent(existing, incoming) {
    const next = incoming?.trim()
    if (!next) return existing ?? ""
    if (!existing) return next
    if (next === existing) return existing
    if (next.startsWith(existing)) return next
    if (existing.startsWith(next)) return existing
    if (next.includes(existing)) return next
    if (existing.includes(next)) return existing
    return `${existing}\n${next}`.trim()
  }

  function upsertBufferedMessage(sessionId, messageId, updates) {
    const now = Date.now()
    if (now - lastBufferCleanupAt >= BUFFER_CLEANUP_INTERVAL_MS) {
      cleanupOrphanedMessageBuffers(now)
      lastBufferCleanupAt = now
    }

    const freshBuffer = (sessionMessageBuffer.get(sessionId) ?? [])
      .filter((message) => now - message.timestamp <= BUFFERED_MESSAGE_TTL_MS)
    let buffered = freshBuffer.find((message) => message.messageId === messageId)
    if (!buffered) {
      while (freshBuffer.length >= MAX_BUFFERED_MESSAGES_PER_SESSION) freshBuffer.shift()
      buffered = { messageId, timestamp: now }
      freshBuffer.push(buffered)
    } else {
      buffered.timestamp = now
    }
    if (updates.role) buffered.role = updates.role
    if (updates.content) buffered.content = mergeMessageContent(buffered.content, updates.content)
    sessionMessageBuffer.set(sessionId, freshBuffer)
  }

  function cleanupOrphanedMessageBuffers(now) {
    for (const [sessionId, buffer] of sessionMessageBuffer.entries()) {
      if (sessionMap.has(sessionId)) continue
      const oldest = buffer[0]
      if (!oldest || now - oldest.timestamp > BUFFERED_MESSAGE_TTL_MS * 2) {
        sessionMessageBuffer.delete(sessionId)
      }
    }
  }

  function clearCommitState(mapping) {
    mapping.commit.inFlight = false
    mapping.commit.taskId = null
    mapping.commit.startedAt = null
  }

  async function moveFileToAbandoned(filePath, fileName) {
    if (!persistenceEnabled || !fs.existsSync(filePath)) return
    const safeName = normalizeIdentifierPart(path.basename(fileName, ".json")) || "state"
    const target = path.join(statePaths.abandoned, `${safeName}.${Date.now()}.json`)
    try {
      await fs.promises.rename(filePath, target)
    } catch (error) {
      log("WARN", "persistence", "Failed to move file to abandoned", { file: filePath, error: error?.message })
    }
  }

  async function rmQuiet(filePath) {
    if (!filePath) return
    try {
      await fs.promises.rm(filePath, { force: true })
    } catch {
      // best effort cleanup
    }
  }

  async function sleep(ms, abortSignal) {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, ms)
      if (!abortSignal) return
      const onAbort = () => {
        clearTimeout(timer)
        reject(new Error("Operation aborted"))
      }
      abortSignal.addEventListener("abort", onAbort, { once: true })
    })
  }
}

function formatTimestamp(date) {
  const pad = (value) => String(value).padStart(2, "0")
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    "-",
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join("")
}
