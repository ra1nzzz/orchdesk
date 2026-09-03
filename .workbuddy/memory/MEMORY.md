# OrchDesk 项目记忆（长期）

## 项目定位
OrchDesk = 本地优先的多 Agent 编排桌面工作台（Electron + dsh/Cordis 底座）。前身 OrchStar（D:/Task/Orchstar，commit 1756e3a；产品域继承、代码不回迁）。参考 orchclaw，理论 cordiverse/paper。

## 铁律（不写进 docs 的口头约束）
- 每个 Phase 退出必须端到端可用，禁止「后端先行、UI 后补」（OrchStar 荒废教训）。
- 任务 SOP：审计子代理 → 开发 → 3 并行 review → 对比审计 → 用户授权后提交。
- 三分层：纯逻辑（零 electron 依赖，可 node 直测）/ 宿主层 / `main.ts` 只接线。新纯逻辑模块必须登记 `arch-guard-verify.cjs` 的 `PURE_MODULES`。
- 降级必须可见（结果带 `via`、日志写明回退）；「未接入」与「为空」必须区分（无桥 → `loaded=false`，不显示「0 条」）。
- 重复小工具收敛到 `common-tools.ts`（`clampInt`/`isAbsoluteLike`/`extOfName`）。

## 知识库约定（docs/，canonical）
- 唯一入口 docs/README.md；分层 00/10/20/30/40/50/60/70/80/99；文档 ID `orch-<area>-<nnn>`；改动后 `audit_knowledge_base.py docs` 须 0 issues。
- 每类事实唯一 canonical 责任方（verify 计数归 CHECKPOINT、结构性约定归 quality-gates、需求归 PRD、分层归 architecture）；外部资料只引用不回拷；密钥/本机绝对路径禁入 docs/。

## 关键决策（ADR）
dsh 底座 / Electron 壳 / 意图网关挂 agent-pre-step / 脑手层级用 Cordis Fiber+isolate / 沙箱按平台 backend（win 首发）/ 浏览器走 Electron 自带 CDP（0009-0011）/ 终端 PTY 多候选+管道降级、文件 Tab（0012）/ 文件编辑不走授权门+外部修改检测+EOL 保护（0013）。
- ADR-0008：主会话回合 = 直连工具循环 + `firePreStep()` 驱动 pre-step waterfall。**不要再提「接入 ctx.agents.followup」**（P7 路线图，切换前须新 ADR）。插件挂 dsh 事件时先确认主链路真 emit 该事件。

## 高发踩坑（血泪，最值钱）
1. **布尔三态**：`x !== null` 在 `undefined`（未探测）时返回 true。「未探测/不可用/可用」必须区分。
2. **上限只截一半**：拼接后再 slice 一次，否则「64KB 尾巴 + 1MB chunk」绕过上限。
3. **判未接入别用 `typeof bridge.fn !== 'function'`**：桥兜底 stub 也是函数 → 恒不命中。用宿主显式标记（如 `bridgeMissing`）。
4. **`extOfName` 先切 basename 再找点**：对全路径 `lastIndexOf('.')` 被带点目录击穿（`D:/proj/com.example/src/app.ts`）。
5. **`readSync` 必须循环读**：短读却声称完整。
6. **判非 UTF-8 用 `TextDecoder(fatal:true)`**：用「含 U+FFFD」会误禁编辑。
7. **EOL 按多数派**：textarea 把 CRLF 吃成 LF，写盘/diff 前须 `detectEol`/`applyEol` 还原，否则整文件假 diff。
8. **断言 FAIL 先怀疑实现**，别先放宽断言（两次「疑似太严」都是真 bug）。
9. **审阅补断言别插在用例序列中间**（污染后续状态假设）；重载模块测干净实例时保存/恢复 `require.cache`。
10. **改插件源码后必须 `tsc` 再 `node scripts/vendor-dsh.cjs`**，否则 probe 跑旧产物出假失败。

## 浏览器工具（ADR-0011）真机铁律
- **CDP 出问题宁可降级也不要挂起**，降级必须可见。挂起源：① `Emulation.setDeviceMetricsOverride` 让主进程直接消失 → 带超时+忽略、受限会话跳过；② `Page.captureScreenshot` 取不到合成帧永久挂起 → 超时回退 `capturePage`（68ms）；③ `Page.navigate` 挂起 → 回退 `win.loadURL()`。`Runtime.evaluate` 外层须再加超时 + `executeJavaScript` 兜底。
- 缩略图用已得 PNG 本地 `nativeImage.resize`，**别发第二次截图请求**。
- 分层：`browser-tools.ts`（纯逻辑：schema/归一化/页面内 JS 表达式构造/风险扫描）+ `browser-cdp.ts`（宿主）+ main 接线。注入面唯一：注入值一律 `JSON.stringify` 并在假 DOM 里真跑一遍。
- `waitForLoad` 双保险：`Page.loadEventFired` + 250ms 轮询 `document.readyState`。CDP 事件都走 `'message'`，method 在第二参。
- 安全：导航=边界外访问（域名白名单+二次确认）；click/type/eval 走授权门；**拒绝时命令绝不下发**（有回归断言）。

## 终端 PTY + 文件 Tab（0012）/ 编辑 diff（0013）
- node-pty 多候选：`ORCHDESK_PTY_MODULE` > `vendor/node-pty`（asarUnpack）> node_modules > dsh profile；全落空 → child_process 管道，`via:'pipe'` 徽标+toast 必须可见。
- 子进程 env 剔除 NODE_OPTIONS/NODE_PATH/ELECTRON_RUN_AS_NODE。洪峰：16ms 攒批 / 单条 256KB / 64KB 回放 / 会话上限 6（只计活跃）。
- 文件 Tab 用户亲手操作**不走授权门**（Agent file_write 链路不变）。四道防呆：mtimeMs 检测（2ms 容差）、editable 主进程统一判定、临时文件 rename 原子写回、入口拒绝（二进制/超 2MB/缺 mtime）。
- diff 用 `renderer/file-edit.js`（UMD-lite）：LCS 前后缀裁剪+DP、±3 上下文、>5000 行或 DP>4M → tooLarge。**回溯循环退出后必须吐完单侧剩余行**（曾丢 add）。
- 渲染层全屏覆盖层：xterm 骨架只建一次（`dataset.ready`），不随状态推送重绘。shiki 用 esbuild IIFE（`createHighlighterCore`+JS 引擎，897KB，`window.ShikiLite`），加体积门槛（>200KB/3000 行回落 `pre`，2MB 高亮实测 10.5s）。

## 渲染层纯逻辑的双环境单文件方案
主窗口 `sandbox:true` → preload 无 `require`；`app.js` 是 IIFE 纯 JS 不能 require TS 产物。故需「Node 验证 + 浏览器共用」的纯逻辑写成 **UMD-lite 单文件**（`module.exports` + `window.OrchDeskXxx`），`<script src>` 挂在 app.js 之前。零构建，杜绝源码/产物漂移。

## 验证入口（`cd apps/desktop`）
- `npm run verify` = **24 套件 814 项**：plugins 88 / orchestration 45 / trace-upload 36 / agent-runtime 38 / agent-loop 14 / model-loop 40 / dsh-runtime 31 / credentials 34 / data-dir 47 / data-port 10 / session-fork 29 / memory-promotion 22 / memory-summarize 16 / connector-registry 30 / plugin-market 15 / usage-registry 11 / session-events 16 / ts-loader 13 / browser-tools 43 / terminal-pty 29 / file-panel 20 / file-edit 20 / arch-guard 15 / e2e 152
- electron 依赖套件：`Module._load` 钩子 stub `electron` 后 require `dist/main.js` 驱动真实 handler；stub 在 `scripts/verify-kit.cjs`（含 CDP `DebuggerStub`、`cdpCommands`）。
- **真机 Electron 在本会话跑不起来（两成因，别再排查）**：① 宿主继承 `ELECTRON_RUN_AS_NODE=1` → electron.exe 退化纯 Node；② 非交互会话 GPU 进程起不来（`gpu_process_host.cc:956` → 退出码 127），`--disable-gpu`/`no-sandbox`/`in-process-gpu` 全无效。故真机 CDP 另设 `pnpm run smoke:browser`（`scripts/browser-smoke.cjs`，11 步），**刻意不进 verify 链**。跑法：`env -u ELECTRON_RUN_AS_NODE -u NODE_OPTIONS ORCHDESK_SMOKE_CI=1 <electron.exe> scripts/browser-smoke.cjs`；脚本自检 `process.type`。冒烟脚本必须放在 `apps/desktop` 下（放 TEMP 会 `Cannot find module 'electron'`）。
- 打包绕过 BUG-W01：`npx tsc -p tsconfig.json && node scripts/vendor-dsh.cjs && node kill-running.cjs && npx electron-builder --win --publish never`
- **Changelog** 走零依赖 `node scripts/changelog.mjs`（不用 conventional-changelog：BUG-W04，parser@6 吃不到 `-hash-` 分隔符 → 静默产出 0 字节）。`release` 链 = changelog → version:bump → dist，**changelog 必须在打 tag 之前跑**。

## 外部对照：OpenWorker（andrewyng/openworker，2026-09-03）
- 结论在 `docs/00-项目/openworker-对照-2026-09-03.md`（id orch-cmp-001），此处只留索引与最易忘的两条。
- **最大欠账不是代码是勾选**：PLAN 107 项验收 **23 已勾 / 84 未勾**；但 BUG-W02 已于 09-01 收窄（用户桌面可实跑、browser smoke 11/11），P0–P4 的 83 项运行期验收是**待执行待回勾**，不是环境阻断。别再写「受 BUG-W02 门控」。
- **verify 缺环境隔离**：OpenWorker `tests/conftest.py` 用 `autouse` fixture 把 state dir 全重定向到 `tmp_path` 并 `delenv` token（它曾因测试读真实 state 向 prod 遥测灌垃圾数据）。OrchDesk verify 直接用真实 `dataDir()`，有同类风险，待补。
- 其余借鉴/不抄清单见报告（A 档 8 条 / B 档 7 条 / 不抄 7 条）。

## 数据目录 / 模型层
- `dataDir()` = `ORCHDESK_HOME` > 便携模式（exe 同目录 `orchdesk-data`）> `%APPDATA%/OrchDesk`；启动 `migrateLegacyData()` 按 key 合并（只补齐不覆盖）。纯逻辑在 `data-dir.ts`。
- 工具调用双模式：优先原生 function calling；不支持走 `<tool:name>json</tool>` 文本兜底，结果用 `role:'user'` 回传（无 tool_calls 时发 `role:'tool'` 会被网关拒）。
- 网关软拒绝：StepFun 等带 tools 时返 HTTP 200 空内容 → 逐级降级到不带 tools；`runAgentTurn` 用 `Map<provider.id|model>` 记忆。去 tools 后仍空时不误置 toolsRejected。

## 死挂点审计（v0.12.0 清零，累计 15 个）
- 方法见 `~/.workbuddy/skills/dead-hook-audit/SKILL.md`。变体谱：服务在链路断 / 桥缺层 / UI 假数据或 `data-action="todo"` 空壳 / **零调用方** / **零写入方**（后两者最易漏，代码看着是完整的）。
- 单测证明不了「宿主接线没」：契约测试（seam 语义）+ 接线测试（驱动真实 IPC handler + mock 服务端，断言请求真发出去）都要有。
