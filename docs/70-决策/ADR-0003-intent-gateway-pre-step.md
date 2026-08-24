---
id: orch-adr-003
title: ADR-0003 上游意图网关以 in-process 插件挂 agent/pre-step
status: accepted
date: 2026-08-17
---

# ADR-0003：意图网关挂 agent/pre-step（in-process 插件）

## 背景

笔记 117（DREAM→上游意图 Agent）设想「用户 prompt 先到上游 Agent 做意图识别，有问题的拦截/优化，通过的才转发下游」，并强调拦截必须**必经**（MCP/Plugin 可被跳过，不能依赖扩展点自觉）。117 设想用「独立上游系统级服务 + 下游 CLI 作为其子进程」来强制必经。

## 决策

**意图网关 `intent-gateway` 实现为 in-process Cordis 插件，监听 dsh 的 `agent/pre-step` 事件，而非独立上游进程。**

## 理由

1. **天然必经**：dsh `docs/architecture.md` L88 明确 `agent/pre-step` 监听器「可改写或拒绝 claimed messages」，且拒绝也关闭一个持久化轮次并入日志——消息到达模型前必过此点，必经性由事件流保证。
2. **更轻**：无 IPC 开销、无额外进程生命周期管理。
3. **可审计**：拦截/拒绝决策自动入 SessionEvent 日志。

## 被否定的替代方案

- **独立上游进程（117 设想）**：进程隔离确实能强制，但引入 IPC 与部署复杂度；且 dsh 的 in-process 必经性已满足「不可跳过」。
- **仅靠工具层校验**：工具层只管执行，管不到「到达模型的 prompt 本身」，不符合 117 的「prompt-level firewall」定位。

## 边界与后果

- in-process 插件与宿主同信任级。**不可信的上游模型/插件**仍需沙箱（[ADR-0005](ADR-0005-sandbox-backends.md)）保护——必经性解决「不可跳过」，沙箱解决「不可信」。
- 需自建 **M3 确定性编译层**（LLM 决策不直接执行，编译为可验证动作），参考 `tool-execution-pipeline` 的 schema 校验。
