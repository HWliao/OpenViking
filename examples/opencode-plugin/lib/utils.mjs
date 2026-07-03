import fs from "fs"
import path from "path"
import { homedir } from "os"

const MAX_PEER_ID_LENGTH = 128
const MAX_OV_SESSION_ID_LENGTH = 512

export const DEFAULT_CONFIG = {
  endpoint: "http://localhost:1933",
  apiKey: "",
  account: "",
  user: "",
  peerId: "",
  peerIdMode: "auto",
  enabled: true,
  timeoutMs: 30000,
  runtime: {
    dataDir: "",
  },
  repoContext: {
    enabled: true,
    cacheTtlMs: 60000,
  },
  autoRecall: {
    enabled: true,
    limit: 6,
    scoreThreshold: 0.15,
    maxContentChars: 500,
    preferAbstract: true,
    tokenBudget: 2000,
  },
}

let logFilePath = null

function cloneDefaultConfig() {
  return JSON.parse(JSON.stringify(DEFAULT_CONFIG))
}

function mergeConfig(fileConfig = {}) {
  const config = cloneDefaultConfig()
  for (const key of ["endpoint", "apiKey", "account", "user", "peerId", "peerIdMode", "enabled", "timeoutMs"]) {
    if (fileConfig[key] !== undefined) config[key] = fileConfig[key]
  }
  config.runtime = {
    ...DEFAULT_CONFIG.runtime,
    dataDir: fileConfig.runtime?.dataDir ?? DEFAULT_CONFIG.runtime.dataDir,
  }
  config.repoContext = { ...DEFAULT_CONFIG.repoContext, ...(fileConfig.repoContext ?? {}) }
  config.autoRecall = { ...DEFAULT_CONFIG.autoRecall, ...(fileConfig.autoRecall ?? {}) }

  if (process.env.OPENVIKING_API_KEY) {
    config.apiKey = process.env.OPENVIKING_API_KEY
  }
  if (process.env.OPENVIKING_ACCOUNT) {
    config.account = process.env.OPENVIKING_ACCOUNT
  }
  if (process.env.OPENVIKING_USER) {
    config.user = process.env.OPENVIKING_USER
  }
  if (process.env.OPENVIKING_PEER_ID) {
    config.peerId = process.env.OPENVIKING_PEER_ID
  }
  if (process.env.OPENVIKING_PEER_ID_MODE) {
    config.peerIdMode = process.env.OPENVIKING_PEER_ID_MODE
  }

  config.peerIdMode = normalizePeerIdMode(config.peerIdMode)
  config.timeoutMs = normalizeNumber(config.timeoutMs, DEFAULT_CONFIG.timeoutMs, 1000, 300000)
  config.repoContext.cacheTtlMs = normalizeNumber(
    config.repoContext.cacheTtlMs,
    DEFAULT_CONFIG.repoContext.cacheTtlMs,
    1000,
    60 * 60 * 1000,
  )
  clampRecallConfig(config.autoRecall)
  return config
}

function normalizePeerIdMode(value) {
  const mode = String(value ?? DEFAULT_CONFIG.peerIdMode).trim()
  if (mode === "auto" || mode === "fixed") return mode
  console.warn(`Invalid OpenViking peerIdMode "${value}"; falling back to "auto".`)
  return DEFAULT_CONFIG.peerIdMode
}

function normalizeNumber(value, fallback, min, max) {
  const next = Number(value)
  if (!Number.isFinite(next)) return fallback
  return Math.max(min, Math.min(max, next))
}

function clampRecallConfig(recall) {
  recall.limit = Math.max(1, Math.min(50, Math.round(Number(recall.limit) || 6)))
  recall.scoreThreshold = Math.max(0, Math.min(1, Number(recall.scoreThreshold) || 0))
  recall.maxContentChars = Math.max(100, Math.min(5000, Math.round(Number(recall.maxContentChars) || 500)))
  recall.tokenBudget = Math.max(100, Math.min(10000, Math.round(Number(recall.tokenBudget) || 2000)))
}

export function loadConfig(pluginRoot, projectDirectory) {
  for (const configPath of getConfigPaths(pluginRoot, projectDirectory)) {
    try {
      if (fs.existsSync(configPath)) {
        const fileConfig = JSON.parse(fs.readFileSync(configPath, "utf8"))
        return mergeConfig(fileConfig)
      }
    } catch (error) {
      console.warn(`Failed to load OpenViking config from ${configPath}:`, error)
    }
  }
  return mergeConfig()
}

function getConfigPaths(pluginRoot, projectDirectory) {
  const paths = []
  if (process.env.OPENVIKING_PLUGIN_CONFIG) paths.push(expandHome(process.env.OPENVIKING_PLUGIN_CONFIG))
  if (projectDirectory) paths.push(path.join(projectDirectory, ".opencode", "openviking-config.json"))
  paths.push(path.join(homedir(), ".config", "opencode", "openviking-config.json"))
  paths.push(path.join(pluginRoot, "openviking-config.json"))
  return paths
}

export function resolveDataDir(pluginRoot, config) {
  const configured = config.runtime?.dataDir
  if (configured) return expandHome(configured)
  return path.join(homedir(), ".config", "opencode", "openviking")
}

function expandHome(value) {
  if (!value || typeof value !== "string") return value
  if (value === "~") return homedir()
  if (value.startsWith("~/") || value.startsWith("~\\")) return path.join(homedir(), value.slice(2))
  return value
}

export function initLogger(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true })
  logFilePath = path.join(dataDir, "openviking-memory.log")
  rotateExistingLog(logFilePath)
}

function rotateExistingLog(filePath) {
  try {
    if (!fs.existsSync(filePath)) return
    const stat = fs.statSync(filePath)
    if (!stat.isFile() || stat.size === 0) return
    fs.renameSync(filePath, nextLogBackupPath(filePath))
  } catch (error) {
    console.error("Failed to rotate OpenViking plugin log:", error)
  }
}

function nextLogBackupPath(filePath) {
  const parsed = path.parse(filePath)
  const timestamp = formatLogTimestamp(new Date())
  for (let index = 0; index < 100; index += 1) {
    const suffix = index === 0 ? "" : `-${index}`
    const candidate = path.join(parsed.dir, `${parsed.name}.${timestamp}${suffix}${parsed.ext}`)
    if (!fs.existsSync(candidate)) return candidate
  }
  return path.join(parsed.dir, `${parsed.name}.${timestamp}-${process.pid}${parsed.ext}`)
}

function formatLogTimestamp(date) {
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

export function safeStringify(value) {
  if (value === null || value === undefined) return value
  if (typeof value !== "object") return value
  if (Array.isArray(value)) return value.map((item) => safeStringify(item))

  const result = {}
  for (const key of Object.keys(value)) {
    const item = value[key]
    if (typeof item === "function") {
      result[key] = "[Function]"
    } else if (typeof item === "object" && item !== null) {
      try {
        result[key] = safeStringify(item)
      } catch {
        result[key] = "[Circular or Non-serializable]"
      }
    } else {
      result[key] = item
    }
  }
  return result
}

export function log(level, toolName, message, data) {
  const normalizedLevel = String(level || "INFO").toUpperCase()
  const entry = {
    timestamp: new Date().toISOString(),
    level: normalizedLevel,
    tool: toolName,
    message,
    ...(data ? { data: safeStringify(data) } : {}),
  }

  if (!logFilePath) {
    if (normalizedLevel === "ERROR") console.error(message, data ?? "")
    return
  }

  try {
    fs.appendFileSync(logFilePath, `${JSON.stringify(entry)}\n`, "utf8")
  } catch (error) {
    console.error("Failed to write OpenViking plugin log:", error)
  }
}

export function makeToast(client) {
  return (message, variant = "warning") =>
    client?.tui?.showToast?.({
      body: { title: "OpenViking", message, variant, duration: 8000 },
    }).catch(() => {})
}

export function normalizeEndpoint(endpoint) {
  return endpoint.replace(/\/+$/, "")
}

export function normalizeIdentifierPart(value) {
  return String(value ?? "")
    .replace(/[^A-Za-z0-9_-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
}

export function isValidPeerId(value) {
  const peerId = String(value ?? "").trim()
  return peerId.length > 0 && peerId.length <= MAX_PEER_ID_LENGTH && /^[A-Za-z0-9_-]+$/.test(peerId)
}

export function resolveFixedPeerId(config = {}) {
  const peerId = String(config.peerId ?? "").trim()
  return { peerId: isValidPeerId(peerId) ? peerId : null }
}

export function deriveAutoPeerId({ project, session, projectID } = {}) {
  const safeProjectId = normalizeIdentifierPart(projectID)
  if (safeProjectId.length < 8) {
    return { peerId: null, safeProjectId, shortProjectId: null }
  }

  const slug = normalizeIdentifierPart(path.basename(String(project?.worktree || session?.directory || "")))
  if (!slug) {
    return { peerId: null, safeProjectId, shortProjectId: safeProjectId.slice(0, 12) }
  }

  const shortProjectId = safeProjectId.slice(0, 12)
  const maxSlugLength = MAX_PEER_ID_LENGTH - shortProjectId.length - 1
  const peerId = `${slug.slice(0, Math.max(1, maxSlugLength))}_${shortProjectId}`
  return { peerId: isValidPeerId(peerId) ? peerId : null, safeProjectId, shortProjectId }
}

export function resolveSafeOpenCodeSessionId(openCodeSessionId, now = Date.now()) {
  const safeSessionId = normalizeIdentifierPart(openCodeSessionId)
  return safeSessionId || `unknown_session_${now}`
}

export function buildOpenVikingSessionId({ peerId, openCodeSessionId, now = Date.now() } = {}) {
  const safeOpenCodeSessionId = resolveSafeOpenCodeSessionId(openCodeSessionId, now)
  const safePeerId = isValidPeerId(peerId) ? String(peerId).trim() : null
  const prefix = safePeerId ? `${safePeerId}_` : "opencode_"
  const remaining = MAX_OV_SESSION_ID_LENGTH - prefix.length
  return {
    safeOpenCodeSessionId,
    ovSessionId: `${prefix}${safeOpenCodeSessionId.slice(0, Math.max(0, remaining))}`,
  }
}

export function effectivePeerId(config) {
  return resolveFixedPeerId(config).peerId
}

export async function makeRequest(config, options) {
  return requestWithBody(config, options, {
    headers: { "Content-Type": "application/json", ...(options.headers ?? {}) },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  })
}

export async function makeMultipartRequest(config, options) {
  return requestWithBody(config, options, {
    headers: options.headers ?? {},
    body: options.body,
  })
}

async function requestWithBody(config, options, { headers, body }) {
  const url = `${normalizeEndpoint(config.endpoint)}${options.endpoint}`
  const requestHeaders = makeAuthHeaders(config, headers, options.actorPeerId)

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? config.timeoutMs)
  let onAbort = null

  if (options.abortSignal) {
    if (options.abortSignal.aborted) controller.abort()
    onAbort = () => controller.abort()
    options.abortSignal.addEventListener("abort", onAbort, { once: true })
  }

  try {
    const response = await fetch(url, {
      method: options.method,
      headers: requestHeaders,
      body,
      signal: controller.signal,
    })

    const text = await response.text()
    const payload = text ? parseJsonOrText(text) : {}

    if (!response.ok) {
      const rawError = typeof payload === "object" ? payload.error ?? payload.message : payload
      const errorMessage = typeof rawError === "string" ? rawError : JSON.stringify(rawError)
      if (response.status === 401 || response.status === 403) {
        throw new Error("Authentication failed. Please check apiKey/account/user in openviking-config.json or OPENVIKING_* environment variables.")
      }
      throw new Error(`Request failed (${response.status}): ${errorMessage}`)
    }

    return payload
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`Request timeout after ${options.timeoutMs ?? config.timeoutMs}ms`)
    }
    if (error?.message?.includes("fetch failed") || error?.code === "ECONNREFUSED") {
      throw new Error(`OpenViking service unavailable at ${config.endpoint}. Start it with: openviking-server --config ~/.openviking/ov.conf`)
    }
    throw error
  } finally {
    clearTimeout(timeout)
    if (options.abortSignal && onAbort) {
      options.abortSignal.removeEventListener("abort", onAbort)
    }
  }
}

function makeAuthHeaders(config, headers = {}, actorPeerId = "") {
  const result = { ...headers }
  if (config.apiKey) result["X-API-Key"] = config.apiKey
  if (config.account) result["X-OpenViking-Account"] = config.account
  if (config.user) result["X-OpenViking-User"] = config.user
  const peerId = isValidPeerId(actorPeerId) ? String(actorPeerId).trim() : ""
  if (peerId) result["X-OpenViking-Actor-Peer"] = peerId
  return result
}

function parseJsonOrText(text) {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

export function getResponseErrorMessage(error) {
  if (!error) return "Unknown OpenViking error"
  if (typeof error === "string") return error
  return error.message || error.code || "Unknown OpenViking error"
}

export function unwrapResponse(response) {
  if (!response || typeof response !== "object") {
    throw new Error("OpenViking returned an invalid response")
  }
  if (response.status && response.status !== "ok") {
    throw new Error(getResponseErrorMessage(response.error))
  }
  return response.result
}

export function validateVikingUri(uri, toolName = "tool") {
  if (typeof uri !== "string" || !uri.startsWith("viking://")) {
    log("ERROR", toolName, "Invalid Viking URI", { uri })
    return 'Error: Invalid URI format. Must start with "viking://".'
  }
  return null
}

export function ensureRemoteUrl(value) {
  try {
    const url = new URL(value)
    return url.protocol === "http:" || url.protocol === "https:"
  } catch {
    return false
  }
}
