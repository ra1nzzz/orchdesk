# Semantic Diff — OrchDesk → Canonical Ontology

> 本文件按 ORCHDESK-UNIFICATION-PROMPT Phase 2 要求产出，记录 orchdesk 本地术语
> 与 Canonical Ontology 的逐项映射，作为后续迁移/消费的对照底表。
>
> 变更请同步回 `mappings/orchdesk.yaml` 与母规范仓库 `DECISION-LOG.md`。

---

## 1. 实体映射

| OrchDesk 本地术语 | 定义位置 | Canonical 实体 | 挂靠 Core | 迁移阶段 | 备注 |
|---|---|---|---|---|---|
| `SessionEvent` | `apps/desktop/session-events.ts:32` | `Session` | → Memory.EpisodicMemory | Phase 2 (annotation) | DSH 事件日志的投影；seq/ts/kind 与 Canonical SessionEvent 对齐 |
| `SessionToolStep` | `apps/desktop/session-events.ts:26` | `ToolCall` + `ToolResult` | → Action | Phase 2 (annotation) | phase 字段对应 execution status；result 对应 ToolResult.result |
| `ToolCall` | `apps/desktop/agent-runtime.ts:25` | `ToolCall` | → Action | Phase 2 (annotation) | 参数态，无调用 id |
| `NativeToolCall` | `apps/desktop/agent-runtime.ts:31` | `ToolCall` | → Action | Phase 2 (annotation) | 带 id + rawArguments，对应 Canonical ToolCall.id + raw schema |
| `ModelReply` | `apps/desktop/agent-runtime.ts:37` | `ModelReply` | → Observation | Phase 2 (annotation) | content/toolCalls/source/usage 与 Canonical ModelReply 对齐 |
| `ToolResult` | `apps/desktop/agent-runtime.ts:62` | `ToolResult` | → Action | Phase 2 (annotation) | error 存在即对应 Canonical ToolResult.status=error |
| `ApiMessage` | `apps/desktop/agent-runtime.ts:69` | `Message` | → Observation | Phase 2 (annotation) | OpenAI chat 规范超集；role/name/tool_call_id 与 Canonical Message 对齐 |
| `OrchDeskRuntime` | `apps/desktop/dsh-runtime.ts:97` | `Agent` (runtime) | → Agent | Phase 2 (annotation) | ctx=DSH Runtime；plugins=DSH plugin layer |
| `PluginLoadResult` | `apps/desktop/dsh-runtime.ts:89` | `Plugin` | → Agent capability | Phase 2 (annotation) | name/ok/active/error 对应 Plugin 运行态 |
| `PluginState` | `apps/desktop/dsh-runtime.ts:373` | `Plugin` | → Agent capability | Phase 2 (annotation) | UI 展示用快照 |
| `SubAgentRecord` | `packages/plugin/brain/src/index.ts:121` | `Agent` | → Agent | Phase 2 (annotation) | id=芯片 id；sessionId=Session；status=Agent 生命周期态 |
| `SubAgentEvent` | `packages/plugin/brain/src/index.ts:135` | `Event` | → Event | Phase 8 | dispatch/dispose 对应 Task lifecycle 事件 |
| `BrainHands` | `packages/plugin/brain/src/index.ts:140` | `Agent` capability | → Agent | Phase 2 (annotation) | dispatch/dispose/promote/list/subscribe 为 SubAgent 管理 API |
| `HubClient` | `apps/desktop/hub.ts:91` | `External Service` | → External Service | Phase 2 (annotation) | 远程 OrchClaw Hub REST 客户端；非 Canonical 核心实体 |
| `MemoryPersistApi` | `apps/desktop/dsh-runtime.ts:255` | `Memory.persistence` | → Memory | Phase 2 (annotation) | serializeDomains/hydrateDomains 为记忆持久化 seam |
| `GrantPersistApi` | `apps/desktop/dsh-runtime.ts:322` | `Approval` persistence | → Approval | Phase 2 (annotation) | serializeGrants/hydrateGrants 为授权白名单持久化 seam |

---

## 2. 事件映射

| OrchDesk 本地事件名 | 产生位置 | Canonical 事件类型 | 映射阶段 | 备注 |
|---|---|---|---|---|
| `SessionEventKind.user` | session-events.ts | `session.user_message` | Phase 2 | 用户消息事件 |
| `SessionEventKind.assistant` | session-events.ts | `session.assistant_turn` | Phase 2 | 模型回合（含工具步骤） |
| `SessionEventKind.fork-origin` | session-events.ts | `session.forked` | Phase 8 | 分叉血缘标记 |
| `SubAgentEvent.dispatch` | brain plugin | `task.created` / `agent.spawned` | Phase 8 | SubAgent 派遣 |
| `SubAgentEvent.dispose` | brain plugin | `task.completed` / `agent.disposed` | Phase 8 | SubAgent 销毁 |
| `agent/pre-step` (waterfall) | dsh-runtime.ts | `agent.pre_step` | Phase 8 | intent 门控 + trace 观测挂点 |
| `tool_result` (executeTool) | main.ts | `tool.result` | Phase 8 | 工具执行结果回传 |

---

## 3. 类型系统差异

| 维度 | OrchDesk 本地 | Canonical | 差异处理 |
|---|---|---|---|
| Session 标识 | `s<base36 时间戳>` (string) | `SessionId` (branded string) | Phase 2 annotation 标注挂靠；Phase 8 消费端转换 |
| 工具调用 id | `call_<timestamp>_<seq>` | `ToolCall.id` (string) | 本地已兼容 OpenAI 规范；直接映射 |
| 事件序号 | `seq` (monotonic int) | `Event.sequence` | 本地 seq 从 1 起；Canonical 无强制起点，直接映射 |
| 时间戳 | `ts` (epoch ms) | `Event.timestamp` (ISO-8601) | Phase 8 消费端做 ms → ISO-8601 转换 |
| 记忆域 | `worker / user / assistant / system` (4 域) | `MemoryDomain` (Working/Episodic/Semantic/Procedural) | 本地 4 域已在 `memory-promotion.ts` canonical 单源化；此处不重复 |

---

## 4. 协议契约

| 协议 | OrchDesk 本地 | Canonical 对齐 | 阶段 |
|---|---|---|---|
| IPC 通道 | `orchdesk:load-sessions` / `persist-sessions` / `run-agent-turn` | 保留本地名；Phase 8 事件总线双写 Canonical envelope | Phase 2 (no change) |
| 插件装配 | `dsh-runtime.ts` + cordis.patch.yml | DSH plugin layer 已是 Canonical 实现 | Phase 2 (no change) |
| 事件消费 | 无（本地仅发不收） | SSE (Ordexa) / WS (OrchClaw) | Phase 8 |

---

## 5. 遗留概念

| 遗留概念 | 说明 | 处理方式 |
|---|---|---|
| `orchdesk:load-sessions` 等 IPC 名 | 本地约定，非 Canonical 标准 | 保留；Phase 8 事件总线双写时不替代 IPC |
| `SessionEventKind.fork-origin` | 本地血缘标记，Canonical Session 无显式 fork 类型 | Phase 8 映射为 `session.forked` 事件 |
| `BrainHands.promoteWorkerOutput` | 本地记忆晋升门控，非 Canonical 标准接口 | 保留本地语义；记忆域已 canonical 单源化 |
| `HubClient` | 远程 OrchClaw Hub 客户端 | 非 Canonical 核心；保持 External Service 映射 |

---

## 6. 迁移检查清单

- [x] Phase 2: 关键类型加 `@canonical` JSDoc 注释（annotation-only，不改逻辑）
- [x] Phase 2: 本文件 `docs/semantic-diff.md` 评审通过
- [x] Phase 2: brain 插件边界结论回母规范 `DECISION-LOG.md`（D-008）
- [x] Phase 2: 事件消费设计文档 `docs/event-consumption-design.md` 产出
- [x] Phase 8: SSE/WS 信封订阅原型实现（event-emit.ts + event-consumer/）
- [x] Phase 8: 事件双写开启（runAgentTurn + executeTool 接入 emitCanonicalEvent）
- [ ] Phase 8: 事件总线单元测试（event-emit-verify.cjs，需编译后运行）
- [ ] Phase 8: 与 Ordexa / OrchClaw 联调（需两端同时开启双写）
