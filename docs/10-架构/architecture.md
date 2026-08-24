---
id: orch-arc-001
title: OrchDesk 总体架构
status: canonical
version: v1.0
updated: 2026-08-17
---

# OrchDesk 总体架构

> 本页是「架构」的 canonical 责任方。理论依据见 `references/paper/README_精读.md`；三方对照见 `references/cross-reference-OrchDesk.md`；决策见 [70-决策](../70-决策/)。

## 1. 分层总览

```text
┌────────────────────────────────────────────────────────────────┐
│                     Electron 桌面壳（自建）                       │
│  ┌─────────────────────────┐   ┌────────────────────────────┐  │
│  │ 主进程                   │   │ 渲染进程（3+1 布局 UI）      │  │
│  │ · 承载/托管 dsh runtime  │◄─►│ · 经 contextBridge 访问宿主  │  │
│  │ · 窗口/托盘/快捷键/更新   │   │ · 只拿被显式暴露的能力       │  │
│  └─────────────────────────┘   └────────────────────────────┘  │
└──────────────────────────────┬─────────────────────────────────┘
                               │ IPC / bridge（论文 §6.2 跨进程模型）
┌──────────────────────────────▼─────────────────────────────────┐
│              dsh runtime（Cordis ctx，底座复用）                  │
│  一切皆插件：注册即 effect、卸载即逆回滚；无特权核心               │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ Profiles + Bundles 分层组合（dsh-base → dsh-desktop →     │  │
│  │ cordis.patch.yml → home 级 → --patch）                    │  │
│  └──────────────────────────────────────────────────────────┘  │
│  OrchDesk 业务插件（自建，挂 ctx）：                             │
│  agent-manager · model-registry · skill-hub · prompt-lib ·      │
│  conversation-ui · orchestrator(CEO/Director/Worker) ·          │
│  intent-gateway(挂 agent/pre-step) · memory-layers ·            │
│  authz(接 approval seam) · sandbox-bridge · compensation        │
├────────────────────────────────────────────────────────────────┤
│  dsh 既有能力（复用）：SessionEvent 日志+fork · approval seam     │
│  (fail-closed) · ctx.sandbox · guard · tool-execution-pipeline  │
├────────────────────────────────────────────────────────────────┤
│  平台沙箱 backend（外部机制，论文 §6.3）：                        │
│  Windows: sandbox-windows-acl · macOS: sandbox-exec/helper ·    │
│  Linux: landlock-run                                            │
└────────────────────────────────────────────────────────────────┘
```

## 2. 理论基础 → 工程不变量

| 论文概念 | Cordis/dsh 落地 | OrchDesk 收获 |
|---|---|---|
| 可逆效应（时间可组合性） | `ctx.effect` 注册即效应、卸载 LIFO 逆回滚 | 插件热插拔无残留、自进化安全 |
| 响应式共效应（空间可组合性） | `inject` 声明依赖 + `notify` 激活/停用 | 依赖缺失静默停用，不崩溃 |
| 统一 Context Γ∞ | 一切交互过同一 `ctx` | 可追踪/可撤销/可反应 |
| 观察等价 ≃ | append-only SessionEvent 日志可重放重建 | 会话恢复/分叉/回放 |
| 系统边界（§6.1） | 边界内可逆、边界外 emission 不可逆 | 需自建补偿层（FR-12） |
| 沙箱（§6.3） | `inject` 能力审查 + 外部沙箱 | 平台 backend 必须外部机制 |

## 3. 运行图组合（Profiles + Bundles）

- OrchDesk 新增 **`dsh-desktop` bundle**：在 `dsh-base`（模型/工具/持久化/沙箱/审批/凭证/遥测）之上叠加桌面层（Electron 桥接、托盘、窗口、桌面专属服务）。
- 组合顺序：`dsh-base → dsh-desktop → 用户 cordis.patch.yml → home 级 → --patch`，按 id 整行替换/插入。
- 「模式切换 = 运行图组合变化」：不同工作模式（如专注/编排/调试）是同一内核在不同 bundle 组合下运行，而非多套内核。

## 4. OrchDesk 插件清单（业务插件 ↔ 需求 ↔ OrchStar 前身模块）

| 插件 | 需求 | 继承 OrchStar | 说明 |
|---|---|---|---|
| `agent-manager` | FR-2 | agents 模块 | 角色、模型/技能/提示词绑定、启停 |
| `model-registry` | FR-3 | models 模块 | 多提供商、凭据 AES-256-GCM |
| `skill-hub` | FR-4 | skills 模块 | 本地/Git/观雅集安装，热插拔 |
| `prompt-lib` | FR-5 | prompts 模块 | 分类、`{skill:}` 引用、绑定矩阵 |
| `conversation-ui` | FR-6 | conversations 模块 | 消息流、分叉、回放（接 ctx.sessions） |
| `memory-layers` | FR-7 | context 模块 | 四域分层记忆 + 转储召回（TF-IDF 起步） |
| `orchestrator` | FR-11 | 脑-手路线图 | CEO/Director/Worker 层级、调度、反馈 |
| `intent-gateway` | FR-10 | —（新） | 挂 `agent/pre-step`，DREAM F1-F4/M1-M3/4-gate |
| `authz` | FR-9 | authz 模块 | 三模式 + L0-L4，接 approval seam |
| `sandbox-bridge` | FR-8 | sandbox 模块 | 接 ctx.sandbox + 平台 backend |
| `compensation` | FR-12 | —（新） | 边界外 emission 的确认/撤回/补偿 |

> OrchStar 的 44 个 REST API 在本架构中**不再以 HTTP 暴露**，而是映射为 Cordis 服务调用与类型化事件（桌面 in-process）；仅当需要 Web 远端访问时才经 `dsh-web-app` 暴露。API→插件映射对照表在 P2 产出。

## 5. 关键事件与 Seams（复用 dsh）

- **`agent/pre-step`**（waterfall）：消息到达模型前必经；监听器可改写或拒绝 claimed messages；拒绝/空首 claim 仍关闭一个不耗 step 的持久化轮次并入日志。→ **意图网关的必经拦截点**。
- **`approval` seam**：`ApprovalOutcome = allowed-once | rejected | cancelled | unavailable`，fail-closed（异常/缺失归 unavailable 不开门）。→ 授权插件对接点。
- **`ctx.sandbox`**：沙箱服务抽象，平台 backend 可插拔。
- **`tool-execution-pipeline`**：工具执行管线（含 schema 校验）→ M3 确定性编译层参考。

## 6. 系统边界与补偿层（OrchDesk 关键设计）

论文 §6.1：效应可逆性由系统边界决定。外部操作分两阶段——**acquisition**（边界内、可逆，如 open/fork 装描述符）与 **emission**（跨出边界、不可撤，如 write 字节/send 报文）。

OrchDesk 对策（`compensation` 插件）：

1. **边界内操作**（文件暂存、沙箱内执行）：依赖 Cordis 可逆效应回滚。
2. **边界外 emission**（发消息、发网络请求、写共享文件）：
   - 执行前 **withhold**：默认 CONFIRM（三类高危：删除文件/对外发送/不可逆操作）。
   - 执行后 **compensation**：提供撤回/补偿动作（撤回消息、删除已写文件），补偿结果入审计日志。
3. 补偿的元定理是论文开放问题——OrchDesk 以「保守确认 + 全量审计」工程兜底，不声称形式化保证。

## 7. 跨进程模型（论文 §6.2）

- 主进程：承载 dsh runtime（Cordis ctx），是唯一持有可能影响系统能力的进程。
- 渲染进程：只经 contextBridge 拿到显式暴露的能力子集；不可信插件/自生成插件走独立沙箱进程 + 桥接。
- 信任分级：宿主插件（in-process）> 市场插件（能力审查 + 沙箱）> 自生成临时插件（默认沙箱 + CONFIRM）。

## 8. 数据流（一次带编排的任务）

```text
用户输入
  → intent-gateway（agent/pre-step：F1-F4 → M1-M3 → 4-gate → ACT/CONFIRM/BLOCK）
  → orchestrator（CEO 拆解 → Director 规划/验收 → Worker 执行）
  → Worker 工具调用 → tool-execution-pipeline（schema 校验）
       → 边界内：沙箱 backend 执行（可逆）
       → 边界外：compensation 插件 CONFIRM 后 emission（入审计）
  → 全程写 SessionEvent 日志（可回放/分叉）
  → 上下文达阈值 → memory-layers 转储（摘要+向量化+伪记忆）
  → 反馈信号回流 orchestrator（完成率/失败/重试）→ 必要时升级 CEO
```

## 9. 架构决策索引

| 决策 | ADR |
|---|---|
| 以 dsh 为底座 | [ADR-0001](../70-决策/ADR-0001-base-deepseek-harness.md) |
| 桌面壳选 Electron | [ADR-0002](../70-决策/ADR-0002-desktop-shell-electron.md) |
| 意图网关挂 agent/pre-step | [ADR-0003](../70-决策/ADR-0003-intent-gateway-pre-step.md) |
| 脑-手层级实现方式 | [ADR-0004](../70-决策/ADR-0004-brain-hands-hierarchy.md) |
| 跨平台沙箱 backend | [ADR-0005](../70-决策/ADR-0005-sandbox-backends.md) |
