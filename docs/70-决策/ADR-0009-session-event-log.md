# ADR-0009：SessionEvent append-only 事件日志（OrchDesk 侧双写）

日期：2026-08-31 ｜ 状态：已采纳 ｜ 关联：PRD FR-6、ADR-0008、CHECKPOINT v0.12.0 第九段「诚实边界」

## 背景

PRD FR-6 要求「SessionEvent append-only 日志：模型可见必入日志，支持分叉、回放、上下文重建」。v0.12.0 第九段交付的分叉/回放**语义**时明确记录了诚实边界：回放的数据形态是 sessions.json 的消息数组，不是 append-only 事件流；接管 dsh `ctx.sessions` 属 P7 路线图，切换前须新 ADR。本 ADR 即该裁决。

## 决策

1. **OrchDesk 侧自建 append-only SessionEvent 日志**，不接管 dsh `ctx.sessions`。
   - 每会话一个 NDJSON 文件：`dataDir()/events/<sessionId>.ndjson`，一行一个事件，只追加不改写。
   - 事件种类：`user`（用户输入全文）、`assistant`（模型回复全文 + model + 工具步骤 + token 用量）、`fork-origin`（分叉血缘）。**模型可见必入日志**：runAgentTurn 持久化消息的同一事务点双写事件。
2. **sessions.json 仍是运行态存储**（渲染层读写、消息流渲染的事实源）；事件流是**回放 / 分叉上下文重建的权威源**。两者同源双写，不同步互拷——回放优先走事件流，事件流缺失（历史会话）时回退消息数组并显式标注，不假装达成。
3. **分叉不拷贝父事件**：子日志只写一条 `fork-origin` 事件（from / fromTitle / atIndex / at）；重建时间线时沿血缘链递归拼接父事件前缀（深度上限 8，防环）。append-only 语义不被拷贝破坏。
4. **上下文重建**：`rebuildContext(events)` 从事件流产出 `[{role, text}]`——分叉子分支的模型上下文可从日志重建，不再依赖消息数组切片。
5. dsh `ctx.sessions` 接管（真事件流成为 dsh 驱动循环的会话层）**仍留 P7**：需要 AgentLoop 切换到 dsh 驱动（ADR-0008 挂点桥接的下一步），届时事件种类需对齐 dsh `SessionEvent` schema，另立 ADR。

## 理由

- 现在就能兑现 PRD FR-6 的「append-only + 分叉 + 回放 + 上下文重建」，不被 P7 迁移阻塞。
- NDJSON 追加写崩溃安全（不会像整文件 JSON 那样半截写坏全丢）；一行一事件天然适合按 seq 回放。
- 不接管 ctx.sessions 避免了在 AgentLoop 未切换 dsh 驱动的前提下硬造第二套会话层——那会制造第十六个死挂点。

## 后果

- 正向：回放/分叉有了不可篡改的追溯源；「模型可见必入日志」成为 runAgentTurn 的硬约束；token 用量（FR-5）顺带入事件。
- 代价：每个 agent 回合多一次追加写（NDJSON，量级可忽略）；渲染层 doFork 多发一次 IPC。
- 风险与边界：事件流与 sessions.json 理论上可漂移（如用户手改文件）——回放以事件流为准并标注 legacy 回退；`sanitizeSessionId` 拒绝路径穿越 key。
