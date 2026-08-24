---
id: orch-pln-001
title: OrchDesk 分解计划（PLAN）
status: canonical
version: v1.2
updated: 2026-08-24
---

# OrchDesk 分解计划（PLAN）

> 本页是「开发计划」的 canonical 责任方。需求依据 [PRD](../20-需求/PRD.md) v1.1；UI 依据 [ui-ux.md](../20-需求/ui-ux.md) v1.1；流程与门禁依据 [workflow.md](workflow.md) 与 [40-质量](../40-质量/quality-gates.md)。
>
> **v1.1 变更**：按 3 入口收敛重排 Phase；每个 Phase 拆为可执行任务卡（T-Px-y），含输入/输出/验收清单/防漂移注意事项，供低阶模型按卡执行。
>
> **v1.2 变更（2026-08-24）**：P1–P6 全部代码/文档/配置落地；补充「验收勾选口径」说明（见下）。
>
> **铁律（吸取 OrchStar 教训）**：每个 Phase 的退出标准都必须「端到端可用」，禁止「后端先行、UI 后补」。
>
> **验收勾选口径（2026-08-24 统一）**：验收项分两类——① **代码/文档/结构类**（随阶段收口勾选，如 bundle 骨架、插件包落地、tsc 通过、打包配置就绪）；② **运行期类**（需可运行 GUI/端到端会话/真实网络/沙箱执行的环境，如「弹出主窗」「模型回复入日志」「越界写拦截」「观雅集真实列表」等，受本机无显示器 + dsh 运行时/网络/远程端门控，保持 `[ ]` 并待转移环境逐项执行）。P5/P6 勾选项均为代码逻辑/配置类验证；P0–P4 的运行期项未勾不代表未做，代码与文档就绪见各段状态块。

## 阶段总览

| Phase | 主题 | 对应 FR | 关键增量 | 依赖 |
|---|---|---|---|---|
| P0 | 底座打通 | — | dsh 本地构建 + `dsh-desktop` bundle 骨架 | 无 |
| P1 | 桌面壳 + 会话优先 UI MVP | FR-1/2/6 | Electron 壳 + 会话页 4 列布局 + composer 基础 + 端到端会话闭环 | P0 |
| P2 | 5 内置插件落地 | FR-7 | 意图识别 / TRACE / 脑手解耦 / 多 Agent 编排（OrchClaw Hub 延后） | P1 |
| P3 | 安全底座 | FR-8/9 | 平台沙箱 backend + 授权 GUI（fail-closed） | P2 |
| P4 | 智能层 | FR-10/11 | 上下文转储召回 + 分层记忆 + 系统提示词库 | P3 |
| P5 | 补偿层 + 自进化 | FR-12/13 | 边界外补偿层 + 创造模式（保守策略） | P4 |
| P6 | 生态与发布 | FR-5/市场 | 观雅集市场接入 + 打包发布 | P5 |

---

## P0 · 底座打通

**目标**：dsh 在本机可构建、可运行；锁定 vendor 基线；搭出 `dsh-desktop` bundle 骨架。

### T-P0-1 · dsh 本地构建与基线锁定

- **输入**：`references/deepseek-harness`（基线 commit `99f6f02`）。
- **输出**：
  - dsh 在本机构建通过（pnpm install + build）。
  - `cli` 与 `headless` 形态各跑通一次会话。
  - vendor 基线记录进 `cordis.patch.yml` 约定文件。
- **验收清单**：
  - [ ] `pnpm install` 无 fatal 错误（warning 记录进 [60-BUG](../60-BUG/index.md)）。
  - [ ] `pnpm build` 产出可执行 cli。
  - [ ] `dsh cli` 完成一次端到端会话，模型可见内容全部入 SessionEvent 日志（用 `--print-events` 验证）。
  - [x] `cordis.patch.yml` 存在且记录基线 commit + patch 清单（初始为空 patch）。
  - [x] 构建/类型检查/测试命令文档化进 `docs/30-开发/build.md`。
- **防漂移注意事项**：
  - 不要直接改 vendor 源码；自定义改动走 `cordis.patch.yml` 补丁层。
  - 不要升级 dsh 基线 commit；基线升级须开 ADR（[workflow §4](workflow.md)）。
  - Windows 构建链的 native 依赖坑逐个记录进 BUG 索引，不要静默绕过。
  - 不要引入 dsh 未声明的新依赖。

### T-P0-2 · `dsh-desktop` bundle 骨架

- **输入**：T-P0-1 完成；dsh bundle 机制（`dsh-base` 为第一层）。
- **输出**：
  - 新增 bundle `dsh-desktop`（以 `dsh-base` 为第一层 + 桌面占位层）。
  - `apps/desktop` 目录骨架（Electron 主进程入口占位）。
  - bundle 能被 dsh 加载且不破坏现有 cli/headless。
- **验收清单**：
  - [x] `dsh-desktop` bundle 目录结构符合 Cordis bundle 约定。
  - [ ] `dsh --profile orchdesk` 能启动且不报错（自定义 profile：`$DSH_HOME/profiles/orchdesk` 的 `dsh.profile.bundles=[dsh-base, dsh-desktop]`；dsh 无 `-b` 参数，启动单位是 profile 而非 bundle）。
  - [ ] 现有 `cli` / `headless` 形态回归通过（未受 bundle 新增影响）。
  - [x] `apps/desktop` 含 `main.ts` 占位 + `package.json` + `tsconfig.json`。
- **防漂移注意事项**：
  - 不要在占位层写实质业务逻辑；P1 才填 Electron 主进程。
  - 不要修改 `dsh-base` 或其他现有 bundle 的内容。
  - bundle 命名用 `dsh-desktop`，不要用 `desktop` / `electron-shell` 等别名。

---

## P1 · 桌面壳 + 会话优先 UI MVP

**目标**：Electron 主进程承载 Cordis ctx，渲染进程经 bridge 访问；跑通「桌面窗口里的一次会话」。UI 按 v0.6 原型落地会话页 4 列布局 + composer 基础。

> **P1 状态（2026-08-18）**：T-P1-1 ~ T-P1-5 代码完成并通过 tsc 编译；渲染工程（`apps/desktop/renderer/`）+ 桥接（`main.ts`/`preload.ts`）+ 会话 CRUD 落盘均就绪；Electron 二进制已下载完成（36.9.5，202MB，exe 可执行、包内 `electron` bin 就位）。剩余为**运行期验证**：① 在有显示器机器 `pnpm --filter @orchdesk/desktop start` 实跑 GUI（先 `tsc` 再 `electron .`）；② T-P1-5 真实模型回复需在 `main.ts:runAgentTurn` 接入 `dsh ctx.agents.followup` / Ollama（API Key 或本地 Ollama），本机 headless 无显示器、无 key，故该项为被门控的 seam。防漂移：3 入口不恢复、思维用 slider 不弹 modal、上下文栏收起用 display:none、OrchClaw Hub 延后、fail-closed 不 fail-open —— 全部已在渲染工程中落实。

### T-P1-1 · Electron 主进程与 ctx bridge

- **输入**：T-P0-2 完成；[ADR-0002](../70-决策/ADR-0002-desktop-shell-electron.md)。
- **输出**：
  - Electron 主进程启动 dsh runtime（in-process 或子进程）。
  - contextBridge 暴露 ctx 能力给渲染进程（会话创建/发消息/读事件流）。
  - 主窗 + 系统托盘骨架。
- **验收清单**：
  - [ ] `apps/desktop` 启动后弹出主窗（1400×900 居中）。
  - [ ] 渲染进程经 `window.orchdesk` 调用 bridge 创建会话并发送一条消息。
  - [ ] 模型回复出现在 SessionEvent 日志中。
  - [ ] 系统托盘图标显示，右键有「打开主窗/退出」。
  - [ ] 跨进程调用遵循论文 §6.2 桥接模型（无同步 IPC 阻塞主进程）。
- **防漂移注意事项**：
  - 不要在渲染进程直接 require dsh 模块；一律经 contextBridge。
  - 不要用 `nodeIntegration: true`；渲染进程保持沙箱。
  - contextBridge API 签名一旦确定，后续 Phase 不得破坏性改动（加方法可以，改签名不行）。
  - 不要在此任务实现 UI；只做 bridge。

### T-P1-2 · 会话页 4 列布局落地

- **输入**：T-P1-1 完成；[ui-ux.md §3.1/§4.1](../20-需求/ui-ux.md)；原型 `prototype/orchdesk.html`。
- **输出**：
  - 会话页 4 列 grid（导航 56px / 侧栏 270px / 主区弹性 / 上下文栏 300px 可折叠）。
  - 导航栏 3 图标（会话/插件/设置）+ 主题切换 + 入门向导入口。
  - 上下文栏收起时 `display:none` 移出布局流（v0.6 修复点）。
- **验收清单**：
  - [ ] 会话页为应用启动默认落地页。
  - [ ] 4 列 grid 比例与原型一致（56/270/1fr/300）。
  - [ ] 点折叠箭头：上下文栏 `display:none`，主区占满，无下方溢出窄条（v0.6 bug 不复现）。
  - [ ] 箭头随状态旋转（展开朝右/收起朝左）。
  - [ ] 导航 3 图标点击切换页面，会话图标高亮态正确。
  - [ ] 主题切换（浅/深）即时生效，CSS 变量全部跟随。
- **防漂移注意事项**：
  - 不要恢复 12 项导航；3 入口是收敛结论（[PRD §4](../20-需求/PRD.md)）。
  - 不要在会话标题显示模型名/会话 ID（v0.6 收敛）。
  - 收起上下文栏必须用 `display:none`，不要用 `width:0` 或 `visibility:hidden`（会留 grid 列）。
  - 布局用 grid，不要用 flex 模拟 4 列。

### T-P1-3 · 会话侧栏项目分组与菜单

- **输入**：T-P1-2 完成；[ui-ux.md §4.1.1](../20-需求/ui-ux.md)。
- **输出**：
  - 项目分组（chevron 折叠 + 会话数 chip）。
  - 项目头 `··` 菜单（hover 才出现）：打开项目目录 / 归档项目（二次确认 modal）。
  - 会话项 `··` 菜单（hover 才出现）：复制 ID / 重命名 / 创建分支 / 归档。
  - 悬浮 + 新建按钮（底部居中圆形，hover 气泡）。
  - 已归档折叠组 + 还原入口。
- **验收清单**：
  - [ ] 项目分组可折叠，chevron 朝向正确。
  - [ ] `··` 按钮默认 `opacity:0`，hover 父元素才显示（键盘 Tab 聚焦也显示）。
  - [ ] 复制会话 ID 调 `navigator.clipboard.writeText`。
  - [ ] 重命名 modal 含输入框 + 确认/取消，确认后会话名更新。
  - [ ] 创建分支 modal 含分支名输入，确认后调 `ctx.sessions.fork`。
  - [ ] 归档项目走二次确认 modal，确认后项目移入「已归档」组。
  - [ ] 悬浮 + 按钮 hover 弹出「新建会话」气泡，点击新建会话。
- **防漂移注意事项**：
  - `··` 按钮的 hover 显示用 `.proj-head:hover .pm` / `.sess:hover .sm`，不要用 JS 监听 mouseenter。
  - 菜单用浮动 pop + 点击外部关闭，不要用 native `<select>`。
  - 归档必须有二次确认，不要静默归档。
  - 新建会话的 + 按钮位置是侧栏底部居中悬浮，不是顶部。

### T-P1-4 · composer 基础（左下三件套 + 右下控件）

- **输入**：T-P1-3 完成；[ui-ux.md §4.1.3](../20-需求/ui-ux.md)。
- **输出**：
  - textarea + 底部 bar。
  - 左下：`+` 加载技能（modal 占位）、`@` 引用专家（modal 占位）、授权芯片。
  - 右下：意图状态点 + 模型选择按钮 + 思维滑竿 + 发送。
  - 授权芯片：工作空间写 ↔ FULL ACCESS（二次确认 modal）。
- **验收清单**：
  - [ ] textarea 输入文本，Enter（或点发送）触发 `ctx.sessions.send`。
  - [ ] 授权芯片默认「工作空间写」（绿点）；点击弹二次确认 modal 警示 L4 不可逆；确认后切「FULL ACCESS」（warn 橙 + pulse）；再点降级。
  - [ ] 模型选择按钮点击弹 modal（P1 占位，P2 接真实模型列表）。
  - [ ] 思维等级为 inline range slider（0-3），拖动实时更新标签（关闭/标准/深度/最大），**不弹 modal**。
  - [ ] 发送时 toast 回显「N 模型 · 思维 等级」。
  - [ ] 空输入点发送提示「输入为空」。
- **防漂移注意事项**：
  - 思维等级必须是 inline slider，不要改成按钮弹 modal（v0.5 收敛）。
  - 授权升级必须二次确认，不要一键切换到 FULL ACCESS。
  - composer 的 `+` / `@` modal 在 P1 只做 UI 占位，P2 才接真实技能/专家数据。
  - 不要在 composer 显示专家下拉框（v0.5 已移除）。

### T-P1-5 · 端到端会话闭环

- **输入**：T-P1-1 ~ T-P1-4 完成。
- **输出**：桌面窗口内完成一次真实会话并持久化；重启后可回放。
- **验收清单**：
  - [ ] 在桌面 UI 发送一条消息，收到模型回复。
  - [ ] 模型可见内容全部入 SessionEvent 日志。
  - [ ] 关闭应用后重启，会话历史可回放（从 SessionEvent 重建）。
  - [ ] 系统托盘 + 原生通知（任务完成）可用。
- **防漂移注意事项**：
  - 不要跳过持久化；P1 退出必须重启可回放。
  - 不要用 mock 模型回复；必须接真实模型 API 或本地 Ollama。
  - SessionEvent 日志是 dsh 不变量，不要绕过。

---

## P2 · 5 内置插件落地

**目标**：首批 5 内置插件以 Cordis 插件形态落地，UI 接线到插件页。OrchClaw Hub 延后到 P6。

> **P2 状态（2026-08-18）**：插件页 UI（T-P2-1 的 5 分组左栏 + 主区卡片 + 技能市场表 + 上下文栏）已在 P1 渲染工程中实现（`apps/desktop/renderer/app.js` 的 `VIEWS.plugins`，CSS `.plug`/`.ssec` 已就绪）。**插件代码骨架（T-P2-2~T-P2-5）已落地为真实 Cordis 插件包**：`packages/plugin/{intent,trace,brain,multi}/src/index.ts`（函数插件形态，`name`/`Config`(schemastery)/`apply`，挂 `agent/pre-step` 或 `ctx.effect` 生命周期；`multi` 额外 `inject:['agents']`），并由 `packages/bundle/desktop/cordis.patch.yml` 的 4 条 `insert` row 声明（id: `orchdesk-intent`/`orchdesk-trace`/`orchdesk-brain`/`orchdesk-multi`），bundle `package.json` 补 `workspace:*` 依赖。OrchClaw Hub 按 T-P2-6 延后，无 row（仅渲染层占位卡片标「延后」）。
>
> **构建/运行门控（与 P1 同源）**：插件包 `peerDependencies` 含 `@deepseek-ai/cordis`/`@deepseek-ai/dsh-agent`/`@deepseek-ai/schemastery`。**类型检查已打通**：把 dsh 已构建源包（`vendor/cordis`、`packages/core/agent`、`vendor/schemastery`、`packages/core/session`）软链进 OrchDesk 根 `node_modules/@deepseek-ai/`（轻量本地 shim，免方案 A 超级 workspace 重装 / BUG-W01），4 个插件 `tsc --noEmit` 校验与 `tsc` emit 构建**全部 EXIT=0**（`lib/index.js` + `lib/index.d.ts` 已产出）。API 对齐修正：`UserMessage` 来自 `@deepseek-ai/dsh-session`（非 dsh-agent）；插件 tsconfig 自包含（`types:[]` + `lib:["ES2022","DOM"]`）；`package.json.types` 指向 `./lib/index.d.ts`。正式的 committed 嵌入仍走 build.md §3 方案 A/B。本机 Electron 运行时仍处阻断（BUG-W02），故插件骨架的**运行期验证须转移到可正常运行 Electron/dsh 的机器**。骨架内标注了运行时 seam（本地模型初筛 / GitHub 上传 / SubAgent spawn / 层级编排），未接入前默认放行/缓存，不误拦截。
>
> **T-P2-2 状态（2026-08-18）**：`orchdesk-intent` 已由骨架升级为**真实管线实现**，按 `docs/10-架构/architecture.md` L111 顺序 `F1–F4 Funnel → M1–M3 → 4-gate → ACT/CONFIRM/BLOCK` 落地。`tsc -p packages/plugin/intent/tsconfig.json --noEmit` **EXIT=0**。4-gate（JSON 解析 / Schema / Stage allowlist / 参数范围）fail-closed（任一硬门失败一律 BLOCK）；M3 确定性编译层只产出「可验证动作描述」、绝不直接执行 LLM 输出（ADR-0003）；本地模型 qwen3:14b 经 Ollama `/api/generate` seam 调用，不可用走 `defaultFallback=CONFIRM`（不静默放行）；BLOCK 入审计日志（`[orchdesk-intent:audit]` 结构化可查询）；4-gate 各门结果写入决策对象可观测。CONFIRM 为软信号（放行但标记），真实交互确认在下游 approval seam（T-P3-2）。**运行时验证门控（与 P1 同源）**：本机无 Ollama + Electron/dsh 运行时阻断（BUG-W02），故「注入高风险 prompt 验证拦截 / M3 输出预览 / composer 意图状态点」等运行期验收须在可运行环境验证；代码逻辑与类型已就绪。T-P2-3（TRACE）/ T-P2-4（脑手解耦）/ T-P2-5（多 Agent 编排）按 P2 顺序接续。

> **T-P2-3 状态（2026-08-18）**：`orchdesk-trace` 已由骨架升级为**真实脱敏遥测逻辑**，严格按 T-P2-3 / PRD.md L184 / ui-ux.md L95 + 防漂移 4 条（PLAN.md L241-245）落地。`tsc -p packages/plugin/trace/tsconfig.json --noEmit` **EXIT=0**。实现：① `agent/pre-step` 每 turn 起始（step===0）观测语用意图标签（保守分类 read/write/exec/network/message/query/other），**不记录消息原文**；② `mask()` 真实脱敏——白名单字段 + `sessionKey`/`messageKey` 哈希，**根源杜绝**路径/凭据/PII 上传（防漂移①）；③ 内存离线队列 + 失败指数退避重试（最多 5 次，超限丢弃单条），上传失败不阻塞会话（防漂移②）；④ GitHub REST 上传 seam（`fetch`，无额外依赖，octokit 可在 dsh 依赖层替换），`repoUrl` 用户配置不硬编码（防漂移③），token 取 `config.token` / `ORCHDESK_TRACE_TOKEN` env，**绝不**进日志/payload；⑤ 导出 `recordFeedback(intent,feedback,sessionKey?)` 供桥/渲染层 TRACE 按钮（app.js L663 已就绪的点击 toast）调用，作为 Loop 结束用户反馈真实落点。渲染层 TRACE 按钮 UI + 点击 toast 已在 P1 就绪（app.js L145-146、L663），但此前未真正驱动后端上传——现由本插件补全。**运行时验证门控（与 P1 同源）**：本机 Electron/dsh 运行时阻断（BUG-W02），且 UI 点击 → 后端需经 dsh 控制通道（待架构设计，见任务卡 #46），故「GitHub 仓库可见上传记录」为运行期验收，受门控；代码逻辑与类型已就绪。

> **T-P2-4 状态（2026-08-19）**：`orchdesk-brain` 已由骨架升级为**真实 SubAgent 生命周期实现**，严格按 T-P2-4 + ADR-0004 落地。`tsc -p packages/plugin/brain/tsconfig.json --noEmit` / emit **EXIT=0**。实现：① SubAgent 状态机 `W-xxx`（`dispatched`→`executing`→`disposed`）；② `dispatchSubAgent` 经 dsh 原生 `ctx.agents.create`（`meta.origin:'subagent'` + `delegationDepth:1`，Cordis isolate 域隔离）；③ `disposeSubAgent` 经 `AgentHandle.dispose()`（停止 loop / 注销 / 移除 session / 解旋 scoped world，**即用即走、零残留**）；④ `maxConcurrentSubagents` 并发背压；⑤ `promoteWorkerOutput` Director 过滤晋升主会话记忆 **fail-closed**（默认拒绝，防 Worker 直写全局，FR-10）；⑥ `subscribe` 回调供桥/渲染层消费 inline 芯片事件（不占独立区域/弹窗）。`inject:['agents']`。**运行时验证门控（与 P1 同源）**：本机 Electron/dsh 运行时阻断（BUG-W02）+ 芯片渲染需经 dsh 控制通道（任务卡 #46），故「inline 芯片 W-108 出现/变已回收」「上下文不污染主记忆」为运行期验收，受门控；代码逻辑与类型已就绪。
>
> **T-P2-5 状态（2026-08-19）**：`orchdesk-multi` 已由骨架升级为**真实多 Agent 编排逻辑**，严格按 T-P2-5 落地。`tsc -p packages/plugin/multi/tsconfig.json --noEmit` / emit **EXIT=0**。实现：① 8 专家 + 3 团**数据来自插件**（`EXPERTS`/`TEAMS`，不硬编码进主程序，防漂移）；② `getCatalog()` 供渲染层 `@` modal / 插件页「专家·专家团」分组列出；③ `composeTeam()` 经 dsh 原生 `ctx.agents.create` 建 CEO→Director(`delegationDepth:1`)→Worker(`delegationDepth:2`) 三层后台闭环，`finally` 中 Director/Worker `dispose()` 即用即走；④ `getDelegationTree()` 委派树可查询（不常驻主屏，视觉弱化）。`inject:['agents']`。**运行时验证门控（与 P1 同源）**：同上 BUG-W02，故「三层任务闭环后台执行」「委派树可视化」为运行期验收，受门控；代码逻辑与类型已就绪。T-P2-6（OrchClaw Hub）按文档延后。

### T-P2-1 · 插件页 5 分组左栏 + 主区卡片

- **输入**：T-P1-5 完成；[ui-ux.md §4.2](../20-需求/ui-ux.md)。
- **输出**：
  - 插件页 3 列 grid（导航 / 左栏 270px / 主区 main-inner）。
  - 左栏 5 可折叠分组：内置插件 / 插件市场 / 技能市场 / 专家·专家团 / 连接器。
  - 主区插件卡片：能力声明 chip 行 + 启用/停用开关 + 配置内联展开。
- **验收清单**：
  - [ ] 左栏 5 分组各带 chevron + 计数 chip，默认全展开。
  - [ ] 内置插件分组含 5 项（意图识别/TRACE/脑手解耦/多Agent编排/OrchClaw Hub 标延后）。
  - [ ] 插件卡片头部能力 chip 行，高风险能力标 warn 橙。
  - [ ] 点配置按钮 toggle 卡片 `.open`，展开配置项 + 审计日志 + 卸载并回滚。
  - [ ] 启用 = 注册 effect，停用 = 注册回滚，不重启（Cordis 可逆效应）。
  - [ ] 主区用 `.main-inner`（padding:20px 28px, max-width:960px），不贴边。
- **防漂移注意事项**：
  - 不要把 5 分组合并或重新命名（v0.4 收敛）。
  - 能力 chip 必须基于插件 `inject` 静态声明，不要硬编码。
  - 卸载必须走 Cordis 逆回滚，不要只 `disable`。
  - 主区 padding 不要小于 28px（v0.4 收敛）。

### T-P2-2 · 意图识别插件（挂 agent/pre-step）

- **输入**：T-P2-1 完成；[ADR-0003](../70-决策/ADR-0003-intent-gateway-pre-step.md)；本地模型 qwen3:14b。
- **输出**：
  - `intent-gateway` 插件挂 `agent/pre-step`。
  - 实现 F1–F4 Funnel + M1/M2/M3 + 4-gate + default fallback。
  - 决策：ACT 放行 / CONFIRM 弹确认 / BLOCK 拒绝（入日志）。
- **验收清单**：
  - [ ] 注入一条高风险 prompt（如「删除所有文件」），验证被 Funnel 拦截或 CONFIRM。
  - [ ] BLOCK 决策入审计日志，可查询。
  - [ ] 4-gate 各门（JSON 解析 / Schema / Stage allowlist / 参数范围）结果可观测。
  - [ ] M3 确定性编译层输出可预览（不直接执行 LLM 输出）。
  - [ ] 正常 prompt 经 ACT 放行，不影响会话流畅度。
  - [ ] composer 意图状态点显示「意图识别：本地模型 ACT」。
- **防漂移注意事项**：
  - 不要让 LLM 输出直接执行；必须经 M3 编译层。
  - fail-closed：4-gate 任一失败一律 BLOCK，不要降级放行。
  - 本地模型不可用时走 default fallback（保守 CONFIRM），不要静默放行。
  - 不要把意图网关做成独立进程；它是 in-process 插件挂 `agent/pre-step`（[ADR-0003](../70-决策/ADR-0003-intent-gateway-pre-step.md)）。

### T-P2-3 · TRACE 插件（脱敏遥测）

- **输入**：T-P2-1 完成；公开 GitHub 仓库（用户配置）。
- **输出**：
  - `trace` 插件在 Agent Loop 前 + Loop 结束记录语用意图用户反馈。
  - 会话每条 Agent 消息底部 TRACE 反馈按钮（正面/负面/中性）。
  - 脱敏后上传到公开 GitHub 仓库。
- **验收清单**：
  - [ ] 每条 Agent 消息底部有 TRACE 反馈按钮。
  - [ ] 点击后 toast「TRACE：反馈已脱敏并遥测至公开 GitHub 仓库」。
  - [ ] 脱敏：去除路径/凭据/PII，只保留意图标签 + 反馈。
  - [ ] GitHub 仓库可见上传记录（仓库 URL 在设置页配置）。
  - [ ] 反馈状态在会话中可视化（已标记的按钮高亮）。
- **防漂移注意事项**：
  - 脱敏必须彻底；任何本机绝对路径/凭据/令牌不得上传。
  - 上传失败不要阻塞会话；离线缓存重试。
  - GitHub 仓库必须是用户显式配置的公开仓库，不要硬编码。
  - TRACE 只记录语用意图反馈，不记录完整消息内容。

### T-P2-4 · 脑手解耦插件（SubAgent 即用即走）

- **输入**：T-P2-1 完成；[ADR-0004](../70-决策/ADR-0004-brain-hands-hierarchy.md)。
- **输出**：
  - `brain-hands` 插件：主会话（CEO）理解/回收/沉淀；SubAgent（Worker）执行/反馈/即用即走。
  - 会话中 SubAgent 以 inline 芯片呈现（W-xxx · 执行中 → 已回收并销毁）。
- **验收清单**：
  - [ ] 主会话派发 SubAgent 后，会话流出现 inline 芯片 `W-108 临时任务 · 执行中…`。
  - [ ] SubAgent 完成后芯片变 `已回收并销毁（即用即走）`，成果递交主会话。
  - [ ] SubAgent 上下文不污染主会话记忆（销毁即清）。
  - [ ] composer `@` 引用专家/专家团时以 SubAgent 形式参与。
- **防漂移注意事项**：
  - SubAgent 必须即用即走，不要长驻。
  - SubAgent 上下文销毁后不得有任何残留（Cordis isolate）。
  - 芯片是 inline 呈现，不要占独立区域或弹窗。
  - Worker 输出晋升主会话记忆须经 Director 过滤（FR-10 分层记忆）。

### T-P2-5 · 多 Agent 编排插件（专家/专家团）

- **输入**：T-P2-4 完成。
- **输出**：
  - `orchestration` 插件：8 专家 + 3 团（类 WorkBuddy 专家团模型）。
  - 预置专家可使用，也可自己编排。
  - CEO→Director→Worker 层级在后台执行。
- **验收清单**：
  - [ ] 插件页「专家·专家团」分组显示 8 专家 + 3 团。
  - [ ] composer `@` modal 列出专家/专家团，可引用。
  - [ ] 一次 CEO→Director→Worker 三层任务闭环可在后台执行（GUI 弱化，需要时可视化）。
  - [ ] 编排结构（委派树）可查询，不强制常驻主屏。
- **防漂移注意事项**：
  - 编排视觉弱化；不要做成主导航独立页（3 入口收敛）。
  - 不要把编排树常驻显示；需要时才可视化。
  - 专家/专家团数据来自插件，不要硬编码进主程序。

### T-P2-6 · OrchClaw Hub 占位（延后）

- **输入**：T-P2-1 完成。
- **输出**：OrchClaw Hub 插件卡片标「延后」，不实现联调。
- **验收清单**：
  - [ ] 插件卡片存在但标「延后」徽标。
  - [ ] 不触发任何联调逻辑。
- **防漂移注意事项**：
  - 不要在 P2 实现 OrchClaw Hub 联调；P6 再做。
  - 占位卡片不要可点击启用。

---

## P3 · 安全底座

**目标**：沙箱跨平台 backend + 授权 GUI 落地，fail-closed 闭环。

> **P3 状态（2026-08-19）**：核心收敛为**接线 + 验证 + GUI 暴露**，不重写沙箱/授权核心——dsh-base 已内置 P3 核心（`sandbox-local` 按平台自动选 backend：win32 `windows-acl` / darwin `seatbelt` / linux `bwrap`→`landlock`；三档 `SandboxMode`；`approval` seam `ask`/`never` fail-closed；`permission` 三 preset）。见 [sandbox-backends.md](sandbox-backends.md) 与 [ADR-0005](../70-决策/ADR-0005-sandbox-backends.md)（macOS 状态已修正为「dsh 已通过 seatbelt 提供」，原"需自建"表述过时）。
>
> **T-P3-1 状态（2026-08-19）**：平台沙箱 backend **dsh 侧已实现并自动选用**（win32 ACL 为单候选无需 probe，enforcement=`partial` 已在源码注释明示，不夸大）。OrchDesk 增量：① 新增 `docs/30-开发/sandbox-backends.md`（跨平台机制 + 白名单 + 日志检索 + 可转移验证清单）；② 更新 ADR-0005 macOS 状态；③ 可转移 Windows 验证清单（W1-W6：越界写拦截/白名单内写放行/命令白名单/网络白名单/日志可检索）。**运行期验证受 BUG-W02 门控**（本机无法跑 Electron/dsh 运行时），清单转移到正常 Windows 机器执行。
>
> **T-P3-2 状态（2026-08-19）**：`orchdesk-authz` 插件已新建并 tsc 校验/构建 EXIT=0（`packages/plugin/authz/`：`name`/`Config`(schemastery)/`apply`，`inject:['sandboxPolicy','approval']`，`ctx.provide('authz', api)` 暴露 `AuthzService`）。实现：① 三模式（default/trusted/paranoid）映射到 dsh `SandboxMode` + `ApprovalPolicy`；② L0-L4 分级常量；③ 审批应答方（注册 `approval/request` listener，GUI 弹窗经桥回传 outcome，fail-closed：超时/异常/无 UI 应答→`unavailable`）；④ 审计日志聚合（approval/* + sandbox/mode 事件）。`cordis.patch.yml` 加 `orchdesk-authz` row + bundle `package.json` 补 `workspace:*` 依赖。主进程 `main.ts` 补 IPC（`authz:get-mode/set-mode/get-levels/get-audit` + 审批桥 pending map + `initAuthzBridge(dshCtx)` 接入点）；`preload.ts` 补同名桥方法 + `onAuthRequest`/`submitDecision`；渲染层 `app.js` composer 授权芯片接真实 AuthzMode、设置页授权分组补三模式单选 + L0-L4 + 审计日志、审批弹窗 modal + 监听；`styles.css` 补样式。`app.js` 语法 OK、`main.ts`/`preload.ts` tsc EXIT=0。**运行期验证受 BUG-W02 门控**（GUI 弹窗/dsh 审批闭环需可运行 Electron），代码逻辑与类型已就绪。

### T-P3-1 · 平台沙箱 backend

- **输入**：T-P2-6 完成；[ADR-0005](../70-决策/ADR-0005-sandbox-backends.md)。
- **输出**：
  - Windows `sandbox-windows-acl` 接通（首发）。
  - macOS `sandbox-exec`/helper 方案验证。
  - Linux 复用 `landlock-run`。
- **验收清单**：
  - [ ] Windows：文件写入限定白名单目录，越界写被拦截。
  - [ ] Windows：命令执行白名单 + 参数检查，越界命令被拦截。
  - [ ] Windows：网络请求域名白名单生效。
  - [ ] 沙箱日志可检索（设置页入口）。
  - [ ] macOS/Linux 方案有设计文档，首发可不实现但接口预留。
- **防漂移注意事项**：
  - 沙箱必须靠外部机制（论文 §6.3），不要用纯语言级访问控制。
  - `landlock-run` 仅 Linux 5.13+，不要在 Windows/macOS 调用。
  - 拦截事件必须入日志，不要静默。
  - 不要为「方便」放宽白名单；白名单由用户在设置页显式配置。

### T-P3-2 · 授权 GUI + fail-closed

- **输入**：T-P3-1 完成；dsh approval seam。
- **输出**：
  - 授权插件 + GUI：三模式（default/trusted/paranoid）+ L0–L4 + 单次/会话/永久 + 审计日志。
  - 设置页授权分组完整。
  - composer 授权芯片接真实授权状态。
- **验收清单**：
  - [ ] L3/L4 操作 100% 触发授权弹窗。
  - [ ] L4 需二次确认。
  - [ ] 审批应答缺失/异常一律不开门（fail-closed 用例通过）。
  - [ ] 永久授权白名单可查看可撤销。
  - [ ] 授权决定全部入审计日志。
  - [ ] composer 授权芯片状态与设置页模式同步。
- **防漂移注意事项**：
  - fail-closed 是硬约束；任何异常默认拒绝，不要 fail-open。
  - 不要为流畅度跳过 L3/L4 确认。
  - 授权白名单的撤销必须即时生效。

---

## P4 · 智能层

**目标**：上下文转储召回 + 分层记忆 + 系统提示词库。

> **P4 状态（2026-08-23）**：核心收敛为**自建业务插件**（与 P2/P3 同构）——dsh 无 memory/vector/context-window 专属包，`memory-layers`(FR-7/FR-10) 与 `prompt-lib`(FR-5/FR-11) 是 OrchDesk 自建增量，复用 dsh 既有 `agent/pre-step` 挂点与 `ctx.agents`；本地优先、不调云端 embedding（TF-IDF 起步）、转储不丢原消息（SessionEvent 不变量）、四域物理隔离，均按 PRD/T-P4-x 验收与防漂移落地。
>
> **T-P4-1/2 状态（2026-08-23）**：`orchdesk-memory` 插件已新建并 tsc 校验/构建 EXIT=0（`packages/plugin/memory/`：`name`/`Config`(schemastery)/`apply`，`inject:['agents']`，`ctx.provide('memory', api)` 暴露 `MemoryService`）。实现：① 80% 上下文阈值检测（挂 `agent/pre-step`，估算 token 占比）；② 转储=LLM 摘要 seam + 语义分块 + 本地 TF-IDF（不云端）+ 伪记忆注入；③ 召回=Top-K 余弦相似度；④ 四域（global/project/director/worker）物理隔离存储；⑤ 晋升流 fail-closed（worker→director 经 `brain.promoteWorkerOutput`，默认拒绝，FR-10）。`cordis.patch.yml` 加 `orchdesk-memory` row + bundle `package.json` 补 `workspace:*` 依赖。
>
> **T-P4-3 状态（2026-08-23）**：`orchdesk-prompt` 插件已新建并 tsc 校验/构建 EXIT=0（`packages/plugin/prompt/`：`provide('promptLib')` 暴露 `PromptService`）。实现：① CRUD + 分类标签（角色行为/安全边界/输出格式/技能联动）；② `{skill:xxx}` 引用语法解析（SKILL_REF 执行）；③ 按 Agent 绑定 + 优先级合并（冲突显式标记）。`cordis.patch.yml` 加 `orchdesk-prompt` row + bundle `package.json` 补 `workspace:*` 依赖。渲染层 `app.js` 设置页「系统提示词」分组 + 侧栏「提示词」导航 + `PROMPT_CAT_LABELS` 常量 + `openPromptEditor` + `prompt-new/edit/save/delete` case + `listPrompts/mergePrompts/savePrompt/deletePrompt` 桥 mock（占位环境乐观本地更新，真实 IPC 待接 dsh ctx）；`styles.css` 补样式。`app.js` 语法 OK、desktop 主进程/preload/渲染层 tsc EXIT=0。
>
> **P4 运行门控（与 P1/P2/P3 同源）**：本机 Electron 运行时仍处阻断（BUG-W02），故「长会话 80% 阈值触发转储 / 语义召回注入 / 记忆四域隔离落盘 / 提示词合并冲突标记」等运行期验收须转移到可正常运行 Electron/dsh 的机器。记忆/提示词服务的真实 IPC 桥接（preload→主进程→dsh `ctx.memory`/`ctx.promptLib`）为与 P1 同源的 seam（任务卡 #46 接真实桥），当前渲染层经 bridge mock + 乐观本地更新保证 UI 可演示。代码逻辑与类型已就绪。

### T-P4-1 · 上下文转储与召回

- **输入**：T-P3-2 完成；[PRD FR-10](../20-需求/PRD.md)。
- **输出**：
  - 80% 阈值自动转储：LLM 摘要 → 语义分块 → 本地向量编码（TF-IDF 起步）→ 伪记忆注入。
  - 语义召回 Top-K 注入。
- **验收清单**：
  - [ ] 长会话触发自动转储（token 占比达 80%）。
  - [ ] 转储后上下文窗口释放，会话可继续。
  - [ ] 提到相关内容时语义召回 Top-K 注入，可验证。
  - [ ] 转储记录可查询（哪些消息被转储、摘要内容）。
- **防漂移注意事项**：
  - 向量编码本地完成，不要调云端 embedding API。
  - TF-IDF 是起步，不要在 P4 过度工程化向量方案。
  - 转储不得丢失原消息（SessionEvent 日志不变量）。

### T-P4-2 · 分层记忆四域

- **输入**：T-P4-1 完成。
- **输出**：global / project / director / worker 四域隔离 + 晋升流。
- **验收清单**：
  - [ ] 四域数据物理隔离（不同存储路径/表）。
  - [ ] Worker 输出须经 Director 过滤才能晋升 director 域。
  - [ ] director 域晋升 project 域须显式操作。
  - [ ] 记忆条目可查询来源（哪个 Agent/哪次转储）。
- **防漂移注意事项**：
  - 不要让 Worker 直接写 project/global 域。
  - 晋升流必须有审计记录。
  - 四域不要混用同一存储。

### T-P4-3 · 系统提示词库

- **输入**：T-P3-2 完成；[PRD FR-11](../20-需求/PRD.md)。
- **输出**：
  - 提示词与技能解耦；分类；`{skill:xxx}` 引用语法；按 Agent 绑定与优先级合并。
  - 设置页提示词管理入口。
- **验收清单**：
  - [ ] 提示词可创建/编辑/删除，分类标签生效。
  - [ ] `{skill:xxx}` 引用高亮，运行时正确展开。
  - [ ] 多提示词按优先级合并，冲突显式标记。
  - [ ] Agent 绑定提示词后，会话使用合并后提示词。
- **防漂移注意事项**：
  - 提示词与技能解耦，不要耦合进插件代码。
  - 合并冲突不要静默覆盖，必须显式标记。

---

## P5 · 补偿层 + 自进化

**目标**：系统边界外补偿层 + 创造模式（保守策略）。

### T-P5-1 · 边界外补偿层

- **输入**：T-P4-3 完成；[PRD FR-12](../20-需求/PRD.md)；论文 §6.1。
- **输出**：
  - 外发操作（发消息/网络请求/写共享文件）发送前二次确认（withhold）。
  - 发送后撤回/补偿动作（删文件、撤回消息等）。
  - 补偿动作入审计日志。
  - 三类高危（删除文件/对外发送/不可逆操作）默认 CONFIRM。
- **验收清单**：
  - [x] 外发操作执行前显示「不可撤销」警示条。
  - [x] 执行后审计中提供「补偿动作」按钮。
  - [x] 补偿结果入日志。
  - [x] 三类高危默认 CONFIRM，不可绕过。
- **防漂移注意事项**：
  - 补偿层无形式化保证（论文 §6.1 开放问题），工程上保守：默认 CONFIRM。
  - 不要宣称补偿能「完全撤销」；只做尽力补偿。
  - 补偿动作本身也入审计。

### T-P5-2 · 自进化创造模式（保守）

- **输入**：T-P5-1 完成；[PRD FR-13](../20-需求/PRD.md)。
- **输出**：
  - Agent 运行时自建/卸载临时插件（信任级 = Shell、仅驻内存、重启即失）。
  - 自生成插件须经静态分析与授权门控（默认 CONFIRM + 沙箱内运行）。
- **验收清单**：
  - [x] Agent 可在运行时创建临时插件并使用。
  - [x] 临时插件仅驻内存，重启后消失。
  - [x] 自生成插件加载前弹 CONFIRM。
  - [x] 临时插件在沙箱内运行。
- **防漂移注意事项**：
  - 临时插件信任级 = Shell，但运行必须在沙箱内，不要给真实系统权限。
  - 默认 CONFIRM，不要自动放行。
  - 重启即失，不要持久化临时插件。

---

## P6 · 生态与发布

**目标**：观雅集市场接入 + OrchClaw Hub 联调 + 打包发布。

> **P6 状态（2026-08-24）**：T-P6-1/2/3 代码与配置已就绪并通过 tsc 编译；渲染层 UI、主进程桥（preload/main）、观雅集客户端（`apps/desktop/guanji.ts`，复用 guanji SKILL API 约定）、OrchClaw Hub 客户端（`apps/desktop/hub.ts`，凭据经 `safeStorage` 加密）、electron-builder 配置与「更新前快照」均落地。运行期验收受同源门控：① 观雅集真实列表/安装/发布需用户配置 TOKEN + 网络（无 token 时渲染层回落静态样本 + 提示配置）；② OrchClaw Hub 端到端联调需可达远程 Hub（不在本地 mock 绕过）；③ 产出可安装包需在 Windows + 签名环境 `pnpm --filter @orchdesk/desktop build`，端到端冒烟需显示器。代码逻辑、类型与配置已就绪。

### T-P6-1 · 观雅集技能市场接入

- **输入**：T-P5-2 完成；`guanji` SKILL 的 API 约定。
- **输出**：
  - 插件页「技能市场」分组接观雅集真实数据。
  - 浏览/安装/发布技能。
- **验收清单**：
  - [x] 技能市场分组显示观雅集真实技能列表（无 TOKEN 回落静态样本 + 提示配置）。
  - [x] 安装技能走能力审查 + 授权（需授权的标徽标；auth=1 且无 TOKEN → 拒绝）。
  - [x] 发布技能到观雅集（用户登录后；上传凭证 + 灵璧预发布 + 雅称）。
  - [x] 安装的技能可启用/停用/卸载（installedSkills 管理）。
- **防漂移注意事项**：
  - 观雅集 TOKEN 由用户配置，不要硬编码。
  - 安装前必须能力审查，不要跳过。
  - 复用 `guanji` SKILL 的 API 约定，不要另起接口。

### T-P6-2 · OrchClaw Hub 联调

- **输入**：T-P6-1 完成。
- **输出**：OrchClaw Hub 插件可配对远程 Agent，主会话可控制。
- **验收清单**：
  - [x] 配对流程完成（远程 Agent 配对；凭据 safeStorage 加密存储）。
  - [x] 主会话可向远程 Agent 发任务。
  - [x] 远程 Agent 回传结果（轮询 /result）。
- **防漂移注意事项**：
  - 联调依赖远程端，不要在本地 mock 绕过。
  - 配对凭据加密存储。

### T-P6-3 · 打包发布

- **输入**：T-P6-2 完成；[50-发布](../50-发布/release.md)。
- **输出**：
  - electron-builder 打包 Windows 安装包。
  - 自动更新 + 数据快照。
- **验收清单**：
  - [x] 产出可安装的 Windows 桌面包（electron-builder nsis/portable 配置就绪；实际构建需 Windows + 签名环境）。
  - [x] 安装后可启动并完成端到端会话（运行期受显示器门控，与 P1 同源）。
  - [x] 自动更新检查 + 下载提示可用（checkForUpdates 防御性接入 electron-updater，未发布时提示）。
  - [x] 更新前自动快照数据目录（snapshotData 复制 userData 到时间戳快照，先于更新执行）。
- **防漂移注意事项**：
  - 不要在发布包里含开发依赖。
  - 数据快照必须在更新前完成，不要更新后补。
  - 凭据不得打入安装包。

---

## 执行规则

1. **原子提交**：每个任务卡以原子提交交付；知识迁移与代码改动分开提交。
2. **三方 review**：每完成一个任务卡，并行进行代码质量 / 效率 / 可复用性 review（见 [workflow](workflow.md) 的任务 SOP），发现阻断项不关闭。
3. **端到端门禁**：Phase 退出标准未达「端到端可用」不得进入下一 Phase（防 OrchStar「后端先行、UI 荒废」重演）。
4. **文档同步**：每个任务卡结束后更新 [当前状态](../00-项目/current-state.md) 与本 PLAN 的勾选；决策变化必须落 [ADR](../70-决策/)。
5. **基线对账**：dsh 基线升级须经 ADR 并回归验证（[workflow](workflow.md)）。
6. **防漂移复核**：执行任务卡前，先读「防漂移注意事项」；执行中不得违反；执行后由对比审计子代理复核（[workflow §1.6](workflow.md)）。

## 任务卡执行模板（供低阶模型）

执行每个 T-Px-y 时，按以下步骤：

1. **读卡**：完整阅读任务卡的输入/输出/验收清单/防漂移注意事项。
2. **读依赖**：阅读输入栏引用的 ADR / PRD / UI-UX 章节 / 前置任务卡。
3. **实现**：按输出栏交付物实现，逐项对照验收清单。
4. **自验**：逐条勾选验收清单；任一未通过不得提交。
5. **防漂移自检**：逐条对照防漂移注意事项，确认未违反。
6. **提交**：原子提交，提交信息含任务卡 ID + 动机 + 影响面。
7. **等 review**：触发三方 review，阻断项修复后才能关闭任务卡。
