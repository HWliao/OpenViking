import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { initLogger, log } from "../lib/utils.mjs"

test("initLogger rotates the previous non-empty log on startup", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "openviking-opencode-log-"))
  try {
    const activeLog = join(dataDir, "openviking-memory.log")
    await writeFile(activeLog, "old log line\n", "utf8")

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
