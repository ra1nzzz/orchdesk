# OrchDesk 项目记忆（长期）

## 项目定位
OrchDesk = 本地优先的多 Agent 编排桌面工作台。前身 OrchStar（本机 D:/Task/Orchstar，commit 1756e3a；产品域继承、代码不回迁）。底座 deepseek-harness（Cordis），参考 orchclaw，理论 cordiverse/paper。

## 知识库约定（docs/，canonical）
- 唯一入口 docs/README.md；生命周期分层 00-项目/10-架构/20-需求/30-开发/40-质量/50-发布/60-BUG/70-决策/80-路线图/99-归档。
- 每类事实唯一 canonical 责任方；外部资料只引用不回拷（references/ 原位）；密钥/令牌/本机绝对路径禁入 docs/。
- 文档 ID 规则 orch-<area>-<nnn>；改动后跑 audit_knowledge_base.py docs 须 0 issues。
- 冲突显式裁决记录于 docs/70-决策/conflicts.md；架构决策落 ADR。

## 关键决策（ADR）
dsh 底座 / Electron 壳 / 意图网关挂 agent-pre-step / 脑-手层级用 Cordis Fiber+isolate / 沙箱按平台 backend（win 首发）/ 浏览器工具走 Electron 自带 CDP（ADR-0011）/ **终端 PTY 多候选+管道显式降级、文件 Tab 只读（ADR-0012）**。

## 浏览器工具（ADR-0011）真机铁律
- **CDP 出问题宁可降级也不要挂起**，且降级必须可见（结果带 `via`、日志写明已回退），不许用「跑通了」掩盖「其实是兜底跑通的」。
- 三条已实测的挂起源：① `Emulation.setDeviceMetricsOverride` 会让**主进程直接消失**（127、stdout 空、try/catch 都来不及）→ 带超时+忽略、受限会话跳过；② `Page.captureScreenshot` 取不到合成帧时**永久挂起** → 超时后回退 `capturePage`（实测 68ms）；③ `Page.navigate` 挂起页面根本打不开 → 回退 `win.loadURL()`。`Page.enable`/`Runtime.enable` 是可降级的可选项，`Runtime.evaluate` 外层须再加超时（内层 `timeout` 只管页面内执行时长）+ `executeJavaScript` 兜底。
- 缩略图拿已得 PNG 本地 `nativeImage.resize` 缩放，**别发第二次截图请求**（CDP 挂起时第二次同样挂，连主结果都拿不到）。
- ADR-0009 SessionEvent 事件流（不接管 dsh ctx.sessions，双写）｜ADR-0010 TS 直测 loader + 架构守护测试（Node ≥22.13 成硬要求）｜**ADR-0011 浏览器工具走 Electron 自带 CDP**。

## 铁律
每个 Phase 退出必须端到端可用，禁止「后端先行、UI 后补」（OrchStar 荒废教训）。任务 SOP：审计子代理→开发→3 并行 review→对比审计→用户授权后提交。

## 产品设计原则（用户确认）
会话 = 一等公民（默认落地页，如 DSH）；脑手解耦/多Agent编排/意图识别是亮点但视觉弱化；一切皆插件，大部分能力收进设置。首批插件：意图识别(本地模型)/TRACE(脱敏遥测→GitHub)/脑手解耦/多Agent编排(专家团)/OrchClaw Hub(延后)。

## 架构补充（v0.3.1 起）
- **Agent Runtime 分层**：`apps/desktop/agent-runtime.ts` = 纯逻辑（零 electron 依赖，可 node 直测：工具定义/参数解析/tool_calls 归一化/文本兜底解析/消息构造）；`main.ts` 只留需 electron 的 `executeTool`。
- **数据目录**：`dataDir()` = `ORCHDESK_HOME` > 便携模式（exe 同目录 `orchdesk-data`）> `%APPDATA%/OrchDesk`。NSIS 的 userData 即后者，故 portable 与 NSIS 共用同一目录。启动 `migrateLegacyData()` 按 key 合并历史位置（只补齐不覆盖）。目录解析/迁移纯逻辑在 `apps/desktop/data-dir.ts`（零 electron 依赖）；guanji.json/hub.json/skills 也走 `dataDir()`；备份导出/导入见 main.ts `orchdesk:export-data/import-data`。
- **工具调用双模式**：优先模型原生 function calling（`role:'tool'` + `tool_call_id`）；不支持时走 `<tool:name>json</tool>` 文本兜底，结果用 `role:'user'` 回传（无 tool_calls 时发 `role:'tool'` 会被网关拒）。
- **网关软拒绝处理**：StepFun 等网关在 chat 模式下带 tools 时返回 HTTP 200 空内容（软拒绝），`callOpenAICompatible` 会逐级降级到不带 tools；`runAgentTurn` 用 `Map<provider.id|model>` 记忆该状态，后续同 provider+model 直接走文本兜底。去 tools 后仍空时不误置 toolsRejected。

## 浏览器工具（ADR-0011，8 个工具并入统一工具表，TOOL_DEFS 7→15）
- 用 `webContents.debugger`（CDP 1.3）驱动一个 `show:false` BrowserWindow，**不引入 playwright/puppeteer**（已装的 playwright 留给外部 E2E）。选 CDP 而非 `executeJavaScript`：支持 awaitPromise/returnByValue/userGesture/超时，不受页面 CSP 影响，截图与导航等待同一套协议。
- 分层：`browser-tools.ts`（纯逻辑零 electron：schema / 参数归一化 / **页面内 JS 表达式构造** / 脚本风险扫描 / 截图路径）+ `browser-cdp.ts`（宿主：窗口生命周期 / attach / `Page.navigate`+加载等待 / `Runtime.evaluate` / `Page.captureScreenshot` 落盘）+ `main.ts` 只接线。新纯逻辑模块记得加进 `arch-guard-verify.cjs` 的 `PURE_MODULES`。
- 安全口径与既有工具一致：导航=边界外访问（域名白名单 + 补偿层外发二次确认）；`browser_click`/`browser_type`/`browser_eval` 走授权门；全部进沙箱日志 `kind:'browser'`；**拒绝时命令绝不下发**（有回归断言）。共享用户默认 session 保留登录态，代价由授权门覆盖而非隔离回避。
- 唯一注入面是表达式构造：注入值一律 `JSON.stringify`，并在**假 DOM 里真跑一遍**；`buildTypeExpression` 用原型 setter + input/change 事件兼容 React/Vue 受控组件。
- `waitForLoad` 双保险：`Page.loadEventFired` 为主 + 250ms 轮询 `document.readyState` 兜底（页面在 attach 前已加载完时事件不会再发）。debugger 的所有 CDP 事件都走同一个 `'message'`，method 在第二个参数里。
- UI 是验收底线（写进 ADR）：标题栏「浏览器」面板 + `onBrowserState` 推送实时跟随；桥不可用时 `getBrowserStatus` 返 `{open:false}` 表示「未接入」，不冒充「已就绪只是没开」。

## 终端 PTY + 文件 Tab（ADR-0012，Minke 对照 P2-10/11）
- **node-pty 多候选**：`ORCHDESK_PTY_MODULE` env > `<appDir>/vendor/node-pty`（vendor-dsh 第 3 步物化 + `asarUnpack:["vendor/node-pty/**"]`，原生 .node 不能在 asar 内）> node_modules > dsh profile；全落空 → `child_process` 管道降级，`via:'pipe'` 徽标+toast 必须可见。
- **环境净化硬前提**：子进程 env 剔除 NODE_OPTIONS/NODE_PATH/ELECTRON_RUN_AS_NODE（`TERMINAL_ENV_STRIP`）。洪峰防护：16ms 攒批 / 单条 256KB 截断标记 / 64KB 回放缓冲 / 会话上限 6。
- **文件 Tab 只读**（编辑/diff 后置 P3）：用户亲手浏览**不走授权门**（与浏览器工具口径相反）；懒加载每层 500 条、读取 ≤2MB 显式 truncated、二进制嗅探=扩展名+头 8KB NUL、语言探测不到→null 不许猜。
- **渲染层全屏覆盖层**（非 modal）：xterm 实例不能随状态推送重绘——骨架只建一次（`dataset.ready`），ESC 关面板但焦点在 `.term-container` 内不抢；xterm 用官方 UMD vendored，shiki 用 esbuild IIFE bundle（`createHighlighterCore`+`createJavaScriptRegexEngine` 纯 JS 引擎，897KB，`window.ShikiLite`；v3 的 `createHighlighter` 不在 core）。vendor 源包当前在 `C:/Users/my/node_modules`（npm 无 package.json 时沿祖先上溯污染 home，待移入 workspace）。

## 渲染层纯逻辑的双环境单文件方案（重要约束）
- 主窗口 `webPreferences.sandbox:true` → preload 拿不到 `require`；`renderer/app.js` 是 IIFE 纯 JS，也不能 `require` TS 产物。
- 结论：需要「Node 验证套件 + 浏览器渲染层共用同一份」的纯逻辑，写成 **UMD-lite 单文件**（`module.exports` + `window.OrchDeskXxx`），`<script src>` 挂在 app.js **之前**。范例：`renderer/session-fork.js`（+ `session-fork-verify.cjs`）。零构建步骤，杜绝源码/产物漂移。

## 验证入口（`cd apps/desktop`）
- `npm run verify` = **23 套件 786 项**：plugins 88 / orchestration 45 / trace-upload 36 / agent-runtime 38 / agent-loop 14 / model-loop 40 / dsh-runtime 31 / credentials 34 / data-dir 47 / data-port 10 / session-fork 29 / memory-promotion 22 / memory-summarize 16 / connector-registry 30 / plugin-market 15 / usage-registry 11 / session-events 16 / ts-loader 13 / browser-tools 43 / **terminal-pty 26 / file-panel 15** / arch-guard 15 / e2e 152
- **真机冒烟另设** `pnpm run smoke:browser`（11 步，**刻意不进 verify 链**：需真 GPU/渲染进程，非交互会话必假红）。跑法：`env -u ELECTRON_RUN_AS_NODE -u NODE_OPTIONS ORCHDESK_SMOKE_CI=1 <electron.exe> scripts/browser-smoke.cjs`；脚本自检 `process.type`，并按 explorer.exe（或 `ORCHDESK_SMOKE_CI=1`）判定是否降级：关 Chromium sandbox + 关硬件加速。参见「浏览器工具真机铁律」一节。
- electron 依赖套件用 `Module._load` 钩子 stub `electron` 后 require `dist/main.js` 驱动真实 handler；stub 在 `scripts/verify-kit.cjs`（`makeElectronStub`/`createChecker`，含 CDP `DebuggerStub` 与共享 `cdpCommands`）；`model-loop-verify.cjs` / `memory-summarize-verify.cjs` 用真 `node:http` mock 做线级验证
- **真机 Electron 在此环境跑不起来（两个成因，别再重复排查）**：① 宿主向下继承 `ELECTRON_RUN_AS_NODE=1` → electron.exe 退化纯 Node（`require('electron')` 返字符串、`app` undefined），所有调用加 `env -u ELECTRON_RUN_AS_NODE`；② 非交互会话里 GPU 进程起不来（`gpu_process_host.cc:956` 连崩 → `FATAL: GPU process isn't usable. Goodbye.` → 退出码 127，stdout 都来不及刷），`--disable-gpu`/`no-sandbox`/`in-process-gpu` **全无效**。故真机 CDP 另设 `pnpm run smoke:browser`（`apps/desktop/scripts/browser-smoke.cjs`，10 步），**刻意不进 verify 链**（需要真 GPU，硬塞只会假红并诱使人放宽断言）；脚本启动期自检 `process.type`，非主进程退 2 并打印指引
- 冒烟/驱动脚本**必须放在 `apps/desktop` 下**（放 `%TEMP%` 会因解析不到 node_modules 而 `Cannot find module 'electron'`）
- **改插件源码后必须 `npx tsc -p packages/plugin/<n>/tsconfig.json` 再 `cd apps/desktop && node scripts/vendor-dsh.cjs`**：probe 套件跑的是 `vendor/plugins/*` 里的产物，忘了 vendor 会用旧代码跑出假失败（2026-08-31 踩到：`rec.chunks` undefined）
- probe 子进程脚本落在系统临时目录，`__dirname` 指向 temp —— 脚本内所有路径必须以注入的 `APP_DIR` 为基准
- 打包：`npm run dist:win` 会因 BUG-W01 触发 pnpm install 失败 → 绕过方式 `npx tsc -p tsconfig.json && node scripts/vendor-dsh.cjs && node kill-running.cjs && npx electron-builder --win --publish never`
- 打包前置 `scripts/vendor-dsh.cjs` 把 dsh 包物化到 `apps/desktop/{vendor/plugins,node_modules/@deepseek-ai}`（build.files 已含两处）；改动插件源码后必须先 `tsc` 再 vendor
- **Changelog 生成**：走零依赖 `node scripts/changelog.mjs [--from <ref>] [--version <v>] [--write] [--selftest]`。**不用** conventional-changelog——其 `git-raw-commits@5` 不再输出 `-hash-` 分隔符，而 `conventional-commits-parser@6` 仍靠它切分，整段历史被吞成一条 `chore:` 后被 angular preset 过滤 → 退出 0、产出 0 字节（BUG-W04，原归因「Node 22/历史重建」已推翻）。`release` 链 = `changelog → version:bump → dist`，changelog 必须在打 tag **之前**跑，否则最新 tag 之后只剩 chore、无米下锅

## 死挂点审计（累计 15 个，v0.12.0 清零）
- 定义与排查法见 `~/.workbuddy/skills/dead-hook-audit/SKILL.md`（非 agent_created；2026-08-31 已用 Edit 补入「零调用方/零写入方」「UI 假数字与空壳」两个变体及三条验证教训）。
- 变体谱：① 服务在、链路断（`case 'fork'` 零调用）；② 桥缺层；③ **UI 写着但是假数据 / `data-action="todo"` 空壳**（`~ 24 MB`、6 个桌面集成开关）；④ **零调用方**（`promote()` 完整但没人调）；⑤ **零写入方**（管道完整但上游没数据 → worker 域永远空）。④⑤ 最易漏：代码看着是完整的。
- 铁律：「未接入」与「接了但为空」必须区分（无桥 → `loaded=false` → 显示「未接入」，不显示「0 条」）。
- **单测证明不了「宿主来接线了没」**：契约测试（seam 语义）与接线测试（驱动真实 IPC handler + 本地 mock 服务端，断言请求真发出去）必须都有。
- **降级状态不许冒充**：状态查询在依赖缺失时不得拿默认值顶（无 provider 时返回 `defaultModel` → 「一个模型都没配」显示成「正在用 qwen3:14b」）；渲染层桥断时不得沿用上一秒状态。
- **断言 FAIL 先怀疑实现，不要先放宽断言**：2026-08-31 两次「疑似断言太严」都是真 bug（TF-IDF OOV 权重归零 → 第一条记忆向量全零、永远召不回；状态用默认值冒充已配置）。

## 审阅工作流
- `yt-dev-review` 技能（~/.workbuddy/skills/）：3 并行审阅子代理（质量/效率/可复用性）→ 交叉比对 → 交叉修复 → 复验门禁。2026-08-29 第二轮以此抓到 5 个 P0 真问题（便携模式失效 / 导入竞态 / responses 丢历史 / 晋升恒断 / TRACE 定时器不上传）。
- 教训：「测试过、生产坏」——verify 自注入依赖会掩盖调用方缺参；审阅时必须对照调用方实参。

## ADR-0008 挂点桥接（长期裁决）
- 主会话模型回合 = 直连工具循环 + `firePreStep()` 每回合驱动 `agent/pre-step` waterfall（intent 网关 reject 硬拒 / trace 遥测）。**不要**再把「接入 ctx.agents.followup」当待办——那是 P7 路线图项且切换前须新 ADR；fail 边界：runtime 未启动 → 放行 + WARN。详见 docs/70-决策/ADR-0008 与 conflicts C6。
- 排查口诀：插件挂在 dsh 事件上时，先确认**主链路是否真的 emit 该事件**（AgentLoop 事件只有 dsh 驱动循环才发）。
