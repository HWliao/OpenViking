import test from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const testDir = dirname(fileURLToPath(import.meta.url))
const codeToolsPath = join(testDir, "../lib/code-tools.mjs")
const memoryRecallPath = join(testDir, "../lib/memory-recall.mjs")
const codeToolsSource = readFile(codeToolsPath, "utf8")

test("code tools propagate actorPeerId to every code request", async () => {
  const source = await codeToolsSource

  assert.match(source, /import \{ effectivePeerId,/)
  assert.match(source, /function getRequestConfig\(context\)/)
  assert.equal((source.match(/actorPeerId: effectivePeerId\(requestConfig\)/g) ?? []).length, 3)
})

test("code tool descriptions restrict use to confirmed viking code repositories", async () => {
  const source = await codeToolsSource

  assert.match(source, /confirmed viking:\/\/ code repository or source subtree/)
  assert.match(source, /evidence that the uri contains supported source files/)
  assert.match(source, /Do not use for general memory search/)
  assert.match(source, /documentation-only resources/)
  assert.match(source, /chat\/session history/)
  assert.match(source, /local filesystem paths/)
})

test("memory recall search payload matches strict server schema", async () => {
  const source = await readFile(memoryRecallPath, "utf8")

  assert.match(source, /const body = \{ query: query\.slice\(0, 4000\), limit: 20 \}/)
  assert.match(source, /const requestConfig = sessionManager\.getRequestConfig\(sessionId\)/)
  assert.match(source, /actorPeerId: effectivePeerId\(requestConfig\)/)
  assert.doesNotMatch(source, /mode:\s*"auto"/)
})
