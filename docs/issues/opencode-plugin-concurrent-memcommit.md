# OpenCode 插件同 session 并发 memcommit

状态：已修复

## 背景

使用 OpenCode 插件时，发现同一个 OpenViking session 可能并发触发多次 `memcommit` / `POST /api/v1/sessions/{id}/commit`。并发提交会让 server 侧底层 RAGFS/Git commit 竞争同一资源锁或 ref，表现为资源锁冲突、`GitConcurrentCommitError` 或 commit 任务失败。

## 已确认现象

- 同一个 OpenCode session 可以由多个插件路径触发 commit。
- 手动 `memcommit` 与生命周期边界 commit 几乎同时发生时，会对同一个 `ovSessionId` 发出多次 `/commit` 请求。
- 本地复现中，同一个 `ovSessionId=Repo_project_abcd_ses_race` 被统计到 `commitPosts=2`。

## 关键根因

`examples/opencode-plugin/lib/memory-session.mjs` 的 `startBackgroundCommit()` 在发送 `POST /commit` 并收到响应后，才设置本地状态：

```text
mapping.commit.inFlight = true
mapping.commit.taskId = taskId
```

这留下了竞态窗口：第一个触发源已经发出 `/commit` 但尚未返回时，第二个触发源仍会看到 `mapping.commit.inFlight === false`，于是也会发出第二个 `/commit`。

## 触发路径

- `examples/opencode-plugin/lib/memory-tools.mjs` 的 `memcommit` 调用 `sessionManager.commitSession(...)`。
- `examples/opencode-plugin/index.mjs` 的 `experimental.session.compacting` 调用 `flushSession(..., { commit: true })`。
- `examples/opencode-plugin/index.mjs` 的 `stop` 调用 `flushAll({ commit: true })`。
- `examples/opencode-plugin/lib/memory-session.mjs` 的 `session.deleted` / `session.error` 路径会设置 `pendingCleanup` 并进入 finalization。
- `triggerFinalizationCommit()` 直接 `POST /commit`，没有复用 `startBackgroundCommit()` 的 in-flight 检查。

## 额外风险

- 显式传入 `memcommit(session_id=...)` 时会走 `commitExplicitOpenVikingSession()`，不使用当前 OpenCode session mapping 的 `inFlight` 状态。如果传入的 session id 正好是当前 OV session，也可能绕过去重。
- server 侧 `TaskTracker` 已有 `create_if_no_running()`，但当前 session commit 路径使用的是普通 task `create()`，没有按 `resource_id=session_id` 做去重。
- server 侧 session commit 虽然有 path lock，但 HTTP/API 每次请求会加载独立 `Session` 实例；如果锁内不重新加载权威 session 文件，仍可能用锁前 stale `_messages` 重复 archive。

## 建议修复

- 插件侧把同一 `ovSessionId` 的 commit 统一收敛到一个 gate。
- `startBackgroundCommit()` 应在发出 `/commit` 前就标记本地 in-flight，或维护 `Map<ovSessionId, Promise>` 作为单进程 mutex。
- `flushSession`、`flushAll`、`commitSession`、`triggerFinalizationCommit` 都应走同一个 gate，不能各自直接 POST。
- finalization 遇到已有 `mapping.commit.inFlight` 时，只设置 `pendingCleanup` 并监控已有 task；等 task 完成后再删除本地 state。
- 显式 `session_id` 的 `memcommit` 如无法映射到当前 session，可保留直接提交；如果能匹配已有 mapping，应复用同一个 gate。
- server 侧可补充防线：session commit task 按 `session_id` 使用 `create_if_no_running()` 或等价 resource-level 去重；锁内重新加载权威 `messages.jsonl` 后再判断是否需要 archive。

## 修复记录

- `examples/opencode-plugin/lib/memory-session.mjs` 新增按 session id 复用的 commit POST gate，同一进程内并发触发只会共享一个 `/commit` 请求。
- `startBackgroundCommit()`、显式 `commitExplicitOpenVikingSession()` 和 finalization commit 现在复用同一个 POST gate。
- 显式 `memcommit(session_id=...)` 如果匹配已有 OpenCode session mapping，会回到 mapping 路径，复用该 session 的 flush、commit state 和 task 监控逻辑。
- finalization 遇到已有 `mapping.commit.inFlight` 时不再发第二次 `/commit`。

## 回归测试建议

- 并发执行 `flushSession(openCodeSessionId, { commit: true })` 与 `commitSession(ovSessionId, openCodeSessionId)`，断言只发生 1 次 `POST /commit`。
- commit in-flight 时触发 `session.deleted`，断言 finalization 不会再次 `POST /commit`，只等待已有 task 并保留 `pendingCleanup`。
- `flushAll({ commit: true })` 与手动 `memcommit` 并发时，同一 `ovSessionId` 只启动 1 个 server commit task。
- server HTTP 层并发提交同一 session 时，只允许一个请求 archive，其他请求复用已有 task 或返回无 archive。

已补充插件侧回归测试：

- `examples/opencode-plugin/tests/memory-session-state.test.mjs`：并发生命周期 commit 与手动 commit 只触发 1 次 server commit。
- `examples/opencode-plugin/tests/memory-session-finalization.test.mjs`：已有 in-flight commit 时 finalization 不再重复 POST。

验证命令：

```powershell
node --test "tests/memory-session-state.test.mjs" "tests/memory-session-finalization.test.mjs"
npm test
npm run check
git diff --check
```

## 关联文件

- `examples/opencode-plugin/index.mjs`
- `examples/opencode-plugin/lib/memory-session.mjs`
- `examples/opencode-plugin/lib/memory-tools.mjs`
- `openviking/server/routers/sessions.py`
- `openviking/service/session_service.py`
- `openviking/session/session.py`
- `openviking/service/task_tracker.py`
