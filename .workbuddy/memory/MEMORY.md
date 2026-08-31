# OrchDesk 项目记忆（长期）

## 项目定位
OrchDesk = 本地优先的多 Agent 编排桌面工作台。前身 OrchStar（本机 D:/Task/Orchstar，commit 1756e3a；产品域继承、代码不回迁）。底座 deepseek-harness（Cordis），参考 orchclaw，理论 cordiverse/paper。

## 知识库约定（docs/，canonical）
- 唯一入口 docs/README.md；生命周期分层 00-项目/10-架构/20-需求/30-开发/40-质量/50-发布/60-BUG/70-决策/80-路线图/99-归档。
- 每类事实唯一 canonical 责任方；外部资料只引用不回拷（references/ 原位）；密钥/令牌/本机绝对路径禁入 docs/。
- 文档 ID 规则 orch-<area>-<nnn>；改动后跑 audit_knowledge_base.py docs 须 0 issues。
- 冲突显式裁决记录于 docs/70-决策/conflicts.md；架构决策落 ADR。

## 关键决策（ADR）
dsh 底座 / Electron 壳 / 意图网关挂 agent-pre-step / 脑-手层级用 Cordis Fiber+isolate / 沙箱按平台 backend（win 首发）。

## 铁律
每个 Phase 退出必须端到端可用，禁止「后端先行、UI 后补」（OrchStar 荒废教训）。任务 SOP：审计子代理→开发→3 并行 review→对比审计→用户授权后提交。

## 产品设计原则（用户确认）
会话 = 一等公民（默认落地页，如 DSH）；脑手解耦/多Agent编排/意图识别是亮点但视觉弱化；一切皆插件，大部分能力收进设置。首批插件：意图识别(本地模型)/TRACE(脱敏遥测→GitHub)/脑手解耦/多Agent编排(专家团)/OrchClaw Hub(延后)。

## 架构补充（v0.3.1 起）
- **Agent Runtime 分层**：`apps/desktop/agent-runtime.ts` = 纯逻辑（零 electron 依赖，可 node 直测：工具定义/参数解析/tool_calls 归一化/文本兜底解析/消息构造）；`main.ts` 只留需 electron 的 `executeTool`。
- **数据目录**：`dataDir()` = `ORCHDESK_HOME` > 便携模式（exe 同目录 `orchdesk-data`）> `%APPDATA%/OrchDesk`。NSIS 的 userData 即后者，故 portable 与 NSIS 共用同一目录。启动 `migrateLegacyData()` 按 key 合并历史位置（只补齐不覆盖）。目录解析/迁移纯逻辑在 `apps/desktop/data-dir.ts`（零 electron 依赖）；guanji.json/hub.json/skills 也走 `dataDir()`；备份导出/导入见 main.ts `orchdesk:export-data/import-data`。
- **工具调用双模式**：优先模型原生 function calling（`role:'tool'` + `tool_call_id`）；不支持时走 `<tool:name>json</tool>` 文本兜底，结果用 `role:'user'` 回传（无 tool_calls 时发 `role:'tool'` 会被网关拒）。
- **网关软拒绝处理**：StepFun 等网关在 chat 模式下带 tools 时返回 HTTP 200 空内容（软拒绝），`callOpenAICompatible` 会逐级降级到不带 tools；`runAgentTurn` 用 `Map<provider.id|model>` 记忆该状态，后续同 provider+model 直接走文本兜底。去 tools 后仍空时不误置 toolsRejected。

## 渲染层纯逻辑的双环境单文件方案（重要约束）
- 主窗口 `webPreferences.sandbox:true` → preload 拿不到 `require`；`renderer/app.js` 是 IIFE 纯 JS，也不能 `require` TS 产物。
- 结论：需要「Node 验证套件 + 浏览器渲染层共用同一份」的纯逻辑，写成 **UMD-lite 单文件**（`module.exports` + `window.OrchDeskXxx`），`<script src>` 挂在 app.js **之前**。范例：`renderer/session-fork.js`（+ `session-fork-verify.cjs`）。零构建步骤，杜绝源码/产物漂移。

## 验证入口（`cd apps/desktop`）
- `npm run verify` = 12 套件 465 项：plugins 63 / orchestration 45 / trace-upload 36 / agent-runtime 38 / agent-loop 14 / model-loop 34 / dsh-runtime 31 / credentials 34 / data-dir 47 / data-port 10 / session-fork 29 / e2e 84
- electron 依赖套件用 `Module._load` 钩子 stub `electron` 后 require `dist/main.js` 驱动真实 handler；`model-loop-verify.cjs` 用真 `node:http` mock 做线级验证
- 打包：`npm run dist:win` 会因 BUG-W01 触发 pnpm install 失败 → 绕过方式 `npx tsc -p tsconfig.json && node scripts/vendor-dsh.cjs && node kill-running.cjs && npx electron-builder --win --publish never`
- 打包前置 `scripts/vendor-dsh.cjs` 把 dsh 包物化到 `apps/desktop/{vendor/plugins,node_modules/@deepseek-ai}`（build.files 已含两处）；改动插件源码后必须先 `tsc` 再 vendor
- **Changelog 生成**：走零依赖 `node scripts/changelog.mjs [--from <ref>] [--version <v>] [--write] [--selftest]`。**不用** conventional-changelog——其 `git-raw-commits@5` 不再输出 `-hash-` 分隔符，而 `conventional-commits-parser@6` 仍靠它切分，整段历史被吞成一条 `chore:` 后被 angular preset 过滤 → 退出 0、产出 0 字节（BUG-W04，原归因「Node 22/历史重建」已推翻）。`release` 链 = `changelog → version:bump → dist`，changelog 必须在打 tag **之前**跑，否则最新 tag 之后只剩 chore、无米下锅

## 死挂点审计（累计 13 个，v0.12.0 清零）
- 定义与排查法见 `~/.workbuddy/skills/dead-hook-audit/SKILL.md`（非 agent_created，需手工增补）。
- 三大变体：① 服务在、链路断（`case 'fork'` 零调用）；② 桥缺层（模块级导出而非 provide 服务）；③ **UI 写着但是假数据 / `data-action="todo"` 空壳**（设置页 `~ 24 MB`、6 个桌面集成开关）。③ 最易漏——比不写更糟，因为用户会当真。
- 铁律：「未接入」与「接了但为空」必须区分（无桥 → `loaded=false` → 显示「未接入」，不显示「0 条」）。

## 审阅工作流
- `yt-dev-review` 技能（~/.workbuddy/skills/）：3 并行审阅子代理（质量/效率/可复用性）→ 交叉比对 → 交叉修复 → 复验门禁。2026-08-29 第二轮以此抓到 5 个 P0 真问题（便携模式失效 / 导入竞态 / responses 丢历史 / 晋升恒断 / TRACE 定时器不上传）。
- 教训：「测试过、生产坏」——verify 自注入依赖会掩盖调用方缺参；审阅时必须对照调用方实参。

## ADR-0008 挂点桥接（长期裁决）
- 主会话模型回合 = 直连工具循环 + `firePreStep()` 每回合驱动 `agent/pre-step` waterfall（intent 网关 reject 硬拒 / trace 遥测）。**不要**再把「接入 ctx.agents.followup」当待办——那是 P7 路线图项且切换前须新 ADR；fail 边界：runtime 未启动 → 放行 + WARN。详见 docs/70-决策/ADR-0008 与 conflicts C6。
- 排查口诀：插件挂在 dsh 事件上时，先确认**主链路是否真的 emit 该事件**（AgentLoop 事件只有 dsh 驱动循环才发）。
