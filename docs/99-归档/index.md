---
id: orch-ach-001
title: OrchDesk 归档索引
status: canonical
updated: 2026-08-17
---

# 归档索引

> 历史记录与过期计划的索引。**历史来源保留原位、不整体回拷**；本页提供回链与说明。区分「历史事实」与「当前事实」——当前事实一律以 canonical 页为准。

## A. 前身项目 OrchStar（历史来源，archived）

OrchStar 是 OrchDesk 的前身（本地多 Agent 工作台，Node.js+Hono+SQLite+Electron 半成品）。其代码与文档**保留在原仓库原位**（快照见 [来源并入记录](../00-项目/source-intake.md) S6；本机路径按治理规则记入工作区记忆，不入共享库）。

| 历史文档 | 内容 | 对 OrchDesk 的意义 |
|---|---|---|
| `docs/development-design.md`（v1.1） | 八大模块设计、数据模型、44 API、安全设计 | 产品域需求基线（已被 [PRD](../20-需求/PRD.md) 吸收） |
| `docs/brain-hands-decoupled-remediation-roadmap.md` | 脑-手解耦、CEO/Director/Worker、分层记忆、7 修复模块 | 编排哲学来源（已被 [ADR-0004](../70-决策/ADR-0004-brain-hands-hierarchy.md) 与 FR-11 吸收） |
| `docs/electron-app-development.md` | Electron 壳现状审计（后端 OK、UI 未接线） | 「后端先行、UI 荒废」教训（LSN-01） |
| `docs/superpowers/plans/`（P0–P7） | 分期实施计划 | 历史计划，已过期 |
| `docs/Orchstar 开发设计文档与架构演进路线图 (整合版).pdf` | 整合版设计与路线图 | 历史快照 |
| `.monkeycode/MEMORY.md` | 用户任务 SOP 与多 Agent 编排理念 | 已被 [workflow](../30-开发/workflow.md) 与 [PRD §4](../20-需求/PRD.md) 吸收 |

**处置**：需求与哲学已吸收进 canonical 文档；OrchStar 代码**不回迁**（[ADR-0001](../70-决策/ADR-0001-base-deepseek-harness.md)）。其未提交制品（fix 脚本、smoke 截图、release/、_testdata/）若日后清理须先备份（删除后无法从 Git 恢复）。

## B. 参考资料（reference，在 `references/` 原位）

非归档，但登记便于检索：

| 资料 | 位置 | 说明 |
|---|---|---|
| deepseek-harness 源码 | `references/deepseek-harness` | 底座（canonical-base） |
| orchclaw 源码 | `references/orchclaw` | 业务能力参考 |
| Cordis 论文 + 精读 | `references/paper/`（paper.pdf / paper.txt / README_精读.md） | 理论地基 |
| 7 条笔记 | `references/ytaiv-notes/`（383/117/125/124/126/121/118 + INDEX.md + raw/） | 设计与调研参考 |
| 三方交叉对照 | `references/cross-reference-OrchDesk.md` | 本项目生成物（absorbed，留作证据） |

## C. 发布与版本证据

| 文档 | 版本 | 内容 |
|---|---|---|
| [v0.3.1 发布登记](v0.3.1-发布登记.md) | v0.3.1（已发布） | 制品哈希、BUG-013/014/015/016 修复、78 项验证 |
| [PRD 差距盘点-2026-08-29](PRD差距盘点-2026-08-29.md) | v0.3.1 时点 | 完成度 ≈ 30%，单点根因 = 运行时缺席 |
| [PRD 差距补齐复盘-2026-08-29](PRD差距补齐-2026-08-29.md) | v0.4.0（pending） | 运行时接入、9/9 插件激活、完成度 ≈ 75%、158 项验证 |

## D. 已关闭的决策/缺口

（随项目推进，将已解决的 ADR 替代项、已修复的 BUG 从活跃页移入此处，保留裁决理由与日期。）
