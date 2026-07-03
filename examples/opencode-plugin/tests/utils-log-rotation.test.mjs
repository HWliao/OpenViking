import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { initLogger, log } from "../lib/utils.mjs"

test("initLogger rotates a previous-day non-empty log on startup", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "openviking-opencode-log-"))
  try {
    const activeLog = join(dataDir, "openviking-memory.log")
    await writeFile(activeLog, "old log line\n", "utf8")
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000)
    await utimes(activeLog, yesterday, yesterday)

    initLogger(dataDir)
    log("INFO", "test", "new log line")

    const files = await readdir(dataDir)
    const backups = files.filter((file) => /^openviking-memory\.\d{8}-\d{6}.*\.log$/.test(file))
    assert.equal(backups.length, 1)
    assert.equal(await readFile(join(dataDir, backups[0]), "utf8"), "old log line\n")
    assert.match(await readFile(activeLog, "utf8"), /new log line/)
  } finally {
    await rm(dataDir, { recursive: true, force: true })
  }
})

test("initLogger keeps a same-day non-empty log active", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "openviking-opencode-log-"))
  try {
    const activeLog = join(dataDir, "openviking-memory.log")
    await writeFile(activeLog, "same day log line\n", "utf8")

    initLogger(dataDir)
    initLogger(dataDir)
    log("INFO", "test", "new log line")

    const files = await readdir(dataDir)
    const backups = files.filter((file) => /^openviking-memory\.\d{8}-\d{6}.*\.log$/.test(file))
    assert.equal(backups.length, 0)
    const activeContent = await readFile(activeLog, "utf8")
    assert.match(activeContent, /same day log line/)
    assert.match(activeContent, /new log line/)
  } finally {
    await rm(dataDir, { recursive: true, force: true })
  }
})
