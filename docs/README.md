---
id: orch-root-001
title: OrchDesk 知识库根索引
status: canonical
updated: 2026-08-17
---

# OrchDesk 知识库

> 本目录是 OrchDesk 项目的**唯一文档入口**。所有文档按生命周期分层组织，每类事实只有一个 canonical 责任方。
> 治理规则见 [30-开发/workflow.md](30-开发/workflow.md)；本知识库由 `consolidate-project-knowledge-base` SKILL 流程建立并维护。

## 分层索引

| 层 | 内容 | 入口 |
|---|---|---|
| 00-项目 | 当前状态、责任边界、来源并入 | [当前状态](00-项目/current-state.md) · [来源并入记录](00-项目/source-intake.md) |
| 10-架构 | 系统边界与图示 | [总体架构](10-架构/architecture.md) |
| 20-需求 | 产品合同 | [PRD](20-需求/PRD.md) · [UI/UX 规范](20-需求/ui-ux.md) |
| 30-开发 | 协作与开发流程 | [分解 PLAN](30-开发/PLAN.md) · [工作流/SOP](30-开发/workflow.md) |
| 40-质量 | 不变量与测试门禁 | [质量门禁](40-质量/quality-gates.md) |
| 50-发布 | 发布操作 | [发布](50-发布/release.md) |
| 60-BUG | 活跃 BUG 与缺口索引 | [BUG 索引](60-BUG/index.md) |
| 70-决策 | ADR 与冲突裁决 | [ADR 列表](70-决策/) · [冲突裁决记录](70-决策/conflicts.md) |
| 80-路线图 | 未来工作 | [路线图](80-路线图/roadmap.md) |
| 99-归档 | 过期计划与历史来源 | [归档索引](99-归档/index.md) |

## 一句话定位

**OrchDesk = 本地优先的多 Agent 编排桌面工作台**：以 deepseek-harness（Cordis）为运行时底座，继承前身 OrchStar 的产品域（Agent/模型/技能/提示词/会话/沙箱/授权/上下文），叠加桌面壳、跨平台沙箱、边界外补偿层与上游意图网关。

- 产品合同 → [20-需求/PRD.md](20-需求/PRD.md)
- 技术决策链 → [70-决策/](70-决策/)
- 从哪里开始读：新成员按 `PRD → 架构 → PLAN` 顺序。
