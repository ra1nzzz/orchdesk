# ADR-0012：PTY 终端 Tab 与只读文件 Tab

日期：2026-09-02 ｜ 状态：已采纳 ｜ 关联：ADR-0010、ADR-0011、Minke 借鉴分析 P2-10/P2-11

## 背景

Minke 对照三块缺口（浏览器 / PTY 终端 / 文件 Tab）中的后两块。浏览器工具（ADR-0011）解决「Agent 能干活」，终端与文件面板解决「**用户能看着 Agent 干活**」——`shell_command` 每次都是一次性的子进程，没有交互式会话（vim / npm run dev / git rebase -i 都跑不了），也没有一个随时盯着项目目录的入口。

三个现实约束：

1. **node-pty 的来源不可靠**：dsh 运行时自建的 `.dsh-home/profiles/node_modules/node-pty`（1.2.0-beta.15，win32-x64 N-API 预编译，Electron/Node 通用）是现成可用的，但 `.dsh-home` 是运行期目录，打包链不保证它在；
2. **渲染层没有构建步骤**：xterm.js 与 shiki 都要进 `renderer/`，不能引打包器；
3. **宿主 shim 污染**：终端子进程若继承 `NODE_OPTIONS` / `ELECTRON_RUN_AS_NODE` 等变量，node 会退化或被劫持（本机已两次实测踩雷）。

## 决策

### PTY 终端

1. **node-pty 多候选加载 + 管道显式降级**，候选顺序：
   `ORCHDESK_PTY_MODULE` env 显式覆盖 > `<appDir>/vendor/node-pty`（vendor-dsh.cjs 物化，dev/packaged 同路径，`asarUnpack` 解出原生 .node）> `<appDir>/node_modules/node-pty` > dsh profile 目录。全部落空 → `child_process` 管道模式，`via:'pipe'` **必须可见**（状态徽标 + 新建会话 toast 警告），不许静默。
2. **环境净化是硬前提**：子进程 env 剔除 `NODE_OPTIONS` / `NODE_PATH` / `ELECTRON_RUN_AS_NODE` 等 shim 变量（`TERMINAL_ENV_STRIP` 清单），`LANG` 兜底 `zh_CN.UTF-8`。
3. **数据洪峰防护**：主进程 16ms 攒批推送；单条 256KB 超限截断并打显式标记 `…[orchdesk: 数据洪峰已截断]…`；每会话 64KB 回放缓冲，重开 Tab 补看历史；会话上限 6。
4. **UI 用全屏覆盖层而非 modal 体系**：xterm 实例与滚动位置不能随状态推送重绘——骨架只建一次（`dataset.ready`），头部与可见性单独更新；ESC 关面板但焦点在终端容器内时不抢（vim/less 也用 ESC）；xterm 缺失 → pre + 逐行输入降级，同样可见。

### 文件 Tab（只读优先）

5. **用户亲手浏览不走 Agent 授权门**（与浏览器工具相反口径）：文件面板是用户主动打开的目录视图，属用户自有操作；编辑 / diff / 写入后置 P3，届时再议授权。
6. **限额全部显式**：目录懒加载每次一层、单目录 500 条上限（超出 truncated 标注）；读取 ≤2MB，超限显式 truncated（不许静默）；二进制嗅探 = 扩展名快通道 + 头 8KB NUL 字节，命中只给元信息不吐内容。
7. **语言探测不许猜**：`languageOf` 映射不到 → null，渲染层不得自行猜测语言。
8. **shiki 用精简 bundle**：`createHighlighterCore` + `createJavaScriptRegexEngine()`（纯 JS 无 WASM，对齐 Minke），显式 import 12 语言 + 2 主题，esbuild IIFE 打成 `renderer/vendor/shiki-bundle.js`（897KB，`window.ShikiLite`）；高亮失败回落 pre 纯文本。

### 分层与验证（沿用 ADR-0010 铁律）

9. `terminal-tools.ts` / `file-panel.ts` 纯逻辑（零 electron）；`terminal-pty.ts` 宿主层（仅 node 内置）；`main.ts` 只接线。新增 `verify` 两套件：terminal-pty 26 项（含管道降级、攒批/截断/回放、IPC 推送链路）+ file-panel 15 项（真实临时目录），verify 链 21→23 套件、745→786 项。

## 后果

- 打包链新增一步物化（vendor-dsh 第 3 步）与 `asarUnpack`；node-pty 缺失只 warn 不阻断（管道降级兜底）。
- 终端会话生命周期完全在主进程（Map 管理），Tab 关闭即 kill；主窗口关闭随进程退出清理。
- 编辑器 / diff 视图 / 文件写入明确后置（P3），本 ADR 口径为只读。

## 审阅后加固（2026-09-02，yt-dev-review 三方并行）

首轮交付后经质量/效率/可复用三路审阅，修掉以下阻断项并补回归断言（不是风格调整，每一条都有可观测后果）：

1. **`ptyAvailable` 三态**：`ptyCache` 有 `undefined`（未探测）/ `null`（探测过，不可用）/ 函数（可用）三态。原写法 `ptyCache !== null` 在 `undefined` 时返回 **true**，与同行的 `via:'pipe'` 自相矛盾——「降级必须可见」在这里被自己破坏。改为 `!!ptyCache`，并补「未探测态不得冒充可用」断言。
2. **洪峰单条封顶缺一次 slice**：超限分支只截了历史尾巴，没截 chunk 本体，「64KB 尾巴 + 1MB chunk」照样绕过 `TERMINAL_CHUNK_MAX` 直推渲染层。改为先截 chunk 再对拼接结果封顶，断言补「单条推送长度 ≤ CHUNK_MAX+标记」。
3. **回放缓冲泄漏**：`pushExit` / `killTerminal` 都没清 `replayBuf`，反复开关终端按 64KB/会话 常驻（实测 1000 会话 +115MB）。两处补 `replayBuf.delete(id)`，退出时保留会话条目（用户要看最后一眼输出）但释放缓冲。
4. **已退出会话占名额**：上限 6 按 `sessions.size` 统计，连开 6 个短命令后就再也开不了新终端（只能手动关 Tab）。改为只统计活跃会话，并在新建时回收已退出条目。
5. **stdin 无 error 监听**：管道模式下进程退出后继续敲键触发 EPIPE → 主进程 uncaughtException。补 `child.stdin.on('error')`。
6. **扩展名被带点目录击穿**：`extOf` 对整个路径取 `lastIndexOf('.')`，`D:/proj/com.example/src/app.ts` 会取到 `example/src/app.ts` → 语言探测返回 null（高亮静默降级）、二进制扩展名快通道失效（写保护少一道）。收敛为 `common-tools.extOfName`（先切 basename）。
7. **readSync 单次读不循环**：短读时内容比磁盘短却声称完整，违反「截断必须显式」。改为循环读满，`truncated = st.size > maxBytes || read < want`。
8. **重复实现收敛**：新建 `common-tools.ts` 收 `clampInt` / `isAbsoluteLike` / `extOfName`（原 browser-tools、terminal-tools、file-panel、terminal-pty 各有一份 clamp，绝对路径正则四份），登记 arch-guard `PURE_MODULES`；`describeTerminalState` 由 `getTerminalState` 真实调用（此前零生产调用方 = 死挂点）；`humanSize` 成为 sizeLabel 唯一真源（渲染层 `fmtSize` 删除）。
9. **目录不 stat**：渲染层不显示目录大小，500 次 statSync（≈17ms 同步阻塞）里的大半是浪费；同时把扫描量上限与条目上限分开计数（大量坏链接时不会全量 stat 一遍才停）。

验证：terminal-pty 26→29 项、file-panel 15→20 项，全量 verify 805→**814 项**（24 套件）。
