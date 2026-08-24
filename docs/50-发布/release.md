---
id: orch-rel-001
title: OrchDesk 发布操作
status: draft
updated: 2026-08-17
---

# 发布操作

> 骨架页，随 [PLAN](../30-开发/PLAN.md) P6 完善。当前（P0 之前）仅定义约定。

## 渠道与打包

- **形态**：Electron 桌面安装包（electron-builder）。
- **平台**：Windows 首发（nsis/portable）；macOS（dmg，待沙箱 backend 就绪）；Linux（AppImage，复用 landlock-run）。
- **分发**：GitHub Releases（OrchDesk 仓库）。

## 版本策略

- 语义化版本 `MAJOR.MINOR.PATCH`；预发布用 `-alpha.N` / `-beta.N`。
- 底座基线（dsh commit）记入每次发布的 manifest，保证可复现。

## 发布检查单（骨架）

- [ ] 全量质量门禁通过（[40-质量](../40-质量/quality-gates.md)）
- [ ] 端到端冒烟：建 Agent → 会话 → 授权 → 热插拔 → 回放
- [ ] 数据目录自动快照（升级前备份）
- [ ] 更新说明（含决策变更链接到 [ADR](../70-决策/)）
- [ ] 签名与哈希（后续补充）

## 证据

每次发布在 [99-归档](../99-归档/index.md) 登记：版本、commit/tree、制品哈希、冒烟结果。
