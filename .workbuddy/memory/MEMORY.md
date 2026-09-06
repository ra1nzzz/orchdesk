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
- 配方（绕 BUG-W01）：`npx tsc -p tsconfig.json && node scripts/vendor-dsh.cjs && node kill-running.cjs && npx electron-builder --win --publish never`（pnpm 包装层触发 safe-delete，别用 pnpm 跑）。
- **顺序铁律（必守）**：bump → changelog → release commit → tsc + vendor-dsh → 打包 → **最后** 打 tag
  （check-version.cjs 严格模式下 `version == 最新 tag` 阻断 dist）。
  **bump 要手动改 package.json**，别用 `npm run version:bump`（bumpp 会连 tag 一起打，直接违反上面的顺序）。
- Changelog 用零依赖 `scripts/changelog.mjs --from <旧tag> --version <新版本> --write`（parser@6 吃不到 -hash- 静默 0 字节）。
  **人工裁决**：同一版内「加了又撤、从未发布」的功能要从 Added/Removed 两处剔除，别让对外说明出现噪音。
- asar 句柄泄漏→同目录重试 EBUSY：换全新输出目录（`-c.directories.output=release-xxx-rN`）。
  GitHub 直连约五成断连→重试 ≤5 次、间隔 6s（本版 0.15.0：首跑 npm 依赖树收集报
  `No JSON content found in output` → 换目录；随即下载 TLS 断连 → 重试第 2 次过）。
- **GitHub Release（gh 未登录，只能 token 走 API）**：创建 → 上传资产（清空代理直连）→ 补 notes →
  `PATCH {"draft":false}` 转正。**创建后必须先核对返回的 `tag_name`** —— 若 tag 没关联上，GitHub 会建成
  `untagged-<sha>`（曾传完 176MB 产物才发现）；修正：`PATCH {"tag_name":"vX.Y.Z"}` 改回即可，
  **不用删 release 重传产物**。
- **Release 三个高危坑（0.15.1 实测，必守）**：
  ① **POST 创建绝不放进「失败就重来」的循环** —— 曾因 break 条件读了子 shell 格式化后的文本
  （原始 `$out` 里没有）导致条件永不成立，**一口气建了 5 个 release**。break 只能基于 HTTP code。
  ② **curl 上传返 HTTP 000 不代表失败**：服务端可能已收下**截断的损坏文件**（Setup 传成
  85,553,915 ≠ 正确 88,121,546）。**发布前必须逐资产核对 size 与本地一致**，不对就删净重传。
     上传用 python urllib（uploads.github.com 稳）；curl 在这里易 000。
  ③ **api.github.com 约 50% 概率 000 / SSL EOF**：PATCH 转正要重试 10+ 次才命中。
  ④ Git Bash 里 curl 的 `--data-binary @/tmp/x.json` 读不到（/tmp 非 Windows 路径），
     必须用 `C:/Users/.../AppData/Local/Temp/x.json`。
- **历史遗留**：GitHub 上每个旧版本都有 2 个重复 release（1 资产 + 3 资产，多为 draft），
  清理属破坏性操作，需用户裁决。
- asar 头解析：pickle 格式，JSON 从 **offset 16** 起、长度读 `readUInt32LE(12)`（不是 offset 8 / readUInt32LE(4)）。
  校验必查 `app.asar.unpacked/vendor/node-pty/prebuilds/win32-x64/conpty.node` 已解包。

## 模块要点（坑；完整见 ADR）
- 浏览器（0011）：宁可降级别挂起、降级可见。挂起源：`Emulation.setDeviceMetricsOverride`（主进程消失）/`Page.captureScreenshot`（回退 `capturePage`）/`Page.navigate`（回退 `win.loadURL`）。缩略图用已得 PNG 本地 resize，别发第二次截图。
- 终端（0012）：子进程 env 剔 NODE_OPTIONS/NODE_PATH/ELECTRON_RUN_AS_NODE；降级 `via:'pipe'` 徽标可见。文件 Tab 用户亲手操作不走授权门。
- diff（0013）：LCS 回溯后必须吐完单侧剩余行（曾丢 add）。
- 渲染双环境：preload 无 require、app.js 是 IIFE → 共用纯逻辑写 **UMD-lite 单文件**（`module.exports`+`window.OrchDeskXxx`），挂 app.js 前，零构建。
- ADR-0008：主会话回合=直连工具循环+`firePreStep()`；别再提「接入 ctx.agents.followup」（P7 须新 ADR）。

## UI 布局（2026-09-05 重构后；改动前先看这里）
- 标题栏**只有**品牌/会话信息/时钟。浏览器·终端·文件三个文字按钮已移除：
  文件→右栏 TAB，浏览器/终端→**状态栏右下角图标区 `#sbActions`**（未激活灰/激活点亮/点击切换）。
- **浏览器侧栏与任务监控共用第 4 列**：`.app.browser-mode` 下 context 隐藏、browserSide 显示。
  Agent 首次调用浏览器自动展开（只在 `open` 跃迁上自动，否则用户收起后会被状态推送弹回来）。
- 浏览器「多TAB」= **页面快照卡**，不是真多页：`browser-cdp.ts` 是单隐藏 CDP 窗口
  （`let win: BrowserWindow`），登记簿上限 `BROWSER_PAGES_MAX=12`，截图回填缩略图。别冒充多标签并存。
- **终端是文档流抽屉**（`.term-drawer`，不是 fixed 覆盖层）：展开即挤压上方主区（app 是 flex:1），
  全屏档 `calc(100vh - 66px)`。高度变化后 xterm 必须重新 fit。文件面板仍是 fixed 全屏（预览要宽）。
- 待办数据源=语义化任务分拆（`extractPlanSteps`：结构化 plan 块 → markdown 列表回退），
  **完成度只用显式标记（[x]/✅）判定，不拿工具数猜**；工具调用是折叠的「执行明细」不是待办。
- **e2e 定位一律用 `data-id`，禁止 `nth(N)` 索引**：插入/重排 TAB 会静默切错页，
  表象是后续元素超时，排查极贵。文件 TAB 三个分支（正常/未绑定/读取失败）都必须有全屏入口按钮。
- 右栏 TAB = 待办 / 产物 / 文件 / **能力**（`ctx-tab` 的 id：`todo|products|files|caps`）。
  「能力」= 插件（`pluginRuntime` 真实装载）+ 技能（磁盘 `skills/*.skill` 真实扫描）+ MCP。
  改名前后两组数据都是假的，别再按旧名找 `skills`。
- **前端即时过滤实现**：插件/技能搜索（2026-09-06）走「预拼 `data-search` 小写 + 运行时
  `.style.display` 切换」，**不触发 render()**（避免丢输入焦点）。委托层收敛模式可复用：
  任何 `[data-action]` div 交互元素经 `hardenActions(root)` 一次性补 `role/tabindex`。
- **对比度纪律**：修改 `--fg-faint`/`--fg-dim` 须用相对亮度公式重算 ×(bg/panel) 双主题，
  浅色 panel 比 bg 容易翻车（用 ≥4.5 的色要挨个核）。现值（2026-09-06）：
  dark `#A6ADBB/#8A93A3`、light `#5F6B7A/#667085` 全 AA。
- **MCP 真接入**：零依赖 stdio 客户端在 `mcp-client.ts`（纯逻辑），不引 SDK。
  配置存 `数据目录/mcp.json`（`DATA_FILE_NAMES.mcp`），env 值 `encryptSecret` 加密。
  子进程 spawn 必须剔 NODE_OPTIONS/NODE_PATH/ELECTRON_RUN_AS_NODE（shim 会注入崩掉 server）。
  握手/列工具/调工具各自超时（15s/15s/120s）；id 走 `isMcpId` 白名单防穿越。
  IPC：`mcp-list/save/delete/set-enabled/probe/call-tool`。

## 技能(.skill)与连接器发现（2026-09-06）
- **.skill 真实格式（可复用知识）**：ZIP 且**根目录 = `<slug>/SKILL.md`**（不是 SKILL.md 在 zip
  根！），可含 references/scripts/ 子目录；SKILL.md 顶 YAML frontmatter(name/description)
  `---` 分隔。应用内 .skill **从不被解压执行**——是分发产物，只管理（列/删/上传）。
- **零依赖 STORE zip 打包器写法（曾经实现又删掉，重做可直接复用）**：不引 adm-zip/jszip。
  CRC32 多项式 0xEDB88320。手写 zip 必须用**系统 python zipfile 跨语言读回**验证
  （自己写自己读都对、别人读不了 = 最大风险）。
- **⚠ Skill 本地发布已回滚移除（2026-09-06 用户裁决）**：`publishLocalSkill` / `skill-pack.ts` /
  UI「发布到本地」全部删除，**保留从观雅集下载 skill**（guanji.listSkills+installSkill「安装」
  按钮）与发到观雅集（guanji.publishSkill）。用户当时要的方向是「发布到本地 ≠ 观雅集下载」，
  重提此功能前先确认形态（表单新建 vs 提示词库晋升）。
- **连接器自动发现** `connector-discover.ts`：parseGitCredentials → github.com 明文 token
  优先；gh hosts.yml 仅作「已登录」信号（token 混淆不可读，诚实返 usable=false）。
  自动发现**只回填不写盘**，用户点「保存并测试」才落盘（诚实预填 + 保存即探测兜底）。
  UI 只给有真实源的连接器（github）显示「自动发现」按钮，不硬凑假按钮。
- **本机 git-credentials 遮蔽坑（跨功能复发预警）**：`~/.git-credentials` 里过期
  x-access-token 常排在有效 token 前，任何「取第一条 github 凭据」的逻辑都会拿到坏 token
  （connector-discover 就命中了这条）。安全网靠「保存即探测」让真实 probe 401 暴露。

## 工具与 skill（本机）
- `impeccable`（UI/UX 审查）：不在 `~/.workbuddy/skills/` 但在 **`~/.workbuddy/skills-marketplace/skills/` 缓存**
  （31 个纯 md、零脚本）→ `cp -r` 装上即可，不用去观雅集/GitHub 搜。审查方法见其 `references/audit.md`。
- 审查结论见 `docs/40-质量/ui-ux-audit.md`（11/20；P1=对比度+键盘可达性）。

## 数据目录 / 模型层
- `dataDir()`=`ORCHDESK_HOME`>便携> `%APPDATA%/OrchDesk`；`migrateLegacyData()` 按 key 合并只补齐不覆盖。
- 工具双模式：优先 function calling；不支持走 `<tool:name>json</tool>` 文本兜底，结果 `role:'user'` 回传（`role:'tool'` 被网关拒）。
- 网关软拒绝：带 tools 返 200 空→逐级降级不带 tools，`Map<provider.id|model>` 记忆；去 tools 后仍空不误置 toolsRejected。

## 知识库与债务（docs/）
- 入口 docs/README.md；分层 00/10/20/30/40/50/60/70/80/99；ID `orch-<area>-<nnn>`；改后 `python scripts/audit_knowledge_base.py docs` 须 0 issues（脚本 2026-09-05 才落进 `scripts/`，此前文档写了门禁命令但仓库里没这个文件）。canonical：verify 计数→CHECKPOINT、结构→quality-gates、需求→PRD、分层→architecture。外部资料只引用不回拷；密钥/本机路径禁入。
- 最大欠账是勾选不是代码（PLAN 107 仅 23 已勾）；83 项运行期验收是**待执行**非环境阻断，别写「受 BUG-W02 门控」。对照 `docs/00-项目/openworker-对照-2026-09-03.md`。
- verify 缺环境隔离（用真实 dataDir，有污染 prod 遥测风险，待补）。
- 死挂点审计 v0.12.0 清零（累计 15+）：含零调用方/零写入方变体；契约+接线测试都要有。方法见 `~/.workbuddy/skills/dead-hook-audit/`。

## UI 交互纪律（插件页梳理 2026-09-07）
- **不留死按钮**：无 IPC 支撑的操作宁可删掉按钮，也不留「点了没反应/只弹 toast」的假动作
  （曾发现「查看审计日志」无 action、「卸载并回滚」假 toast、market-local-nav 空 case 三个）。
- **侧栏条目三分类**：pside-nav（滚+flash 高亮）/ ss-i-action（内联按钮）/ ss-i-static
  （显式不可点：cursor:default+opacity）——禁止「无 action 又不标 static」的僵尸条目。
- **e2e 断言用户可见状态必须元素级定位**：全文正则 /已安装/ 会撞「已安装（N）」标题假阳性。
- **UI 文案禁内部文档标识**（PRD FR-xx / ADR-xxxx）：代码注释保留引用，渲染文本一律不带。
- **conn-nav 类「滚动+render」**：render 重建 DOM 会丢滚动位置，须 requestAnimationFrame 后再滚。
- 侧栏 .ss-i padding 7px 10px（12px 字号下 5px 偏挤，用户可感）。
