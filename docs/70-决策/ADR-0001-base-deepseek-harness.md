---
id: orch-adr-001
title: ADR-0001 以 deepseek-harness 为底座（取代 OrchStar 自研后端）
status: accepted
date: 2026-08-17
---

# ADR-0001：以 deepseek-harness 为底座

## 背景

前身 OrchStar 用自研 Node.js + Hono + SQLite 后端实现了八大模块（P0–P7、464 测试全通过），但它是**静态功能堆叠**：插件无法可逆热插拔，Agent 无法在运行时安全地自挂/卸载能力，每次改动都要重启、丢进程内状态。

## 决策

**以 deepseek-harness（dsh，Cordis 内核）为 OrchDesk 运行时底座；不回迁 OrchStar 后端代码，仅继承其产品域（需求基线）。**

## 理由

1. Cordis 把「一切皆插件、注册即 effect、卸载即逆回滚」做成运行时不变量（dsh `docs/architecture.md` L11-13），理论地基为《时空可组合性的编程范式》——这是自研后端难以企及的形式化保证。
2. dsh 已具备 SessionEvent 日志+分叉、Profiles+Bundles、`agent/pre-step` 拦截点、fail-closed approval、沙箱抽象。
3. 论文结论点名「自进化 Agent harness」是最重要验证方向，正是 OrchDesk 定位。

## 被否定的替代方案

- **继续用 OrchStar 自研后端**：功能虽完成，但无可逆效应/自进化保证；UI 尚未接线、桌面壳未完成，继续投入的边际价值低于换底座。
- **基于 orchclaw 直接桌面化**：orchclaw 偏服务端/Web 架构（PM2/Docker），桌面化改造量大于以 dsh 为底座；orchclaw 降为业务能力**参考**。

## 后果

- OrchStar 后端成为历史来源（[99-归档](../99-归档/index.md)）；其 API 概念在 P2 映射为 Cordis 服务/事件。
- OrchDesk 需跟踪 dsh 演进（基线锁定 + ADR 对账，见 [workflow](../30-开发/workflow.md)）。
