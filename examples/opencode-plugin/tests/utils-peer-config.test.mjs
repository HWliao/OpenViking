import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadConfig, makeRequest } from "../lib/utils.mjs"

const ENV_KEYS = [
  "OPENVIKING_PLUGIN_CONFIG",
  "OPENVIKING_PEER_ID",
  "OPENVIKING_PEER_ID_MODE",
  "OPENVIKING_AGENT_ID",
  "OPENVIKING_AGENT_ID_MODE",
]

function snapshotEnv() {
  return Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]))
}

function restoreEnv(snapshot) {
  for (const key of ENV_KEYS) {
    if (snapshot[key] === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = snapshot[key]
    }
  }
}

test("loadConfig uses peer env overrides and ignores legacy agent env", async () => {
  const env = snapshotEnv()
  const dir = await mkdtemp(join(tmpdir(), "openviking-peer-config-"))
  try {
    const configPath = join(dir, "openviking-config.json")
    await writeFile(configPath, JSON.stringify({
      agentId: "file-agent",
      agentIdMode: "fixed",
      peerId: "file-peer",
      peerIdMode: "fixed",
    }), "utf8")

    process.env.OPENVIKING_PLUGIN_CONFIG = configPath
    process.env.OPENVIKING_AGENT_ID = "legacy-env-agent"
    process.env.OPENVIKING_AGENT_ID_MODE = "auto"
    process.env.OPENVIKING_PEER_ID = "env-peer"
    process.env.OPENVIKING_PEER_ID_MODE = "auto"

    const config = loadConfig(dir)

    assert.equal(config.peerId, "env-peer")
    assert.equal(config.peerIdMode, "auto")
    assert.equal(Object.hasOwn(config, "agentId"), false)
    assert.equal(Object.hasOwn(config, "agentIdMode"), false)
  } finally {
    restoreEnv(env)
    await rm(dir, { recursive: true, force: true })
  }
})

test("invalid peerIdMode warns and falls back to auto", async () => {
  const env = snapshotEnv()
  const dir = await mkdtemp(join(tmpdir(), "openviking-peer-config-"))
  const warnings = []
  const originalWarn = console.warn
  try {
    const configPath = join(dir, "openviking-config.json")
    await writeFile(configPath, JSON.stringify({ peerIdMode: "invalid-mode" }), "utf8")
    process.env.OPENVIKING_PLUGIN_CONFIG = configPath
    console.warn = (...args) => warnings.push(args.join(" "))

    const config = loadConfig(dir)

    assert.equal(config.peerIdMode, "auto")
    assert.match(warnings.join("\n"), /Invalid OpenViking peerIdMode/)
  } finally {
    console.warn = originalWarn
    restoreEnv(env)
    await rm(dir, { recursive: true, force: true })
  }
})

test("makeRequest sends actor peer header and never sends agent header", async () => {
  const originalFetch = globalThis.fetch
  let capturedHeaders = null
  try {
    globalThis.fetch = async (_url, options) => {
      capturedHeaders = options.headers
      return new Response(JSON.stringify({ status: "ok", result: true }), { status: 200 })
    }

    await makeRequest({
      endpoint: "http://openviking.test",
      apiKey: "api-key",
      account: "account",
      user: "user",
      agentId: "legacy-agent",
      timeoutMs: 1000,
    }, {
      endpoint: "/api/test",
      method: "POST",
      actorPeerId: "actor-peer",
      body: { ok: true },
    })

    assert.equal(capturedHeaders["X-OpenViking-Actor-Peer"], "actor-peer")
    assert.equal(Object.hasOwn(capturedHeaders, "X-OpenViking-Agent"), false)
  } finally {
    globalThis.fetch = originalFetch
  }
})
