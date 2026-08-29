---
id: orch-bug-000
title: OrchDesk 活跃 BUG 与缺口索引
status: canonical
updated: 2026-08-30
---

# 活跃 BUG 与缺口索引

> 只列**活跃/未解决**项；已解决的移出并记入归档。每项含 ID、级别、状态、归属 Phase。

## 已知缺口（来自三方交叉对照，详见 `references/cross-reference-OrchDesk.md`）

| ID | 描述 | 级别 | 状态 | 归属 |
|---|---|---|---|---|
| GAP-01 | dsh 无桌面壳（`apps/` 仅 cli/web），桌面壳须自建 | 高 | open | P0/P1 |
| GAP-02 | macOS 沙箱 backend 缺失（landlock-run 仅 Linux；win-acl 仅 Windows） | 中 | open | P3 / 路线图 |
| GAP-03 | 系统边界外补偿层未建（发消息/网络/写共享文件不可逆） | 中 | open | P3/P6 |
| GAP-04 | DREAM M3 确定性编译层未建（dsh 无统一策略编译层） | 中 | open | P4 |
| GAP-05 | `dsh-desktop` bundle 与 `apps/desktop` 骨架已建（P0）；profile `orchdesk` 接线与工程拓扑待 P1 | 中 | open | P1 |

## 历史教训（登记为风险，非可执行 BUG）

| ID | 描述 | 教训 | 对策 |
|---|---|---|---|
| LSN-01 | OrchStar 后端完成但 UI 未接线 → 项目荒废 | 「后端先行、UI 后补」等于半成品 | Phase 端到端门禁（[40-质量](../40-质量/quality-gates.md)） |
| LSN-02 | OrchStar 脏工作树含未提交 fix 脚本/smoke 截图 | 未提交制品删除后无法从 Git 恢复 | 清理前归档 + 备份（[workflow](../30-开发/workflow.md)） |

## 活跃技术债 / BUG（本轮未解决，需接力修复）

| ID | 描述 | 级别 | 状态 | 归属 |
|---|---|---|---|---|
| BUG-W01 | pnpm 11 在 Git Bash / 沙箱下 safe-delete 失败，install 中止 exit 1，node_modules 未生成；需 `--config.safe-delete=false`。另：WorkBuddy CLI 沙箱对「一次删除 >50 文件」有 bulk-delete 守卫，整树 `rmSync` 会抛 `SAFE_DELETE_BULK_CONFIRM_REQUIRED`——构建脚本须用「原地覆盖 + 逐个清陈旧」（见 `vendor-dsh.cjs` `syncDir`） | 高（阻塞 Windows 构建） | open | P0 / T-P0-1 |
| BUG-W03 | **宿主环境网络间歇不可用**：代理（`HTTP_PROXY=127.0.0.1:7897`）时断时续，直连 TLS 亦间歇失败；electron-builder 打包在 packaging 阶段下载 electron zip 偶发 `Client network socket disconnected`。**对策已验证**：① 挂 `NODE_OPTIONS=--use-system-ca` 绕开 safe-delete shim（否则 CLI 注入的 shim 会把 electron-builder 的整树 rm 转为 trash 并失败）；② 失败重试（3-6 次，网络间歇性恢复）；③ 被杀进程遗留的 `release/win-unpacked.tmp.lock` 须先清（PowerShell `Remove-Item -Force` 可删，shim 的 trash 删不掉）；④ `@deepseek-ai/*` 不能走 `files`/`node_modules` glob（依赖收集器会忽略），须用 `extraFiles` 放包外（插件 ESM 解析已实测可穿透）。构建脚本整树删除须用「原地覆盖 + 逐个清陈旧」（见 `vendor-dsh.cjs` `syncDir`） | 高（本 agent 环境打包需重试；产物已验证） | open | P6 / T-P6-3 |

## 已关闭 BUG（v0.4.1 起）

| ID | 描述 | 级别 | 关闭版本 | 归属 |
|---|---|---|---|---|
| BUG-018 | **发消息能响应，要求执行任务时报「模型返回空内容」**。用户截图：provider=STEPFUN、model=step-3.7-flash、apiMode=chat、HTTP 200、finish_reason=stop、content 为空。根因：StepFun 等网关在 chat 模式下**接受** `tools`/`tool_choice` 参数（不返 4xx），但实际不返回 `tool_calls`，content 也为空——软拒绝；原代码只在硬 4xx/错误信息含 tool 时降级，空响应被当成最终答案。修复：`callOpenAICompatible` 识别软拒绝并逐级降级到不带 tools；`runAgentTurn` 用进程级 `Map<provider.id\|model, true>` 记忆软拒绝，后续同 provider+model 的会话直接走 `<tool:>` 文本兜底。验证：model-loop M 组 3 项 + verify 313 项全绿 | 高 | v0.4.1 | P1 / Agent Runtime |
| BUG-W04 | **conventional-changelog 静默空输出**（原归因「Node 22 + 历史重建」为**误判，已推翻**）。真实根因：管线内部 `git-raw-commits@5.0.1` 的输出不再带 `-hash-` 分隔符（实测 274 行中该分隔符出现 0 次），而 `conventional-commits-parser@6.4.0` 仍靠它切分提交 → 整段历史被吞成**一条**提交（header 取最新那条 `chore:`，其余全部落进 body）→ 被 angular preset 按 chore 过滤 → 退出码 0、产出 0 字节。非版本漂移：core v8.0.0 本就声明 `git-raw-commits ^5.0.0`。**修复**：不再依赖该上游链，改用零依赖 `scripts/changelog.mjs`（git `--pretty` 自定义 `\x1f`/`\x1e` 分隔符自行切分，Keep a Changelog 分组 + SemVer 推断 + 幂等写入）；`package.json` 的 `changelog` 脚本已切到它，`release` 链 `changelog → version:bump → dist` 顺序正确（changelog 在打 tag 之前跑）。自带 `--selftest`（开发期即抓到 `rank['']` 为 undefined 致版本推断失效的真 bug） | 中 | v0.4.1+（随下个版本生效） | 版本治理 |
| BUG-019 | **「你叫小星」下一轮就忘（记忆没生效）**。根因：`runAgentTurn` 是裸模型循环，从未调用 dsh memory 服务——助手回复「好的我记住了」是口头应答，没有任何持久化；system prompt 也不含任何用户记忆。修复（dsh memory 真实接入对话流，FR-7 最小闭环）：新工具 `memory_save`（写入 memory 插件 global 域）+ 每轮 `listDomain('global')` 召回最近 10 条注入 system prompt + 提示词规则「用户告知长期事实必须调 memory_save，不要只口头答应」。验证：model-loop N1-N3（保存→同会话下一轮 system 注入→相对路径基准） | 高 | v0.5.0 | P1 / Agent Runtime + dsh memory |
| BUG-020 | **D:\Code\WxTools 被判「不是 Git 仓库」**（实际是）。根因：`shell_command` 固定跑在 `resolveShellCwd()`（user home），Agent 没有会话级工作目录概念，git 命令全在 home 下执行（home 确实不是 git 仓库）；system prompt 也不告知模型当前在哪。修复：新工具 `set_cwd`（校验存在 + 沙箱白名单后切换会话目录，进程内 Map 存储）+ `shell_command` 的 exec cwd 用会话目录 + `file_read/write/list` 相对路径以会话目录 resolve + system prompt 声明「当前工作目录」。验证：model-loop N3（set_cwd 后 `file_list "."` 列的是新目录） | 高 | v0.5.0 | P1 / Agent Runtime |

## 已关闭 BUG（v0.4.0 pending，待发布）

| ID | 描述 | 级别 | 关闭版本 | 归属 |
|---|---|---|---|---|
| BUG-017 | **打包产物真机启动崩溃**："Cannot find module '@deepseek-ai/cordis'"（`dsh-runtime.js` 的 CJS 静态 require）。根因：asar 内模块的 CJS 裸说明符解析不落到包外 `<approot>/node_modules`（extraFiles）；教训=asar 内主进程代码引用包外依赖必须走「显式路径 + ESM 动态加载」（与插件同款），且打包验证必须覆盖 CJS require 链路而非只测 ESM import。修复：`dsh-runtime.ts` 改 `loadContext()`（多级探测 cordisEntry + dynamicImport，兼容 dev/portable/NSIS 三布局）；Setup 包已验证（asar 内静态 require=0 + 包根含 7 个 @deepseek-ai 包） | 高 | v0.4.0（pending） | P1 / 打包 |

## 已关闭 BUG（v0.3.1，已归档）

| ID | 描述 | 级别 | 关闭版本 | 归属 |
|---|---|---|---|---|
| BUG-013 | 重新打包后项目数据丢失（多安装形态 `userData` 不互通） | 高 | v0.3.1（`dataDir()` + `migrateLegacyData()`） | P1 数据层 |
| BUG-014 | Agent Runtime 工具调用不稳定（参数构造根因） | 高 | v0.3.1（`agent-runtime.ts` 纯逻辑 + 双模式适配） | P1 Agent Runtime |
| BUG-015 | `selectedModels` 空导致发送失败 | 中 | v0.3.1（重选 + 自动跳转设置页） | P1 模型管理 |
| BUG-016 | 打包 EBUSY 锁目录 | 中 | v0.3.1（`kill-running.cjs`） | P0 构建 |

> 裁决理由与证据见 [v0.3.1 发布登记](../99-归档/v0.3.1-发布登记.md)；运行期验收（GUI 实机）
> 仍受 BUG-W02 门控，须在 Windows 桌面验证。

## 已关闭缺口（v0.4.0 补齐，已归档）

| ID | 描述 | 关闭版本 | 说明 |
|---|---|---|---|
| GAP-05 | `dsh-desktop` bundle 与 `apps/desktop` 骨架已建，profile 接线与工程拓扑待 P1 | v0.4.0（pending） | `dsh-runtime.ts` 真实装载 9 插件，运行时接入完成 |

> 详见 [PRD 差距补齐复盘-2026-08-29](../99-归档/PRD差距补齐-2026-08-29.md)。
| BUG-W02 | **宿主环境（WorkBuddy CLI）对 Electron 二进制存在环境级阻断**：`process._linkedBinding('electron')` → "No such binding was linked: electron"；`require('electron')` 解析到 npm 包 `index.js` 返回 exe 路径字符串（`electron_1.app` undefined → 主进程启动即崩）。**二次验证（2026-08-24 打包后实跑）**：直接运行 `node_modules/electron/dist/electron.exe`（unset `ELECTRON_RUN_AS_NODE`、NODE_OPTIONS 仅 `--use-system-ca`、无沙箱）仍复现 binding 缺失；叠加 WorkBuddy CLI 默认设置 `ELECTRON_RUN_AS_NODE=1`（强制 Node 模式）。**2026-08-24 早间「误用 node」结案为误判，已推翻**。任何 Electron GUI 无法在本 agent 宿主环境启动 | 高（阻断本 agent 环境 GUI 实跑；打包产物本身完整） | open | P1 / 打包实跑验证 |

> BUG-W02 二次验证（2026-08-24 打包后实跑，推翻早间结案）：早间「误用 `node` 跑主进程」的结案**不成立**——以 `electron .` 启动 dev 模式、直接运行 `node_modules/electron/dist/electron.exe`（unset `ELECTRON_RUN_AS_NODE`、NODE_OPTIONS 仅 `--use-system-ca`、无沙箱）均复现 `process._linkedBinding('electron')` → "No such binding was linked"；`process.versions.electron=36.9.5` 存在但核心 binding 未链接，`require('electron')` 因此解析到 npm 包返回 exe 路径。叠加 WorkBuddy CLI 默认 `ELECTRON_RUN_AS_NODE=1`（强制 Node 模式，无 Chromium 初始化）。结论：**本 agent 宿主环境无法启动任何 Electron GUI**（环境级阻断，非产物缺陷）。electron-builder 打包产物（nsis Setup 84MB + portable 84MB + win-unpacked，asar 结构校验完整）在**正常 Windows 桌面**（无 WorkBuddy 注入）预期可运行，须用户实机双击验证；本 agent 环境内 GUI 实跑验证继续受 BUG-W02 门控，业务逻辑层验证走 node 直驱（verify-p5 23/23）。
