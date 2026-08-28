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
- **数据目录**：`dataDir()` = `ORCHDESK_HOME` > 便携模式（exe 同目录 `orchdesk-data`）> `%APPDATA%/OrchDesk`。NSIS 的 userData 即后者，故 portable 与 NSIS 共用同一目录。启动 `migrateLegacyData()` 按 key 合并历史位置（只补齐不覆盖）。
- **工具调用双模式**：优先模型原生 function calling（`role:'tool'` + `tool_call_id`）；不支持时走 `<tool:name>json</tool>` 文本兜底，结果用 `role:'user'` 回传（无 tool_calls 时发 `role:'tool'` 会被网关拒）。

## 验证入口（`cd apps/desktop`）
- `npm run verify` = `agent-runtime-verify.cjs`(35) + `agent-loop-verify.cjs`(14) + `e2e-fix-verify.cjs`(29)
- `agent-loop-verify.cjs` 用 `Module._load` 钩子 stub `electron` 后驱动真实主进程 `runAgentTurn`
- 打包：`npm run dist:win`（自动 `kill-running.cjs` 结束 OrchDesk.exe 防 EBUSY）
