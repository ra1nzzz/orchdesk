---
id: orch-conf-001
title: 冲突裁决记录
status: canonical
updated: 2026-08-17
---

# 冲突裁决记录

> 按治理规则：来源冲突时记录冲突内容、选定权威、被否定解释与裁决理由；不静默拼接矛盾陈述。
> 优先级：① 可观察的生产行为/当前代码 ② 已验证的发布证据 ③ 已接受的 ADR/产品合同 ④ 维护中的操作文档 ⑤ 未完成计划/历史笔记 ⑥ 聊天摘要/记忆。

## C1：桌面壳技术选型 —— Tauri vs Electron

```text
Topic: OrchDesk/OrchStar 桌面壳用 Tauri 还是 Electron
Source A and claim: OrchStar《开发设计文档》——Phase 2 用 Tauri v2（历史笔记/未完成计划，优先级 ⑤）
Source B and claim: OrchStar 实际仓库 electron/main.cjs + Electron 图标/打包——实际用 Electron（可观察的当前代码，优先级 ①）
Selected authority: Source B（Electron）
Decision: OrchDesk 桌面壳采用 Electron
Reason: 可观察代码优先于未完成计划；且 Cordis/dsh 全 Node 生态，Electron 主进程可 in-process 承载 ctx（见 ADR-0002）
Follow-up gate: 无
```

## C2：dsh 是否有现成桌面壳 —— 误报修正

```text
Topic: dsh 是否已有桌面壳 apps/qurvis（Electron）
Source A and claim: 早期调研汇报「dsh 已有桌面壳 apps/qurvis（Electron）」（聊天摘要，优先级 ⑥）
Source B and claim: 直接核查 dsh 源码 references/deepseek-harness/apps/ —— 仅 cli 与 web，无 qurvis/Electron（可观察的当前代码，优先级 ①）
Selected authority: Source B
Decision: dsh 无桌面壳；OrchDesk 须自建桌面壳 + dsh-desktop bundle（这是自建增量，非「在 qurvis 上改」）
Reason: 源码为最高权威；早期汇报为误读，予以证伪并记录，避免后续基于错误前提规划
Follow-up gate: P0 底座打通时复核 dsh apps/ 是否新增桌面形态
```

## C3：上游意图 Agent 形态 —— 独立进程 vs in-process 插件

```text
Topic: 上游意图 Agent 以独立系统级进程还是 in-process 插件实现
Source A and claim: 笔记 117 —— 独立上游服务 + 下游 CLI 作为子进程，靠进程隔离强制必经（外部笔记，优先级 ⑤）
Source B and claim: dsh 源码 architecture.md L88 —— agent/pre-step 监听器可改写/拒绝 claimed messages，必经性由事件流保证（可观察的当前代码，优先级 ①）
Selected authority: Source B（in-process 插件挂 agent/pre-step）
Decision: intent-gateway 以 in-process Cordis 插件实现（ADR-0003）
Reason: dsh 原生必经点已满足「不可跳过」且无 IPC 开销；但「不可信组件」仍须沙箱（ADR-0005）补充 Source A 的隔离诉求
Follow-up gate: P4 意图网关落地时验证不可信上游模型走沙箱
```

## C4：底座 —— OrchStar 自研后端 vs deepseek-harness

```text
Topic: OrchDesk 继续用 OrchStar 自研 Hono 后端还是换 dsh 底座
Source A and claim: OrchStar 后端 P0-P7 完成、464 测试全通过（已验证的代码证据，优先级 ①，但属于「旧系统」）
Source B and claim: dsh/Cordis 提供可逆效应/自进化运行时不变量（已接受的决策 + 论文理论，优先级 ③）
Selected authority: Source B（dsh 底座）
Decision: 以 dsh 为底座，OrchStar 后端转为历史来源，代码不回迁（ADR-0001）
Reason: OrchStar 后端虽完成，但无可逆热插拔/自进化保证，且 UI 未接线、桌面壳未完成；换底座的长期价值高于继续投入
Follow-up gate: P2 核心域迁移时产出 OrchStar 44 API → Cordis 服务/事件映射表
```

## C5：Agent 运行时 —— openclaw CLI vs dsh runtime

```text
Topic: Agent 运行时用 openclaw CLI 子进程（OrchStar 方案）还是 dsh runtime
Source A and claim: OrchStar —— openclaw CLI 以子进程运行、stdio 通信（旧系统证据，优先级 ①）
Source B and claim: dsh —— 一切皆插件的 Cordis runtime（已接受决策，优先级 ③）
Selected authority: Source B（dsh runtime）
Decision: Agent 运行时用 dsh；orchclaw 的会话/任务/工作流/记忆等能力作为插件移植参考，不依赖 openclaw CLI 子进程
Reason: 与 ADR-0001 一致；openclaw CLI 方案与 dsh 插件模型不兼容
Follow-up gate: P2 评估 orchclaw 各技能向 Cordis 插件的移植清单
```
