---
id: orch-cur-001
title: OrchDesk 当前状态
status: canonical
updated: 2026-09-18
---

# OrchDesk 当前状态

> 本页是「当前产品状态与版本」的 canonical 责任方。过期计划一律进 [99-归档](../99-归档/index.md)，不得写成当前事实。

## 阶段

产品已发 **v0.16.0**。P0–P6 代码主体完成，GUI 实机仍受环境门控。P0–P6 详细日记见 [current-state-P0-P6](../99-归档/current-state-P0-P6.md)。

## 当前事实

| 项 | 事实 |
|---|---|
| 版本 | `0.16.0`（权威：`apps/desktop/package.json`） |
| dsh 基线 | `99f6f02` |
| 文档入口 | [CHECKPOINT](CHECKPOINT.md) |

## 关键事实（裁决后）

1. **底座**：deepseek-harness（dsh），Cordis 内核。决策见 [ADR-0001](../70-决策/ADR-0001-base-deepseek-harness.md)。
2. **dsh 没有桌面壳**：`apps/` 仅 `cli` 与 `web`；早期「存在 apps/qurvis（Electron）」的说法已证伪。桌面壳是 OrchDesk 自建增量。见 [冲突裁决](../70-决策/conflicts.md)。
3. **OrchDesk 的自建增量**：桌面壳（`dsh-desktop` bundle + Electron）、跨平台沙箱 backend（**dsh 已内置三平台 backend**：win32 `windows-acl` / darwin `seatbelt` / linux `bwrap`→`landlock`，OrchDesk 不重写，仅接线+验证+GUI 暴露，见 [sandbox-backends.md](../30-开发/sandbox-backends.md)）、系统边界外补偿层、上游意图网关（挂 `agent/pre-step`）、**记忆分层 `memory-layers` 与系统提示词库 `prompt-lib`（P4 新增，因 dsh 无 memory/vector 专属包，属 OrchDesk 自建业务插件，本地优先、四域物理隔离、不调云端 embedding）**；以及 P6 生态层 **观雅集客户端（复用 guanji SKILL API 约定、TOKEN 用户配置不硬编码）与 OrchClaw Hub 配对客户端（凭据经 safeStorage 加密）**，均为 OrchDesk 自建客户端、不重写 guanji/Hub 核心（防漂移）。**2026-09 新增（Minke 对照）**：浏览器工具（自带 CDP，ADR-0011）、终端 PTY（多候选+管道显式降级，ADR-0012）、文件面板（只读→编辑/diff，ADR-0012/0013），分层与安全口径见 [架构 §10](../10-架构/architecture.md)、需求落点 [PRD FR-14](../20-需求/PRD.md)。
4. **前身 OrchStar** 已完成 Web 后端（P0–P7、464 测试），但 UI 未接线、桌面壳未完成；其产品域作为 OrchDesk 的需求基线，代码不回迁。见 [归档索引](../99-归档/index.md)。
5. **原型收敛结论（v0.6）**：3 入口（会话/插件/设置）、会话=一等公民、亮点功能视觉弱化但基于事实执行、一切皆插件、首批 5 内置插件（意图识别/TRACE/脑手解耦/多Agent编排/OrchClaw Hub 延后）。此为后续所有工作的基线，不可违背。
6. **dsh 底座已内置 P3 核心**（收敛发现）：dsh-base 在 win32 自动挂载 `dsh-sandbox-windows-acl` 受限令牌沙箱链 + 三权限预设（`workspace-write`/`read-only`/`danger-full-access`）+ approval seam（`ask`/`never`）。OrchDesk 的 P3 主要工作收敛为 GUI 接线 + win32 ACL 验证 + fail-closed 复核，**无需从零写沙箱/授权核心**。bundle 机制（`cordis.patch.yml` 的 `insert` 按 id 覆盖叠加 + profile `dsh.profile.bundles` 多层）已确认，是 `dsh-desktop` 落地的机制基础。
7. **dsh 启动机制纠正（防漂移）**：dsh **无 `-b` 参数**；启动单位是 *profile*，`dsh --profile <name>` 从 `$DSH_HOME/profiles/<name>` 加载，其 `package.json` 的 `dsh.profile.bundles` 列表按序叠加 bundle 层（base → desktop → 用户层 → `--patch`）。P1 桌面壳采用「渲染进程持有 UI 状态 + 主进程本地运行时适配器」架构，经 contextBridge 桥接（`load-sessions` / `persist-sessions` / `run-agent-turn`）；dsh 的集成形态经 [ADR-0008](../70-决策/ADR-0008-model-loop-dsh-bridge.md) 裁决（2026-08-30，修正本条早期「届时接入 followup」的设想）：模型调用/工具循环为直连实现（请求-响应，已被 318 项 verify 覆盖），主回合经 `dsh-runtime.firePreStep` 桥接驱动 `agent/pre-step` waterfall——**intent 意图网关与 trace 遥测在主链路真实生效**（此前为死挂点）；AgentLoop（followup/send/steer）完整事件化列入路线图。PLAN 中「`dsh -b dsh-desktop`」旧表述已纠正（见 T-P0-2 验收）。

## 责任边界（权威映射）

| 事实类别 | canonical 责任方 |
|---|---|
| 当前产品状态 | 本页 |
| 架构 | [10-架构/architecture.md](../10-架构/architecture.md) |
| 需求（PRD/UI-UX） | [20-需求/](../20-需求/PRD.md) |
| 计划与流程 | [30-开发/PLAN.md](../30-开发/PLAN.md)、[workflow.md](../30-开发/workflow.md) |
| 决策 | [70-决策/](../70-决策/) |
| 质量门禁 | [40-质量/quality-gates.md](../40-质量/quality-gates.md) |
| 缺口/BUG | [60-BUG/index.md](../60-BUG/index.md) |
| 历史记录 | [99-归档/index.md](../99-归档/index.md) |

外部参考（`references/`）一律为**镜像/快照**，不作 canonical；快照清单见 [来源并入记录](source-intake.md)。

## 下一步

- GUI 实机冒烟仍待正常 Windows 桌面按 [smoke-checklist](../40-质量/smoke-checklist.md) 回勾。
- 过期计划与 P0–P6 日记见 [current-state-P0-P6](../99-归档/current-state-P0-P6.md)，不得写成当前事实。
