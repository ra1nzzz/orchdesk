# CHECKPOINT

> 项目状态快照 + 版本治理 + 关键决策 + 下一步。
> 本文件是「项目进行到哪了」的唯一入口，阅读本文件即可接续工作。
> v0.4.1–v0.15 的超长版本日记已迁至 [CHECKPOINT-version-diary-0.4-0.15](../99-归档/CHECKPOINT-version-diary-0.4-0.15.md)。

---

## 1. 项目状态

| 维度 | 状态 | 说明 |
|------|------|------|
| **当前版本** | `0.16.2`（未打 tag；修复模型空闲超时与渲染进程闪退） | SemVer，权威版本见 `apps/desktop/package.json` |
| **最新 Commit** | `4aa7553` | docs(发布): 补充 v0.16.0 发布记录 |
| **主线分支** | `main` | protected，push 需 CI 通过 |
| **远端仓库** | `ra1nzzz/orchdesk` | GitHub，public |
| **最新 Release** | [v0.16.0](https://github.com/ra1nzzz/orchdesk/releases/tag/v0.16.0) | 发布记录见 [release.md](../50-发布/release.md) |
| **文档审计** | 以知识库审计为准 | canonical 文档与代码保持一致 |
| **TypeScript** | tsc EXIT=0 | 全栈编译无错误 |
| **验证套件** | 以 `apps/desktop` 的 verify 链为准 | 28 套件（含 e2e / event-emit）；计数以实际跑链为准，此处不假装刚跑过 |
| **真机冒烟** | 待人工执行 | GUI 实机仍受环境门控；清单见 [smoke-checklist](../40-质量/smoke-checklist.md) |

### 1.1 PRD 完成度

代码侧 P0–P6 主体已接线（死挂点清零与各版交付见 [版本日记](../99-归档/CHECKPOINT-version-diary-0.4-0.15.md)）；v0.12 时点加权完成度估约 98%。剩余主要是用户环境运行期验证（GUI 实机冒烟 / 真实模型闭环）、FR-7 Hub 联调（PRD 明示首发不含）与 P7 完整事件化。判定口径仍同 [差距盘点](../99-归档/PRD差距盘点-2026-08-29.md)：「已接线」= 有真实数据流。补齐复盘见 [PRD差距补齐-2026-08-29](../99-归档/PRD差距补齐-2026-08-29.md)。

## 下一步

- GUI / PTY / CDP 实机冒烟仍待正常 Windows 桌面按 [smoke-checklist](../40-质量/smoke-checklist.md) 回勾。
- 工程债（已开工、未收口）：`runAgentTurn` 已抽到 `agent-turn.ts`；`executeTool` 已抽到 `tool-exec.ts`。IPC 已抽到 `ipc-browser.ts` / `ipc-terminal.ts` / `ipc-file-panel.ts` / `ipc-connectors.ts` / `ipc-mcp.ts` / `ipc-market.ts` / `ipc-sandbox.ts` / `ipc-authz.ts` / `ipc-memory.ts` / `ipc-prompt.ts` / `ipc-plugins.ts` / `ipc-guanji.ts` / `ipc-hub.ts` / `ipc-data-ops.ts` / `ipc-desktop.ts`（须在 `ipcMain.handle` sender 门 patch 之后注册）。`main.ts` 仍含会话 / 模型 / TRACE / 用量 / 项目 / `set-session-cwd` 等其余 IPC。O2 双 runtime 与 SessionStore **不要**在本轮做。回合 abort 已接线。chat/ollama **请求 `stream:true`**：SSE/NDJSON 增量 `onDelta`；JSON 网关整包兜底；网关 400/415/422 拒流时同轮改 `stream:false`（含 tool 的 400 仍走工具降级）。`responses`/`completions` 仍非流式。
- 版本治理细节见 [VERSION-GOVERNANCE](./VERSION-GOVERNANCE.md)；打包与 Release 踩坑见 [release.md](../50-发布/release.md)。
- 当前产品状态 canonical 页：[current-state.md](./current-state.md)。

## 关键决策

| 决策 | 方案 | 理由 |
|------|------|------|
| 版本治理 | SemVer + Conventional Commits + bumpp | 行业标准，GitHub 生态原生支持 |
| 自动更新 | electron-updater + GitHub Releases | 零成本，无需自建服务器 |
| CI/CD | GitHub Actions | 仓库原生，无需第三方 |
| 脚本约束 | 唯一版本修改入口 | 避免手动编辑导致版本漂移 |
| 更新前快照 | snapshotData → snapshots/ | 更新失败可回滚 |

完整 ADR 见 [docs/70-决策/](../70-决策/)。

*上游文档：[current-state.md](./current-state.md) | [VERSION-GOVERNANCE.md](./VERSION-GOVERNANCE.md) | [PRD差距补齐复盘](../99-归档/PRD差距补齐-2026-08-29.md) | 变更日志 `apps/desktop/CHANGELOG.md`*

---

## 简化方案实施 CHECKPOINT（2026-09-23）

方案 spec：`docs/superpowers/specs/2026-09-23-orchdesk-simplification-design.md`（C 混合 · 参考 ZCode）

| 阶段 | 状态 | 内容 | 验证 |
|------|------|------|------|
| P1.1 布局双态 | ✅ 完成 | `viewMode` state（light 默认）+ `.app.light/project` class；右栏默认收起（`ctxOpen: 0`，chevron 可展开）；light 栅格 60/240/1fr | e2e 262/262、全链 CHAIN_EXIT=0、浏览器冒烟确认 |
| P1.2 导航收拢 | 待做 | rail→Ctrl+K/图标抽屉 + e2e nav helper 改编（23 处） | — |
| P1.3 任务监控浮出 | 待做 | 回合中自动浮出 + 结束收起 | — |
| P1.4 隐式 cwd | 待做 | 会话不问项目 + 按目录分组（复用 sessionCwd） | — |
| P2 模型内嵌 / P3 项目模式 / P4 UX 调研 | 待做 | 见 spec §9 | — |

**P1.1 实施记录与发现**：
- e2e 右栏交互点（组 5/BUG-023/死挂点④⑥）新增 `ensureCtxOpen()` 可见性前置——元素始终在 DOM（CSS 隐藏），数 count 会把隐藏当已展开（原④守卫因此失效）
- 侧栏项目展开点击增加“校验+有界重试”：整段 innerHTML 重渲染与点击窗口存在竞态，单次点击曾落在相邻项目（mousedown/mouseup 间 DOM 移位）——低危产品观察，记录待办
- 拆分策略调整：app.js 单 IIFE 与 ~20 个内部符号深度耦合，独立“纯搬迁”阶段风险过高，改为随 P1.2/P1.3/P1.4 增量抽取（layout.js/welcome.js）

| P1.2 导航收拢 | ✅ 完成 | 标题栏 ☰ + Ctrl+K 导航抽屉（会话/插件/设置/主题）；light 模式 rail 隐藏、60px 列去除；Esc/外点关闭；导航后自动关抽屉 | e2e 266/266（23 处导航改走 navTo + 4 项新断言）、全链 CHAIN_EXIT=0、冒烟确认 |

| P1.3 任务监控浮出 | ✅ 完成 | 轻模式回合开始自动浮出右栏（含入场动画）；回合结束 5s 自动收起（仅自动开过的面板）；回合中手动 toggle = 用户接管；工具步骤期间右栏实时刷新 | e2e 269/269（新增组 3B：自动开/手动接管/结束不自动动）、全链 CHAIN_EXIT=0 |
| 测试基建修复（flaky 消除） | ✅ | credentials-verify「治理项⑥ dirty 合并 flush」的真因不是写盘计时，而是探针子进程 `require(dist/main.js)` 后 Node 退出阶段与 Cordis 悬挂句竞炸 libuv 断言（UV_HANDLE_CLOSING）——约 50% 概率把已打印的 TOOL_JSON 一起吞掉，非零退出被当成 probe 失败。修：① 三次判定改 `Promise.all` 并发打出（顺序 await 的 IPC 往返延迟会把三条拉出同一 100ms 窗口，慢机恒定 3 次写，测的是机器速度不是合帧）；② 探针容错对齐本文件首个 probe 的口径——err.stdout 里已有 TOOL_JSON 即采信，只有连结果都没打出才算真失败。5 连跑 EXIT=0 | — |

| P1.4 隐式 cwd | ✅ 完成 | state.workspaceDir（localStorage 持久化）+ 欢迎页「设置工作目录」chip + 项目选择降级可选；轻会话携带 cwd；applySessionCwd 回落会话级 cwd；轻模式侧栏按工作目录分组（无 cwd 归「任务」组，旧行为不变） | e2e 270/270（新增 chip 断言）、全链 CHAIN_EXIT=0、冒烟确认 |
| 测试基建修复 | ✅ | verify-plugins.mjs 退出竞态：process.exit 与 Cordis 悬挂句竞炸 libuv 断言（0xC0000135，92/0 全过仍误红）——加排空+dispose 收尾，3 连跑 EXIT=0 | — |

### P1 收口评审（yt-dev-review 三维九域 · 2026-09-23）

三维并行评审 + 六盲区扫描，Evidence-Gated 评分：**A 质量 6.5/10 · B 效率 8/10 · C 可复用性 8/10**。
收敛判定：**PASS（附 P2 修复轮已闭环）**——P0 无、P1 ×2 修复后复验通过、P2 ×13 全部修复并回归。

**P1 缺陷（2 项，已修复并复验）**
- P1-1 `actions/plugins.js` 技能卸载确认按钮读 `el.dataset.n`，实际 DOM 只有 `data-id` → 改 `dataset.id`
- P1-2 `actions/session.js` `act_home_send` 任务分支建会话后未下发 cwd → 补 `ctx.applySessionCwd(id)`（隐式 cwd 此前只在 `act_sel` 重放，首回合跑默认目录）

**P2 缺陷（13 项，本轮修复）**

| # | 位置 | 缺陷 | 修复 |
|---|------|------|------|
| A-P2-6 / B-1 | `app.js` scheduleLiveRender | 右栏每 150ms 全量重算 + 整块 innerHTML 替换，非待办 TAB 也被刷、滚动位置被打回顶部 | 加 `ctxTab==='todo'` 门控 + `.ctx-body` scrollTop 保存/恢复 + 替换后 `hardenActions` |
| A-P2-1 | `app.js` toggleNavDrawer / openMenu | 外点关闭监听用 `{once:true}`，点抽屉内「切换主题」（不关抽屉）后永久失去外点关闭 | 去 once，改常驻监听 + 监听内自判自摘（openMenu 同款一并修） |
| A-P2-2 | `app.js` 预设键盘导航 | 用 `:not(.hidden)` 判可见，但 `mpPresetFilter` 用内联 `style.display` → 过滤后仍跳到隐藏项 | 改按 `style.display !== 'none'` 过滤 |
| A-P2-3 | `app.js` 插件页侧栏 | `#psec-mcp/temp/connectors/market` 兜底行完全静态 → 「分区无侧栏入口」告警误报、用户只能滚屏发现 | 新增 `secJump` 行（可跳分区、视觉弱化、不假装有内容） |
| A-P2-5 | `app.js` Ctrl+K / 抽屉定位 | Ctrl+K 无终端焦点守卫（终端内误唤抽屉）；锚点隐藏时抽屉定位到 (0,0) 被裁 | 补 `inTerm` 守卫；`offsetParent` 判可见，不可见回落到 (48px,12px) |
| A-P2-8 / C-F3 | `app.js` + actions/* | confirmDestructive / confirmRename / confirmArchiveProject / confirmNewBranch 的 title、data-id、input value 未转义；4 个调用方 title 直插动态值 | 统一 `esc()`（含调用方插值） |
| C-F4 | `styles.css` | `.app.light` 与 `body.light-mode .app` 四规则两两等价，双钩子改一处漏一处即布局漂移 | 网格列规则只留 `.app.light` 一处；`body.light-mode` 仅保留 rail 隐藏与 ☰ 显隐 |
| C-F5 | `e2e-fix-verify.cjs` | `navTo` 只走抽屉，project 态（☰ 隐藏）全组导航用例将集体超时 | 优先 `#rail [data-action="nav"]`，不可见才回退抽屉 |
| A-P2-4 | `app.js` mpEnsureCatalog | 目录失败置 `[]`，与「真空目录」不可分且无重试 | 失败置 `null` + 显式说明 + 「重试」按钮（新 action `mp-catalog-retry`） |
| C-F1 / F2 | `app.js` | `sessItem` 在 renderProject 内联一份副本；路径末段逻辑三处重复 | `sessItem` 提为函数声明共用；新增 `dirBase(d)` 一行级共用（3 处） |
| A-P2-7 | `scripts/verify-plugins.mjs` | C1 用例断言失败时 `setOutcome`/`setAuthModeStore` 泄漏到后续用例（check 不抛出）→ 假绿 | 3 处改 try/finally 复位 |
| C-F8 | `actions/session.js` | `ctx.closeNavDrawer && ctx.closeNavDrawer()` 多余守卫 | 直接调用（ctx 注入面保证存在） |
| A-P2-9 | `app.js` | P1.3 注释与 spec「用户可钉住」的口径不一致 | 注释改写为三态语义（自动开 / 空闲手动=钉住 / 本回合手动仅当回合接管） |

**ACCEPT AS-IS（延后，记录理由）**
- C-F6：ctx 暴露 11 项 mp helper，待 P2 模型 chip 落地时一并收 `ctx.mp` 命名空间
- C-F7：verify-kit 的 disposeAndDrain 共享，等第三个 Cordis 套件出现再抽
- pickWorkspace 的 prompt 兜底无 toast；mpModelChips 未知 cap 显示「推理」
- credentials-verify「治理项⑥ dirty 合并 flush」100ms 窗口计数 flaky（机器负载波动误判，重跑即过）

**验证**：全链 `pnpm run verify` CHAIN_EXIT=0；e2e **275/275**（基线 273 + A-P2-1 抽屉回归 2 项新断言）；浏览器冒烟（轻模式欢迎页 / 抽屉展开 / 抽屉内切主题后外点仍可关 / 主题与布局）通过，端口已清理。

### P2 模型内嵌（2026-09-24 · spec §5.3）

出口标准（spec §9）：**零配置 Ollama 用户打开即聊；无模型用户 ≤3 次点击可聊**——两条都达成并回归。

| 层 | 内容 |
|---|---|
| 主进程 | 新 IPC `orchdesk:ollama-probe`（复用 `listAvailableModels` 的 `/api/tags`→`/v1/models` 老版本回退，不另造探测）；preload `probeOllama`；共享 `bridge-stub.js` 补桩（无桥时 `ok:false`，不用空数组冒充「探过但没装」） |
| 渲染层 | `modelChipState/modelChipHTML` 四态 chip（ready 绿 / ollama 橙「发现 Ollama · 一键接入」/ none 黄「未配置模型」/ demo 紫「演示模式」），欢迎页+会话页共用一份（原两处逐字重复）；`refreshCtxLive()` 提为 IIFE 级 helper（P1.3 实时刷新与 P2 演示回合共用同一份门控） |
| 内嵌面板 | `openModelSetupModal()`：复用设置页同一套 `mp*` 表单状态与动作（预设搜索 / KEY 防抖拉取 / 默认全选），仅把「类型/名称/URL/协议」收进高级折叠；`act_model_add_provider` 增 inModal 分支（添加后关模态 + 退出演示 + autoSelect + render），设置页原行为不变 |
| Ollama 接入 | `adoptOllama()` 写真提供商配置（持久化）；模型池**直接用刚保存的 providers 建**，不回读 `getModelConfig`——回读拿到保存前快照会把刚接入的提供商冲掉，chip 于是回到「未配置」，接入看起来没生效 |
| 演示模式 | `runDemoTurn()` echo Agent：模拟工具步骤走与真回合同一套 `state.toolSteps` 通道（右栏待办有内容可看），回复明确自证「本地回显，未调用任何模型」；`doAbortSend` 演示分支（无主进程回合可停）；`s.model='演示模式'` 侧栏如实标注 |

**实施中自查发现并修复的 4 个缺陷**（都在本轮闭环，非评审提出）：
1. `doSend` 只改 `state.demoMode` 不重渲染 → 整个回合 chip 停在「未配置模型」。修：回合中就地换 chip + 回合末 `render()`（与真回合路径同一处）
2. 演示分支 `return` 在 `try/finally` 之前 → 真回合的「5s 自动收梢」被跳过，演示回合的面板永远不收。修：收梢逻辑移入 `runDemoTurn` 的 finally
3. 演示消息 `intent:'DEMO'` → `renderMsg` 渲染成「意图 · 已拦截」徽标（彻底的误告）。修：用 `'ACT'`
4. 演示消息 tools 形状 `{name,result}` 与主进程 `toolSteps` 的 `{n,ph,result}` 不一致 → 工具行渲染空名、摘要「undefined 步」。修：对齐形状 + 补 `steps`

**演示模式的两条诚实保障**（防「配置了真模型却还在 echo」）：`autoSelectModels` 产出非空选择即清 `demoMode`；`modelChipState` 中就绪态优先于演示态。双保险，UI 不许撒谎。

**验证**：全链 CHAIN_EXIT=0；e2e **292/292**（基线 275 + P2 组 17 共 17 项新断言：chip 三态 / 内嵌面板不跳设置页 / Ollama 一键接入落盘 / 演示回显自证 / chip demo 态 / 右栏浮出且演示步骤入栏）；浏览器冒烟（无桥态 chip「未配置模型」→ 内嵌面板 → 预设下拉展开且如实报「目录获取失败+重试」→ 演示回合全链路）通过，端口已清理。

| P2 模型内嵌 | ✅ 完成 | Ollama 自发现 IPC + composer 四态 chip + 内嵌两步配置面板 + 演示模式；设置页模型管理保留完整形态 | e2e 292/292、全链 CHAIN_EXIT=0、冒烟确认 |
| P3 项目模式 | ✅ 完成 | 模式记忆（localStorage）+ 双入口切换（导航抽屉 / project 态 rail）+ 四类编排触发自动升级 + `viewModePinned` 克制 + project 态右栏常驻 | e2e 307/307、全链 CHAIN_EXIT=0、冒烟确认 |
| P4 UX 调研 | ✅ 完成（首轮） | 六 surface 并发表查 95 项发现；P0×1 + P1×14 已修并回归，P1×8 + P2×50 + P3×21 进 backlog | e2e 317/317、全链 CHAIN_EXIT=0、冒烟确认 |

### P3 项目模式（2026-09-24 · spec §6）

出口标准（spec §9）：**编排用户路径不变，轻用户不被曝光**——达成并回归。

| 项 | 内容 |
|---|---|
| 模式记忆 | `orchdesk.viewMode` / `orchdesk.viewModePinned` 两个 localStorage key；启动即恢复，project 态 `ctxOpen` 初值 1（右栏常驻，仍可手动收起） |
| 切换入口 | 导航抽屉新增「切换到项目模式 / 轻模式」；project 态 rail 底部常驻同一入口（轻态 rail 隐藏，抽屉已够） |
| 自动触发 | 四类，全部走同一个 `escalateToProject(reason)`：① 建项目会话 ② 选择项目 ③ 引用专家团 / 派发专家团任务 ④ 回合结束 Agent 产出**多步**计划（`extractPlanSteps().steps.length >= 2`；单步不值得搬去重形态） |
| 克制 | 两条：已在项目态不重复动作；**用户手动切过（`viewModePinned`）绝不再自动升级**——自动升级是「按需」，不是替用户决定 |
| project 态 | rail 恢复 + 右栏任务监控常驻 + 侧栏项目分组 + 会话页分叉/回放，即今天的完整体验（spec §6「所有现有能力原样保留」） |

**实施中发现并修复的产品缺陷（P1.3 承诺未落地）**：`VIEWS.session.ctx()` 的执行明细只从已落库的 `m.tools` 取，**回合进行中右栏永远只有计划、看不到正在执行什么**——与 P1.3「工具步骤时从右侧滑出」不符。修：`turnBusy === 本会话` 门控下把实时 `state.toolSteps` 并进执行明细（回合一结束即停合并，避免与 `m.tools` 重复）。

**顺带修掉的断言假阳性**：P2 的「演示工具步骤进入右栏」原本只查 `orch-plan`，而空态提示文案里也含这个词（```orch-plan 围栏说明）——绿了但没验证到东西。改为断言「执行明细」段 + 只可能来自工具步骤的 `workspace-scan`，并补一条**回合进行中**的断言（此时走的是实时合并新路径，不是 `m.tools`）。

**验证**：全链 CHAIN_EXIT=0；e2e **307/307**（基线 306 + P3 组 18 共 15 项新断言 + 上述 2 条修正/新增）；浏览器冒烟确认 project 态四列完整体验（rail / 侧栏 / 主区 / 右栏任务监控）与 rail 上的「轻模式」回落入口，端口已清理。

### P4 UX 调研（2026-09-24 · spec §7）

方法：Nielsen 十条 + 认知负荷 checklist，6 个 surface 并行只读走查（每个发现都带 file:line 证据）。
产出 **95 项发现：P0×1 / P1×22 / P2×50 / P3×21 / 待验证×1**。

**本轮已修（15 项，全部有 e2e 回归锁定）**

| 编号 | 级 | 问题 | 修法 |
|---|---|---|---|
| S6-2 | **P0** | 授权模式切换乐观更新，持久化失败不回滚 → UI 显示「偏执（全锁）」而实际仍是信任/默认，**展示的安全姿态比现实更严** | `doSwitchAuth` 失败即回滚 `state.authMode` + `render()` + err toast 点名回滚到哪个模式 |
| S4-1 | P1 | （P3 自己引入的回归）实时工具步骤合并写在 `msgs.forEach` 内 → 按历史消息数重复追加，10 条历史的会话 3 个工具显示成 30 行 | 合并移出 forEach，并加注释说明两个踩过的坑 |
| S1-01 | P1 | 设置页添加提供商成功后回到会话页，chip 仍显示「未配置模型/演示模式」 | 两条路径都 `autoSelectModels` + 清 `demoMode` |
| S1-02 | P1 | 右栏副标题写死「DSH 插件 · 已启用」，同面板「能力」TAB 却显示「未接入」——同一后端两个矛盾状态 | 副标题改由 `state.pluginRuntime` 派生，与设置页 statbar 同款文案 |
| S1-03 | P1 | composer「意图识别 · 本地模型」是静态 HTML，插件未装载时仍宣称在初筛，placeholder 也承诺「先经意图识别插件初筛」 | 新增 `intentCtlState()` 读运行时（active/停用/未装载/未接入 → 一律「按拒绝处理」），placeholder 动态化 |
| S3-01 | P1 | 模型保存三坑：隐藏的手动框旧值仍参与计算；取消全部勾选静默存假模型 `default`；编辑时取消勾选旧模型全保留 | 来源优先级重写（面板出现过就只认勾选，为空则阻止保存）；隐藏框连值一起清；删掉 `default` 占位 |
| S3-02 | P1 | 编辑提供商保存后只刷列表不重渲染表单 → 再点「保存」走添加分支 push 同名 id，列表出现两行相同提供商 | 保存成功统一 `render()` + 按钮 await 期间禁用防连点 |
| S3-03 | P1 | 「完整 URL」勾选却不补协议，按 placeholder（localhost:11434）填写存下无协议 URL，失败提示还藏真实原因 | 去掉 full 门禁，缺协议一律补 `http://`（`mpCurrentInput` 与保存路径同规则） |
| S5-1 | P1 | 轻模式展开浏览器侧栏时网格回落到项目态四列（60px rail 列），而轻模式 rail 被隐藏 → 侧栏被压成 60px、主区缩到 270px | 补 `.app.light.browser-mode{grid-template-columns:240px 1fr 300px}` |
| S5-2 | P1 | 文件 TAB / 全屏面板 / 终端只认「项目绑定目录」，不认轻模式已下发主进程的隐式 `s.cwd` → 新用户被迫重选刚选过的目录 | 新增 `fileTabRootDir()` = `projectPathOf() \|\| s.cwd`，三处统一；未绑定文案改「尚未设置工作目录」并给出去欢迎页设定的下一步 |
| S5-3 | P1 | 冷启后终端图标一直置灰「未接入主进程」+ not-allowed 光标，而桥其实是好的 | init 的 `Promise.allSettled` 补 `terminalStatus()` 同步（与浏览器对称） |
| S4-3/S5-4 | P1 | 文件 TAB 根目录一次性装载（`ft.inited` 全局 guard），切会话/项目后仍显示上一个目录的树 | 根目录变化即重装 + `lastDir` 防失败态死循环 |
| S1-05 | P1 | 欢迎页 `#outboundWarn` 是死的：`act_home_send` 搬文本后立即 doSend，300ms 防抖预警只可能在发送之后 fire → 不可逆操作预警在新用户主路径失效 | input 监听补 `homeComposer` 分支 + 新增 `confirmOutboundIfNeeded()` 发送前同步判定（一 shot 确认，不卡死） |

**延后（记录理由，进 backlog）**
- S2-1 技能停用只翻内存标志不落盘 / S2-2 Hub 解除配对不调主进程 / S2-3 技能市场空数组静默回落静态样本 —— 三项都需新增主进程 IPC（`skill-set-enabled` / `hub-unpair` / `guanjiList` 三态），跨层改动单独一轮
- S3-04 authz 不可用时整个授权分区假装活着（S6-2 已修回滚部分，loaded 三态待加）
- S3-05 设置页与 composer 模态两套模型表单不一致（UI 重构，M）
- S4-2 右栏 tab 切换走整页 render 丢草稿/跳滚动（需新增 `renderCtxOnly`，M，须防破坏现有 e2e）
- S6-1 审批弹窗「关闭≠拒绝」+ 无倒计时 + 英文 outcome（跨 renderer+main，M）
- S6-3 网络白名单「留空=全部拒绝」在信任模式下为假 + 存储态/显示态分叉（跨层，M）
- S1-04 欢迎页项目行压缩首屏决策点（需保留「创建项目」入口，e2e 与有会话无项目场景都依赖，判为设计取舍而非缺陷）

**验证**：全链 CHAIN_EXIT=0；e2e **317/317**（P4 组 19 共 10 项新断言：意图门诚实态 / 右栏副标题诚实态 / 终端图标不谎报 / **授权模式失败回滚(P0)** / 不产 default 假模型 / 编辑保存后表单复位 / 无重复 id / 文件 TAB 认隐式 cwd）；浏览器冒烟确认「更多」菜单显示「意图识别 · 运行时未接入 · 按拒绝处理」（琥珀点）与 placeholder 去掉绝对承诺，端口已清理。

### P4 第二轮（2026-09-24 · backlog 消化）

在第一轮 95 项发现的基础上继续消化 P2/P3。**本轮再修 17 项**（全部有 e2e 或代码级回归保护）。

| 编号 | 级 | 问题 | 修法 |
|---|---|---|---|
| S3-14 | P1 | 点设置页侧栏分区触发整页 `render()` → 用户在「模型管理」填了一半的预设/KEY/勾选被静默清空 | 新增 `renderSettingsMain()` 只重渲主区 + 分区高亮/滚动 |
| S2-10 | P1 | 清除连接器凭证一键直达无确认（同页清空审计/卸载技能/删 MCP 都有确认） | 套 `confirmDestructive`，新 action `conn-clear-confirmed` |
| S3-11 | P1 | 清空晋升审计 / 清空用量记账一键即清、无不可逆提示（同为审计轨迹） | 都套 `confirmDestructive`（晋升审计里还记着「被 Director 拦下」的安全事件） |
| S1-12 | P2 | 标题栏 tray 提示写死「本地运行 · 1 专家在线」，全仓无 JS 更新 | `renderTrayHint()` 按 `expertList()` 真实条数刷新 |
| S1-13 | P2 | 入门向导展示「deepseek-harness 运行时 · 就绪 · 基线 99f6f02」——徽章与 commit 全无运行时背书 | 改为「OrchDesk 运行时 · 本地 · 数据留在本机」，不冒充后端状态 |
| S2-4 | P2 | 侧栏内置插件徽章读常量 `p.on`，主区卡片读运行时 → 同页可矛盾 | 侧栏改用 `pluginBadge(id)` / `pluginSwitchedOn(id)`，与主区同源 |
| S2-5 | P2 | `listTempPlugins()` 失败时 `catch(()→{})` 不置标志 → 「暂无临时插件」冒充「没查到」 | 新增 `tempPluginsLoaded` 三态，侧栏与主区分辨「暂无 / 未接入」 |
| S2-12 | P2 | 编排目录拉不到时回落硬编码 8 专家 + 3 团，UI 无任何标注；`orchestrationLive()` 写了没人调用 | 专家组顶部加「编排目录未接入 · 兜底名单」行，接上那个 helper |
| S3-06 | P2 | L0-L4 分级在 `getAuthLevels` 失败/返回空时「加载中…」永久卡死 | 三态：拉到但空 → 可重试；未接入 → fail-closed 按最严处理 |
| S3-10 | P2 | 数据目录分区未扫描时显示字面量 `%APPDATA%/OrchDesk`（未经核实却以真实面目呈现） | 改为「本地（未扫描）」，与同页 statbar 一致 |
| S3-13 | P2 | statbar 授权模式位永远挂绿点（三档同色）、沙箱位永远 `ok` 徽标 | 按档位给色（偏执=danger/信任=warn/默认=ok），授权服务未接入时标注；沙箱按 `state.sandbox.mode` 有无显示 |
| S4-4 | P2 | 创建分支模态承诺「可随时**合并**或丢弃分支」——全仓无任何分支合并 UI/IPC | 改为「分支可随时归档 / 删除（侧栏 ··· 菜单）」 |
| S4-5 | P2 | 回放把「加载中」和「IPC 查失败」都显示成「事件流未接入」 | 四态：`bridgeMissing` → 未接入；`!loaded` → 加载中；`error` → 读取失败+原因；否则未接入 |
| S1-11 关联 / S3-15 关联 | — | — | 见下方延后清单 |

**本轮同时确立的两条工程纪律**
1. **补丁执行器必须每次跑 `node --check`**：本轮 `&&` 短路导致一次模板字面量闭合反引号缺失混过 3 个补丁，直到 e2e 才暴露。已改为「补丁后立即语法校验 + 失败即停」。
2. **改行为必须同步改 e2e**：3 处「补确认」的行为变化先让 e2e 红了 3 项，补上「断言确认弹窗出现 + 点确认」后转绿——行为变化被测试捕获正是设计意图。

**验证**：全链 CHAIN_EXIT=0；e2e **320/320**（本轮新增/调整 6 项断言：3 处破坏性操作的确认弹窗与确认后生效）。

**剩余 backlog（P2/P3 共 ~54 项，按 surface 优先级推进）**
- 跨层需新 IPC：S2-1 技能停用落盘 / S2-2 Hub 解除配对 / S2-3 技能市场三态 / S6-1 审批弹窗倒计时+中文 outcome / S6-3 白名单 stored/effective 双名单
- UI 重构（M 起）：S1-06 项目下拉两处文案与「创建项目」入口不一致 / S1-09 分叉回放发现性 / S2-7 侧栏 7 组顺序与主区不符 / S2-9 徽章 9.5px 单字缩写 / S3-05 两套模型表单 / S3-12 风控文案术语墙 / S4-2 `renderCtxOnly` / S4-9 回放平铺 / S4-11 待办累积历史计划
- 文案与细节（S）：S1-07 快捷操作覆盖已输入文字 / S1-08 零会话推荐不相关 / S1-10 侧栏「项目/任务」假 tab / S2-6 弱化行不可辨 / S2-8 两个搜索过滤器行为不一致 / S2-11 MCP 未接入仍可填表单 / S2-13 市场安装的技能不进加载选择器 / S2-14 插件市场计数 +5 / S2-15~18 / S3-07 授权审计英文枚举 / S3-08 白名单表单默认即被拒 / S3-09 默认模型下拉与真实值不符 / S3-16 侧栏与主区分区不同名 / S4-6 待办空态暴露内部协议 / S4-7 能力 tab 二值色 / S4-8 产物命名重复 / S4-10（同 S1-02 已修）/ S4-12~14 / S5-6~14 / S6-4~15

### P4 第三轮（2026-09-24 · backlog 消化）

**本轮再修 7 项**。

| 编号 | 级 | 问题 | 修法 |
|---|---|---|---|
| S1-07 | P2 | 点快捷操作**无条件覆盖**用户已在欢迎页打好的文字并立即发送，toast 还说「已加载模板」——用户根本来不及看到或编辑 | 只填模板 + focus，不代点发送；toast 改「已填入模板 · 可直接编辑后发送」 |
| S2-11 | P2 | MCP 桥未接入时仍渲染「+ 添加 MCP server」主按钮 → 用户填完 ID/命令/env，保存才 toast「主进程未接入」，整个填写是无效劳动 | 未接入时按钮置 disabled + 「需主进程接入」提示（fail-closed：不可用即不可操作） |
| S1-10 | P2 | 侧栏「项目 / 任务」分段只有一个「项目」项、无 `data-action`，CSS 却给 `cursor:pointer` + hover——看着是可切换过滤器，点了没反应，还承诺了不存在的「任务」tab | 加 title 说明；CSS 按容器限定 `.proj-seg .seg-tabs .seg-tab{cursor:default}` 去掉假可点样式 |
| S3-06 | P2 | L0-L4 分级有**两处**渲染，第一轮只修了授权弹窗里那处；设置页这处仍是「加载中…」永久卡死 | 同一套三态补到设置页 |
| S3-08 | P2 | 白名单表单默认组合（工具=`*` 任意操作、粒度=永久）恰是后端明文拒绝的组合，placeholder 又明示「或 `*`」，与上方说明文字直接矛盾 | `*` 选项改名「任意操作（永久粒度不可用）」并移到末位；scope 默认改「本会话」；placeholder 去掉 `*` 诱导 |
| S3-09 | P2 | 切换默认模型 / 拖「Agent 迭代」滑块都是静默保存，失败被 `.catch(()=>{})` 吞掉，用户无从得知有没有生效 | 默认模型保存加 toast 反馈（成功/失败都给结论） |
| S4-6 | P2 | 待办空态把内部协议语法（```orch-plan 围栏）直接暴露给终端用户 | 改为人话：「复杂任务会自动拆成待办；下面执行明细是本回合真实执行过的每个动作」 |

**顺带确立的纪律（第三轮）**：改行为必须同步改 e2e——本轮 S1-07 让「quick-weekly 点击后模板被发送」这条旧断言转红，改为断言「模板填入输入框且**不**产生用户消息」后转绿。**旧断言转红正是它在履行职责**，不是障碍。

**验证**：全链 CHAIN_EXIT=0；e2e **320/320**（本轮调整 1 项断言并强化其语义）。

**累计进度**：P4 三轮共修 **39 项**（第一轮 15 + 第二轮 17 + 第三轮 7），覆盖 P0×1 / P1×20 / P2×18。剩余 backlog ~48 项已按「跨层需新 IPC / UI 重构 M 起 / 文案细节 S」三组记入上一节，继续按序推进。

### OpenCodeReview 全面审查与修复（2026-09-29）

按阿里巴巴 [OpenCodeReview](https://github.com/alibaba/open-code-review)（ocr v1.12.10）的规则集做了一次全项目审查。因变更已全部提交、无有意义 diff，采用其**委托模式**（`ocr delegate rule <files>` 取规则，由本 agent 执行评审）——OCR 负责文件选择与规则解析，不消耗其 LLM 配额。规则集两套：`system / **/*.{ts,js,...}`（28 条）+ `system / default`（正确性/安全/性能/可维护性/测试覆盖）。

**审查方式**：5 个范围并行只读走查（未提交的模型链路 / UI 重构提交 6dbf8e7 / 插件层安全 / IPC 与宿主层 / 渲染层主体），每个发现带 file:line 证据。共产出 **64 项发现：P0×0 / P1×6 / P2×25 / P3×33**。

**已修 23 项（P1×6 + 高价值 P2×17）**

| 编号 | 级 | 问题 | 修法 |
|---|---|---|---|
| R3-1 | P1 | authz 永久白名单只拒字面量 `*`，`**` 编译成 `^[\s\S]*[\s\S]*$` 命中一切目标 → 「永久免审写任意文件」 | 判定改为「去掉 `*` 后为空即通配」 |
| R3-2 | P1 | intent F1 写成 `C:\\Windows`（匹配两个连续反斜杠），真实路径一个反斜杠 → 系统路径信号在主平台是**死规则**，漏斗朝 fail-open 衰减 | 改单层转义 + 6 个用例自校验 |
| R4-1 | P1 | 渲染层可达的 `browser-goto` 只校验 http(s)，无 `isBlockedHost` → 内网/云元数据读数经标题截图回传的 SSRF 通道，且不记沙箱日志 | 补主机黑名单 + `recordSandbox` 留痕 |
| R5-02 | P1 | 提示词标题/冲突文档**完全未转义**拼进 innerHTML，经落盘读回 = 存储型 XSS | 统一 `esc()` |
| R5-01 | P1 | 每次冷启动 fetch api.github.com 拿**上游 main 的 commit** 当本地版本显示——本地构建/fork/旧版本展示的不是正在运行的代码，且违反本地优先 | 删 fetch，改显本地版本（新增 `orchdesk:app-version` IPC） |
| R1-1 | P1 | 等响应头阶段被超时 abort 时错误被包成普通 Error，`isAbortError` 匹配不到 → 用户看到 cryptic 文案 | abort 原样 rethrow |
| R3-4 | P2 | 审批 `Promise.race` 后不 clearTimeout/不 removeEventListener → 每次审批泄漏 120s 定时器 + 监听器 | 抽出 cleanup，race 结束即收 |
| R3-5 | P2 | 本地模型 fetch 只挂调用方 signal 无自身超时 → Ollama 挂着时回合楔死且 abort 救不回 | `AbortSignal.any` 合并 15s 超时 |
| R3-10 | P2 | G4 外发域名用 `host.includes(d)` → `api.openai.com.evil.net` 被放行、空条目放行一切 | 归一化 + 相等或子域匹配 |
| R3-6 | P2 | multi 运行器未注入时 subAgentTurn 返 null，调用方仍置 `status='done'` → 委派树伪造成功 | null → failed + note |
| R3-7 | P2 | brain `await handle.dispose()` 无 try/catch → 抛错则状态卡 executing、配额永久占用 | try/catch 后继续收尾 |
| R4-3 | P2 | `run-agent-turn` 的 sessionId/text 无运行时闸门（同文件其他 handler 都有）→ text 非字符串时整链崩 | 补 typeof 校验 |
| R1-4 | P2 | `maxToolIterations` 用 `||` 取默认值，显式配 0 被静默放大 200 倍（loadModelConfig 注释承诺的是 `??`） | 改 `??` |
| R5-05 | P2 | `doArchiveSession` 无条件访问 `state.projects[0].sessions[0]` → 首跑无项目时归档必崩且状态半生效 | 空值保护 + 去掉硬编码 'p3' 兜底 |
| R5-07 | P2 | `toast(msg,'err')` 的类型名 err 在 CSS 不存在 → 所有错误提示渲染成中性样式，失败被静默 | `.toast.err` 别名到 danger |
| R2-6 | P2 | composer placeholder 直插 `${s.expert}`（外部目录数据）未转义 → 含 `"` 撑破属性 | `esc()` |
| R2-7 | P2 | 项目绑定会话的「更改」工作目录对 chip 无效却 toast 成功 | 按会话类型给不同成功文案 |
| R2-8 | P2 | 右栏关闭钮只在会话页头部 → 钉住后进主页/插件/设置页无收起入口（状态机死角） | 关闭钮加进右栏自己的头部 |
| R5-03 | P2 | 提示词编辑器三个回显值三种口径且都不完整（title 只转 `"`、body 只转 `<`、agents 完全没转）→ 属性注入 | 统一 `esc()` |
| R5-04 | P2 | 改「默认模型」后 autoSelectModels 被 localStorage 早退覆盖 → 默认模型对实际发送毫无影响却 toast 成功 | 前插默认项 + 先落盘再 autoSelect |
| R1-2 | P2 | Ollama 流式零内容落入 JSON.parse 失败分支，报「返回非 JSON 响应」（事实错误）且丢诊断 | 可按 JSON 解析时返回 emptyReason |
| R3-3 | P2 | 审批监听器白名单命中即放行且不读 mode → 偏执（全锁）模式下永久白名单仍能开门 | 偏执模式不认白名单 |
| R3-8 | P2 | 补偿层强制门只问 `requiresWithhold`（对 other 恒 false）→ 同段文本主进程拦、插件放行 | 与 withhold() 同口径 |

**顺带修掉的测试基建问题**：R2-8 给右栏加了第二个 `toggle-ctx` 入口后，e2e `ensureCtxOpen` 的 `.first()` 会点到面板收起时被 CSS 隐藏的那个 → 三处 locator 改 `:visible`。**这是新入口带来的真实回归，被既有测试抓住正是设计意图。**

**剩余 backlog（41 项：P2×8 / P3×33）**：完整清单在 `_ocr_findings.json`（含位置/规则/修法/工作量）。P3 集中在命名与硬编码收敛（如默认模型名 7 处硬编码、`completions` 模式 `max_tokens: 1024` 无常量）、残留死代码（UI 重构后 `navDrawer*`/`loadViewMode`/`getSmartRecommendations` 整链无调用者）、以及文案术语墙。P2 剩余含 SSE 截断无提示（R1-3，需扩 ModelReply 类型）、models-test 无超时、审批弹窗初始焦点落在最宽松选项等。

**验证**：全链 `pnpm run verify` CHAIN_EXIT=0；tsc EXIT=0；e2e **300/300**；verify-plugins 92/0、intent-gate 10/0、arch-guard 27/0、model-catalog 19/0、dsh-runtime 32/0。改动 plugin src 后已重编译 + 重 vendor（arch-guard R6 守护）。

### OpenCodeReview 剩余项消化（2026-09-29 续）

接上一节「剩余 backlog 41 项（P2×8 / P3×33）」，按用户批准的四步顺序执行。清单已归档到 `docs/40-质量/open-code-review-findings-2026-09-29.json`（上一节写的 `_ocr_findings.json` 已不存在，以归档件为准）。

**第 1 步 · 守护失效三项（本轮最高风险，守护本身失效比被守护的 bug 更危险）**

| 编号 | 问题 | 修法 |
|---|---|---|
| R3-16 | `verify-plugins.mjs` 给同步的 `withhold(text: string)` 传对象，并断言不存在的 `proceed` 字段 → **恒真的假断言**，守护看着绿实际没验 | 改三条真断言：按字符串入参验 withhold / `firePreStep` + `setOutcome('rejected')` 验 reject / unavailable 验 reject |
| R4-2 | 审批应答通道 `ipcMain.on` 不过 sender 门 → 任意渲染层可代答审批 | 补 `if (e && e.senderFrame) return;`（**必须空安全**：测试探针以 `null` 事件驱动该通道，直接写 `e.senderFrame` 会炸 4 个 credentials-verify 用例） |
| R3-9 | evolution HARD_DENY 漏 ESM 形态，`import cp from 'node:child_process'` 不被拦 | 补 `esm-node-builtin` / `esm-remote-import` 两条规则；`staticGate` 开头加 `typeof spec?.code !== 'string'` fail-closed 拒绝 |

**第 2 步 · UI 重构残留清理**：删约 200 行死码——`VIEWMODE_*` 全套、`navDrawer*` 整链（含 `#navDrawerRoot` 容器、`nav-drawer`/`view-mode-toggle` 注册、Esc 分支）、`escalateToProject`/`toggleViewMode` 空壳及 4 处调用点、`getSmartRecommendations`（68 行）+ `act_quick_weekly` + 8 个 `quick-*` 注册、`.proj-select`/`.ps-*` 16 行死 CSS、A 组单行死码 6 处。

**第 3 步 · 硬编码收敛**
- R1-8：6 处 `'qwen3:14b'` 收敛为 `agent-runtime.ts` 的 `DEFAULT_MODEL` + `pickModel(provider, cfg, requested?)`。**注意 requested 参数**——第一版把用户显式选的模型吞了，是回归，靠对照原逻辑抓住。
- R1-9：`completions` 模式 `max_tokens: 1024` → `COMPLETIONS_MAX_TOKENS = 2048`（原值会把长摘要静默截断）。
- R5-17：归档容器兜底不再硬编码种子 id `'p3'`，统一走 `__archived__` 虚拟容器（与 `doArchiveProject` 同口径，找不到就建）；终端上限 `6` 提为渲染层常量 + **新增 arch-guard R18** 机械校验与 `terminal-tools.ts` 的 `TERMINAL_MAX_SESSIONS` 一致（沿用 R10/R11 的跨构建边界单源模式）。R18 第一版自身有 bug（`stray` 为 null 时 `.join` 抛错），正是本轮在修的同类「守护失效」。
- R5-13：`networkAllow` 兜底从 `['*']`（悄悄放开全网）改 `[]`，并加 `loaded` 标志区分「未拉取」与「空 = 全部拒绝」——原文案明写「留空 = 全部拒绝（fail-closed）」，代码却反着来。

**第 4 步 · 按文件簇并行消化**：8 个并行子代理按模块分派（authz / intent / compensation / multi+brain / trace+memory+prompt / model-client / main.ts / ipc-browser+host-services+file-panel+preload），父代理接手风险最高的 `renderer/app.js`。

**核对结论（重要）**：41 项里有相当一部分在 HEAD `a4e2bd0` 已修（R5-01/02/03/04/06/07/08、R2-6/7/8、R1-1/2、R3-1/3/4/5/6/7、R4-1/3、R5-14/15/16 的部分）。逐条核对后**只对确有缺口的做增量**，不重复改动——避免把已修的东西改出空 diff 或回归。

**本轮真正新增的增量**

| 编号 | 问题 | 修法 |
|---|---|---|
| R3-3 | authz 审批监听器 paranoid 早退不完整：HEAD 版只「跳过白名单」仍弹窗，偏执下用户点允许仍能开门 | 监听器最前 `paranoid` → `rejected` + 审计；读不到档位按最严。定论：白名单分支**保留**（桌面链路审批唯一发起方是 `host-services.approval.request`，但该监听器是 ADR-0008 明确的 dsh 管道 seam，删掉会丢 FR-9 语义且不增加安全性） |
| R3-10 | intent G4 对**无 scheme 的裸串**整体 toLowerCase 当 host → `evil.net/x.api.openai.com` 命中 `.api.openai.com` 后缀，白名单被绕过 | 补 `hostOf()`：裸串也只取 host 段、剥 userinfo/端口，剥不出返回 `''` → 拒绝 |
| R3-8 | 补偿层 HEAD 版把 withhold 判定**内联复制**到 pre-step 门——行为一致但两处各写一遍，改一处忘另一处就又分裂 | 提取 `needsWithhold(text)` 唯一判定处，两处都调 |
| R3-13 | 补偿类别规则无边界子串：commit 命中 commitment、API 命中 rapid、GET/POST 命中 budget/poster → 普通对话被判 network-egress/irreversible，整回合弹确认 | 英文词加 `\b` 边界；HTTP 方法拆成**大小写敏感**独立规则（整表带 `/i`，`\bGET\b` 照样命中动词 get，只加边界不消误报）；补 `\bdelete\b`（英文删除原先完全不被命中，与文件头「删除文件默认 CONFIRM」承诺相反） |
| R3-11 | trace `batchSize` 无下限，配 0 时 `splice(0,0)` 永返空批 → **死循环**且 flushing 永不复位 | schema `.min(1).default(20)` + flush 循环内双保险 break |
| R3-12 | trace 关闭 = repoUrl 置空 → 插件直接 `return` 丢弃，宿主注释却承诺「只缓冲不上传，不静默丢数据」 | `queueSize()` 增补 `disabled: boolean` 并经 IPC 透出；宿主注释改为「直接不记录」，`TraceServiceLike` 类型同步 |
| R3-14 | memory `dump()` 在每块摘要循环内调 `vectorizeCorpus()` → O(块数 × 语料大小)，单次 dump 数十次全语料遍历 | 提到循环外一次算完（注释已论证 IDF 时差可接受，提出去不改变结论） |
| R3-15 | prompt `update()` 用 `{...cur, ...patch}` 浅合并 → 调用方传显式 `undefined` 就把 priority 重置 0、agents 重置 [] | 逐键过滤 undefined |
| R1-3 | SSE/NDJSON 的 `[DONE]`/`finish_reason`/`done:true` 被忽略 → 连接中途 FIN/RST 时**半截内容当完整答复返回，无任何提示** | 两个 parser 记 `sawTerminator`，`ModelReply` 加 `truncated?: boolean`；**agent-turn 消费侧**补「响应可能不完整」提示（不消费则字段就绪但 UI 仍静默） |
| R1-7 | `emitDelta` 有 try/catch 并注释「渲染层失败不影响回合」，但 parser 内 `onDelta` 调用无保护 → 契约自相矛盾，换调用方即踩雷 | parser 构造时包一层 |
| R4-4 | host-services `sessionModes` 原样采信磁盘值 → 损坏的 sandbox.json 写入非法模式串后该会话被当作可写（顶层 mode 有白名单回落，这里漏了） | 装载时逐值过 `SANDBOX_MODES` |
| R4-5 | file-panel `expectedMtimeMs` 嵌套三元 | 抽 `toFiniteNumber()`（**不钳制**——mtime 是外部修改检测基线，钳成默认值等于放过过期写入） |
| R4-7 | preload 声明 `mergePrompts(category, body)` 返回 `{ok, conflicts}`，handler 实际只收一个 agentId、返回无 `ok` 字段 → body 死参数、ok 假类型 | 签名改 `(agentId: string)`，返回类型对齐 `MergeResult` |
| R4-9 | `load-sessions` filter 回调 `(s: any)` 绕过类型保护 | 局部 `type StoredSession` + 类型谓词，真值语义逐字等价 |
| R1-5 | trace 两个 handler 内 `const/let dataDir` 遮蔽模块级 `function dataDir()` | 改名 `dir` |
| R1-6 | `models-test` 不传 signal 不包 withTimeout → 黑洞端点悬挂约 10 分钟 | 包 `withTimeout(..., 30_000)`，超时文案可读（剥掉 `summarize-timeout:` 前缀） |
| R4-8 | host-services `followup` 里 `const meta = agents.get(...); void meta;` 死语句 | 删除（定论：`git log -S` 证实自引入起就是死的；真要传 meta 得先改 Map 结构 + main.ts 运行器，而运行器对 meta 零消费，接了只是把死代码搬家） |
| R4-6 | `==`/`!=` 散落 10 处（含 sender 门这一安全关键判断） | main.ts 3 处 + data-dir/mcp-client 5 处全改；`connector-registry.ts:429` **保留**（TAPD status 可能是数字或字符串，宽松相等是语义需求，已带 `eslint-disable eqeqeq` + 注释） |
| R2-11 | `state.ctxOpen` 初值是数字 0，与其余布尔字段不一致，取反后类型在 number/boolean 间摇摆 | 改 `false` |
| R5-11 | statbar 授权模式点配色三层嵌套三元 | 提 `authModeDotColor()` 查表（未接入给 `fg-faint`，不挂绿点） |
| R5-15 | 补偿记录 `(e.text||'').replace(/</g,'&lt;')` 只转 `<`，`e.note` 完全未转义 → 含 `&lt;` 的原文被解码后显示成别的字符 | 统一 `esc()` |
| R2-9 | `render()` catch 把 `err.stack` 原样拼 innerHTML → 错误信息携带的用户文本可注入页面（同函数未知页分支本来就走 `esc()`，口径不一致） | `esc()` |
| R2-10 | 我方的清理脚本把 7 个渲染层文件写成 CRLF 主导 + 裸 LF 混合（仓库规范形态是 LF，`core.autocrlf=true` 只是检出副作用） | 归一为纯 LF；`git diff` 仍是纯内容变更 |
| R2-12 | index.html 标题栏注释同时写着「☰ 唤出导航抽屉」和「三入口轨常驻」——同一注释块自相矛盾；`renderRail` 注释承诺「底部给模式切换」而实际只有主题切换 | 两处注释改到与实现一致 |
| R3-1 | （补测试缺口）`verify-plugins.mjs` 的 B-4 用例只覆盖字面量 `'*'`，没有 `'**'`/`'* *'`/`' * '` 的 permanent 用例 | 补 4 条 |

**验证**：全链 `pnpm run verify` **CHAIN_EXIT=0**；tsc EXIT=0；e2e **300/300**；verify-plugins **94/0**（新增 4 条 B-4 用例）；intent-gate 10/0；verify-orchestration 50/0；verify-trace-upload 37/0；arch-guard **28/0**（新增 R18）；model-loop 50/0；model-catalog 19/0；file-panel 20/0；file-edit 20/0；browser-tools 44/0。改 plugin src 后 9 个包全部重编译 + 重 vendor。

**遗留（不在本轮范围，已记录待跟踪）**
- compensation / evolution 直接调 `ctx.approval.request`，paranoid 模式下仍弹 GUI 确认（不涉白名单，但与「paranoid = 任何 ask 自动拒绝」的产品承诺不一致）。
- `e2e-fix-verify.cjs` 的 bridge mock 用自己一套简化正则，与真实 `CATEGORY_RULES` 不一致（测试夹具占位实现，是「两处判定可能分叉」的同类隐患）。
- `main.ts` 里那批 `DEFAULT_MODEL`/`pickModel` 注释行号引用可能随后续改动漂移。

### paranoid 铁律收口（2026-09-29 续二）

上一轮遗留项第一条已修。**规则**：`paranoid`（偏执模式）= `sandboxMode: 'read-only'` + `approvalPolicy: 'never'`——审批策略是 `never` 而非 `ask`，意思是**问题本身不被提出、答案预先定为「不」**。三档对比：`default`/`trusted` 是 `ask`（弹窗问用户），`paranoid` 是 `never`（不问，直接拒）。

**缺口**：主进程 `approvalGate`（`main.ts:458`）把档位判定放在最前面（早于白名单查询、早于弹窗），`if (mode === 'paranoid') return 拒绝`。但 compensation 与 evolution 两个插件是**直接调 `ctx.approval.request`**，绕过了 `approvalGate` → 同样在 paranoid 下，主进程路径不问就拒，插件路径照样弹 GUI 确认框。同一档位两条路、一套问一套不问。不是安全漏洞（用户仍可点拒绝、fail-closed 仍在），但**行为不统一**：偏执模式本该零提问。

**修法**（两个插件同构）：
- `inject` 补 `'sandboxPolicy'`，用 `sandboxPolicy.getAuthMode()` 读档位——与 authz 插件的 `getMode` **同源**。没有各自反推 `sandboxMode`：`default`/`trusted` 在 `(sandboxMode, approvalPolicy)` 上同参，反推法永远分不出两者。
- 档位判定前移到 `approval.request` **之前**：paranoid → 直接拒 + 写审计（compensation 走 `withhold-decided` 条目，reason 点明「paranoid（全锁）模式自动拒绝，不弹窗」）。
- **读不到档位回落 `paranoid`（最严）**。这是有意的 fail-closed 倾斜：误判为 paranoid 的后果是多拒一次（用户可切档），误判为 default 的后果是偏执模式下仍然弹窗问人——正是本条要修的行为。

**测试**（`scripts/verify-plugins.mjs`，94→97）：
- compensation：paranoid 下外发 prompt → `reject` **且审批请求零新增**（弹窗本身就是违约，光断言 reject 不够）
- compensation 反向对照：default 档仍发起 1 次审批请求——只断言 paranoid 会拒是不够的，若档位被读成恒 paranoid，default 也会被拒且同样零请求，测试仍绿
- evolution：paranoid 下 `createTempPlugin` → `ok:false`、reason 点明 paranoid（用户看得出是档位所致而非门控故障）、零审批请求

**验证**：全链 `pnpm run verify` CHAIN_EXIT=0；e2e 300/300；verify-plugins **97/0**。改 plugin src 后已重编译 + 重 vendor。

### 遗留项收口（2026-09-29 续三）

上一轮遗留两条，本条处理第一条，第二条核实为不存在。

**① e2e 的 bridge mock 用自制正则（已修）**

`e2e-fix-verify.cjs` 的 `bridge.withhold`  fixture 用 `/删除|发给|发送|curl|http/i` 近似真实规则，而 `CATEGORY_RULES` 有 6 类 + 词边界 + `'other'` 兜底措辞，mock 只覆盖一类且 `category` 恒为 `external-message`。真实规则改严后 mock 不跟着变 → e2e 给出偏乐观的结论（两处判定分叉）。且当时**无任何断言消费它**，纯死重量。

修法：把纯判定提为 compensation 的模块级导出，夹具复用同一份规则。
- `withholdText(text, failClosedUnknown?)` —— 模块级纯判定，插件内 `withhold()` 与 `needsWithhold()` 都委托它（唯一实现）
- `withholdRuleSpecs()` —— 可序列化的规则数据（正则 source/flags + 类别表）。夹具跑在浏览器上下文无法 require Node 模块，故注入规则**数据**而非函数体，页内按同样三步重建

配套两处加固：
- **漂移守卫**：导航后实测比对页内重建器与真实 `withholdText`，15 条语料（6 类高危各一条 + R3-13 误报样本 commitment/rapid/budget/poster/"use the model"/"perform a code review" + 本套件实际发送的文本），分叉即抛错。已做变异验证：把页内 `'other'` 改成 `'other-MUTATED'` → 守卫报错并给出双方判定
- **新增 2 条 e2e 断言**（300→302）：外发文本 → `#outboundWarn` 可见；普通对话 → 保持隐藏（顺带守 R3-13 无误报）。夹具从此不再是死重量

**② main.ts 注释行号引用（核实为不存在）**

上轮备注「`DEFAULT_MODEL`/`pickModel` 注释行号引用可能漂移」。全仓扫 `文件:行号` 形式的注释共 4 处（`dsh-runtime.ts`→`memory-promotion.ts:21-23`、`ipc-authz.ts`→`main.ts:125`、`tool-exec.ts`→`file-panel.ts:31`、`authz/src`→`main.ts:451-471` + `host-services.ts:345-384`），逐条核对**全部仍准确**，无需修改。

**过程教训（记入流程）**：本轮我曾用 `git checkout -- <file>` 撤销一次变异测试的改动，而该文件尚有**未提交**的 `withholdText`/`withholdRuleSpecs` 工作 → 被一并回滚，只能重做。以后回滚带未提交工作的文件前必须先 `cp` 备份，或先 commit 再动。

**验证**：全链 `pnpm run verify` CHAIN_EXIT=0；e2e **302/302**（原 300 + 新增 2）；verify-plugins 97/0；arch-guard 28/0。
