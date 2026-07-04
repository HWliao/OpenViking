# OpenCode 插件 peerId 运行态改造与 session state 拆分

状态：已修复

## 背景

OpenViking 0.4.x 引入 User / Peer 模型，旧 `agent_id` 与 `viking://agent/...` 进入 legacy 兼容路径。OpenCode 插件当前仍保留 `agentId` / `agentIdMode` 配置和运行时分支，同时已有新字段 `peerId`，但需要彻底改为 peer 运行模型。

## 目标

- OpenCode 插件以 `peerId` 作为新模型的主要配置项。
- 插件请求使用 `X-OpenViking-Actor-Peer` 表达 peer 视图。
- 删除 `agentId` / `agentIdMode` 配置、环境变量和运行时兼容路径。
- 拆分 OpenCode 插件本地 session state，避免所有项目和 session 共享一个 map 文件。

## 不在范围

- 不迁移旧 `viking://agent/...` server/storage 数据。
- 不把旧 `agentId` 自动当作 `peerId` 使用。
- 不读取 `OPENVIKING_AGENT_ID` 或 `OPENVIKING_AGENT_ID_MODE` 作为 fallback。

## 待办

- 删除 OpenCode 插件配置中的 `agentId` / `agentIdMode` 字段和相关运行时分支。
- 更新插件文档，只描述 `peerId` / `peerIdMode`。
- 验证插件自动 recall、memsearch、memread、memwrite、memcommit 都透传 `peerId`。
- 补充 session state 拆分、finalization、日志轮转的检查项和回滚说明。

## 已确认设计决策

### peerId 配置与兼容

- 运行时只使用 `peerId`，不兼容旧 `agentId`。
- 删除 `agentId` / `agentIdMode` 默认配置和读取逻辑。
- 删除 `OPENVIKING_AGENT_ID` / `OPENVIKING_AGENT_ID_MODE` 环境变量支持。
- 新增并只使用 `peerIdMode`，保留 `fixed | auto` 语义。
- `peerIdMode` 默认值为 `auto`。
- `OPENVIKING_PEER_ID_MODE` 优先于文件中的 `peerIdMode`。
- `peerIdMode` 无效时打印 warning，fallback 到 `auto`。
- 请求头只发送 `X-OpenViking-Actor-Peer`，不再发送 `X-OpenViking-Agent`。
- 写入 session message 时使用 body 字段 `peer_id`，与请求头中的 peer 保持一致。

### peerId 自动派生

- `peerIdMode=auto` 下，`peerId` 表达 OpenCode project 身份，不表达 workspace、worktree、branch 或单个 session。
- 不参考 `project.name`，因为它更像用户自定义的语义化展示名。
- readable slug 来源优先级为 `basename(project.worktree)`，其次 `basename(session.directory)`。
- 自动 peerId 形态为 `<slug>_<short_project_id>`。
- `short_project_id` 来自规范化后的 `projectID` 前 12 位。
- 规范化后的 `projectID` 少于 8 个字符时，自动 peerId 派生失败。
- `projectID` 是自动 peerId 唯一性的核心，不使用 directory-only peerId。
- `projects/<safe_project_id>.json` 中已有有效 `peerId` 时永远优先，不重新派生。
- cache 中已有 peerId 无效时，打印 warning，丢弃旧值，重新派生并覆盖。
- 被替换的无效 peerId 保留到 `previousPeerIds`，用于排查。
- `peerIdMode=auto` 派生失败时，fallback 顺序为已有 session state 中的 peerId、显式配置 `peerId`、不发送 actor peer。
- auto 派生失败但使用显式 `peerId` fallback 时，只写入 session state，不写入 project file。
- SDK 查询 session/project 失败时，每次都打印 warning，不做节流。
- `peerIdMode=fixed` 下显式 `peerId` 无效时，打印 warning/error，不阻断插件启动，但禁用 peer 传播。

### 标识规范化与长度

- 规范化规则：非 `A-Z a-z 0-9 _ -` 字符替换为 `_`，连续 `_` 合并，去掉首尾 `_`。
- `peerId` 最大长度为 128。
- `ovSessionId` 最大长度为 512。
- `safe_oc_session_id` 不使用 hash，需要保留可读性，方便查找。
- `ovSessionId` 使用规范化后的 peerId 和 OpenCode session id 拼接：`<safe_peer_id>_<safe_oc_session_id>`。
- 如果没有有效 peerId，`ovSessionId` fallback 为 `opencode_<safe_oc_session_id>`。

### 本地状态目录

- 不再使用单个 `openviking-session-map.json` 承载所有 project/session 状态。
- 新状态根目录为 `<runtimeDataDir>/openviking-sessions/`。
- 目录结构：

```text
openviking-sessions/
  meta.json
  projects/
    <safe_project_id>.json
  sessions/
    <safe_oc_session_id>.json
  finalizing/
    <safe_oc_session_id>.<pid>.<timestamp>.json
  abandoned/
    <safe_oc_session_id>.<timestamp>.json
```

- `meta.json` 只放低频 schema/迁移信息，不放动态计数、lastSaved 或 last cleanup time。
- `meta.json` 缺失或创建失败只打印 warning，不阻止插件运行。
- 目录初始化失败时，禁用本地持久化 state，插件以内存态继续运行。
- 进入内存态持久化降级时打印一次 warning，说明进程退出后 pending messages/routing state 会丢失。

### project 文件

- project 文件路径为 `projects/<safe_project_id>.json`。
- `safe_project_id = normalize(projectID)`。
- 不同 `projectID` 规范化后得到同一个 `safe_project_id` 时，视为同一个 project identity。
- `safe_project_id` 少于 8 个字符时，不写 project 文件，不生成 auto peerId。
- project file 首次创建使用 no-overwrite create，例如 `fs.promises.writeFile(path, json, { flag: "wx" })`。
- 如果首次创建时遇到 `EEXIST`，读取现有 project file，并使用现有有效 `peerId`。
- 写 project file 前做轻量 read-before-write；如果已有有效 `peerId`，使用现有值并放弃本次写入。
- 已有 project file 的后续更新使用 temp file + rename 原子写。
- project file 是坏 JSON 时，移动到 `abandoned/project-<safe_project_id>.<timestamp>.json`，然后重新生成。
- TTL 不清理 project 文件。

### session 文件

- session 文件路径为 `sessions/<safe_oc_session_id>.json`。
- `safe_oc_session_id = normalize(openCodeSessionId)`，不 hash。
- 不同原始 OpenCode session id 规范化后得到同一个 `safe_oc_session_id` 时，视为同一个 session。
- 规范化后为空时使用 `unknown_session_<timestamp>`。
- session file 保存 routing、message staging 和 commit 恢复状态。
- session file 是坏 JSON 时，移动到 `abandoned/<safe_oc_session_id>.<timestamp>.json`，重新创建，不尝试恢复 pending messages。
- session file 首次创建不强制 `wx`，同一进程内直接写当前内存状态。
- session file 写入使用 temp file + rename 原子写。
- session state 保存时不做跨进程复杂 merge。正常情况下同一个 session 不会有多进程处理。
- `sendingMessages` 不持久化，只作为进程内防重入状态。
- `pendingMessages` 继续使用数组 pairs，保持 `Map` 序列化形态。
- `messageRoles` 继续使用数组 pairs。
- `capturedMessages` 继续只保存 message id 数组。
- `commit.inFlight`、`commit.taskId`、`commit.startedAt`、`commit.pendingCleanup`、`commit.lastCommitTime` 持久化，但只作为恢复提示，不作为永久阻塞条件。
- `pendingCleanup` 继续保存，表示 session 已删除或出错，需要等 flush/commit 后删除本地 state。

示例 session state：

```json
{
  "version": 1,
  "openCodeSessionId": "ses_xxx",
  "safeOpenCodeSessionId": "ses_xxx",
  "projectID": "project_xxx",
  "safeProjectId": "project_xxx",
  "peerId": "OpenViking_project_xxx",
  "ovSessionId": "OpenViking_project_xxx_ses_xxx",
  "createdAt": 1783000000000,
  "updatedAt": 1783000000000,
  "lastSeenAt": 1783000000000,
  "expiresAt": 1783086400000,
  "capturedMessages": [],
  "messageRoles": [],
  "pendingMessages": [],
  "commit": {
    "lastCommitTime": null,
    "inFlight": false,
    "taskId": null,
    "startedAt": null,
    "pendingCleanup": false
  }
}
```

### TTL 与 session finalization

- session TTL 从 `lastSeenAt` 开始计算。
- 每次 session 事件、message 暂存更新、flush 成功、commit 触发时更新 `lastSeenAt`。
- `expiresAt = lastSeenAt + 1 day`。
- TTL 过期不只是删除 session state，还要执行 session finalization。
- finalization 流程：加载过期 session state，flush `pendingMessages` 到 server；如果 push 成功，触发一次 session commit；然后删除本地 session state。
- 如果 `pendingMessages` 为空但 `capturedMessages` 非空，也要触发 commit，然后删除本地 session state。
- 如果 `pendingMessages` 和 `capturedMessages` 都为空，直接删除本地 session state。
- pending push 失败时保留 session state，下次重试。
- commit 请求发生 transport failure 或没有 server 响应时，保留 session state，下次重试。
- commit 请求只要有 server 响应，即使是业务错误，也删除本地 session state；后续交给 server 或用户排查。
- 当前 server 的记忆抽取挂在 session commit 流程上，单纯 add message 不会立即触发记忆抽取。因此 finalization 仍需要触发 commit。
- TTL finalization 机会式触发，不使用常驻定时器。
- 触发点：plugin startup/load state、每次 `memcommit` 后、session deleted/error/compacted 边界、plugin shutdown/flushAll。

### finalizing 与崩溃恢复

- 处理过期 session 前使用 atomic rename claiming，避免多个进程重复 finalization 同一个 session。
- claim 形态：`sessions/<id>.json` 重命名为 `finalizing/<id>.<pid>.<timestamp>.json`。
- rename 成功的进程负责 flush pending messages、触发 commit、删除或恢复文件。
- rename 失败的进程跳过。
- push 或 commit transport failure 需要重试时，将 finalizing 文件恢复回 `sessions/<id>.json`。
- startup/load state 时恢复超时的 `finalizing/*.json`。
- `claimedAt` 或 mtime 超过 10 分钟时，移动回 `sessions/<safe_oc_session_id>.json`。
- 未超过 10 分钟时，认为其他进程还在处理，跳过。
- 恢复 finalizing 文件时，如果 active session 文件已存在，比较 `lastSeenAt` / `updatedAt`，保留较新的 active 文件，较旧文件移动到 `abandoned/`。

### 旧 map 文件处理

- 旧 `openviking-session-map.json` 不迁移内容。
- 如果发现旧文件，尝试重命名为 `openviking-session-map.v1-backup-YYYYMMDD-HHMMSS.json`。
- 备份失败时打印 warning，不阻止新 `openviking-sessions/` 工作。
- 只要旧 `openviking-session-map.json` 还存在，每次启动都尝试备份。
- 旧 pending messages 不补提交，只允许 warning。

### 插件日志轮转

- OpenCode OpenViking 插件当前日志文件为 `openviking-memory.log`。
- 插件 logger 是自定义 `fs.appendFileSync`，没有现成滚动组件。
- 采用按天轮转方案：`initLogger` 启动时检查 active `openviking-memory.log` 的本地修改日期；只有文件存在、非空、且日期早于今天时才重命名为带时间戳的历史文件，再创建新的 active log。
- 同一天内多次启动不再重复备份日志；如果 active log 是昨天或更早的文件，下一次启动只备份一次。
- 历史文件格式为 `openviking-memory.YYYYMMDD-HHMMSS.log`；同秒冲突时追加 `-1`、`-2` 等后缀。
- 轮转失败时打印 error，但不阻断插件启动，继续写 active log。

## 实现待办补充

- 替换 `examples/opencode-plugin/lib/memory-session.mjs` 中单文件 `sessionMap` 持久化逻辑。
- 引入 `openviking-sessions/` 目录初始化、project state、session state、finalizing claim 与 abandoned recovery。
- 删除 `agentId` / `agentIdMode` 配置、环境变量和运行时路径，改为 `peerId` / `peerIdMode`。
- 将请求头切换为 `X-OpenViking-Actor-Peer`。
- 将 session message body 切换为 `peer_id`。
- 保持 `openviking-memory.log` active 文件名不变，并在插件启动时按本地日期进行日级轮转。
- 更新 README、INSTALL、INSTALL-ZH 中的配置说明。
- 补充测试覆盖 peerId 配置迁移、auto 派生、project file 稳定性、session file staging、旧 map 备份、finalization、atomic claim、坏 JSON abandoned、内存态降级。
- 补充测试覆盖日志按天轮转，确认同一天多次启动不会重复备份。

## 下一步待改动点：projectID=global 兜底

- 当前问题：TUI/进行中会话等路径下，OpenCode session 可能返回 `projectID=global`。
- `global` 不是可用的项目唯一标识，规范化后长度也不足 8，导致插件不会写入 `projects/<safe_project_id>.json`，auto peerId 派生失败。
- 后续改动：当解析到 `projectID=global` 时，不直接使用 `global` 作为 project identity；改为使用 `safe_direction` 作为兜底 project id。
- `safe_direction` 应从目标 OpenCode session 绑定的 directory/cwd/project 信息派生，必须先通过 OpenCode session id 查询 session 信息，不能 fallback 到 plugin 初始化 directory。
- `safe_direction` 仍使用现有标识规范化规则：只允许 `A-Z a-z 0-9 _ -`，其它字符替换为 `_`，连续 `_` 合并，去掉首尾 `_`。
- 如果 `safe_direction` 为空或仍不足以构成稳定 project identity，则 auto peerId 继续失败，并按既有 fallback 进入已有 session peerId、显式 `peerId`、不发送 actor peer。
- 补充测试：覆盖 session/project 返回 `projectID=global` 时，插件使用 `safe_direction` 写入 project/session state，并生成 `<项目可读名>_<短safe_direction>` 形态的 peerId。

## 下一步待改动点：解除 project id 长度写入限制

- 当前设计里 `safe_project_id` 少于 8 个字符时不写 project 文件、不生成 auto peerId。
- 后续需要解除该限制：project identity 是否可用不应只由规范化长度判断。
- 解除限制后，`projectID=global` 仍不能直接作为有效项目身份；它必须先走 `safe_direction` 兜底逻辑。
- 对非 `global` 的短 project id，应允许写入 `projects/<safe_project_id>.json`，并按相同规则生成稳定 peerId。
- 补充测试：覆盖短 project id、`global` project id、空/无效 directory 三类路径，确认只有真正缺少稳定来源时 auto peerId 才失败。

## 下一步待改动点：缺少 mapping 时懒初始化

- 当前问题：插件升级后，已经在进行中的 OpenCode 会话不会重新触发 `session.created`，因此不会进入 `sessions/` 目录。
- 后续改动：当 `message.updated`、`message.part.updated`、`memcommit` 或工具请求发现缺少 session mapping 时，应基于当前 OpenCode session id 懒初始化 mapping。
- 懒初始化流程必须先调用 OpenCode session API 获取 session 信息，再基于 session 绑定的 directory/cwd/project 信息解析 project/peer，不 fallback 到 plugin 初始化 directory。
- 懒初始化成功后，应立即写入 session state，并继续处理已 buffer 的 message role/text。
- 懒初始化失败时，保留现有 buffer 行为，不丢消息；后续事件或显式 `memcommit` 可再次触发重试。
- 补充测试：覆盖插件启动后接入已有 session，先收到 message 事件、没有 `session.created` 的情况下也能生成 session state。

## 下一步待改动点：升级 SDK 并统一使用 v2 API

- 当前插件依赖 `@opencode-ai/plugin`，其 `client` 同时暴露 legacy SDK 与 v2 SDK 能力；现有代码仍主要按 legacy `path/query` 形态调用。
- 后续改动：升级 OpenCode plugin SDK 到最新可用版本，并把插件内部 OpenCode API 调用统一迁移到 v2 版本。
- session 查询应使用 v2 `session.get({ sessionID, directory?, workspace? })` 等价接口。
- project 查询应使用 v2 `project.current({ directory?, workspace? })` 等价接口。
- 迁移时需要保留对插件运行时 `client` 形态的防御性检查；如果 v2 client 不可用，应明确 warning 并让 peer auto 派生失败，而不是静默使用错误 directory。
- 补充测试：覆盖 v2 session/project API 参数形态，确认 directory/workspace 被正确传入，且不会再用 legacy 错误参数导致 `projectID=global`。

## 下一步待改动点：session mapping 中 peerId 为 null

- 已排查原因：`examples/opencode-plugin/lib/memory-session.mjs` 的 `resolvePeerContext` 先 `fetchOpenCodeSession` 和 `fetchOpenCodeProject`，但随后用 `{ ...sdkSession, ...eventSession }` 合并，导致 `session.created` 事件里的 `projectID=global` 覆盖 SDK 查询到的真实 `projectID`。
- 已排查原因：`resolvePeerContext` 再用 `const projectID = session.projectID ?? project?.id`，因此只要 event/session 上有 `global`，就不会继续使用 project API 返回的真实 project id。
- 已排查原因：`safeProjectId = normalizeIdentifierPart(projectID)` 后得到 `global`，但当前代码只有 `safeProjectId.length >= 8` 时才读取/写入 project file 并调用 `deriveAutoPeerId`；`global` 长度不足 8，直接跳过 auto 派生。
- 已排查原因：没有显式 `peerId` fallback 时，`resolvePeerContext` 最终返回 `{ peerId: null, projectID: "global", safeProjectId: "global", source: "none" }`，`handleSessionCreated` 随后用 null peer 构建 `opencode_<safe_oc_session_id>` 形态的 `ovSessionId` 并持久化 session state。
- 最小复现结果：即使 mock 的 `client.session.get` 和 `client.project.current` 都返回 `project:real1234567890`，只要 `session.created` event 带 `projectID=global`，当前持久化结果仍是 `peerId: null`、`projectID: "global"`、`safeProjectId: "global"`、`ovSessionId: "opencode_ses_global"`。
- 后续改动：`global` 必须被视为不可用 project identity；事件里的 `projectID=global` 不能覆盖 SDK/project API 或 session-bound directory 派生出的稳定 project identity。
- 补充测试：复现 `projectID=global` 导致 `peerId: null` 的路径，并验证修复后 resolvable session 写入有效 `peerId`、生成 `<safe_peer_id>_<safe_oc_session_id>` 形态的 `ovSessionId`，且请求使用 `X-OpenViking-Actor-Peer`。

## 下一步待改动点：日志按天轮转

- 当前问题：`openviking-memory.log` 如果按每次插件启动备份，会在频繁重启时产生大量日志备份文件。
- 后续改动：启动时只在 active log 的本地修改日期早于今天时备份；同一天多次启动不备份。
- 补充测试：覆盖昨天日志会备份、当天日志不会备份、同一天多次启动最多产生一次备份。

## 验证建议

- 使用 `peerId` 启动 OpenCode 插件后，确认请求头包含 `X-OpenViking-Actor-Peer`。
- 确认旧 `OPENVIKING_AGENT_ID` / `OPENVIKING_AGENT_ID_MODE` 不影响插件行为。
- 确认配置中只使用 `peerId` / `peerIdMode`，且默认 `peerIdMode=auto`。
