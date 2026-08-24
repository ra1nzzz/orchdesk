---
id: orch-adr-004
title: ADR-0004 脑-手层级用 dsh 插件 + sessions 实现
status: accepted
date: 2026-08-17
---

# ADR-0004：脑-手解耦层级的实现方式

## 背景

用户核心设计哲学（见 OrchStar 记忆与脑-手路线图）：**CEO（长驻脑）→ Director（8 领域总监）→ Worker（临时手）**，Worker 即用即走、上下文不污染上层，记忆四层（global/project/director/worker）隔离。前身 OrchStar 为此设计了专门的角色/层级/调度模块，但未完成。

## 决策

**脑-手层级用 dsh 原生机制实现，而非自研独立调度内核：**

- **角色层级与生命周期** → `orchestrator` 插件，Agent 状态与 delegation 记录为 Cordis 服务。
- **Worker 即用即走** → 映射到 Cordis Fiber：Worker 作为子 Fiber 注册为父上下文的受追踪 effect，任务完成即 dispose（级联卸载、逆回滚），天然「即用即走、无残留」。
- **记忆四层隔离** → Cordis `isolate`（同键在不同上下文解析到不同 realm）+ `memory-layers` 插件实现 global/project/director/worker 域隔离。
- **会话与上下文** → 复用 `ctx.sessions` + SessionEvent 日志；Worker 任务级上下文销毁即失。

## 理由

1. Cordis Fiber 生命周期（`ctx.use` 注册为父级 effect、卸载父级级联卸载子级、惯性状态机）与「Worker 即用即走、Director 先拆卸下游再自身回收」的语义**天然同构**。
2. `isolate`/`intercept` 提供依赖域隔离与访问元数据（只读/白名单），正好实现「Worker 不直接写全局记忆」。
3. 复用运行时不变量，避免自研调度内核重蹈 OrchStar 自研后端的覆辙。

## 被否定的替代方案

- **自研角色/调度内核（OrchStar 路线）**：重复造轮子，且失去可逆效应与 Fiber 级联语义。

## 后果

- 编排调度（预算/背压/升级）作为 `orchestrator` 插件逻辑实现，底层生命周期交给 Cordis。
- 需在 P5 验证：Worker dispose 后其记忆/上下文确实不泄漏到上层（隔离测试）。
