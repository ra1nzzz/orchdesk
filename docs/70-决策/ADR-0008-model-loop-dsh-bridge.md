---
id: orch-adr-008
title: ADR-0008 主会话模型回合与 dsh AgentLoop 的关系
status: accepted
date: 2026-08-30
---

# ADR-0008：主会话模型回合与 dsh AgentLoop 的关系

## 背景

PLAN T-P1-5 原设想：真实模型回复在 `main.ts:runAgentTurn` 接入 `dsh ctx.agents.followup` / Ollama。工程落地过程中（v0.3.1–v0.5.0）实际实现为**直连 OpenAI 兼容 API / Ollama 的请求-响应工具循环**，未走 dsh AgentLoop，且长期未做显式裁决——构成文档漂移（PLAN/current-state 与 CHECKPOINT 口径打架），2026-08-30 由用户质询暴露。

关键事实：

1. dsh 的 `followup(message): void` 是 **fire-and-forget 的 inbox 驱动**（dsh runtime-types L124）：消息进 inbox、由 driver 事件驱动 turn，无 Promise 返回；与 Electron IPC 的请求-响应模型不同构。
2. `intent`（意图网关）与 `trace`（遥测）插件均挂 `agent/pre-step` waterfall——**该事件只有 dsh AgentLoop 驱动时才会发出**。主会话绕过 AgentLoop 意味着这两个 PRD 亮点功能在主链路上从未生效（死挂点），2026-08-30 前即如此。
3. 直连循环已承载：工具调用双模式、网关降级、软拒绝降级、结果裁剪、memory 召回注入（v0.5.0），被 verify 11 套件验证。
4. 全量切换 AgentLoop 需同步改造：工具执行映射进 dsh 工具体系、模型配置映射进 dsh 模型层、会话体系切换、IPC 从请求-响应改为事件订阅——估计是一次伤筋动骨的重构，且现有直连循环的 318 项验证全部作废重来。

## 决策

**v1 采用「挂点桥接」：主会话每个回合开始时，手动驱动 `agent/pre-step` waterfall（`dsh-runtime.firePreStep`），使 intent 门控与 trace 遥测在主链路真实生效；模型调用/工具循环维持现有直连实现。AgentLoop 完整事件化（followup/send/steer + session 体系）列入路线图，作为 P7 级架构演进项，切换前必须先出工具/模型映射的 ADR。**

桥接语义（fail 边界）：

| 情形 | 行为 | 依据 |
|---|---|---|
| decision.kind === 'reject' | 硬拒：不调模型，回复含拦截提示并落盘 | intent 4-gate fail-closed（ADR-0003） |
| decision.kind === 'enter'/'confirm' 等 | 放行（confirm 软信号的确认在下游 approval seam，与插件注释语义一致） | intent 插件注释「CONFIRM 软信号（放行但标记）」 |
| 运行时未启动 / ctx 无 waterfall / waterfall 抛错 | 放行 + WARN 日志 | 基础设施缺失 ≠ 风险输入放行；执行侧仍有目录白名单 + 命令白名单兜底 |
| 仅对用户输入门控一次（iter=0） | 后续工具 step 不重复过 intent | 意图网关管「用户意图」；工具执行已有沙箱门控 |

## 后果

- 正面：PRD 意图网关/TRACE 遥测在主会话真实生效（model-loop O1 验证 `rm -rf /` 硬拒、不调模型）；无需推翻 318 项已验证的循环实现。
- 负面/代价：dsh 的 steer（转向）、maintenance、inbox 排队等 AgentLoop 能力主会话暂不可用；每轮多一次进程内 waterfall 调用（开销可忽略）。
- 文档修正：PLAN T-P1-5、current-state 关键事实 7 按本 ADR 更新；裁决记录见 conflicts.md C 条目。

## 验证

- `model-loop-verify.cjs` O1：'rm -rf /' → `calls.length === 0` 且回复/落盘含「意图网关拦截」；A–N 组全绿证明正常对话零误拦。
