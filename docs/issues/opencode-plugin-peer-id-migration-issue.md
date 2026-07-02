# OpenCode 插件支持 peerId 并迁移旧 agentId 数据

状态：未开始

## 背景

OpenViking 0.4.x 引入 User / Peer 模型，旧 `agent_id` 与 `viking://agent/...` 进入 legacy 兼容路径。OpenCode 插件当前仍保留 `agentId` / `agentIdMode` 兼容配置，同时已有新字段 `peerId`，但需要明确改造和迁移策略。

## 目标

- OpenCode 插件以 `peerId` 作为新模型的主要配置项。
- 插件请求使用 `X-OpenViking-Actor-Peer` 表达 peer 视图。
- 旧 `agentId` 配置仅作为 legacy 兼容或迁移输入。
- 将原旧 `agentId` 数据迁移到对应 user 下的 peer 路径。

## 迁移范围

- `viking://agent/<agent_id>/memories/...` 迁移到 `viking://user/<user_id>/peers/<agent_id>/memories/...`。
- `viking://agent/<agent_id>/resources/...` 迁移到 `viking://user/<user_id>/peers/<agent_id>/resources/...`。
- `viking://agent/<agent_id>/skills/<skill>/...` 迁移到 `viking://user/<user_id>/skills/<skill>/...`。

## 待办

- 明确 OpenCode 插件配置中 `peerId` 与 `agentId` 的优先级和兼容规则。
- 更新插件文档，推荐新用户只配置 `peerId`。
- 验证插件自动 recall、memsearch、memread、memwrite、memcommit 都透传 `peerId`。
- 制定并验证旧 `agentId` 数据迁移流程。
- 补充迁移完成后的检查项和回滚说明。

## 验证建议

- 使用 `peerId` 启动 OpenCode 插件后，确认请求头包含 `X-OpenViking-Actor-Peer`。
- 执行迁移后，确认旧 agent 数据可在 `viking://user/<user_id>/peers/<agent_id>/...` 下看到。
- 确认 Web Studio 的 User / peers 树能浏览迁移后的 memories 和 resources。
