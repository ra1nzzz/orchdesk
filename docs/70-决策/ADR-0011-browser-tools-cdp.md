# ADR-0011：浏览器工具走 Electron 自带 CDP

日期：2026-09-01 ｜ 状态：已采纳 ｜ 关联：ADR-0010、Minke 借鉴分析 P1、PRD 插件市场「浏览器插件」

## 背景

Minke（同底座同类项目）的产品能力对照里，OrchDesk 缺三块：**浏览器工具 / PTY 终端 / 文件 Tab**。其中浏览器是「让 Agent 真正能干活」的关键一环——只会读文件与跑命令的 Agent 干不了任何需要网页的事（查价格、填表单、读后台数据）。

选型时的三个现实约束：

1. 仓库里**已装 playwright**，但它是给外部自动化脚本用的（E2E 套件），体积大、要独立下载 Chromium、启动一次几百毫秒到数秒；
2. 独立 Chromium **没有用户的登录态**，遇到需要登录的站点（电商后台、内部系统）直接废掉一半能力；
3. Electron **自带 CDP**：每个 `webContents` 都有 `debugger`（协议 1.3），无需任何新依赖。

## 决策

1. **用 `webContents.debugger` 驱动一个内置 BrowserWindow，不引入 playwright / puppeteer。**
   - 选 CDP 而非 `webContents.executeJavaScript`：前者支持 `awaitPromise` / `returnByValue` / `userGesture` / 超时，且不受页面 CSP 与上下文污染影响；截图与导航等待也属同一套协议。
   - 默认 `show:false` 后台窗口（不打断用户），用户可随时从标题栏「浏览器」面板调出 / 收回 / 关闭。
2. **共享用户默认 session（保留登录态）**，不做独立 session 隔离。代价是 Agent 能看到用户已登录的页面，因此：
   - 导航 = 边界外网络访问 → 域名白名单，非白名单过补偿层外发二次确认（与 `web_fetch` 同口径）；
   - `browser_click` / `browser_type` / `browser_eval` = 真实改变页面（下单、发帖、删数据）→ 授权门（与 `file_write` 同档，paranoid 模式全锁）；
   - 每一次判定都进沙箱日志（新增 `kind: 'browser'`），事后能回答「Agent 在哪个网页上点了什么」。
3. **工具集 8 个**：`browser_open` / `browser_text` / `browser_links` / `browser_click` / `browser_type` / `browser_screenshot` / `browser_eval` / `browser_close`。并入统一工具表（`TOOL_DEFS`），模型侧只有一张清单。
4. **分层沿用既有铁律**：
   - `browser-tools.ts`（纯逻辑，零 electron）：工具 schema、参数归一化与钳制、**页面内 JS 表达式构造**、脚本风险扫描、截图路径规则、状态描述；
   - `browser-cdp.ts`（宿主层）：窗口生命周期、CDP attach、`Page.navigate` 与加载等待、`Runtime.evaluate`、`Page.captureScreenshot` 落盘；
   - `main.ts` 只做接线（工具分派 + 授权/外发门 + 沙箱日志 + IPC）。
5. **表达式构造必须可单测**：这是本模块唯一的注入面（模型给的选择器/文本要拼进 JS 源码）。所有注入值一律经 `JSON.stringify`，并在验证套件的**假 DOM 里真跑一遍**（断言引号、反斜杠、换行不逃逸，且语义正确）。
6. **UI 是验收底线，不是装饰**：Agent 在后台窗口操作网页，若用户没有观察与制动入口就是黑箱。渲染层必须提供标题栏入口 + 状态面板（标题/地址/最近截图缩略图 + 显示/隐藏/关闭 + 截图目录），并通过状态推送实时跟随。

## 理由

- **零依赖**：CDP 是 Electron 自带的。不再引入一个下载 Chromium 的重型依赖，也避免打包体积与更新校验链的复杂度（Minke 那边这三条都是要维护的）。
- **登录态是能力的一半**：能打开网页但没有权限 ≈ 没用。共享 session 的代价由授权门覆盖，而不是靠隔离来回避。
- **可控与可测**：CDP 命令是显式的方法调用列表，可以在 stub electron 下断言「命令真的发出去了」——这比黑盒地调 `executeJavaScript` 好验证得多。
- **为什么不做真 headless**：Electron 没有官方 headless 模式；`offscreen:true`（OSR）在部分显卡驱动上截图有兼容问题，且无法显示给用户看。隐藏窗口已足够。

## 不做

- 独立 Chromium（playwright / puppeteer）——体积 + 无登录态 + 与已装的 playwright 用途混淆；
- 独立 session / 隐私模式——会丢登录态，收益（隔离 Cookie）由授权门以更低成本覆盖；
- 远程浏览器 / 多标签并发——当前单窗口单标签，够用再说；
- 自动等待策略（networkidle 等）——只提供 `load` / `dom` 两档，避免把不可判定的等待条件写进工具契约。

## 后果

- 正向：Agent 具备真实网页能力；工具链与既有安全口径一致（白名单 + 授权门 + 沙箱日志）；用户有观察与制动入口。
- 代价与风险：
  - Electron 升级可能改变 CDP 行为（`Emulation.setDeviceMetricsOverride` / `Page.captureScreenshot` 已做失败忽略）；
  - 后台隐藏窗口仍有内存与 CPU 占用，用户需能一键关闭（面板已提供）；
  - `browser_eval` 等价在网页里执行任意代码，只在授权门后执行，且拒绝时命令绝不下发（有回归测试守护）；
  - 工具数量从 7 增至 15，会影响每轮请求的 token 用量——三处硬编码「7 个工具」的断言已改为从工具表取数，后续新增工具不会再撞这套断言。

## 验证分两层：为什么还有个不进 verify 链的冒烟脚本

`browser-tools-verify.cjs`（39 项，在 `npm run verify` 里）用 stub electron 驱动真实 `dist/main.js`，
能证明「命令发出去了 / 门没开时不下发 / 截图落盘路径对 / 沙箱日志有留痕」，但**证明不了真机上
`debugger.attach` → `Page.navigate` → `Runtime.evaluate` → `Page.captureScreenshot` 真能跑通**。
这只有真 Chromium 能回答，而真 Chromium 需要可用的 GPU/渲染进程。

所以另设 `apps/desktop/scripts/browser-smoke.cjs`（`pnpm run smoke:browser`），**刻意不进 verify 链**：
CI 与非交互会话里 GPU 进程起不来，硬塞进去只会得到一条环境噪音造成的假红，进而诱使人放宽断言。

实测到的两个环境坑（已写成脚本启动期的显式报错，退出码 2）：

1. `ELECTRON_RUN_AS_NODE=1`（从 Electron 宿主应用继承而来时很常见）会让 `electron.exe` 退化成纯 Node，
   `require('electron')` 返回路径字符串、`app` 为 `undefined`。跑法：`env -u ELECTRON_RUN_AS_NODE electron scripts/browser-smoke.cjs`。
2. 脚本必须放在 `apps/desktop` 下，否则 `require('electron')` 解析不到 `node_modules`。

冒烟覆盖 11 步：环境自检（绕开产品代码先开一个窗口，用来区分「环境不行」还是「代码不行」）
→ 本地 http 测试页导航 → 取正文 → 取链接 → 填值 + 回读（引号/反斜杠不逃逸）→ 点击命中
→ 点击缺失元素必须报错 → 截图 PNG 真落盘 → 状态带 `lastShot` → 关闭后归零。

### 真机实测（2026-09-01，Electron 36.9.5）：11/11 通过，并暴露三个必须留降级的问题

在受限会话（无 GPU 合成、无交互桌面）里跑通了全链路，`Runtime.evaluate` / `Page.navigate` /
`Page.captureScreenshot` 全部走 CDP 正路（`via=cdp`，截图 12408 字节）。过程中暴露三点，
**都不是「CI 才有的怪事」，在用户锁屏 / 远程桌面 / 最小化时同样会发生**：

1. **`Emulation.setDeviceMetricsOverride` 会让主进程直接消失**（退出码 127、stdout 空、
   连 `try/catch` 都来不及）。它只用于把视口与设备像素比对齐（窗口本身已是 1280×900），
   价值有限 → 现在带 2s 超时 + 失败忽略，且在 `ORCHDESK_BROWSER_NO_SANDBOX=1` 时直接跳过。
2. **`Page.captureScreenshot` 取不到合成帧时会永久挂起，而不是报错**。同环境下 Electron 原生
   `webContents.capturePage()` 68ms 就出图 → 截图改为「CDP（带超时，默认 8s）→ capturePage 回退」，
   回退时如实告知模型只截到视口，不冒充整页。
3. **`Page.navigate` 挂起时页面根本不会被打开** → 回退 `win.loadURL()`（did-finish-load 才 resolve）。
   同理 `Page.enable` / `Runtime.enable` 只是锦上添花（前者只为收 `loadEventFired`，后者对
   `Runtime.evaluate` 非必需），改为带超时的可降级调用；`Runtime.evaluate` 外层再加超时，
   超时后退回 `executeJavaScript`（缺 awaitPromise / CSP 豁免，只作最后兜底）。

**原则**：CDP 出问题时宁可降级也不要挂起——「工具没反应」比「降级后功能少一点」糟糕得多，
且降级路径必须**可见**（结果里带 `via`，沙箱日志写明「已回退 capturePage」），
不许用「跑通了」掩盖「其实是兜底跑通的」。

另外两个纯环境坑（也已写进脚本）：没有主窗口时关掉最后一个窗口会让 Electron 默认 `quit`
（表现为跑一半静默退出、rc=0 且无结果），冒烟脚本必须拦 `window-all-closed`；
冒烟过程中不要中途开关窗口（关掉后再新建并 attach 会让主进程消失）。
