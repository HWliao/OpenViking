import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

const sourceFiles = [
  "index.mjs",
  "lib/runtime.mjs",
  "lib/repo-context.mjs",
  "lib/memory-session.mjs",
  "lib/memadd-local.mjs",
  "lib/memory-tools.mjs",
  "lib/code-tools.mjs",
  "lib/memory-recall.mjs",
  "lib/viking-uri-guard.mjs",
  "lib/utils.mjs",
]

const testDir = path.join(root, "tests")
const testFiles = fs
  .readdirSync(testDir)
  .filter((name) => name.endsWith(".test.mjs"))
  .sort()
  .map((name) => path.join("tests", name))

for (const file of [...sourceFiles, ...testFiles]) {
  const result = spawnSync(process.execPath, ["--check", file], {
    cwd: root,
    stdio: "inherit",
  })

  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
}
