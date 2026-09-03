# OrchDesk 项目记忆（长期）

## 定位与铁律
本地优先多 Agent 编排桌面工作台（Electron + dsh/Cordis 底座）。前身 OrchStar（D:/Task/Orchstar，1756e3a，仅继承产品域）。
- 每 Phase 退出须端到端可用，禁「后端先行 UI 后补」。SOP：审计子代理 → 开发 → 3 并行 review → 对比审计 → 用户授权后提交。
- 三分层：纯逻辑（零 electron，可 node 直测）/ 宿主层 / `main.ts` 只接线；新纯逻辑登记 `arch-guard-verify.cjs` 的 `PURE_MODULES`。
- 降级必须可见（结果带 `via`）；「未接入」≠「为空」。重复小工具收敛到 `common-tools.ts`。

## 高发踩坑（最值钱）
1. 布尔三态：`x !== null` 在 `undefined`（未探测）时 true；「未探测/不可用/可用」须区分。
2. 上限只截一半：拼接后再 slice，否则「64KB 尾巴 + 1MB chunk」绕过。
3. 判未接入别用 `typeof bridge.fn !== 'function'`（兜底 stub 也是函数），用宿主显式标记 `bridgeMissing`。
4. `extOfName` 先切 basename 再找点（全路径 `lastIndexOf('.')` 被带点目录击穿）。
5. `readSync` 必须循环读（短读却声称完整）。
6. 非 UTF-8 用 `TextDecoder(fatal:true)`；用「含 U+FFFD」会误禁编辑。
7. EOL 按多数派：textarea 吃 CRLF→LF，写盘/diff 前须 `detectEol`/`applyEol` 还原，否则整文件假 diff。
8. 断言 FAIL 先怀疑实现，别放宽（两次「疑似太严」都是真 bug）。
9. 补断言别插在用例序列中间（污染状态假设）；重载模块测干净实例要存/恢复 `require.cache`。
10. 改插件源码后必须 `tsc` 再 `node scripts/vendor-dsh.cjs`，否则 probe 跑旧产物出假失败。

## 真机与验证（cd apps/desktop）
- `npm run verify` = **24 套件 814 项**（明细以 CHECKPOINT 为 canonical）。输出前缀三种，`📊 结果: ` 那条 grep 别漏。
- **真机 Electron 本会话跑不起来（两成因，别再排查）**：① 宿主继承 `ELECTRON_RUN_AS_NODE=1` → electron.exe 退化纯 Node；② 非交互会话 GPU 进程起不来 → 退出码 127，禁用 GPU 参数全无效。真机 CDP 另设 `pnpm run smoke:browser`（刻意不进 verify 链），脚本须放 `apps/desktop` 下；用户桌面可跑项收在 `docs/40-质量/smoke-checklist.md`。
- electron 依赖套件：`Module._load` stub `electron` 后 require `dist/main.js` 驱动真实 handler（stub 在 `scripts/verify-kit.cjs`）。

## 打包发版
- 配方（绕 BUG-W01，别用 pnpm 包装）：`npx tsc -p tsconfig.json && node scripts/vendor-dsh.cjs && node kill-running.cjs && npx electron-builder --win --publish never`
- **tag 必须在打包之后打**：`check-version.cjs` 严格模式下 `version == 最新 tag` 阻断 dist。
- Changelog 用零依赖 `scripts/changelog.mjs`（conventional-changelog 有 BUG-W04：parser@6 吃不到 `-hash-` → 静默 0 字节）。
- **asar 句柄泄漏**：electron-builder 报错后进程不退出、持续持有 asar 句柄 → 同目录重试永远 EBUSY；按进程名查不到，须 `Get-CimInstance Win32_Process` 按命令行查再 `Stop-Process`。**最稳是换全新输出目录**（`-c.directories.output=release-xxx-rN`）：同目录 5 败、换目录一次过。
- GitHub 下载/上传直连约五成 TLS 断连 → 重试循环（≤5 次、间隔 6s）。
- asar 头部是 pickle（前后有填充）→ 从首 `{` 截到末 `}` 再 `JSON.parse`。node-pty 1.2.0 走 `prebuilds/<platform-arch>/conpty.node`，不是 `build/Release`。

## 模块要点（完整内容见 ADR，此处只留坑）
- **浏览器（0011）**：宁可降级也别挂起、降级必须可见。挂起源三条：`Emulation.setDeviceMetricsOverride`（主进程直接消失）/ `Page.captureScreenshot`（取不到合成帧 → 回退 `capturePage`）/ `Page.navigate`（回退 `win.loadURL`）。缩略图用已得 PNG 本地 resize，**别发第二次截图请求**。
- **终端 PTY（0012）**：子进程 env 剔除 NODE_OPTIONS/NODE_PATH/ELECTRON_RUN_AS_NODE；全落空时 `via:'pipe'` 徽标必须可见。
- **文件 Tab / diff（0013）**：用户亲手操作不走授权门；diff 的 **LCS 回溯后必须吐完单侧剩余行**（曾丢 add）。
- **渲染层双环境**：preload 无 `require`、`app.js` 是 IIFE → 「Node 验证 + 浏览器共用」的纯逻辑写成 **UMD-lite 单文件**（`module.exports` + `window.OrchDeskXxx`），`<script src>` 挂在 app.js 前，零构建。
- **ADR-0008**：主会话回合 = 直连工具循环 + `firePreStep()`；**别再提「接入 ctx.agents.followup」**（P7，须新 ADR）。

## 数据目录 / 模型层
- `dataDir()` = `ORCHDESK_HOME` > 便携模式（exe 同目录 `orchdesk-data`）> `%APPDATA%/OrchDesk`；`migrateLegacyData()` 按 key 合并（只补齐不覆盖）。
- 工具双模式：优先原生 function calling；不支持走 `<tool:name>json</tool>` 文本兜底，结果用 `role:'user'` 回传（发 `role:'tool'` 会被网关拒）。
- 网关软拒绝：带 tools 返 200 空内容 → 逐级降级到不带 tools，`runAgentTurn` 用 `Map<provider.id|model>` 记忆；去 tools 后仍空时不误置 toolsRejected。

## 知识库（docs/）与债务
- 入口 docs/README.md；分层 00/10/20/30/40/50/60/70/80/99；ID `orch-<area>-<nnn>`；改后 `audit_knowledge_base.py docs` 须 0 issues。每类事实唯一 canonical（verify 计数→CHECKPOINT、结构约定→quality-gates、需求→PRD、分层→architecture）；外部资料只引用不回拷；密钥/本机路径禁入。
- **最大欠账是勾选不是代码**：PLAN 107 项仅 23 已勾；BUG-W02 已收窄（用户桌面可实跑、browser smoke 11/11），83 项运行期验收是**待执行**非环境阻断 —— 别再写「受 BUG-W02 门控」。对照报告 `docs/00-项目/openworker-对照-2026-09-03.md`。
- verify 缺环境隔离（直接用真实 `dataDir()`，有污染 prod 遥测风险，待补）。
- 死挂点审计 v0.12.0 清零（累计 15）：变体谱含**零调用方**与**零写入方**（最易漏）；契约测试 + 接线测试都要有。方法见 `~/.workbuddy/skills/dead-hook-audit/SKILL.md`。
