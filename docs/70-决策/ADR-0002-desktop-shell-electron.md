---
id: orch-adr-002
title: ADR-0002 桌面壳选 Electron（而非 Tauri）
status: accepted
date: 2026-08-17
---

# ADR-0002：桌面壳选 Electron

## 背景

需要一个桌面壳承载 dsh runtime 并渲染 UI。存在 Tauri 与 Electron 两个候选。

## 决策

**选 Electron。**

## 理由

1. **运行时同构**：Cordis/dsh 全 TypeScript/Node 生态；Electron 主进程可直接 in-process 承载 Cordis ctx，无需 Rust 侧重写运行时。
2. **论文 §6.4 契合**：Electron/Node 的模块 registry 满足「运行时可引入/收回模块」，JS Proxy 满足「透明访问中介」——是 Cordis 动态组合的天然宿主。
3. **前身实证**：OrchStar 设计文档曾写 Tauri v2（Phase 2），但实际落地时已改用 Electron（`electron/main.cjs`）——说明在本项目语境下 Electron 更顺手。此为一次显式冲突裁决（见 [conflicts.md](conflicts.md)）。
4. 团队/个人无 Rust 经验，Tauri 学习成本高。

## 被否定的替代方案

- **Tauri v2**：包体小、内存省，但需 Rust 承载/桥接 Node runtime，与 Cordis 的 Node 生态错位；OrchStar 实践中已被放弃。

## 后果

- 包体与内存开销大于 Tauri（可接受，桌面工具场景）。
- 需做好 Electron 安全基线（contextIsolation、sandbox、禁用 remote、CSP），见 [质量门禁](../40-质量/quality-gates.md)。
