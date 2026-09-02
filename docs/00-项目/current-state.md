---
id: orch-cur-001
title: OrchDesk 当前状态
status: canonical
updated: 2026-09-02
---

# OrchDesk 当前状态

> 本页是「当前产品状态与版本」的 canonical 责任方。过期计划一律进 [99-归档](../99-归档/index.md)，不得写成当前事实。

## 阶段

**P0（底座打通）已完成 ✓；P1（桌面壳 + 会话优先 UI MVP）代码与环境就绪，但实跑验证被运行时级阻断；P2（5 内置插件落地）主体已收口；P3（安全底座）代码与文档就绪，运行期验证受同款门控；P4（智能层）代码与文档就绪，运行期验证受同款门控；P5（补偿层 + 自进化）代码/文档/运行验证就绪（node 直驱真实插件逻辑 verify 20/0），GUI 外发警示条·补偿审计·临时插件管理 UI 已接线，GUI 渲染受无显示器门控；P6（生态与发布）代码与配置就绪（观雅集客户端复用 guanji SKILL API 约定 + OrchClaw Hub 配对客户端凭据经 safeStorage 加密 + electron-builder nsis/portable 配置 + 更新前数据快照），运行期受同源门控（TOKEN/网络/远程 Hub/显示器）。** 渲染工程（4 列布局 / 侧栏项目分组 / 会话菜单 / composer / 模型多选 + 思维滑竿）已从 v0.6 原型提升为真实 Electron 渲染层；bridge 接通本地运行时（会话持久化 + 模型回合 seam），主进程与 preload 编译通过（tsc EXIT=0）；Electron 二进制已下载完成（36.9.5，202MB，exe 可执行、version 探测 exit 0），包内 `electron` bin 已就位。但经「执行启动预览」指令实拉验证：**本 agent 宿主环境（WorkBuddy CLI）无法启动任何 Electron GUI**（BUG-W02 open）——直接运行 `electron.exe` 本体（unset `ELECTRON_RUN_AS_NODE`、NODE_OPTIONS 仅 CA、无沙箱）复现 `process._linkedBinding('electron')` → "No such binding was linked"，叠加 WorkBuddy CLI 默认 `ELECTRON_RUN_AS_NODE=1`（强制 Node 模式）；`require('electron')` 解析到 npm 包返回 exe 路径，主进程启动即崩。2026-08-24 早间「误用 node」结案为**误判，已推翻**。electron-builder 打包产物完整（nsis Setup + portable + win-unpacked，asar 校验通过），GUI 实跑须在**正常 Windows 桌面**（无 WorkBuddy 注入）执行 `pnpm --filter @orchdesk/desktop start` 或直接运行产物 exe。真实模型闭环（T-P1-5）与 P3 授权/沙箱运行期验证为被门控的 seam。

## 已完成（2026-08-17 ~ 2026-08-18）

| 事项 | 证据 |
|---|---|
| 拉取底座与参考仓库 | `references/deepseek-harness`（master `99f6f02`）、`references/orchclaw`（main `d1a041e`）、`references/paper`（`948a07b`） |
| Cordis 论文精读（88 页全） | `references/paper/README_精读.md`、全文 `references/paper/paper.txt` |
| 抓取 7 条 Fast Note Sync 参考笔记 | `references/ytaiv-notes/`（383/117/125/124/126/121/118 + INDEX） |
| 论文 × 笔记 × dsh 源码三方交叉对照 | `references/cross-reference-OrchDesk.md` |
| 安装治理工具 | `guanji`（观雅集）+ `consolidate-project-knowledge-base` SKILL |
| 建立本知识库 | `docs/`（canonical 文档，audit 0 issues） |
| **原型 v0.2 → v0.6 收敛** | `prototype/orchdesk.html`（单文件 HTML，3 入口：会话/插件/设置） |
| 原型 v0.6 验证截图 | `prototype/_shot_session.png` / `_shot_session_collapsed.png` 等 |
| 文档按 v0.6 收敛更新 | PRD v1.1 / UI-UX v1.1 / PLAN v1.1（任务卡化） |
| **OrchDesk 工程骨架** | 根 `package.json` / `pnpm-workspace.yaml` / `tsconfig.base.json` / `cordis.patch.yml`（基线 `99f6f02` + 空 patch） / `.gitignore` |
| **构建文档 build.md** | `docs/30-开发/build.md`（环境 / dsh 构建 / 工程拓扑 / Windows 坑） |
| **桌面壳 bundle 骨架** | `packages/bundle/desktop/`（对齐 dsh bundle 约定：`package.json` `dsh.bundle.patch` + `cordis.patch.yml` + `src` 占位 + `tsconfig`） |
| **桌面壳 app 骨架** | `apps/desktop/`（Electron 主进程 `main.ts` + `preload.ts` 占位，`nodeIntegration:false` 红线） |
| **T-P0-1 ✓ dsh 底座构建** | `references/deepseek-harness`：`pnpm install` EXIT=0（PowerShell，51min）+ `build:lib` EXIT=0 + `apps/cli/lib/bin.js` 产物 + `--dump-default-config --profile web/headless` 确定性验证通过 |
| **BUG-W01 登记** | 60-BUG：pnpm 11 在 Git Bash/MinGW 下 safe-delete trash fatal，对策「install 用原生 PowerShell」 |
| **T-P1-1 ✓ orchdesk profile + 桌面壳接线** | `.dsh-home/profiles/orchdesk/`（bundles=[dsh-base, dsh-desktop]）+ 软链本地 `packages/bundle/desktop`；`dsh --profile orchdesk` 合成 EXIT=0（dsh-desktop 被正确识别叠加）；`apps/desktop/main.ts` 已加 `launchDshRuntime()`（设 DSH_HOME + spawn `dsh --profile orchdesk` + 退出回收） |

## 已完成（2026-08-18 续 · P1 桌面壳 + 会话优先 UI MVP）

| 事项 | 证据 |
|---|---|
| 桌面渲染工程（renderer/） | `apps/desktop/renderer/{index.html,styles.css,app.js}`：3 入口 + 会话页 4 列 grid（56/270/1fr/300，上下文栏收起用 `display:none`）+ 侧栏项目分组/菜单 + composer 三件套 + 模型多选 + 思维滑竿（0–3 不弹 modal）+ 授权芯片二次确认 |
| 桌面壳桥接（T-P1-1 收敛） | `apps/desktop/main.ts` 实现 `orchdesk:load-sessions` / `persist-sessions` / `run-agent-turn` 三个 IPC；`preload.ts` 经 contextBridge 暴露同名白名单；渲染进程 `window.orchdesk` 调用。`nodeIntegration:false` 红线保持 |
| 会话 CRUD 真实落盘 | 新建 / 重命名 / 分支 / 归档会话经桥写入 `userData/orchdesk-sessions.json`，可重启回放（SessionEvent 日志的落盘形态） |
| 主进程 + preload 编译 | `tsc -p apps/desktop/tsconfig.json` 产出 `dist/main.js` + `dist/preload.js`，EXIT=0 |
| Electron 运行时 | `apps/desktop` 依赖 `electron 36.9.5` 已装入工程；二进制已下载完成（202MB，exe 可执行、version 探测 exit 0）；包内 `.bin/electron` 已就位。启动方式为 `electron .`（`package.json` `main: dist/main.js`；`start` = `pnpm run build:main && electron .`）。**宿主环境阻断（BUG-W02 open）**：本 agent 环境（WorkBuddy CLI）下 Electron 核心 binding 未链接（`_linkedBinding('electron')` → No such binding；`require('electron')` 返回 npm 包 exe 路径；`ELECTRON_RUN_AS_NODE=1` 叠加），任何 Electron GUI 无法在此启动；2026-08-24 早间「误用 node」结案已推翻 |
| T-P1-5 端到端骨架 | 发送消息 → 桥 `run-agent-turn` → 落盘 SessionEvent；真实 LLM 调用为 seam（`ORCHDESK_MODEL_PROVIDER` 分支待接 `dsh ctx.agents.followup` / Ollama） |

> **P1 验证门控（宿主环境 Electron 阻断，BUG-W02 open）**：本 agent 环境（WorkBuddy CLI）下 Electron 核心 binding 未链接（`_linkedBinding('electron')` → "No such binding was linked"，`ELECTRON_RUN_AS_NODE=1` 叠加，`electron.exe` 本体复现），任何 Electron GUI 无法在此启动；2026-08-24 早间「误用 node」结案为误判已推翻。GUI 实跑须在**正常 Windows 桌面**执行 `pnpm --filter @orchdesk/desktop start`（先 `tsc` 再 `electron .`）。真实模型回复需 API Key 或本地 Ollama，且须在可运行 Electron 的环境验证。

## 进行中（P2 启动 · 2026-08-18 晚）

P1 收尾 + 「执行启动预览」环境级阻断诊断落档后，按「清理并继续」启动 P2 非 GUI 工程。

| 事项 | 证据 |
|---|---|
| P2 插件页 UI 已在 P1 渲染工程就绪 | `apps/desktop/renderer/app.js` `VIEWS.plugins`（5 分组左栏 `.ssec` + 主区 `.plug` 卡片 + 技能市场表 + 上下文栏 L0-L4）；CSS `.plug`/`.ssec` 已定义 |
| **T-P2-2~T-P2-5 插件代码骨架（真实 Cordis 插件）** | `packages/plugin/{intent,trace,brain,multi}/src/index.ts`：函数插件形态（`name`/`Config`(schemastery)/`apply`），intent/trace/brain 挂 `agent/pre-step`，brain/multi 用 `ctx.effect` 生命周期；multi 额外 `inject:['agents']`；标注运行时 seam（本地模型初筛 / GitHub 上传 / SubAgent spawn / 层级编排） |
| 插件接入 dsh-desktop bundle | `packages/bundle/desktop/cordis.patch.yml` 4 条 `insert` row（id: `orchdesk-intent`/`orchdesk-trace`/`orchdesk-brain`/`orchdesk-multi`）；bundle `package.json` 补 4 个 `workspace:*` 依赖 |
| OrchClaw Hub 延后 | T-P2-6：无 patch row，仅渲染层占位卡片标「延后」 |
| 探针残留清理 | `apps/desktop/probe.js`/`probe3.cjs` 已删除（residue cleared） |
| **dsh 轻量嵌入 + 插件 tsc 校验/构建通过** | 把 dsh 已构建源包（`vendor/cordis`、`packages/core/agent`、`vendor/schemastery`、`packages/core/session`）软链进 OrchDesk 根 `node_modules/@deepseek-ai/`（本地 shim，免方案 A 重装 / BUG-W01）；4 插件 `tsc --noEmit` 校验 + `tsc` emit **全部 EXIT=0**（`lib/index.js`+`lib/index.d.ts` 已产出） |
| API 对齐修正 | `UserMessage` 来自 `@deepseek-ai/dsh-session`（非 dsh-agent）；插件 tsconfig 自包含（`types:[]`+`lib:["ES2022","DOM"]`）；`package.json.types` 指向 `./lib/index.d.ts` |
| **T-P2-2 意图网关真实管线实现完成** | `packages/plugin/intent/src/index.ts` 由骨架升级：按 architecture.md L111 管线 `F1–F4 Funnel → M1–M3 → 4-gate → ACT/CONFIRM/BLOCK`；4-gate fail-closed（JSON 解析/Schema/Stage allowlist/参数范围）；M3 确定性编译层（不直接执行 LLM 输出，ADR-0003）；本地模型 qwen3:14b 经 Ollama seam 调用，不可用走 `defaultFallback=CONFIRM`；BLOCK 入审计日志可查询；`tsc --noEmit` EXIT=0 |
| **T-P2-3 TRACE 脱敏遥测真实逻辑完成** | `packages/plugin/trace/src/index.ts` 由骨架升级：按 T-P2-3/PRD/UI 设定 + 防漂移 4 条（路径/凭据/PII 不传、上传失败不阻塞、repoUrl 不硬编码、只记意图标签+反馈）落地；`agent/pre-step` 每 turn 起始观测语用意图标签（不记消息原文）；`mask()` 白名单字段+哈希根源脱敏；内存离线队列+失败指数退避重试（最多 5 次）；GitHub REST 上传 seam（`fetch`，repoUrl 用户配置、token 取 config/env 不进日志/payload）；导出 `recordFeedback` 供桥/渲染层 TRACE 按钮调用；`tsc --noEmit` EXIT=0 |
| **T-P2-4 脑手解耦 SubAgent 生命周期真实实现完成** | `packages/plugin/brain/src/index.ts` 由骨架升级：SubAgent 状态机 `W-xxx`（`dispatched`→`executing`→`disposed`）；`dispatchSubAgent` 经 dsh 原生 `ctx.agents.create`（`meta.origin:'subagent'`+`delegationDepth:1`，Cordis isolate）；`disposeSubAgent` 经 `AgentHandle.dispose()`（即用即走、零残留）；`maxConcurrentSubagents` 并发背压；`promoteWorkerOutput` Director 过滤晋升主会话记忆 fail-closed（FR-10）；`subscribe` 回调供桥消费 inline 芯片事件；`inject:['agents']`；`tsc --noEmit`/emit EXIT=0 |
| **T-P2-5 多 Agent 编排专家团真实逻辑完成** | `packages/plugin/multi/src/index.ts` 由骨架升级：8 专家+3 团数据来自插件（`EXPERTS`/`TEAMS`，不硬编码主程序）；`getCatalog()` 供渲染层 `@` modal/插件页；`composeTeam()` 经 dsh 原生 `ctx.agents.create` 建 CEO→Director(`delegationDepth:1`)→Worker(`delegationDepth:2`) 三层后台闭环、`finally` 中 `dispose()` 即用即走；`getDelegationTree()` 委派树可查询（视觉弱化）；`inject:['agents']`；`tsc --noEmit`/emit EXIT=0 |

> **P2 构建/运行门控（与 P1 同源）**：插件包 `peerDependencies` 已通过**本地软链 shim** 完成类型检查与构建（无需方案 A/B 重装；正式的 committed 嵌入仍走 build.md §3 方案 A/B）。GUI 运行期验证受宿主环境 Electron 阻断（BUG-W02 open），须在正常 Windows 桌面执行。骨架未接入真实模型/上传前默认放行/缓存，不误拦截正常请求。真正运行时插件开关（T-P1 渲染层 toggle 接真实 Cordis 效应）需 dsh 控制通道，列为待架构设计的后续任务。

## 进行中（P3 · 2026-08-19）

P2 收口后，按 PLAN 路线图启动 P3（安全底座）。收敛发现：dsh-base 已内置 P3 全部核心（平台沙箱 backend + 三档 SandboxMode + approval seam fail-closed + permission 三 preset），故 P3 的 OrchDesk 增量是**接线 + 验证 + GUI 暴露**，不重写核心（防漂移）。

| 事项 | 证据 |
|---|---|
| **dsh 平台沙箱 backend 已实现并自动选用** | `dsh-sandbox-local` 的 `PLATFORM_CHAINS`：win32=`['windows-acl']`（单候选无需 probe，enforcement=`partial`）、darwin=`['seatbelt']`（已内置 `seatbeltProfileArgs`）、linux=`['bwrap','landlock']`。OrchDesk 无需新增 backend row |
| **T-P3-1 文档 + ADR 修正** | 新增 `docs/30-开发/sandbox-backends.md`（跨平台机制 + 白名单 + 日志检索 + 可转移验证清单 W1-W6）；ADR-0005 macOS 状态从"需自建"修正为"dsh 已通过 seatbelt 提供"（原表述过时） |
| **T-P3-2 orchdesk-authz 插件新建** | `packages/plugin/authz/`：`inject:['sandboxPolicy','approval']` + `provide('authz')`；三模式映射（default/trusted/paranoid → dsh SandboxMode+ApprovalPolicy）；L0-L4 分级；审批应答方（fail-closed）；审计聚合。`tsc --noEmit`/emit EXIT=0 |
| **T-P3-2 bundle 接线** | `cordis.patch.yml` 加 `orchdesk-authz` row；bundle `package.json` 补 `@orchdesk/dsh-authz: workspace:*` |
| **T-P3-2 主进程/预加载桥** | `main.ts` 补 IPC（`authz:get-mode/set-mode/get-levels/get-audit` + 审批 pending map + `initAuthzBridge(dshCtx)` 接入点）；`preload.ts` 补同名桥 + `onAuthRequest`/`submitDecision`。tsc EXIT=0 |
| **T-P3-2 渲染层接线** | `app.js`：composer 授权芯片接真实 AuthzMode、设置页授权分组补三模式单选+L0-L4+审计日志、审批弹窗 modal+监听；`styles.css` 补样式；`app.js` 语法 OK |
| **T-P3-2 三模式语义收敛** | OrchDesk 三模式不含 danger-full-access（最松也是 workspace-write+ask），比旧"FULL ACCESS"概念更安全；paranoid=read-only+never 最严。从更严切更松模式需二次确认 |

> **P3 运行门控（与 P1/P2 同源）**：GUI 运行期验证受宿主环境 Electron 阻断（BUG-W02 open，本 agent 环境无法启动 Electron），故「GUI 审批弹窗闭环 / dsh approval/request 真实应答 / win32 ACL 越界写拦截」等运行期验收须在正常 Windows 桌面执行。代码逻辑与类型已就绪（authz 插件 tsc EXIT=0 + 主进程/preload tsc EXIT=0 + app.js 语法 OK）。

## 进行中（P4 · 2026-08-23）

P3 收口后，按 PLAN 路线图启动 P4（智能层）。收敛发现：dsh **无** memory / vector / context-window 专属包，故 `memory-layers`(FR-7/FR-10) 与 `prompt-lib`(FR-5/FR-11) 是 OrchDesk **自建业务插件**（与 P2/P3 同构：薄封装 dsh 既有挂点、复用 `agent/pre-step` 与 `ctx.agents`），不重写核心（防漂移）。

| 事项 | 证据 |
|---|---|
| **dsh 无记忆/向量服务（收敛确认）** | grep dsh 包无 `memory`/`vector`/`context-window` 专属模块；memory-layers 与 prompt-lib 为 OrchDesk 自建增量 |
| **T-P4-1/2 orchdesk-memory 插件新建** | `packages/plugin/memory/`：`inject:['agents']` + `provide('memory')`；80% 上下文阈值检测（挂 `agent/pre-step`）+ 转储（LLM 摘要 seam + 语义分块 + 本地 TF-IDF 不云端 + 伪记忆注入）+ 召回（Top-K 余弦）+ 四域（global/project/director/worker）物理隔离 + 晋升流 fail-closed（worker→director 经 `brain.promoteWorkerOutput`）；`tsc --noEmit`/emit EXIT=0 |
| **T-P4-3 orchdesk-prompt 插件新建** | `packages/plugin/prompt/`：`provide('promptLib')`；CRUD + 分类标签（角色行为/安全边界/输出格式/技能联动）+ `{skill:xxx}` 引用语法解析 + 按 Agent 绑定 + 优先级合并（冲突显式标记）；`tsc --noEmit`/emit EXIT=0 |
| **bundle 接线** | `cordis.patch.yml` 加 `orchdesk-memory`(L50)/`orchdesk-prompt`(L59) row；bundle `package.json` 补 `@orchdesk/dsh-memory`/`@orchdesk/dsh-prompt: workspace:*` |
| **渲染层提示词管理 UI 接线** | `app.js`：设置页「系统提示词」分组 + 侧栏「提示词」导航 + `PROMPT_CAT_LABELS` 常量 + `openPromptEditor` + `prompt-new/edit/save/delete` case + `listPrompts/mergePrompts/savePrompt/deletePrompt` 桥 mock（占位环境乐观本地更新，真实 IPC 待接 dsh ctx）；`styles.css` 补 `.prompt-list/.pl-item/.mb-row`；`app.js` 语法 OK |
| **全栈 tsc 校验通过** | memory/prompt 插件 tsc EXIT=0；desktop 主进程/preload/渲染层 tsc EXIT=0；`node --check app.js` OK |

> **P4 运行门控（与 P1/P2/P3 同源）**：GUI 运行期验证受宿主环境 Electron 阻断（BUG-W02 open），故「长会话 80% 阈值触发转储 / 语义召回注入 / 记忆四域隔离落盘 / 提示词合并冲突标记」等运行期验收须在正常 Windows 桌面执行。记忆/提示词服务的真实 IPC 桥接（preload→主进程→dsh `ctx.memory`/`ctx.promptLib`）为与 P1 同源的 seam（任务卡 #46 接真实桥），当前渲染层经 bridge mock + 乐观本地更新保证 UI 可演示。代码逻辑与类型已就绪。

## 进行中（P5 · 2026-08-24）

P4 收口后，按 PLAN 路线图启动 P5（补偿层 + 自进化）。收敛发现：dsh **无** 补偿层 / 自进化专属包，故两者是 OrchDesk **自建业务插件**（与 P2–P4 同构：薄封装 dsh 既有 seam、复用 `agent/pre-step` 与 `ctx.approval`），不重写核心（防漂移）。

| 事项 | 证据 |
|---|---|
| **dsh 无补偿层/自进化包（收敛确认）** | dsh 无 compensation/evolution 模块；两者为 OrchDesk 自建增量 |
| **T-P5-1 orchdesk-compensation 插件新建** | `packages/plugin/compensation/`：`inject:['approval']` + `provide('compensation')`；分类（delete-file/external-message/network-egress/shared-file-write/irreversible/other）+ `WITHHOLD_CATEGORIES` 覆盖三类外发+三类高危；`withhold` 预判 + `compensate` 补偿动作（不宣称可完全撤销）+ 审计环形缓冲 200；`agent/pre-step` 挂 `ctx.approval.request` 二次确认，fail-closed（无通道→reject）；`tsc --noEmit`/emit EXIT=0 |
| **T-P5-2 orchdesk-evolution 插件新建** | `packages/plugin/evolution/`：`inject:['approval']` + `provide('evolution')`；`staticGate` 静态分析（HARD_DENY 命中即 fail-closed 拒绝，其余 requiresSandbox）；`createTempPlugin` 先静态门控再 approval.request（默认 CONFIRM），成功仅驻内存（Map，status:active/trustLevel:shell/requiresSandbox:true，重启即失）；`disposeTempPlugin` 卸载；审计 200；`tsc --noEmit`/emit EXIT=0 |
| **bundle 接线** | `cordis.patch.yml` 加 `orchdesk-compensation`/`orchdesk-evolution` 两 row；bundle `package.json` 补 `@orchdesk/dsh-compensation`/`@orchdesk/dsh-evolution: workspace:*` |
| **渲染层 UI 接线（T-P5-1/2）** | `app.js`：composer 外发「不可撤销」警示条（实时 `bridge.withhold`）+ 设置页「补偿层审计」分区（补偿动作按钮 `comp-record`）+ 插件页「临时插件」面板（视觉弱化，`tp-new/create/dispose`）；bridge 补 `withhold/compensate/getCompensationAudit/createTempPlugin/listTempPlugins/disposeTempPlugin` mock（占位环境乐观本地状态）；`styles.css` 补 `.outbound-warn/.temp-plug-card/.tp-item`；`app.js` 语法 OK |
| **P5 运行验证（绕开 GUI，node 直驱真实插件逻辑）** | `scripts/verify-p5.mjs`：加载真实编译 `lib/index.js` + mock ctx（`effect`/`on`/`provide`/可挂 `approval`），覆盖补偿层 classify/withhold/补偿/审计 + `agent/pre-step` withhold 门控（allow→放行/deny→拦截/none→fail-closed）+ 自进化静态门控/授权门控/仅驻内存/卸载。**通过 20 / 失败 0** |

> **P5 运行门控（与 P1–P4 同源）**：本 agent 环境无法启动任何 Electron GUI（BUG-W02 open：binding 未链接 + `ELECTRON_RUN_AS_NODE=1`）。故 P5 采用「node 下加载真实编译插件 + mock ctx 直驱 `apply()`」验证真实业务逻辑（分类/withhold/补偿/静态门控/授权门控/fail-closed），绕开 GUI；渲染层 UI 经 bridge mock + 乐观本地更新保证可演示。真实 dsh approval/request 应答与沙箱执行验证须在正常 Windows 桌面环境执行。

## 进行中（P6 · 2026-08-24）

P5 收口后，按 PLAN 路线图启动 P6（生态与发布）。收敛发现：观雅集接入须**复用 guanji SKILL（v2.0.0）的 API 约定**（BASE_URL=skill.ytaiv.com、各端点、TOKEN 由用户配置），不得另起接口；OrchClaw Hub 联调为**真实 REST 客户端**（URL 可配置、凭据经 `electron.safeStorage` 加密），不在本地 mock 绕过；打包走 electron-builder（Windows nsis/portable，GitHub Releases 分发）。

| 事项 | 证据 |
|---|---|
| **T-P6-1 观雅集客户端新建** | `apps/desktop/guanji.ts`：`GuanjiClient` 复用 guanji SKILL API（recommend/latest·featured·top 合并去重、`<slug>/download`、auth/token、`/upload/prepare`+`/skills/upload` 灵璧预发布+`/alias`）；TOKEN 存 `userData/guanji.json` 不硬编码；`capabilityReview` 强制能力审查（auth=1 且无 TOKEN → `needs-auth` 拒绝，不跳过）；`tsc` EXIT=0 |
| **T-P6-1 主进程/预加载桥** | `main.ts` 补 `guanji:token-status/set-token/list/install/publish` IPC；`preload.ts` 补同名桥；渲染层 `app.js` 技能市场分组接真实列表（无 TOKEN 回落静态样本 + 提示配置）、安装走能力审查+授权徽标、发布走登录后上传、已安装技能启用/停用/卸载 |
| **T-P6-2 OrchClaw Hub 客户端新建** | `apps/desktop/hub.ts`：`HubClient` 配对（`/api/pair`）+ 发任务（`/api/agent/<h>/task`）+ 回收（`/api/agent/<h>/result/<taskId>`）；凭据经 `safeStorage.encryptString/decryptString` 加密落盘 `userData/hub.json`（无加密后端拒绝明文）；`tsc` EXIT=0 |
| **T-P6-2 主进程/预加载桥 + 渲染 UI** | `main.ts`/`preload.ts` 补 `hub:status/pair/send/result`；`app.js` 把 Hub 卡片从「延后」升级为配对 UI（URL+凭据输入、已配对显示 Agent、下发任务+回收结果）；`PLUGINS` hub 条目 `deferred:0`、`d`/`cfg` 改联调就绪描述 |
| **T-P6-3 打包发布配置** | `apps/desktop/package.json` 加 `build`（appId/com.orchdesk.app、productName OrchDesk、asar、files=dist+renderer+package.json、win=[nsis,portable] x64、publish=github）；凭据均在 `userData`（应用外），不进安装包 |
| **T-P6-3 更新前快照 + 更新检查** | `main.ts` 加 `snapshotData()`（复制 userData 到 `snapshots/<时间戳>`）+ `checkForUpdates()`（防御性 `import('electron-updater')`，未发布时提示，更新前必先快照）；`preload.ts`+`app.js` 暴露 `snapshotData`/`checkUpdates` 桥与「检查更新（先快照）」按钮 |
| **全栈 tsc + 语法校验** | desktop `tsc -p tsconfig.json` EXIT=0；`node --check app.js` OK；guanji/hub/preload/main 三方桥一致 |

> **P6 运行门控（与 P1–P5 同源）**：观雅集真实列表/安装/发布需用户配置 TOKEN + 网络（无 TOKEN 时渲染层回落静态样本并提示配置，能力审查不跳过）；OrchClaw Hub 端到端联调需可达远程 Hub（代码为真实客户端，不在本地 mock）；产出可安装 Windows 包需在 Windows + 签名环境执行 `pnpm --filter @orchdesk/desktop build`，端到端冒烟需显示器。代码逻辑、类型与打包配置已就绪。

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

- **[2026-08-29 补齐] dsh/Cordis 运行时已真实接入**：此前 [差距盘点](../99-归档/PRD差距盘点-2026-08-29.md) 指出 2515 行插件是「写完了没接线」的死代码（单点根因 = 运行时缺席）。现 `apps/desktop/dsh-runtime.ts` 在主进程 `new Context()` 装载全部 9 插件（9/9 ACTIVE，`getService()` 可取）、`main.ts` 用 `bootRuntime()` 替换 `initAuthzBridge({get:()=>undefined})`、11 个 `dshBridgeStub` 改为真实 `ctx.get(...)`、7 插件 `provide(name,value,true)` 第三参误传修复；凭据升级 AES-256-GCM（`credentials.ts`）、沙箱子进程隔离、6 处渲染层缺陷修复；插件测试 2/9 → 9/9（`scripts/verify-plugins.mjs`），验证套件扩至 158 项全绿。**PRD 完成度从 ≈ 30% 升至 ≈ 75%**。完整复盘见 [归档/PRD差距补齐-2026-08-29](../99-归档/PRD差距补齐-2026-08-29.md)。三笔提交（`e820e33`/`2d988c5`/`91ae26b`）已落 `main`，未打 tag / 未发布（预期 v0.4.0）。

- **P1–P6 全部代码与配置已就绪**：六阶段（底座/桌面壳/内置插件/安全底座/智能层/补偿自进化/生态发布）的插件、桥接、渲染 UI、打包配置均落地并通过 tsc 编译（EXIT=0）+ app.js 语法检查 + 插件真实逻辑 node 直驱验证（verify-p5 23/23，现扩至 verify-plugins 9/9）+ 知识库审计 0 issues。**打包已产出**：electron-builder 成功生成 nsis Setup（`release/OrchDesk-Setup-0.3.1.exe`，84MB）+ portable（`release/OrchDesk-0.3.1.exe`）+ `latest.yml` + `win-unpacked/`（asar 结构校验完整）。剩余动作是**运行期验证**（与 P1 同源门控）：① 本 agent 环境 Electron 阻断（BUG-W02 open：binding 未链接 + `ELECTRON_RUN_AS_NODE=1`），GUI 实跑须在**正常 Windows 桌面**直接双击产物 exe 或执行 `pnpm --filter @orchdesk/desktop start`；② 真实模型闭环需在 `main.ts:runAgentTurn` 接入 `dsh ctx.agents.followup` 或本地 Ollama（配置 API Key / `ORCHDESK_MODEL_PROVIDER`）；③ 观雅集真实列表/安装/发布需用户配置 TOKEN + 网络；④ OrchClaw Hub 端到端联调需可达远程 Hub；⑤ 正式发布分发需补 `publish`/`repository` 真实仓库信息后走 GitHub Releases。
- **本机门控**：本 agent 宿主环境（WorkBuddy CLI）无法启动任何 Electron GUI（BUG-W02 open，2026-08-24 早间「误用 node」结案已推翻）；打包/联调/发布实跑须在正常 Windows 桌面 + 网络/远程环境完成。代码正确性已通过 tsc 编译（EXIT=0）+ app.js 语法检查 + verify-p5（真实插件逻辑）+ asar 结构校验 + 知识库 audit 0 issues。
- 铁律：每个 Phase 端到端可用，不重演 OrchStar「后端先行、UI 荒废」。P6 为路线图收口阶段，生态（观雅集/Hub）与发布（electron-builder/更新前快照）均按 PLAN 落地、不任务漂移。

## UI/UX 迭代（2026-08-28）

| 事项 | 证据 |
|---|---|
| **启动并行化** | `init()` 从 14 个串行 IPC 改为 `Promise.allSettled` 并行；首屏 `render()` 先渲染空壳，后台并行加载会话/授权/提示词/记忆/补偿/模型/观雅集/Hub 等元数据 |
| **欢迎页智能推荐** | `getSmartRecommendations()`：无历史→新手引导（创建项目/闲时任务/浏览技能/项目分析）；有历史→扫描近 7 天消息主题信号（报错/文档/重构/数据/PPT）+ 技能使用频率 TOP1 + 空闲检测，动态生成 4 个快捷按钮 |
| **动态时段问候** | `getGreeting()` 扩展：早上好/上午好/中午好/下午好/傍晚好/晚上好/夜深了 +「一起来做点什么呢？」 |
| **布局调整** | `.home-screen` `justify-content:center`（垂直居中）；`.composer` 去底部背景和 border-top；`.home-greeting` 字号缩小到 20px/600 |
| **Markdown 渲染** | 集成 `marked.js`（MIT, UMD）替换手写正则渲染器；新增 `.md-body` 样式（代码块/列表/引用/链接）；`:nth-child` 修复列表间隔过宽（`ul margin:2px 0` / `li margin:0 0 2px`） |
| **模型管理 UI** | 设置页「默认模型」下拉（来自所有已配置提供商的模型列表）；切换后 `autoSelectModels` 重算 + 异步持久化到 `models.json` |
| **下拉浮窗层级** | `.composer-more-dropdown` z-index 50→200；`.proj-dropdown` z-index 50→200 + `pointer-events:auto/none` 过渡 |
| **项目选择器修复** | 阻止 `.proj-dropdown` 内点击冒泡到 `proj-select-toggle` handler |
| **电灯白屏防护** | `BrowserWindow` 加 `backgroundColor: '#1E1E1E'` |
| **Emoji → SVG 全覆盖** | 全部 emoji 图标已迁移到 `ic()` SVG 映射（含 ctx-empty 💬→clipboard） |
| **E2E 测试** | Playwright 脚本 26/29 PASS（3 项为 mock bridge 消息收发限制，预期内） |

## 第二轮补齐（2026-08-29 晚 · yt-dev-review 并发审阅工作流）

> 流程：主会话推进 + 解耦模块委派并行子代理开发；每模块完成后由 `yt-dev-review` 技能派 3 个并行审阅子代理（质量/效率/可复用性）→ 交叉比对 → 交叉修复 → 全量复验。本轮共 12 个开发/审阅子代理。

| 模块 | 交付 | 审阅发现的真问题（已修复） |
|---|---|---|
| M1 数据目录统一 | 新纯逻辑 `apps/desktop/data-dir.ts`（`resolveDataDir`/`migrateDataFiles`/`mergeSessionsData` 等，零 electron 依赖）；guanji.json/hub.json/skills 接入 `dataDir()`；凭据类 copy-if-absent 迁移；`data-dir-verify.cjs` 36 项 | **P0**：`main.ts` 调 `resolveDataDir` 漏传 `existsSync`（缺省恒 false）→ 便携模式生产失效（测试自注入 so 全绿，「测试过、生产坏」）；每次启动重写整份 sessions（merge 对已存在 id 计 added）；候选目录未规范化去重；copyTree 每文件 mkdir |
| M2 导出/导入 JSON | BUG-013 方案 B：`orchdesk:export-data/import-data` + preload 桥 + 设置页按钮；备份单文件（kind: orchdesk-backup，白名单 5 段）；`data-port-verify.cjs` 10 项 | **P0**：导入竞态——`persist-sessions` 是渲染层状态整体重写，导入落盘与渲染层重拉之间触发 persist 会冲掉导入数据（修：渲染层 `importSuspend` 挂起 persist，finally 恢复）；伪造备份可写入明文凭据（修：`credentialSectionValid` 校验 enc/tokenCipher）；大文件无上限（修：256MB 拒绝）；pick-folder 非空断言 |
| M3 模型闭环线级验证 | `apps/desktop/model-loop-verify.cjs` 23 项：`node:http` 真 mock 服务（OpenAI chat/responses/completions + Ollama 四形态、一轮多 tool_calls、降级、401/429 canary 防泄漏、迭代上限、结果裁剪） | **P0**：`apiMode:'responses'` 的 `input` 只拼 user 消息 → 丢 system 提示词与 assistant 历史，工具能力彻底失效（修：按规范传完整消息数组，system→developer）；明文 apiKey 被静默删除（修：就地加密迁移）；Ollama 错误正文未截断；maxToolIterations 保存 500 运行 200 的静默不符 |
| M4 编排闭环验证 | `scripts/verify-orchestration.mjs` 45 项：真实 brain/multi 插件产物 + mock Cordis ctx（SubAgent 派生/即用即走/背压/晋升 fail-closed/三层编排/委派树） | **P0**：`brain.promoteWorkerOutput` 恒 false → FR-10 worker→director 晋升永久断裂（修：接入 director 过滤 seam，默认仍拒绝）；multi rootId `ceo-${Date.now()}` 同毫秒碰撞（修：自增序号）；`getDelegationTree` 只展开一层（修：递归）；失败节点被跨 root「置 done」洗白（修：failed 状态 + 只遍历本次 root） |
| M5 TRACE 上传验证 | `scripts/verify-trace-upload.mjs` 36 项：真 `node:http` mock + 传输层重写 api.github.com→127.0.0.1（脱敏断言喂真实样串） | **P0**：30s 定时器路径在 `pending<batchSize` 时被批量门控拦截 → 低流量记录永不上传、进程退出即丢（修：定时器/dispose 走 `flushNow`）；`splice` 误删队首未到期项；无 repoUrl/token 静默丢单（修：记录留队列）；明文凭据结构可导入 |
| M6 vendor 修复 | `scripts/vendor-dsh.cjs` 三处修复：DESKTOP 路径少算一级（产物写 `apps/vendor` 而打包配置期望 `apps/desktop/vendor`）；shim `exports` 目标缺 `./` 前缀（require 直接抛 Invalid exports target）；build.files 补 `node_modules/@deepseek-ai/**/*`。重跑后 7 dsh 包 + 9 插件物化，`@deepseek-ai/cordis` 等 require 探测通过 | 前一轮会话遗留的脚本 bug 正是「重跑确认」要抓的问题 |

**验证**：`npm run verify` 扩至 **11 套件 308 项全绿**（EXIT=0）；`tsc -p apps/desktop/tsconfig.json` EXIT=0；`node --check app.js` OK。

**流程产物**：`yt-dev-review` 技能已建（`~/.workbuddy/skills/yt-dev-review/SKILL.md`，实现三方并发审阅 + 交叉修复 + 复验门禁 SOP）。

**遗留（与此前同源门控）**：打包产物 asar 校验（dist:win 进行中）；GUI 实机冒烟（BUG-W02）；真实模型/SubAgent/TRACE 实测（须 API Key、Ollama、GitHub repoUrl+TOKEN）；代码签名；审阅建议中未采纳的低成本项（electron stub 公共化、导出缩进、readJsonFile 下沉）已记录在案。

## BUG-018 修复（2026-08-30 · v0.4.1）

| 事项 | 证据 |
|---|---|
| **问题** | 发消息能响应，要求执行任务（触发 tool_calls）时报「模型返回空内容」。用户截图：provider=STEPFUN、model=step-3.7-flash、apiMode=chat、HTTP 200、finish_reason=stop、content 为空 |
| **根因** | StepFun 等网关在 chat 模式下**接受** `tools`/`tool_choice` 参数（不返 4xx），但实际不返回 `tool_calls`，content 也为空——软拒绝。原代码只在硬 4xx/错误信息含 tool 时降级，空响应被当成最终答案 |
| **修复** | `apps/desktop/main.ts` `callOpenAICompatible`：带 tools 时 200 空内容 → 继续降级到去 `tool_choice` → 去 `tools`；降级成功且拿到非空响应后返回 `toolsRejected=true`。`runAgentTurn` 用进程级 `Map<provider.id\|model, true>` 记忆软拒绝，后续同 provider+model 的会话直接走 `<tool:>` 文本兜底 |
| **附加改进** | 软拒绝路径补 `[softReject]` 模型日志；空内容但去 tools 后仍空时**不**误置 `toolsRejected`，避免把真·空响应误判为网关不支持工具 |
| **验证** | `model-loop-verify.cjs` 新增 M 组 3 项（M1 逐级降级 / M2 文本兜底完成任务 / M3 跨会话记忆）；`npm run verify` 扩至 **11 套件 313 项全绿**；tsc EXIT=0 |
| **审阅** | `yt-dev-review` 三维度并发审阅：质量/效率均指出 toolsRejected 应跨会话持久化（已采纳）；质量指出空响应不应误置 toolsRejected（已采纳）；可复用性指出软拒绝分支缺日志与空白 content fail-open（已补日志；空白 content 边界本次未单独抽函数，留后续） |

## 桌面能力增强：Minke 对照四批（2026-08-31 ~ 2026-09-02 · v0.12.x）

> 同底座同类项目 Minke（lencx/Minke）三路对照分析的吸收批次。分阶段计划与每日细节见 CHECKPOINT 第十二~十六批；本节只登记结构性事实。

| 批次 | 交付 | 裁决/证据 |
|---|---|---|
| P0 工程基建 | TS 直测 loader + 架构守护测试 | [ADR-0010](../70-决策/ADR-0010-ts-direct-test-and-arch-guard.md)：Node ≥22.13 硬要求；PURE_MODULES 登记制 |
| P1 浏览器工具 | 8 工具并入统一工具表（TOOL_DEFS 7→15），Electron 自带 CDP | [ADR-0011](../70-决策/ADR-0011-browser-tools-cdp.md)；真机冒烟 `smoke:browser` 11/11（不进 verify 链） |
| P2-10 终端 PTY | 终端 Tab（多会话、上限 6）：node-pty 多候选加载，全落空显式降级管道 | [ADR-0012](../70-决策/ADR-0012-terminal-pty-and-file-panel.md)：`via:'pty'\|'pipe'` 必须可见；vendor 物化 + asarUnpack |
| P2-11 文件面板（只读） | 懒加载树 + 预览（shiki 精简 bundle，语言探测不到不猜） | 同上；2MB 显式截断、二进制双通道嗅探 |
| P3 文件编辑/diff | 用户亲手编辑/保存/diff，不走授权门 | [ADR-0013](../70-决策/ADR-0013-file-edit-diff.md)：外部修改检测（mtimeMs）+ editable 统一判定 + 原子写回 + EOL 保护 |

**验证规模**：`npm run verify` 11 套件 313 项（BUG-018 批次）→ **24 套件 805 项**（2026-09-02）。提交链：`81d804e`/`d0ab400`（P1）→ `bc07239`/`3661ef9`（P2）→ feat 文件编辑/`9444d61`（P3 文档）。需求侧落点为 [PRD FR-14](../20-需求/PRD.md)；分层与降级口径见 [架构 §10](../10-架构/architecture.md)。

**遗留**：终端/文件面板真机 GUI 冒烟待用户桌面会话（BUG-W02 门控口径不变）；CodeMirror merge 级 diff 已列路线图中期。
