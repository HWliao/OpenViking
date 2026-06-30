# OpenViking API Surface

本文档整理当前服务端对外暴露的 HTTP REST API、`ov` 命令行工具保留的用户接口，以及 MCP Server 暴露的工具接口。

## 边界说明

- REST API 是 OpenViking Server 的稳定 HTTP 接口，默认以 `/api/v1` 为主版本前缀。
- `ov` / `openviking` CLI 是 REST API 的命令行封装，入口来自 `pyproject.toml` 的 `ov = "openviking_cli.rust_cli:main"`，实际命令实现位于 `crates/ov_cli`。
- MCP Server 通过 streamable HTTP 暴露给 Claude Code 或其他 MCP Client，入口为 `/mcp`。
- Web Studio 静态页面入口 `/`、`/studio`、`/studio/{path:path}` 不属于业务 API，仅用于前端访问。
- 文档以代码路由为准，具体请求/响应字段以各路由的 Pydantic model、Rust CLI 参数和 MCP tool schema 为准。

## 通用约定

- 服务地址：`{OPENVIKING_SERVER_URL}`，本地常见为 `http://127.0.0.1:8765`。
- 内容类型：REST API 默认使用 JSON；文件上传、下载和 WebDAV 接口按对应协议使用 multipart、字节流或 XML。
- 鉴权：受保护接口通常通过服务端配置的 API Key、OAuth 或多租户账号权限控制。CLI 读取本地配置中的 server URL 与 API key。
- URI：资源、技能、记忆和文件系统接口统一使用 `viking://...` URI。
- 异步处理：资源导入、重建索引、watch 触发、session commit 等可能返回 task id，可通过 tasks / observer / wait 接口跟踪。

## REST API

### System

| Method | Path | 说明 |
| --- | --- | --- |
| `GET` | `/health` | 服务健康检查。 |
| `GET` | `/ready` | 服务就绪检查。 |
| `GET` | `/api/v1/system/status` | 查询系统状态和组件健康状态。 |
| `POST` | `/api/v1/system/wait` | 等待队列或异步处理达到稳定状态。 |
| `POST` | `/api/v1/system/consistency` | 执行系统一致性检查。 |
| `GET` | `/metrics` | Prometheus metrics。 |

### Auth And OAuth

| Method | Path | 说明 |
| --- | --- | --- |
| `GET` | `/.well-known/oauth-protected-resource` | OAuth protected resource metadata。 |
| `GET` | `/oauth/authorize/page` | OAuth 授权页。 |
| `GET` | `/oauth/authorize/page/status` | 授权页状态查询。 |
| `GET` | `/api/v1/auth/oauth/pending/{pending_id}` | 查询 pending OAuth 授权状态。 |
| `POST` | `/api/v1/auth/oauth-verify` | 验证 OAuth 授权结果。 |
| `POST` | `/api/v1/auth/otp` | 生成或验证一次性授权码。 |

### Admin

| Method | Path | 说明 |
| --- | --- | --- |
| `GET` | `/api/v1/admin/accounts` | 列出账号。 |
| `POST` | `/api/v1/admin/accounts` | 创建账号。 |
| `DELETE` | `/api/v1/admin/accounts/{account_id}` | 删除账号。 |
| `GET` | `/api/v1/admin/accounts/{account_id}/users` | 列出账号下用户。 |
| `POST` | `/api/v1/admin/accounts/{account_id}/users` | 添加账号用户。 |
| `GET` | `/api/v1/admin/accounts/{account_id}/agents` | 列出账号下 agent。 |
| `DELETE` | `/api/v1/admin/accounts/{account_id}/users/{user_id}` | 移除账号用户。 |
| `PUT` | `/api/v1/admin/accounts/{account_id}/users/{user_id}/role` | 更新用户角色。 |
| `POST` | `/api/v1/admin/accounts/{account_id}/users/{user_id}/key` | 创建或刷新用户 key。 |

### Resources And Skills

| Method | Path | 说明 |
| --- | --- | --- |
| `POST` | `/api/v1/resources/temp_upload` | 上传临时文件。 |
| `POST` | `/api/v1/resources/temp_upload_signed` | 创建带签名的临时上传。 |
| `POST` | `/api/v1/resources` | 添加 URL、本地上传或已有临时文件为资源。 |
| `POST` | `/api/v1/skills` | 添加 skill。 |

### Filesystem

| Method | Path | 说明 |
| --- | --- | --- |
| `GET` | `/api/v1/fs/ls` | 列出 URI 下的直接子节点。 |
| `GET` | `/api/v1/fs/tree` | 以树形结构列出 URI 下节点。 |
| `GET` | `/api/v1/fs/stat` | 获取 URI 元数据。 |
| `POST` | `/api/v1/fs/mkdir` | 创建目录。 |
| `DELETE` | `/api/v1/fs` | 删除资源或目录。 |
| `POST` | `/api/v1/fs/mv` | 移动或重命名资源。 |

### Content

| Method | Path | 说明 |
| --- | --- | --- |
| `GET` | `/api/v1/content/read` | 读取 URI 内容。 |
| `GET` | `/api/v1/content/abstract` | 读取 URI 摘要。 |
| `GET` | `/api/v1/content/overview` | 读取 URI 概览。 |
| `GET` | `/api/v1/content/download` | 下载 URI 对应文件内容。 |
| `POST` | `/api/v1/content/write` | 写入内容。 |
| `POST` | `/api/v1/content/reindex` | 对 URI 重新索引。 |

### Search

| Method | Path | 说明 |
| --- | --- | --- |
| `POST` | `/api/v1/search/find` | 快速语义查找。 |
| `POST` | `/api/v1/search/search` | 深度语义搜索，可结合 session context。 |
| `POST` | `/api/v1/search/grep` | 文本或模式检索。 |
| `POST` | `/api/v1/search/glob` | 按 glob 枚举 URI。 |

### Sessions

| Method | Path | 说明 |
| --- | --- | --- |
| `POST` | `/api/v1/sessions` | 创建 session。 |
| `GET` | `/api/v1/sessions` | 列出 sessions。 |
| `GET` | `/api/v1/sessions/{session_id}` | 获取 session 详情。 |
| `DELETE` | `/api/v1/sessions/{session_id}` | 删除 session。 |
| `GET` | `/api/v1/sessions/{session_id}/context` | 获取 session context。 |
| `GET` | `/api/v1/sessions/{session_id}/archives/{archive_id}` | 获取 session archive。 |
| `POST` | `/api/v1/sessions/{session_id}/commit` | 提交 session 并触发归档/记忆抽取。 |
| `POST` | `/api/v1/sessions/{session_id}/extract` | 对 session 执行抽取。 |
| `POST` | `/api/v1/sessions/{session_id}/messages` | 添加单条消息。 |
| `POST` | `/api/v1/sessions/{session_id}/messages/batch` | 批量添加消息。 |
| `POST` | `/api/v1/sessions/{session_id}/used` | 记录 session context 使用情况。 |
| `GET` | `/api/v1/sessions/{session_id}/tool-results` | 列出 tool results。 |
| `GET` | `/api/v1/sessions/{session_id}/tool-results/{tool_result_id}` | 读取 tool result。 |
| `GET` | `/api/v1/sessions/{session_id}/tool-results/{tool_result_id}/search` | 搜索 tool result。 |

### Stats And Console

| Method | Path | 说明 |
| --- | --- | --- |
| `GET` | `/api/v1/stats/memories` | 记忆统计。 |
| `GET` | `/api/v1/stats/sessions/{session_id}` | 指定 session 统计。 |
| `GET` | `/api/v1/console/dashboard/summary` | Console dashboard 汇总。 |
| `GET` | `/api/v1/console/tokens` | Token 使用序列。 |
| `GET` | `/api/v1/console/context-commits` | Context commit 记录。 |
| `GET` | `/api/v1/console/audit` | 审计日志。 |

### Privacy Configs

| Method | Path | 说明 |
| --- | --- | --- |
| `GET` | `/api/v1/privacy-configs` | 列出隐私配置。 |
| `GET` | `/api/v1/privacy-configs/{category}` | 按 category 查询隐私配置。 |
| `GET` | `/api/v1/privacy-configs/{category}/{target_key}` | 查询目标隐私配置。 |
| `GET` | `/api/v1/privacy-configs/{category}/{target_key}/versions` | 列出配置版本。 |
| `GET` | `/api/v1/privacy-configs/{category}/{target_key}/versions/{version}` | 查询指定版本。 |
| `POST` | `/api/v1/privacy-configs/{category}/{target_key}` | 写入新版本配置。 |
| `POST` | `/api/v1/privacy-configs/{category}/{target_key}/activate` | 激活指定配置版本。 |

### Relations

| Method | Path | 说明 |
| --- | --- | --- |
| `GET` | `/api/v1/relations` | 查询资源关系。 |
| `POST` | `/api/v1/relations/link` | 创建资源关系。 |
| `DELETE` | `/api/v1/relations/link` | 删除资源关系。 |
| `POST` | `/api/v1/relations/build_graph` | 构建关系图。 |

### Pack

| Method | Path | 说明 |
| --- | --- | --- |
| `POST` | `/api/v1/pack/export` | 导出 ovpack。 |
| `POST` | `/api/v1/pack/backup` | 备份 ovpack。 |
| `POST` | `/api/v1/pack/import` | 导入 ovpack。 |
| `POST` | `/api/v1/pack/restore` | 恢复 ovpack。 |

### Tasks, Watches, Observer

| Method | Path | 说明 |
| --- | --- | --- |
| `GET` | `/api/v1/tasks` | 列出异步任务。 |
| `GET` | `/api/v1/tasks/{task_id}` | 查询任务详情。 |
| `GET` | `/api/v1/watches` | 列出 watch，或按 query 查询。 |
| `GET` | `/api/v1/watches/{task_id}` | 查询指定 watch。 |
| `PATCH` | `/api/v1/watches/{task_id}` | 按 task id 更新 watch。 |
| `PATCH` | `/api/v1/watches` | 按 URI 更新 watch。 |
| `DELETE` | `/api/v1/watches/{task_id}` | 按 task id 删除 watch。 |
| `DELETE` | `/api/v1/watches` | 按 URI 删除 watch。 |
| `POST` | `/api/v1/watches/{task_id}/trigger` | 按 task id 手动触发 watch。 |
| `POST` | `/api/v1/watches/trigger` | 按 URI 手动触发 watch。 |
| `GET` | `/api/v1/observer/queue` | 观察处理队列。 |
| `GET` | `/api/v1/observer/vikingdb` | 观察 VikingDB 状态。 |
| `GET` | `/api/v1/observer/models` | 观察模型状态。 |
| `GET` | `/api/v1/observer/lock` | 观察锁状态。 |
| `GET` | `/api/v1/observer/retrieval` | 观察检索状态。 |
| `GET` | `/api/v1/observer/filesystem` | 观察文件系统状态。 |
| `GET` | `/api/v1/observer/system` | 观察系统状态。 |

### Bot Gateway

这些接口挂载在 `/bot/v1` 前缀下。

| Method | Path | 说明 |
| --- | --- | --- |
| `GET` | `/bot/v1/health` | Bot gateway 健康检查。 |
| `POST` | `/bot/v1/chat` | 非流式聊天。 |
| `POST` | `/bot/v1/chat/stream` | 流式聊天。 |
| `POST` | `/bot/v1/feedback` | 提交反馈。 |

### Debug

| Method | Path | 说明 |
| --- | --- | --- |
| `GET` | `/api/v1/debug/health` | Debug 健康检查。 |
| `GET` | `/api/v1/debug/vector/scroll` | 调试向量库滚动查询。 |
| `GET` | `/api/v1/debug/vector/count` | 调试向量数量。 |

### WebDAV Compatibility

WebDAV 兼容接口挂载在 `/webdav/resources`，同时支持根路径和 `/{resource_path:path}`。

| Method | Path | 说明 |
| --- | --- | --- |
| `OPTIONS` | `/webdav/resources[/{resource_path:path}]` | 查询 WebDAV 支持能力。 |
| `PROPFIND` | `/webdav/resources[/{resource_path:path}]` | 查询资源属性。 |
| `GET` / `HEAD` | `/webdav/resources[/{resource_path:path}]` | 读取资源内容或元数据。 |
| `PUT` | `/webdav/resources[/{resource_path:path}]` | 写入资源。 |
| `DELETE` | `/webdav/resources[/{resource_path:path}]` | 删除资源。 |
| `MKCOL` | `/webdav/resources[/{resource_path:path}]` | 创建集合/目录。 |
| `MOVE` | `/webdav/resources[/{resource_path:path}]` | 移动资源。 |

## `ov` CLI 保留接口

`ov` CLI 保留以下用户可见命令面。命令会读取本地配置中的 server URL、认证信息、输出格式和语言偏好，并调用上文 REST API。

### Data Commands

| Command | 说明 | 主要 REST 能力 |
| --- | --- | --- |
| `ov add-resource` | 添加 URL、本地文件、目录或临时上传为资源。 | `POST /api/v1/resources`、temp upload、watch。 |
| `ov add-skill` | 添加 skill。 | `POST /api/v1/skills`。 |
| `ov ls` / `ov list` | 列出目录内容。 | `GET /api/v1/fs/ls`。 |
| `ov tree` | 树形列出资源。 | `GET /api/v1/fs/tree`。 |
| `ov mkdir` | 创建目录。 | `POST /api/v1/fs/mkdir`。 |
| `ov rm` / `ov del` / `ov delete` | 删除资源。 | `DELETE /api/v1/fs`。 |
| `ov mv` | 移动或重命名资源。 | `POST /api/v1/fs/mv`。 |
| `ov stat` | 查看资源元数据。 | `GET /api/v1/fs/stat`。 |
| `ov read` | 读取资源内容。 | `GET /api/v1/content/read`。 |
| `ov abstract` | 读取资源摘要。 | `GET /api/v1/content/abstract`。 |
| `ov overview` | 读取资源概览。 | `GET /api/v1/content/overview`。 |
| `ov write` | 写入资源内容。 | `POST /api/v1/content/write`。 |
| `ov get` | 下载或获取资源内容。 | `GET /api/v1/content/download` 或 content read。 |
| `ov reindex` | 重建资源索引或语义/vector artifact。 | `POST /api/v1/content/reindex`。 |
| `ov add-memory` | 一次性写入记忆，内部创建 session、写消息并 commit。 | sessions messages + commit。 |

### Retrieval Commands

| Command | 说明 | 主要 REST 能力 |
| --- | --- | --- |
| `ov find` | 快速语义查找。 | `POST /api/v1/search/find`。 |
| `ov search` | 深度语义搜索。 | `POST /api/v1/search/search`。 |
| `ov grep` | 文本或模式搜索。 | `POST /api/v1/search/grep`。 |
| `ov glob` | 按 glob 枚举资源。 | `POST /api/v1/search/glob`。 |

### Session And Agent Commands

| Command | 说明 | 主要 REST 能力 |
| --- | --- | --- |
| `ov session` | 管理 session、上下文、归档和 tool result。 | `/api/v1/sessions...`。 |
| `ov chat` | 与 Bot gateway 对话。 | `/bot/v1/chat` 或 `/bot/v1/chat/stream`。 |
| `ov tui` | 启动交互式 TUI 浏览资源。 | fs、content、search。 |

### Operations Commands

| Command | 说明 | 主要 REST 能力 |
| --- | --- | --- |
| `ov wait` | 等待异步处理完成。 | `POST /api/v1/system/wait`。 |
| `ov task` | 跟踪异步任务。 | `GET /api/v1/tasks`、`GET /api/v1/tasks/{task_id}`。 |
| `ov status` | 查看服务组件状态。 | `GET /api/v1/system/status`。 |
| `ov observer` | 查看 queue、model、filesystem、retrieval 等 observer 状态。 | `/api/v1/observer/...`。 |
| `ov health` | 快速健康检查。 | `/health`、`/ready`、`/api/v1/system/status`。 |
| `ov config` | 管理 CLI 本地配置。 | 本地配置为主，按需探测 server。 |
| `ov language` | 设置 CLI 语言偏好。 | 本地配置。 |
| `ov version` | 显示 CLI 版本。 | 本地命令。 |

### Admin And Governance Commands

| Command | 说明 | 主要 REST 能力 |
| --- | --- | --- |
| `ov admin` | 多租户账号、用户和 key 管理。 | `/api/v1/admin/...`。 |
| `ov system` | 系统工具命令。 | `/api/v1/system/...`。 |
| `ov privacy` | 隐私配置管理。 | `/api/v1/privacy-configs...`。 |
| `ov relations` | 查询资源关系。 | `GET /api/v1/relations`。 |
| `ov link` | 创建资源关系。 | `POST /api/v1/relations/link`。 |
| `ov unlink` | 删除资源关系。 | `DELETE /api/v1/relations/link`。 |
| `ov export` | 导出 ovpack。 | `POST /api/v1/pack/export`。 |
| `ov backup` | 备份 ovpack。 | `POST /api/v1/pack/backup`。 |
| `ov import` | 导入 ovpack。 | `POST /api/v1/pack/import`。 |
| `ov restore` | 恢复 ovpack。 | `POST /api/v1/pack/restore`。 |

### Local Utility Commands

| Command | 说明 |
| --- | --- |
| `ov crypto init-key` | 初始化本地加密 key。 |

## MCP Server 接口

MCP Server 挂载在 `/mcp`，支持 streamable HTTP：

| Method | Path | 说明 |
| --- | --- | --- |
| `GET` | `/mcp` | 建立或恢复 streamable HTTP 会话。 |
| `POST` | `/mcp` | 发送 MCP JSON-RPC 请求。 |
| `DELETE` | `/mcp` | 关闭 MCP 会话。 |

### MCP Tools

| Tool | 参数 | 说明 |
| --- | --- | --- |
| `find` | `query`, `target_uri`, `limit`, `min_score`, `level` | 快速语义查找。 |
| `search` | `query`, `target_uri`, `session_id`, `limit`, `min_score`, `level` | 深度语义搜索，可携带 session context。 |
| `read` | `uris` | 读取一个或多个 URI 内容。 |
| `list` | `uri`, `recursive` | 列出 URI 下资源。 |
| `remember` | `messages` | 写入对话消息并生成记忆。 |
| `add_resource` | `path`, `temp_file_id`, `description`, `watch_interval`, `to` | 添加资源，支持路径、临时文件和 watch。 |
| `list_watches` | 无 | 列出资源 watch。 |
| `cancel_watch` | `to_uri` | 取消资源 watch。 |
| `grep` | `uri`, `pattern`, `case_insensitive`, `node_limit` | 文本或模式搜索。 |
| `glob` | `pattern`, `uri`, `node_limit` | 按 glob 枚举资源。 |
| `forget` | `uri`, `recursive` | 删除资源或记忆。 |
| `code_outline` | `uri` | 获取代码结构概要。 |
| `code_search` | `query`, `uri` | 在代码资源中进行语义搜索。 |
| `code_expand` | `uri`, `symbol` | 展开代码符号详情。 |
| `health` | 无 | MCP/OpenViking 健康检查。 |

## 接口选择建议

| 调用方 | 推荐接口 |
| --- | --- |
| Web 前端或后端服务 | 直接调用 REST API。 |
| 人工运维、脚本、CI | 使用 `ov` CLI；需要稳定机器可读输出时启用 CLI 的 JSON 输出参数。 |
| Agent / MCP Client | 使用 `/mcp` 暴露的 MCP tools。 |
| WebDAV 客户端 | 使用 `/webdav/resources` 兼容接口。 |
| Prometheus | 拉取 `/metrics`。 |
