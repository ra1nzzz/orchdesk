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
