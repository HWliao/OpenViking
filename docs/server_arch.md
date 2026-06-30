# OpenViking Server Runtime Architecture

This document describes the server-side runtime architecture of OpenViking: the runtime components, their responsibilities, and how they interact during startup, request handling, background processing, and shutdown.

## 1. High-Level Model

OpenViking server is a single-process, compositional runtime built around FastAPI and a long-lived `OpenVikingService` instance.

```text
Client / Agent / MCP Client
  |
  v
FastAPI App
  |
  |-- middleware: auth, metrics, tracing, timing, body dump
  |-- routers: resources, filesystem, search, sessions, admin, observer, tasks, webdav, bot
  |
  v
OpenVikingService
  |
  |-- service layer: FS, Search, Resource, Session, Pack, Relation, Debug
  |-- storage layer: VikingFS, VikingDBManager, AGFS/RAGFS
  |-- background layer: QueueManager, WatchScheduler, TaskTracker, LockManager
  |-- processing layer: ResourceProcessor, SkillProcessor, SemanticProcessor, TextEmbeddingHandler
  |
  v
Persistent Storage / VectorDB / QueueFS / External Models
```

The FastAPI application is mainly the HTTP and protocol adapter. The actual runtime state is owned by `OpenVikingService`.

## 2. Main Entry Points

| Component | Location | Responsibility |
|---|---|---|
| FastAPI app factory | `openviking/server/app.py:create_app` | Builds the HTTP application, registers middleware, routers, exception handlers, lifespan hooks, and optional protocol endpoints. |
| Runtime service container | `openviking/service/core.py:OpenVikingService` | Owns and wires core infrastructure and service-layer components. |
| Service dependency registry | `openviking/server/dependencies.py` | Stores the active `OpenVikingService` and `ServerConfig` for routers and server-side utilities. |
| Server config | `openviking/server/config.py` | Controls server concerns such as auth mode, CORS, observability, OAuth, bot proxy, and tool output externalization. |
| OpenViking config | `ov.conf` via config initialization | Controls storage, embedding, retrieval, rerank, VLM, transaction, workspace, and default identity settings. |

## 3. Startup Flow

### 3.1 App Creation

`create_app()` performs the HTTP-layer setup:

```text
load_server_config()
  -> validate_server_config()
  -> create FastAPI app
  -> attach app.state.config
  -> register middleware
  -> register exception handlers
  -> register routers
  -> register optional OAuth / MCP / WebDAV / bot endpoints
```

Routers are thin adapters. They usually resolve the active service through `get_service()` and forward the request to a service-layer component.

### 3.2 Lifespan Startup

FastAPI lifespan creates or adopts the runtime service:

```text
if service is not provided:
    service = OpenVikingService()

set_service(service)
init metrics / usage audit / telemetry
start task tracker cleanup loop
start MCP lifespan
create background initialization task:
    await service.initialize()
```

Heavy initialization is deferred to a background task. This lets the server start accepting requests while storage, queues, indexes, and processors are being prepared. Service-layer methods guard themselves with initialization checks and raise structured errors if dependencies are not ready.

### 3.3 `OpenVikingService.__init__()`

The constructor does lightweight object construction and storage bootstrap:

```text
initialize_openviking_config()
  -> create default UserIdentifier
  -> create sub-services:
       FSService
       RelationService
       PackService
       SearchService
       ResourceService
       SessionService
       DebugService
  -> _init_storage()
  -> initialize embedder
```

`_init_storage()` prepares low-level infrastructure:

```text
create AGFS/RAGFS client
  -> init QueueManager
  -> create VikingDBManager
  -> setup Embedding and Semantic queues with start=False
  -> init LockManager
  -> set global TaskTracker
```

Queues are configured but not started yet. They are started only after `VikingFS` is initialized, so recovered queue tasks cannot run before the filesystem runtime is ready.

### 3.4 `OpenVikingService.initialize()`

The async initializer starts the actual runtime:

```text
acquire data directory process lock
  -> initialize encryption module
  -> initialize context collection
  -> create VikingFS
  -> start QueueManager workers
  -> initialize account and user directories
  -> create PrivacyConfigService
  -> create ResourceProcessor
  -> create SkillProcessor
  -> create SessionCompressor
  -> start LockManager
  -> start WatchScheduler
  -> inject dependencies into sub-services
  -> mark service initialized
```

## 4. Runtime Components

### 4.1 HTTP And Protocol Layer

| Component | Responsibility | Interacts With |
|---|---|---|
| FastAPI app | HTTP runtime shell. Registers middleware, routers, lifespan, and exception handlers. | Server config, service registry, routers. |
| Middleware | Cross-cutting request behavior: CORS, observability, profiling, request timing, optional body dump. | Request/response pipeline, metrics, tracing. |
| Routers | API adapters for system, admin, resources, filesystem, content, search, relations, sessions, stats, packs, debug, observer, metrics, tasks, watches, WebDAV, and bot proxy. | `get_service()`, `RequestContext`, service layer. |
| OAuth endpoints | Optional OAuth 2.1 authorization and token flows. | OAuth store/provider, app state. |
| MCP endpoint | MCP session manager and MCP request handling. | Service registry, server config, MCP SDK. |
| WebDAV router | File access through WebDAV semantics. | VikingFS and service layer. |
| Bot proxy router | Optional proxy to bot API when enabled. | Bot API URL and token. |

### 4.2 Identity And Auth Layer

| Component | Responsibility | Interacts With |
|---|---|---|
| `RequestContext` | Per-request identity and authorization context. Contains account, user, agent, and role. | Routers, VikingFS, services, processors. |
| `UserIdentifier` | Canonical account/user/agent identity object. | Service initialization, sessions, request context. |
| `APIKeyManager` | Loads and validates root/API keys when API-key auth is enabled. | Server config, VikingFS. |
| Auth mode handling | Supports development, trusted, and API-key backed modes. Trusted mode can accept gateway-injected identity headers. | Request headers, `RequestContext`, app state. |

Identity context is critical because URI access, encrypted content scope, user directories, session paths, and watch/task ownership are all evaluated through the current request context.

### 4.3 Service Container

| Component | Responsibility | Interacts With |
|---|---|---|
| `OpenVikingService` | Runtime kernel. Owns infrastructure lifecycle and wires dependencies into sub-services. | All core runtime components. |
| `get_service()` / `set_service()` | Global service registry used by HTTP routers. | FastAPI lifespan and routers. |
| `DebugService` | Health and runtime status access. | ObserverService, QueueManager, VikingDB, filesystem observers. |

`OpenVikingService` is the central boundary between the HTTP layer and the storage/processing runtime.

### 4.4 Service Layer

| Service | Responsibility | Main Dependencies |
|---|---|---|
| `FSService` | Public filesystem operations. | `VikingFS`, `PrivacyConfigService`. |
| `SearchService` | Search and retrieval operations. | `VikingFS`, `VikingDBManager`. |
| `ResourceService` | Resource ingestion orchestration, queue waiting, watch setup, async task tracking. | `VikingFS`, `VikingDBManager`, `ResourceProcessor`, `SkillProcessor`, `WatchScheduler`, `TaskTracker`. |
| `SessionService` | Session creation, loading, listing, deletion, and `Session` object creation. | `VikingFS`, `VikingDBManager`, `SessionCompressor`. |
| `RelationService` | Relationship operations over stored entities/resources. | `VikingFS`. |
| `PackService` | OV pack import/export and related packaging operations. | `VikingFS`, vector store. |
| `DebugService` | Health checks and component observers. | Config, VikingDB, AGFS client, queue manager. |

Sub-services are constructed early but become fully usable only after `OpenVikingService.initialize()` injects their dependencies.

### 4.5 Storage Layer

| Component | Responsibility | Notes |
|---|---|---|
| `VikingFS` | Canonical `viking://` namespace runtime. Handles URI normalization, access control, encryption/decryption, file operations, tree traversal, search helpers, and vector cleanup on delete. | Core content boundary. |
| AGFS/RAGFS client | Low-level filesystem or virtual filesystem backend used by `VikingFS`. | Created from storage config. |
| `VikingDBManager` | Vector database and context collection manager. Handles vector collection lifecycle, retrieval, count, delete, and index operations. | Core semantic index boundary. |
| VectorDB backend | Concrete vector storage, such as Qdrant or another configured backend. | Used by `VikingDBManager` and queue handlers. |
| Encryption module | Optional content encryption/decryption by account scope. | Used by `VikingFS`. |

Conceptually:

```text
VikingFS       = source content, files, directories, and viking:// namespace
VikingDBManager = semantic index, vector records, retrieval metadata
```

Most high-level operations use both: write content to `VikingFS`, then build or update semantic/vector state through queues and `VikingDBManager`.

### 4.6 Queue And Processing Layer

| Component | Responsibility | Interacts With |
|---|---|---|
| `QueueManager` | Owns named queues, starts worker threads, dispatches queue messages, tracks status and errors. | AGFS/RAGFS, `EmbeddingQueue`, `SemanticQueue`. |
| `EmbeddingQueue` | Persistent queue for embedding work. | `TextEmbeddingHandler`. |
| `SemanticQueue` | Persistent queue for semantic processing work. | `SemanticProcessor`. |
| `TextEmbeddingHandler` | Consumes embedding messages, generates embeddings, writes vectors. | Embedder, `VikingDBManager`. |
| `SemanticProcessor` | Consumes semantic messages for extraction, summary, memory, and indexing workflows. | VikingFS, model providers, VikingDB. |
| Embedder | Converts text chunks into dense or sparse vectors. | Embedding handler, retrieval config. |

Worker model:

```text
QueueManager.start()
  -> one daemon thread per queue
  -> each thread owns an asyncio event loop
  -> drain queue messages
  -> process concurrently up to configured limit
  -> ack on success
  -> keep unacked on failure for recovery
```

Standard queues:

```text
Embedding queue -> TextEmbeddingHandler -> embedder -> VikingDBManager / VectorDB
Semantic queue  -> SemanticProcessor    -> extraction/summary/memory/index updates
```

### 4.7 Resource Runtime

| Component | Responsibility |
|---|---|
| `ResourceService` | API-facing orchestration for adding resources. Validates target URI, delegates processing, waits for queues when requested, creates watch tasks, and tracks async task status. |
| `ResourceProcessor` | Imports local files, remote resources, and directories into the `viking://resources` namespace. |
| `SkillProcessor` | Handles skill-related processing and indexing. |
| `WatchScheduler` | Periodically refreshes watched resources. |
| `WatchManager` | Stores and manages watch task metadata. |
| `TaskTracker` | Tracks async resource ingestion tasks and status. |

Resource ingestion chain:

```text
POST /resources/add
  -> ResourceService.add_resource()
  -> validate target URI under viking://resources
  -> ResourceProcessor.process_resource()
  -> write source content into VikingFS
  -> enqueue embedding / semantic work when indexing is enabled
  -> if wait=true: wait for queue completion
  -> if wait=false: create TaskTracker task_id
  -> optionally create or update Watch task
```

### 4.8 Session Runtime

| Component | Responsibility |
|---|---|
| `SessionService` | Creates and loads sessions for the current request context. |
| `Session` | Represents a concrete conversation/session state. Stores messages and session artifacts through `VikingFS`. |
| `SessionCompressor` | Compresses sessions and extracts long-term memories. |
| Semantic queue | Handles async memory/semantic processing for session data. |

Session chain:

```text
Session API
  -> SessionService
  -> Session(viking_fs, vikingdb_manager, session_compressor, ctx)
  -> messages and artifacts stored in VikingFS
  -> memory extraction through SessionCompressor
  -> optional semantic queue processing
```

### 4.9 Transaction And Lock Runtime

| Component | Responsibility |
|---|---|
| `LockManager` | Manages exact-path locks, tree locks, move locks, batch locks, stale lock cleanup, and redo recovery. |
| `PathLockEngine` | Lower-level path lock implementation. |
| `RedoLog` | Tracks redo work for recovery paths such as session memory reprocessing. |

Typical delete/update protection:

```text
VikingFS.rm()
  -> acquire path or tree lock
  -> collect target URIs
  -> delete vector records from VikingDBManager
  -> delete files from AGFS/RAGFS
  -> release lock
```

The lock manager also starts background tasks during service initialization:

```text
LockManager.start()
  -> stale lock cleanup loop
  -> optional redo recovery loop
```

### 4.10 Observability Runtime

| Component | Responsibility |
|---|---|
| HTTP observability middleware | Records request-level metrics and tracing data. |
| Prometheus metrics | Exposes runtime metrics when enabled. |
| OpenTelemetry tracing/log export | Emits traces and logs to configured OTLP targets. |
| Usage audit | Records usage/audit events when enabled. |
| `ObserverService` | Aggregates component health and status. |
| `QueueObserver` | Reports queue health, status table, and errors. |
| Filesystem/VikingDB/retrieval/transaction observers | Expose component-specific runtime health. |

Observer request chain:

```text
GET /api/v1/observer/queue
  -> observer router
  -> DebugService.observer.queue
  -> get_queue_manager()
  -> QueueObserver
  -> status response
```

## 5. Request Interaction Patterns

### 5.1 Generic HTTP Request

```text
Client
  -> FastAPI middleware
  -> auth and identity extraction
  -> router
  -> get_service()
  -> build/use RequestContext
  -> service-layer method
  -> VikingFS / VikingDBManager / QueueManager / Session
  -> JSON response
```

### 5.2 Filesystem Read

```text
Filesystem/content endpoint
  -> FSService
  -> VikingFS.read(uri, ctx)
  -> check access
  -> convert viking:// URI to backend path
  -> AGFS/RAGFS read
  -> decrypt when enabled
  -> response bytes/content
```

### 5.3 Search

```text
Search endpoint
  -> SearchService
  -> validate query and optional URI scopes
  -> VikingFS / VikingDBManager retrieval
  -> optional rerank and filtering
  -> matched contexts response
```

### 5.4 Resource Add With Async Processing

```text
Resource endpoint
  -> ResourceService.add_resource(wait=false)
  -> ResourceProcessor writes content
  -> enqueue semantic and embedding messages
  -> TaskTracker creates task_id
  -> response includes task_id

Queue workers
  -> process queued work
  -> update vector index / semantic artifacts
  -> TaskTracker marks completion or failure
```

### 5.5 Resource Add With Wait

```text
Resource endpoint
  -> ResourceService.add_resource(wait=true)
  -> ResourceProcessor writes content
  -> enqueue queue work
  -> request wait tracker waits for relevant queues
  -> response includes queue_status
```

### 5.6 Watched Resource Refresh

```text
WatchScheduler loop
  -> find due watch task
  -> ResourceService.add_resource(skip_watch_management=True)
  -> ResourceProcessor refreshes content
  -> queue processing updates index
```

### 5.7 Session Memory Processing

```text
Session messages stored in VikingFS
  -> SessionCompressor extracts compressed context or long-term memories
  -> semantic processing can be enqueued
  -> SemanticProcessor updates memory/index artifacts
```

## 6. Memory Processing Runtime

OpenViking has two related but different processing paths that are often both described as memory:

| Category | URI Scope | Source | Schema Driver | Indexed As |
|---|---|---|---|---|
| Resource context | `viking://resources/...` | Files, URLs, repositories, directories, raw content. | Resource parsers, tree builders, semantic processors. | `context_type=resource` |
| User memory | `viking://user/{{ user_space }}/memories/...` | Conversation/session extraction. | Memory YAML schemas. | `context_type=memory` |
| Agent memory | `viking://agent/{{ agent_space }}/memories/...` | Conversation/session extraction, tool/skill/trajectory/experience extraction. | Memory YAML schemas. | `context_type=memory` |
| Skill context | Skill-related URI scopes. | Skill files and skill extraction flows. | Skill extraction templates/processors. | `context_type=skill` |

All of these ultimately share the unified context collection. The collection-level schema is not a separate schema per memory type. Instead, OpenViking distinguishes context by URI, `context_type`, ownership fields, and indexed metadata.

### 6.1 Unified Context Collection

The unified context collection is defined by `CollectionSchemas.context_collection()`.

Important fields:

| Field | Meaning |
|---|---|
| `id` | Primary key. |
| `uri` | Canonical `viking://...` URI. |
| `type` | Reserved resource subtype field. |
| `context_type` | High-level category: `resource`, `memory`, or `skill`. |
| `vector` | Dense vector. |
| `sparse_vector` | Sparse vector. |
| `level` | Context level: L0 abstract, L1 overview, L2 detail/content. |
| `name` | Display/search name. |
| `description` | Description metadata. |
| `tags` | Tags metadata. |
| `abstract` | Main indexed summary/content text. |
| `account_id` | Account isolation field. |
| `owner_user_id` | User ownership field. |
| `owner_agent_id` | Agent ownership field. |

The practical model is:

```text
same vector collection
  -> context_type separates resource / memory / skill
  -> uri separates resources / user memories / agent memories / sessions / skills
  -> account_id and owner fields enforce tenant and owner scope
```

### 6.2 Resource Context Processing

Resource context is not controlled by the memory YAML schemas. It is created by resource ingestion and parsing.

```text
ResourceService.add_resource()
  -> ResourceProcessor.process_resource()
  -> UnifiedResourceProcessor
       -> AccessorRegistry fetches source
       -> ParserRegistry parses local resource
       -> TreeBuilder / parser-specific output
  -> write parsed artifacts to viking://resources/...
  -> enqueue embedding and semantic work when build_index=true
  -> QueueManager workers update VikingDBManager / VectorDB
```

Resource context is indexed as `context_type=resource` and usually lives under `viking://resources/...`.

### 6.3 Long-Term Memory Extraction

Long-term memory extraction is session-driven. The core entry point is `SessionCompressorV2.extract_long_term_memories()`.

```text
Session messages
  -> extract_long_term_memories()
  -> create MemoryTypeRegistry
  -> initialize default memory files
  -> build ExtractContext
  -> MemoryIsolationHandler prepares read/write scope
  -> SessionExtractContextProvider prefetches relevant existing memories
  -> ReAct memory extraction orchestrator asks the LLM for operations
  -> MemoryUpdater.apply_operations()
  -> write/edit/delete Markdown memory files in VikingFS
  -> enqueue changed memory files for embedding
  -> generate directory .overview.md files
  -> optionally write archive memory_diff.json
```

The extractor returns lightweight `Context` objects for stats, but the real result is persisted directly into `VikingFS`.

### 6.4 Default Memory Schemas

Default memory schemas are YAML files under `openviking/prompts/templates/memory/`. They define memory type, target directory, filename template, fields, merge behavior, embedding text, and overview generation.

`MemoryTypeRegistry` loads schemas from:

```text
built-in templates/memory
  -> optional templates/memory/experimental_memory when enabled
  -> memory.custom_templates_dir overrides when configured
  -> configured prompt templates memory directory when present
```

Default schema summary:

| Memory Type | Scope | Directory | Filename | Mode | Purpose |
|---|---|---|---|---|---|
| `profile` | user | `viking://user/{{ user_space }}/memories` | `profile.md` | upsert | User profile. |
| `preferences` | user | `viking://user/{{ user_space }}/memories/preferences` | `{{ user }}/{{ topic }}.md` | upsert | User preferences by topic. |
| `entities` | user | `viking://user/{{ user_space }}/memories/entities` | `{{ category }}/{{ name }}.md` | upsert | People, projects, concepts, and other named entities. |
| `events` | user | `viking://user/{{ user_space }}/memories/events` | `YYYY/MM/DD/{{ event_name }}.md` | add-only | Dated event records. |
| `soul` | agent | `viking://agent/{{ agent_space }}/memories` | `soul.md` | upsert | Agent core truths, boundaries, vibe, continuity. |
| `identity` | agent | `viking://agent/{{ agent_space }}/memories` | `identity.md` | upsert | Agent identity information. |
| `tools` | agent | `viking://agent/{{ agent_space }}/memories/tools` | `{{ tool_name }}.md` | upsert | Tool usage knowledge and failure patterns. |
| `skills` | agent | `viking://agent/{{ agent_space }}/memories/skills` | `{{ skill_name }}.md` | upsert | Skill execution knowledge. |
| `experiences` | agent only | `viking://agent/{{ agent_space }}/memories/experiences` | `{{ experience_name }}.md` | upsert | Agent experience summaries. |
| `trajectories` | agent only | `viking://agent/{{ agent_space }}/memories/trajectories` | `{{ trajectory_name }}_{{ timestamp }}.md` | add-only | Agent execution trajectories. |

Schema fields are used by the extraction LLM and by `MemoryUpdater`. For example, a schema can define fields such as `topic`, `content`, `category`, `name`, `ranges`, `tool_name`, or `skill_name`. Each field can have a merge operation, so memory updates are schema-aware rather than simple string overwrites.

### 6.5 User Memory And Agent Memory Separation

User memory and agent memory share the same file format and collection schema, but they are separated by URI scope and request identity.

```text
user memory:
  viking://user/{{ user_space }}/memories/...

agent memory:
  viking://agent/{{ agent_space }}/memories/...
```

The effective `user_space` and `agent_space` are derived from `RequestContext`, `UserIdentifier`, and namespace policy.

```text
RequestContext
  -> account_id
  -> user_id
  -> agent_id
  -> role
  -> namespace_policy
```

This context affects:

1. Which memory files can be read during extraction.
2. Which namespace receives new memory files.
3. Which owner fields are written into vector records.
4. Which memories are visible during retrieval.

### 6.6 Memory Prefetch And Isolation

Before the LLM writes memory operations, existing memory context is prefetched.

```text
SessionExtractContextProvider.prefetch()
  -> load enabled memory schemas
  -> skip agent_only schemas for normal session extraction
  -> compute read scope from MemoryIsolationHandler
  -> search multi-file schema directories
  -> read single-file schema files
  -> provide conversation plus existing memory context to extractor
```

The extractor is instructed to use read/search tools only. It does not write files directly. It outputs structured operations, and `MemoryUpdater` is the only component that applies those operations to storage.

### 6.7 Memory Update And Merge

`MemoryUpdater.apply_operations()` applies resolved memory operations.

```text
ResolvedOperations
  -> validate all target URIs are resolved
  -> distribute links/backlinks
  -> apply upserts
       -> read latest file from VikingFS
       -> parse existing MemoryFile
       -> merge fields using schema merge_op
       -> preserve system-managed metadata
       -> render content_template
       -> write Markdown file
  -> apply deletes through VikingFS.rm()
  -> apply links to existing files
  -> enqueue changed memory files for vectorization
  -> regenerate affected directory .overview.md files
```

Deletes go through `VikingFS.rm()`, so vector records are cleaned up with the file deletion path.

### 6.8 Memory File Format

Memory files are stored as Markdown files, with structured fields managed by `MemoryFileUtils`.

```text
memory schema fields
  -> MemoryFile metadata and content
  -> content_template rendering
  -> Markdown file in VikingFS
```

This format is intentionally human-readable while still allowing field-aware merging and extraction.

### 6.9 Memory Vectorization

After memory files are written or edited, they are converted into embedding messages.

```text
changed memory URI
  -> read memory file
  -> parse MemoryFile
  -> choose embedding text
       -> schema.embedding_template when valid
       -> fallback to plain content
  -> build Context(context_type="memory", level=DETAIL)
  -> EmbeddingMsgConverter.from_context()
  -> VikingDBManager.enqueue_embedding_msg()
  -> EmbeddingQueue
  -> TextEmbeddingHandler
  -> VectorDB
```

Memory directory overviews are generated separately as `.overview.md` files. These provide L1-level summaries for search and browsing.

### 6.10 Session Archive And Redo Recovery

When memory extraction happens as part of session compression/archive, the archive may receive a diff file:

```text
{archive_uri}/memory_diff.json
```

This records written, edited, and deleted memory files for audit and recovery.

`LockManager` also has redo recovery for session memory work:

```text
LockManager.start()
  -> recover pending redo tasks
  -> read archived messages
  -> create session compressor
  -> extract_long_term_memories()
  -> fallback enqueue semantic memory processing
```

### 6.11 Memory Retrieval Usage

At retrieval time, memories are found through the same context retrieval infrastructure as resources and skills, but scoped by URI and `context_type`.

```text
query
  -> retrieval/search planner
  -> target context_type=memory when memory is requested
  -> URI scope filters for user or agent memory
  -> VectorDB search
  -> MatchedContext results
```

For agent-facing prompt construction, relevant user memory or agent experience can be recalled and injected into the LLM context. For example, user memory recall searches current user-related memory, while agent experience recall targets `viking://agent/{{ agent_space }}/memories/experiences/`.

### 6.12 Memory Processing Summary

```text
Session messages
  -> SessionCompressorV2
  -> MemoryTypeRegistry loads YAML schemas
  -> ContextProvider prefetches old memories
  -> LLM emits structured memory operations
  -> MemoryUpdater writes Markdown memory files
  -> changed files enqueue embedding messages
  -> QueueManager workers write vectors
  -> unified context collection stores searchable memory records

Resource content
  -> ResourceProcessor and parsers
  -> viking://resources files
  -> semantic / embedding queues
  -> same unified context collection as resource records
```

The important distinction is that default memory schemas control only `viking://user/.../memories` and `viking://agent/.../memories` files. Resource context is parsed and indexed through the resource pipeline, not through memory YAML schemas.

## 7. Shutdown Flow

FastAPI lifespan cleanup and `OpenVikingService.close()` stop runtime components in a controlled order:

```text
shutdown usage audit
shutdown metrics
stop TaskTracker cleanup loop
cancel OAuth GC task
close OAuth store
service.close()
  -> stop WatchScheduler
  -> stop LockManager
  -> mark VikingDBManager closing
  -> stop QueueManager workers
  -> close VikingDBManager
  -> clear VikingFS and processor references
  -> mark service uninitialized
```

## 8. Key Design Points

1. The FastAPI app is an adapter layer; `OpenVikingService` is the runtime kernel.
2. Routers should stay thin and delegate behavior to service-layer components.
3. `VikingFS` is the authoritative content and namespace layer for `viking://` URIs.
4. `VikingDBManager` is the semantic/vector index layer.
5. `QueueManager` decouples expensive embedding and semantic work from HTTP requests.
6. Queue workers start only after `VikingFS` is ready to avoid recovered tasks racing initialization.
7. `RequestContext` is passed through service and storage operations to enforce identity, access, encryption scope, and ownership.
8. `LockManager` protects concurrent filesystem/index mutations and provides stale lock cleanup and redo recovery.
9. `TaskTracker` and request wait tracking provide two modes for resource ingestion: async task polling and synchronous wait.
10. Observability is built into the server runtime through middleware, metrics, tracing, audit, and observer APIs.
11. User memory and agent memory are Markdown files under different `viking://` namespaces, but both are indexed as `context_type=memory` in the unified context collection.
12. Default memory behavior is controlled by YAML schemas in `openviking/prompts/templates/memory`, not by the vector collection schema.

## 9. Component Relationship Summary

```text
FastAPI App
  |
  |-- set_service(OpenVikingService)
  |-- app.state.config
  |-- app.state.api_key_manager
  |-- app.state.oauth_store
  |
  v
OpenVikingService
  |
  |-- FSService
  |     -> VikingFS
  |
  |-- SearchService
  |     -> VikingFS
  |     -> VikingDBManager
  |
  |-- ResourceService
  |     -> ResourceProcessor
  |     -> SkillProcessor
  |     -> VikingFS
  |     -> VikingDBManager
  |     -> WatchScheduler
  |     -> TaskTracker
  |
  |-- SessionService
  |     -> Session
  |     -> VikingFS
  |     -> VikingDBManager
  |     -> SessionCompressor
  |
  |-- PackService
  |     -> VikingFS
  |     -> Vector store
  |
  |-- RelationService
  |     -> VikingFS
  |
  |-- DebugService
  |     -> ObserverService
  |     -> QueueManager / VikingDB / filesystem observers
  |
  |-- QueueManager
  |     -> EmbeddingQueue
  |     |    -> TextEmbeddingHandler
  |     |    -> Embedder
  |     |    -> VikingDBManager
  |     |
  |     -> SemanticQueue
  |          -> SemanticProcessor
  |          -> VikingFS / VikingDBManager
  |
  |-- LockManager
  |     -> PathLockEngine
  |     -> RedoLog
  |
  |-- WatchScheduler
  |     -> WatchManager
  |     -> ResourceService refresh path
  |
  |-- VikingFS
  |     -> AGFS/RAGFS
  |     -> optional encryption
  |
  |-- VikingDBManager
        -> VectorDB backend
        -> context collection
```
