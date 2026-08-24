---
id: orch-adr-005
title: ADR-0005 跨平台沙箱 backend 策略
status: accepted
date: 2026-08-17
---

# ADR-0005：跨平台沙箱 backend 策略

## 背景

论文 §6.3 明确：**沙箱必须靠外部机制**（SFI/独立运行时/沙箱进程/容器），语言级访问控制挡不住恶意组件直连宿主运行时。dsh 的沙箱实现 `native/landlock-run`（Linux Landlock，~300 行 C11，fail-closed）**仅支持 Linux 内核 5.13+**；Windows 有 `sandbox-windows-acl` 雏形；macOS 无现成实现。

## 决策

**按平台提供沙箱 backend，统一接 `ctx.sandbox` 抽象；首发 Windows，macOS 次之，Linux 复用。**

| 平台 | backend | 状态 | 说明 |
|---|---|---|---|
| Windows | `sandbox-windows-acl`（ACL + 受限令牌/Job Object） | **已实现**（dsh `sandbox-local` 自动选，单候选无需 probe） | 首发目标， enforcement = `partial`（NTFS 硬链接别名区外路径，OS 层强制其余面） |
| macOS | `seatbelt`（`sandbox-exec` CLI，Apple 标记 deprecated 但仍随系统发布） | **已实现**（dsh `sandbox-local` 内置 `seatbeltProfileArgs`） | 单候选，功能 probe fail-closed；非"需自建"缺口（原 ADR 表述过时，见下「状态修正」） |
| Linux | `bwrap` → `landlock-run`（内核 5.13+） | **已实现**（dsh `sandbox-local` 自动选链） | 直接复用，无需 OrchDesk 改动 |

> **状态修正（2026-08-19）**：本 ADR 最初撰写时假设 dsh 在 macOS 无 seatbelt 实现（"需自建"）。
> 经核实 dsh `packages/sandbox/sandbox-local` 已内置 `seatbeltProfileArgs` 与 `defaultProbeSeatbelt`，
> `PLATFORM_CHAINS.darwin = ['seatbelt']` 为单一候选（无需 probe）。故 macOS 在 dsh 侧**已实现**，
> OrchDesk 不另起 backend。原"macOS 缺口进路线图"的结论不再成立，三平台 backend 均由 dsh 提供，
> OrchDesk 仅做接线 + 验证 + GUI 白名单暴露（见 [sandbox-backends.md](../30-开发/sandbox-backends.md)）。

## 理由

1. 遵循论文 §6.3「外部机制」原则：用 OS 级强制（ACL/seatbelt/Landlock/进程隔离），不做纯语言级拦截。
2. `ctx.sandbox` 已提供服务抽象，平台 backend 可插拔，符合 dsh「seams 可整段替换」的设计。
3. fail-closed：OS 无法强制则不运行命令（继承 landlock-run 的语义）。

## 被否定的替代方案

- **纯 Node `vm`/语言级沙箱**：论文明确否定（挡不住直连宿主运行时）。
- **首发即全平台**：macOS backend 缺失，强行首发会拖慢节奏；故首发 Windows。

## 后果

- macOS 沙箱是明确缺口与后续工作（进 [路线图](../80-路线图/roadmap.md)）。
- 所有平台 backend 必须 fail-closed 并有对应平台的安全测试。
