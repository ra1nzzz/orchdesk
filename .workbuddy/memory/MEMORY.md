# OrchDesk 项目记忆（长期）

## 定位与铁律
本地优先多 Agent 编排桌面工作台（Electron + dsh/Cordis）。前身 OrchStar（D:/Task/Orchstar，1756e3a，仅继承产品域）。
- 每 Phase 退出须端到端可用。SOP：审计子代理→开发→3 并行 review→对比审计→授权后提交。
- 分层：纯逻辑（零 electron，node 直测）/宿主/main.ts 只接线；新纯逻辑登记 `arch-guard-verify.cjs` 的 `PURE_MODULES`。
- 降级必须可见（带 `via`）；「未接入」≠「为空」；重复小工具收敛 `common-tools.ts`。

## 高发踩坑
1. 布尔三态：`x !== null` 遇 `undefined` 为 true；「未探测/不可用/可用」须区分。
2. 上限只截一半：先拼后 slice 漏尾巴。`readSync` 循环读。
3. 判未接入用宿主显式 `bridgeMissing`（`typeof bridge.fn` 不可靠，stub 也是函数）。
4. `extOfName` 先切 basename 再找点（全路径 `lastIndexOf('.')` 被带点目录击穿）。
5. EOL 按多数派：textarea 吃 CRLF→LF，写盘/diff 前 `detectEol`/`applyEol` 还原。非 UTF-8 用 `TextDecoder(fatal:true)`。
6. 断言 FAIL 先怀疑实现别放宽；补断言别插用例序列中间；重载模块测存/恢复 `require.cache`。
7. 改插件源码后 `tsc` 再 `node scripts/vendor-dsh.cjs`（probe 跑旧产物假失败）。
8. 冒烟/驱动脚本必须放 `apps/desktop` 下（temp 下解析不到 node_modules）。

## 真机与验证（cd apps/desktop）
- `npm run verify` = 24 套件，项数以 CHECKPOINT 为 canonical；grep `📊 结果:` 别漏。
- 真机 Electron 本会话跑不起来：① 宿主带 `ELECTRON_RUN_AS_NODE=1`（须 `env -u` 摘）；② 非交互会话 GPU 起不来→退出 127，禁 GPU 参数全无效。真机 CDP 另设 `pnpm run smoke:browser`（不进 verify 链）；桌面可跑项收 `docs/40-质量/smoke-checklist.md`。
- electron 套件：`Module._load` stub electron 后 require `dist/main.js`（stub 在 `scripts/verify-kit.cjs`）。

## 打包发版
- 配方（绕 BUG-W01）：`npx tsc -p tsconfig.json && node scripts/vendor-dsh.cjs && node kill-running.cjs && npx electron-builder --win --publish never`；tag 在打包后打（check-version 严格模式阻断）。
- Changelog 用零依赖 `scripts/changelog.mjs`（parser@6 吃不到 `-hash-` 静默 0 字节）。
- asar 句柄泄漏→同目录重试 EBUSY：换全新输出目录（`-c.directories.output=release-xxx-rN`）。GitHub 直连约五成断连→重试 ≤5 次、间隔 6s。asar 头部是 pickle：首 `{` 到末 `}` 再 parse；node-pty 1.2.0 在 `prebuilds/<plat-arch>/conpty.node`。

## 模块要点（坑；完整见 ADR）
- 浏览器（0011）：宁可降级别挂起、降级可见。挂起源：`Emulation.setDeviceMetricsOverride`（主进程消失）/`Page.captureScreenshot`（回退 `capturePage`）/`Page.navigate`（回退 `win.loadURL`）。缩略图用已得 PNG 本地 resize，别发第二次截图。
- 终端（0012）：子进程 env 剔 NODE_OPTIONS/NODE_PATH/ELECTRON_RUN_AS_NODE；降级 `via:'pipe'` 徽标可见。文件 Tab 用户亲手操作不走授权门。
- diff（0013）：LCS 回溯后必须吐完单侧剩余行（曾丢 add）。
- 渲染双环境：preload 无 require、app.js 是 IIFE → 共用纯逻辑写 **UMD-lite 单文件**（`module.exports`+`window.OrchDeskXxx`），挂 app.js 前，零构建。
- ADR-0008：主会话回合=直连工具循环+`firePreStep()`；别再提「接入 ctx.agents.followup」（P7 须新 ADR）。

## 数据目录 / 模型层
- `dataDir()`=`ORCHDESK_HOME`>便携> `%APPDATA%/OrchDesk`；`migrateLegacyData()` 按 key 合并只补齐不覆盖。
- 工具双模式：优先 function calling；不支持走 `<tool:name>json</tool>` 文本兜底，结果 `role:'user'` 回传（`role:'tool'` 被网关拒）。
- 网关软拒绝：带 tools 返 200 空→逐级降级不带 tools，`Map<provider.id|model>` 记忆；去 tools 后仍空不误置 toolsRejected。

## 知识库与债务（docs/）
- 入口 docs/README.md；分层 00/10/20/30/40/50/60/70/80/99；ID `orch-<area>-<nnn>`；改后 `audit_knowledge_base.py docs` 须 0 issues。canonical：verify 计数→CHECKPOINT、结构→quality-gates、需求→PRD、分层→architecture。外部资料只引用不回拷；密钥/本机路径禁入。
- 最大欠账是勾选不是代码（PLAN 107 仅 23 已勾）；83 项运行期验收是**待执行**非环境阻断，别写「受 BUG-W02 门控」。对照 `docs/00-项目/openworker-对照-2026-09-03.md`。
- verify 缺环境隔离（用真实 dataDir，有污染 prod 遥测风险，待补）。
- 死挂点审计 v0.12.0 清零（累计 15+）：含零调用方/零写入方变体；契约+接线测试都要有。方法见 `~/.workbuddy/skills/dead-hook-audit/`。
