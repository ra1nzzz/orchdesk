# CHECKPOINT

> 项目状态快照 + 版本治理 + 关键决策 + 下一步。
> 本文件是「项目进行到哪了」的唯一入口，阅读本文件即可接续工作。

---

## 1. 项目状态

| 维度 | 状态 | 说明 |
|------|------|------|
| **当前版本** | `0.12.0`（未打 tag；v0.11.0 已发 Release） | SemVer，pre-1.0 阶段；`0.10.1` 为上一 Release |
| **最新 Commit** | `0f2424d` | feat(fork/sandbox/datadir): 补 PRD 三处缺口（FR-6 分叉回放 / FR-8 沙箱日志 / FR-4.2 内容清单） |
| **主线分支** | `main` | protected，push 需 CI 通过 |
| **远端仓库** | `ra1nzzz/orchdesk` | GitHub，public |
| **最新 Release** | [v0.4.1](https://github.com/ra1nzzz/orchdesk/releases/tag/v0.4.1) | 由 `v*` tag 触发 CI：tsc → electron-builder（nsis + portable）→ GitHub Release |
| **文档审计** | 0 issues（`audit_knowledge_base.py docs`） | canonical 文档与代码保持一致 |
| **TypeScript** | tsc EXIT=0 | 全栈编译无错误 |
| **验证套件** | 465/465 PASS | `npm run verify`（plugins 63 / orchestration 45 / trace-upload 36 / agent-runtime 38 / agent-loop 14 / model-loop 34 / dsh-runtime 31 / credentials 34 / data-dir 47 / data-port 10 / session-fork 29 / e2e 84） |

> **v0.4.1 关键修复**：StepFun / 部分 OpenAI 兼容网关在 chat 模式下带 `tools` 参数时返回 HTTP 200、content/toolCalls 全空（软拒绝），导致「发消息能响应，要求执行任务则报错」。现 `callOpenAICompatible` 识别软拒绝并逐级降级到不带 tools，成功后把 `provider.id|model` 记入进程级记忆，后续会话直接走 `<tool:>` 文本兜底解析。新增 model-loop M 组 3 项回归测试。

> **v0.5.0 关键交付（dsh memory 真实接入对话流，BUG-019/020）**：① 新工具 `memory_save`——用户告知的长期事实写入 dsh memory 插件 global 域，每轮回召回最近 10 条注入 system prompt（此前「我记住了」全是口头应答）；② 新工具 `set_cwd`——会话级工作目录，shell/file 操作以此为基准，system prompt 声明当前目录（此前命令固定跑在 home，`D:\Code\WxTools` 这类项目全被误判「不是 git 仓库」）；③ 工具 5→7，verify 313→318。同轮落地 ponytail audit 削减项：`scripts/verify-kit.cjs` 共享 electron stub + 计分脚手架（5 份 stub / 10 份样板归一，净减 ~160 行）、`scripts/changelog.mjs` 替换静默空输出的 conventional-changelog 链（BUG-W04 根因推翻：git-raw-commits@5 与 parser@6 分隔符契约断裂）。

> **v0.6.0 关键交付（漂移裁决：ADR-0008 挂点桥接）**：用户质询「用 DSH 作为 agent runtime 是不是 PRD/PLAN 设定」暴露文档漂移——PLAN T-P1-5 写明接入 `ctx.agents.followup`，实际代码直连循环且未做显式裁决；更深危害是 **intent 意图网关与 trace 遥测挂在 `agent/pre-step` 上，该事件只有 dsh AgentLoop 驱动才发，主会话绕过 → 两个 PRD 亮点在主链路是死挂点**。裁决（[ADR-0008](../70-决策/ADR-0008-model-loop-dsh-bridge.md) + conflicts C6）：followup 是 fire-and-forget inbox 驱动、与 Electron IPC 请求-响应不同构，全量切换需重写工具/模型/会话三层映射；v1 落地「挂点桥接」——`dsh-runtime.firePreStep` 每回合驱动 waterfall，intent reject 硬拒不调模型（model-loop O1：`rm -rf /` 被拦、0 次模型调用），trace 观测同挂点生效；AgentLoop 完整事件化列 P7 路线图。PLAN/current-state 漂移表述已同步修正。

> **v0.7.0 关键交付（BUG-021：审批死挂点修复，PRD L3/L4 生效）**：`shell_command` 接入授权门——白名单准入后 paranoid 直接拒、default/trusted 过 `approval.request`（GUI 弹窗，fail-closed）；修复应答方注册错位（此前挂在 authz 插件的空接口上，实际发起方 host-services 的应答器恒 null → 审批 UI 从未收到真实请求）；新增渲染层就绪标记（未就绪零等待拒绝，不等 120s）。至此 PRD 三个亮点挂点（intent 网关/trace 遥测/审批弹窗）全部真实生效于主链路。

> **v0.8.0 补齐（死挂点清零 + FR-5/FR-11 生效）**：① promptLib 提示词库接入对话流（第四个死挂点——服务/桥/UI 齐全但 system prompt 从不消费，用户配置的提示词从未生效）；`runAgentTurn` 经 `mergeForAgent('orchdesk-main')` 合并后注入 system prompt（含冲突标注）。② 记忆召回升级为语义 Top-K（TF-IDF 余弦），召回为空回落机械取尾——短查询与记忆无词面交集时不得吞掉用户告知的事实。③ `file_write` 接入授权门（与 shell 共用 approvalGate），写文件不再 silently 放行。验证 324/324；audit 0 issues。

> **v0.9.0 补齐（第五个死挂点：专家团派发）**：编排此前「看得见目录、发不出任务」——catalog 桥只读，无 compose-team 桥、渲染层无派发入口。修复：`orchdesk:compose-team` IPC（multi `composeTeam` 真实跑三层）+ preload 桥 + 插件页「派发任务」按钮（askInput 收任务 → 委派树渲染）。model-loop Q1 端到端：Director 层经 agentRunner→callModel 真实执行、全节点收敛 done。PRD 亮点「多 Agent 编排」从目录浏览升级为可派发。

> **v0.9.1 修复（fix→patch）**：`firePreStep` payload 补全——此前只传当前单条消息，memory 插件的 80% 上下文阈值检测（按 payload.messages 总 token 估算）形同虚设；现传完整会话正文（system + 历史回灌 + 当前输入），intent 取 lastUser 不受影响、memory 阈值检测真实生效。**两处诚实跳过**：① `web_fetch` 不接补偿/审批门——只读 GET 无不可逆外发，接入只会让每次抓网页弹窗（ponytail 判定不需要存在）；② trusted 模式 file_write 免审——依赖 authz `getMode` 反查缺陷修复（当前把 trusted 折叠为 default，需改插件 + vendor 重物化），成本/价值不匹配，记为已知债（upgrade path 见 `approvalGate` 注释）。

### 1.1 PRD 完成度（FR 维度，2026-08-30 复核）

> 判定口径同 [差距盘点](../99-归档/PRD差距盘点-2026-08-29.md)：「已接线」= 有真实数据流。
> 演进：30%（08-29 前）→ 75%（08-29 补齐）→ ≈ 88%（08-30，v0.5.0–v0.9.1 七连发，代码侧死挂点清零）→ **≈ 91%（08-31，v0.12.0 五连发：FR-9 授权白名单 / FR-4.2 桌面集成 + 数据目录清单 / FR-6 分叉回放 / FR-8 沙箱日志，第十至十三个死挂点清零）**。

| 层 | 权重 | 完成度（08-30 复核） | 说明 |
|------|--------|------|------|
| P0 功能（FR-1~9） | 70% | ~95% | v0.5.0 记忆/工作目录闭环；v0.6.0 意图网关主链路生效（ADR-0008）；v0.7.0 审批弹窗真实生效（FR-9 L3/L4）；v0.8.0 提示词库生效 + file_write 过门；v0.11.0 FR-8 网络白名单 + FR-12 补偿层接线；**v0.12.0 FR-9 授权白名单（会话/永久可撤销）、FR-4.2 桌面集成 6 开关 + 数据目录真实清单、FR-6 分叉回放、FR-8 沙箱日志可检索**；工具 5→7；网关软拒绝降级。剩余：真实模型实机闭环、代码签名 |
| P1 功能（FR-10~12 + 编排） | 25% | ~85% | v0.8.0 记忆语义召回（Top-K + 兜底）；v0.9.0 专家团可派发（委派树端到端 done）；v0.9.1 memory 80% 阈值检测生效。剩余：真实模型下编排/SubAgent 效果验证 |
| P2 功能（自进化 + Hub） | 5% | ~65% | evolution/临时插件（静态分析 + CONFIRM + 仅驻内存）可用；Hub 客户端就绪未连线。剩余：Hub 连接配置实测 |
| **加权合计** | | **≈ 91%** | 剩余 ≈ 9%：① **用户环境运行期验证**——GUI 实机冒烟 / 真实模型闭环 / TRACE 上传 / 签名；② **已知未实现（非死挂点，是未做）**——FR-3 插件市场与连接器（后端无注册表，UI 已诚实标注「规划中」）、FR-7 OrchClaw Hub（PRD 明示首发不含）、FR-10 记忆分层晋升（Worker→Director→global 过滤未见实现）、FR-5 用量追踪（PRD 标「可选」）；③ **P7 路线图依赖**——FR-6 的 dsh `SessionEvent` append-only 级分叉与 NFR「会话可重放重建」的真事件流重建（需接管 `ctx.sessions`，切换前须新 ADR）。**代码侧无已知死挂点（累计发现并修复 13 个）** |

> **v0.10.0 交付（第六个死挂点：TRACE 上传不可达）**：上传端（Issues API + NDJSON + 白名单脱敏）与观测端（v0.6.0）早已完整，但 `configure`/`flush` 是插件模块级导出而非 provide 服务——主进程无桥，repoUrl/TOKEN 无处设置，记录只积压缓冲。修复（用户裁决：**保持 Issues 目标不变**，曾短暂考虑 Contents API 写 Trace/ 子目录，被正确否决——Issues 才是 append-only 审计正解）：① TOKEN **加密内置**——`scripts/prepare-trace.cjs` 打包前用随包密钥 AES-256-GCM 加密 `build/trace-token.local.txt` → `trace-token.enc.json`，dsh-runtime 装载 trace 时解密注入 config（诚实边界：同包密钥=混淆级，TOKEN 必须用 fine-grained 仅 issues:write）；② 用户开关——设置页「TRACE 遥测」开关（默认开），关闭 = repoUrl 置空 → 只缓冲不上传，重启生效；③ verify 329/329（新原语 encryptWithKey/decryptWithKey ×2 + buildTraceConfig 注入 ×2）。
> **v0.10.1 交付（第七个死挂点：记忆持久化 + 记忆主语颠倒）**：① **记忆持久化**——memory 插件的 `serializeDomains`/`dataRoot` 自 v0.6.0 起无 host 接管，记忆仅进程内存、重启即清零（用户实测「记了称呼、重启忘光」的结构性根源之一）。修复：插件新增 `hydrateDomains`（非法条目过滤：空 text/缺 vector/非数组域静默丢弃）；dsh-runtime 装载后从 `dataDir()/memory/{domain}.json` 回灌 + 20s 轮询快照去重落盘 + `stopRuntime` 退出冲刷。② **记忆主语约定**——用户说「你是小星，我是梧哥」被存成「用户称呼：小星」，回放时角色颠倒。修复：`memory_save` 工具描述与系统规则强制第三人称客观存储（「用户」=人类，「助手」=OrchDesk，禁「我/你/对方」），注入头加主语图例。③ **buildTraceConfig 密闭性**——打包含真 TOKEN 后 verify 的「无内置文件」分支失真，加 `ORCHDESK_TRACE_BUILD_DIR` 测试 seam。④ **CI release workflow 修复**——自 v0.8.0 起连续失败（cache: npm 找不到 lock 秒挂 / 缺 vendor-dsh / BUG-W04 conventional-changelog / electron-builder 认 GH_TOKEN 不认 GITHUB_TOKEN），改为 pnpm 全链路 + 插件 lib 自建（lib/ 被 gitignore）+ changelog.mjs + GH_TOKEN。verify 333/333。
> **v0.11.0 交付（第八、第九死挂点 + FR-8 网络白名单 + E2E 套件腐化修复）**：① **TRACE 用户反馈不进遥测**（FR-7）——渲染层「有帮助/需改进」按钮只改本地 Set + persist，`recordFeedback` 从不落地。修复：trace 插件 `provide('trace')`（recordFeedback/queueSize/errorRecords/flushNow）+ `orchdesk:trace-feedback` IPC + preload 桥 + 按钮带 `data-fb` 正负区分，反馈真实入队（source='user'）。② **补偿层工具级未接线**（FR-12）+ **契约 bug**——`comp-withhold` 把 text 包成 `{text}` 传给 `withhold(text: string)`，正则恒不匹配 →「不可修复」警示条与二次确认从未触发；`comp-compensate` 丢弃 note。修复：契约改字符串、note 透传、新增 `outboundGate()` 接进工具链（web_fetch 非白名单域名 + shell 删除/外发命令过补偿层二次确认）。③ **FR-8 网络域名白名单**——sandboxPolicy 新增 `networkAllow`/`isDomainAllowed`（`*` 不限，精确+子域+`*.` 后缀匹配，非法 URL fail-closed）+ 设置页可编辑 + IPC。④ **E2E 套件腐化修复**——`e2e-fix-verify.cjs` 的 mock bridge 返回空 sessions/projects，侧栏/消息流 5 项断言在空数据下永不可能通过（套件空转），改为注入真实形状种子数据并补齐新桥方法 → 16 项/5 失败 → 29 项全绿。verify 337/337。


> **v0.12.0 交付（第十一个死挂点：授权粒度只有「单次」｜PRD FR-9）**：PRD 明文要求「授权粒度：单次 / 会话 / 永久（操作类型+路径白名单，可查看可撤销）」，实际只有「单次」——同一个文件每次写都要重新点确认，设置页也没有白名单可看可撤销。修复分三层：① **authz 插件**新增白名单能力：`GrantRule`（tool + pattern + scope + sessionId + hits）、`grant` / `revoke` / `revokeAll` / `listGrants` / `matchGrant` / `serializeGrants` / `hydrateGrants`，并新增 `grant-added` / `grant-revoked` / `grant-matched` 三类审计。匹配为 **glob-lite**：只支持 `*` 通配、其余正则元字符全部转义、**整串锚定**——`D:/work/*` 不会逃逸到 `D:/workplace/secret`，模式里的 `.` 也不等价于任意字符；目标缺失时只有 `*` 规则能命中（无目标的请求不该被真实路径规则放行）。非法入参一律拒绝并给 reason（白名单是安全边界，静默丢弃会让用户以为「已经记住了」）。② **持久化**：dsh-runtime 新增 `GrantPersistApi`，落盘 `authz-grants.json`，启动回灌（坏条目静默跳过，宁缺勿滥）；与记忆的 20s 轮询不同，白名单走**写穿**——数量少、变更罕见，不能让「刚点了永久允许、20 秒内崩溃就没了」。③ **接线**：`approvalGate` 在 paranoid 判定**之后**、审批弹窗**之前**查白名单（**paranoid 压倒白名单**——用户切偏执的意图就是全锁）；审批请求新增 `target` 字段（file_write 传路径、shell_command 传命令、web_fetch 传 URL），弹窗据此给出「会话内允许 / 永久允许」，无目标时明确说明只能单次允许；设置页新增白名单管理区（按操作类型 + 目标模式 + 粒度添加，列表显示命中次数，可单条撤销 / 全部撤销）。验证：plugins 新增 7 项（含前缀逃逸、元字符转义、会话隔离等安全语义）+ dsh-runtime 2 项（IPC 落盘与回灌）+ E2E 7 项（添加/空目标拦截/撤销）。verify 346→371。
> **v0.12.0 交付（第十个死挂点：桌面集成 6 项全是空壳｜PRD FR-4.2）**：设置页「桌面集成」2×3 网格中，系统托盘 / 全局快捷键 / 登录自启动 / 自动更新 / 悬浮窗 / 开机提醒 **6 项全部是 `data-action="todo"` 占位**——UI 可点、不落盘、更无系统副作用（托盘其实在启动时被无条件 `createTray()`，与开关无关）。修复（新增 `apps/desktop/desktop-integration.ts`：**纯逻辑、零 electron 依赖**，与 data-dir.ts 同一约定）：① **配置层**——6 键归一化（未知键丢弃、字符串 `'false'` 不恒真、缺失回落默认）、`desktop.json` 落盘（登记进 `DATA_FILE_NAMES` 随数据目录迁移）、`setDesktopKey` 拒绝未知键（拼写错误静默丢弃比报错更难查）。② **副作用层**（main.ts，按配置重放、切换时只重放受影响的那一项）：托盘 → `Tray` 创建 / `destroy`；快捷键 → `globalShortcut` 注册 / 注销 `CommandOrControl+Shift+Space`（退出前 `unregisterAll`，否则 Windows 上残留导致快捷键失灵）；自启动 → `app.setLoginItemSettings` 且**回读系统实际状态**（写入可能被系统拒绝，UI 展示实际值而非意愿值）；自动更新 → 延迟 8s 后台 `checkForUpdates`（默认开，退出时安装）；悬浮窗 → 无边框 `alwaysOnTop` + `skipTaskbar` 小窗（沙箱渲染进程，靠 BrowserWindow 'focus' 事件实现「点击唤起主窗」，页面内不发 IPC），内容由渲染层推送会话上下文（主进程不猜）；开机提醒 → 启动完成 / 发现新版发系统通知。③ **渲染层**——6 开关改真实绑定 `data-action="desktop-toggle"`，乐观更新 + 失败回滚；桥未接入时降级为 `.disabled` 不可点并标注（不再出现「UI 可点但不生效」）。④ **验证**——新增 9 项 dsh-runtime 用例（断言重点不是配置能存能读，而是**每个开关真的触发了对应系统副作用**：Tray 实例被 destroy、加速器被注销、登录项被写入、悬浮窗 BrowserWindow 被创建）+ 8 项 E2E（6 开关 key 与 PRD 一致、无 todo 空壳残留、点击翻转）；`scripts/verify-kit.cjs` 补齐 `globalShortcut` / `Notification` / `screen` / `Tray.destroy` / `app.setLoginItemSettings` / BrowserWindow 实例台账。verify 337→346。
> **v0.12.0 交付（第十二个死挂点：会话分叉与回放从未可达｜PRD FR-6）**：PRD 要求「会话可分叉：从任意轮次开新分支」+ NFR「可恢复 · 会话可重放重建」，实际 `case 'fork'` 在全项目**零调用点**——分叉逻辑只存在于会话状态字段（`forkedFrom`/`forkedAt`）与 `doFork` 函数里，UI 没有任何按钮能触发它，是典型的「服务/逻辑全建好了，但真实链路从未调用」。修复：① **入口接线**——会话标题栏补「分叉」「回放」两个真实按钮（此前只有 `data-action="todo"` 占位）。② **分叉点可选**——弹窗内滑块 0..N（默认全继承），标签实时显示「第 N 条（你：…）之后」；血缘记 `{from, atIndex, at, fromTitle}`，分支顶部显示血缘提示，消息流在第 N 条后插入分叉点节点标记（`.fork-node` 虚线 + 徽章）。③ **回放**——`renderReplay()` 从同一份数据重建只读时间线（不挂 composer，退出即恢复），事件按「消息顺序、消息内先 tool → subagent → feedback」铺开，分支额外在最前插 `fork-origin`。④ **两个易错语义已写进代码注释**：`forkMessages` 只认**真数字**为分叉点——`Number(null) === 0`，照单全收会把「没传分叉点」静默变成「空分支」，而丢消息不可逆，故 `null/''/undefined` 一律按全继承；切片必须走 `s.msgs`（deepClone 产物），不能切 `src.msgs`，后者元素仍是源会话的对象引用，分支与主干会共享消息对象。⑤ **单文件双环境**——新增 `renderer/session-fork.js`（UMD-lite，`module.exports` + `window.OrchDeskFork`），因为主窗口 `webPreferences` 是 `sandbox:true`（preload 拿不到 `require`）、app.js 是 IIFE（也不能 `require` TS 产物），做成双环境单文件才能让 Node 验证套件与浏览器渲染层**共用同一份**，杜绝源码/产物漂移。⑥ **诚实边界**——当前回放的数据形态是 sessions.json 的消息数组，还不是 dsh `SessionEvent` append-only 事件流（需接管 `ctx.sessions`，属 P7 路线图，切换前须新 ADR）；UI 与文档均不假装已达成。验证：新增 `session-fork-verify.cjs` 29 项（装载契约 / 血缘归一化 / 切片边界 / 回放时间线）+ E2E 组 8 共 20 项。
> **v0.12.0 交付（第十三个死挂点：沙箱判定只活在 return 里｜PRD FR-8「日志可检索」）**：PRD 明文要求沙箱「日志可检索」，实际所有判定（路径越界、命令不在白名单、域名未授权、审批放行/拒绝、执行异常）**只存在于 `executeTool` 的返回值里**，事后无从追溯「为什么被拦」。修复：① **埋点**——`executeTool` 11 处（file_read/file_write/file_list/shell_command/web_fetch/set_cwd 的放行、拒绝、执行异常）+ 外层 `catch` 兜底埋点（首版漏了这条：`file_read` 读不存在文件时直接抛到外层，导致「落盘可回读」用例拿不到任何记录）；相对路径一律解析成绝对路径再记，否则用户按绝对路径检索永不命中。② **持久化**——新增 `sandbox-log.ts`（纯逻辑、零 electron 依赖）：环形缓冲 500 条、淘汰最旧（审计追溯看最近的事故，不是当数据库）、**写穿落盘** `sandbox-log.json`（与授权白名单同节奏，不留「刚发生就崩了」的窗口）；坏条目跳过而非整体丢弃。③ **检索**——设置页新增关键词 / 判定 / 类型三维检索 + 统计条（放行/拒绝/出错 + Top 工具）+ 清空；关键词走 `input` 监听 350ms 防抖（首版误放进 `change` 监听，需失焦才触发）。④ **「未接入」与「接了但为空」必须区分**——无桥返回 `null` → `loaded=false` → UI 显示「未接入」，不显示「0 条」。验证：credentials 19→34（8 项纯逻辑 + 5 项真实 IPC 驱动：命令白名单拒绝入日志、审批放行记 allowed、审批拒绝记 denied、落盘可回读、清空归零）+ E2E 组 9 共 9 项。
> **v0.12.0 交付（FR-4.2 数据目录内容清单 + 假数据清理）**：设置页「数据目录」卡片与右栏快捷操作里写死 **`~ 24 MB` / `~ 1.2 MB` 两个硬编码数字**，与真实磁盘毫无关系——「备份整个数据目录」旁边标的体积是编的。修复：① `data-dir.ts` 新增 `scanDataDir()`（递归、**跳过符号链接**避免软链成环、顶层子项按体积降序 + 根汇总 `.` 排在最后、目录不存在返回空清单不抛错）+ `formatBytes()`；`sizeText` 在主进程侧生成，渲染层不再各写一套换算。② IPC `orchdesk:data-dir-inventory` + preload 桥 + 设置页渲染真实清单（每项名称/类型/体积/文件数）。③ **修 `statTree` 重复计数 bug**（由新增用例当场抓出）：父级照单全收 `out` 的新增条目时，后代**目录条目本身**被算第二遍——`logs` 实为 120 B 报 190 B、根汇总 520 B 报 780 B；改为递归返回 `{size, files}` 供父级累加，并在注释里写明不要改回扫 `out` 的写法。④ **桥不可用显示「内容清单未接入（主进程桥不可用）」**而不是沿用旧假数字。⑤ 清单只在启动时取一次，导入/导出之后会过期 → 补「刷新清单」按钮。⑥ **假数据/空壳清零**——右栏两个假数字与一个 `data-action="todo"` 空壳按钮全部替换；侧栏最后一个 `todo` seg-tab 改为静态标签；兜底分支从静默 toast 改为 `console.warn` + 显式「该动作尚未接线」+ `default:` 未知动作告警（此前那句「该操作在真实版本中打开对应面板」是用假承诺糊死挂点，比不写更糟）。验证：data-dir 36→47（空目录 / 嵌套汇总 / 空目录 / 软链不成环 / formatBytes 四档与负数回退）+ E2E 组 10 共 11 项（含「已无 `~ 24 MB` 硬编码」反向断言与桥不可用降级）。全量 verify **371→465**（12 套件）。
> 详细：差距盘点（30%）见 [PRD差距盘点-2026-08-29](../99-归档/PRD差距盘点-2026-08-29.md)；
> 补齐复盘（75%）见 [PRD差距补齐-2026-08-29](../99-归档/PRD差距补齐-2026-08-29.md)。

### 1.2 环境门控

- **本机（WorkBuddy CLI）**：无法启动 Electron GUI（BUG-W02，binding 未链接）—— 业务逻辑验证走 node 直驱（verify 套件）
- **正常 Windows 桌面**：双击 `release-v091/OrchDesk Setup 0.9.1.exe`（安装版）或 `release-v091/OrchDesk 0.9.1.exe`（便携版）即可运行
- **真实模型闭环**：需配置 API Key（OpenAI 兼容）或本地 Ollama；`runAgentTurn` 已接真实工具循环

---

## 2. 版本治理方案

### 2.1 版本号递增规则

采用 **SemVer** + **Conventional Commits** 自动推断：

```
<version> = <major>.<minor>.<patch>
```

| 提交类型 | 版本影响 | 例子 |
|----------|----------|------|
| `feat:` | MINOR 递增 (`0.1.0` → `0.2.0`) | 新功能 |
| `fix:` | PATCH 递增 (`0.2.0` → `0.2.1`) | Bug 修复 |
| `BREAKING CHANGE:` | MAJOR 递增 (`0.2.0` → `1.0.0`) | 兼容性破坏 |
| `docs:`/`chore:`/`refactor:`/`test:` | 不影响版本 | 文档/运维/重构/测试 |

### 2.2 版本递增工具

| 工具 | 用途 |
|------|------|
| `bumpp` | 交互式版本递增（patch/minor/major 选择），自动更新 `package.json` + 打 git tag |
| `conventional-changelog-cli` | 从 git 提交自动生成 `CHANGELOG.md`（Angular preset） |
| `electron-updater` | 运行时检测 GitHub Releases，自动下载 + 安装更新 |

### 2.3 release 流程（一条命令）

```bash
# 1. 确认代码已提交
git status

# 2. 运行 release 脚本（changelog → version bump → build → dist）
pnpm run release

# 3. 推送到 GitHub（触发 CI + 自动发布）
git push origin main --follow-tags
```

### 2.4 CI/CD（GitHub Actions）

**`release.yml` 触发条件**：
- 推送 `v*` tag（如 `git push origin v0.2.0`）
- 或手动触发（`workflow_dispatch`）

**CI 流水线**：
1. Checkout + Setup Node 20
2. `npm install`
3. 从 tag 提取版本号 → 更新 `package.json`
4. 生成 `CHANGELOG.md`
5. `tsc` 编译
6. `electron-builder` 打包（nsis + portable）
7. Upload artifact（保留 30 天）
8. 自动发布到 GitHub Releases（`--publish always`）

### 2.5 自动更新通道

```
应用启动 → checkForUpdates()
    ↓
electron-updater → 请求 GitHub Releases /latest.yml
    ↓
有新版？→ autoDownload（后台下载）
    ↓
下载完成 → 通知用户 → 用户确认 → autoInstallOnAppQuit（退出时安装）
```

- **更新前必做**：`snapshotData()` 快照 userData（`app.getPath('userData')` 复制到 `snapshots/<时间戳>`）
- **开发模式**：跳过更新检查（`!app.isPackaged`）

### 2.6 不可变的原则

1. **版本号 = package.json version = git tag = GitHub Release tag**，四者一致
2. **唯一修改版本号的入口** = `pnpm run version:bump`（bumpp），禁止手动编辑
3. **所有代码变更须使用 conventional commits**，否则版本推断失效
4. **打 tag 前必须有 CHANGELOG.md 条目**（`pnpm run release` 自动保证）
5. **更新前必须先快照**（`snapshotData` 在 `checkForUpdates` 内自动执行）
6. **禁止在同一版本号上重复打包**：`build` / `dist*` 前置 `scripts/check-version.cjs`
   —— 当 `package.json` 版本与最新 tag 相同时直接阻断，必须走 `version:bump`。
   唯一例外是 release 流程（传 `--allow-tagged`，且 tag 必须指向当前 HEAD）。
   本条由机器执行，不依赖自觉（2026-08-30 起因「连续多版都打在 0.3.1 上」而立）

### 2.7 NPM 脚本一览

| 脚本 | 用途 |
|------|------|
| `pnpm run version:bump` | 交互式版本递增（bumpp）；CI/脚本环境用 `npx bumpp minor --yes` |
| `pnpm run changelog` | 手动重新生成 CHANGELOG.md |
| `pnpm run check-version` | 版本守卫（同版本号重复打包时阻断） |
| `pnpm run version:show` | 显示当前版本 + 最新 tag |
| `pnpm run release` | `changelog` → `version:bump` → `dist` 一条龙 |
| `pnpm run build` | 版本守卫(allow-tagged) → `tsc` → `electron-builder` |
| `pnpm run dist` | `tsc` → `electron-builder --publish never` |

---

## 3. 关键决策（ADR 摘要）

| 决策 | 方案 | 理由 |
|------|------|------|
| 版本治理 | SemVer + Conventional Commits + bumpp | 行业标准，GitHub 生态原生支持 |
| 自动更新 | electron-updater + GitHub Releases | 零成本，无需自建服务器 |
| CI/CD | GitHub Actions | 仓库原生，无需第三方 |
| 脚本约束 | 唯一版本修改入口 | 避免手动编辑导致版本漂移 |
| 更新前快照 | snapshotData → snapshots/ | 更新失败可回滚 |

完整 ADR 见 [docs/70-决策/](../70-决策/)

---

## 4. 当前里程碑

### v0.3.1（已发布，2026-08-29）

**主题**：Agent Runtime 工具调用稳定化 + 数据目录统一

- [x] BUG-014 工具调用参数构造根因修复（`agent-runtime.ts` 纯逻辑 + 双模式适配）
- [x] BUG-013 数据目录统一与迁移（`dataDir()` + `migrateLegacyData()`）
- [x] BUG-015 未选模型自动跳转设置页
- [x] BUG-016 打包前 `kill-running.cjs` 结束进程防 EBUSY
- [x] 验证体系 78 项全绿（agent-runtime 35 / agent-loop 14 / e2e 29）

### v0.4.0（已提交 main，未发布；2026-08-29 第二轮补齐）

**主题**：接入 dsh/Cordis 运行时，激活全部 9 插件（PRD 差距补齐）

- [x] P0-1 接入 dsh/Cordis 运行时，`startRuntime()` 装载 9 插件（commit `e820e33`）
- [x] P0-2 修复 `provide(name,value,true)` 误传第三参（7 插件）
- [x] P1-3 凭据改 AES-256-GCM + 机器指纹（`credentials.ts`）
- [x] P1-4 沙箱子进程隔离 + 清理 6 个 mock 常量
- [x] P2-5 插件测试 2/9 → 9/9（`scripts/verify-plugins.mjs` 51 项）+ 修复 3 真 bug
- [x] 6 处渲染层缺陷修复（clone→deepClone / 插件开关 / model-test / tool-step / TRACE key / 项目落盘）
- [x] 验证体系扩至 158 项全绿（新增 dsh-runtime 20 / credentials 19 / verify-plugins 51）

**第二轮补齐（2026-08-29 晚，yt-dev-review 三方审阅 + 交叉修复流程）**：

- [x] M1 guanji.json / hub.json / skills 统一数据目录（新纯逻辑 `data-dir.ts` + 凭据 copy-if-absent 迁移；审阅修复「便携模式生产失效」BLOCKER：`resolveDataDir` 漏传 `existsSync`）
- [x] M2 导出 / 导入 JSON 数据功能（BUG-013 方案 B：`orchdesk:export-data/import-data` + 设置页按钮；审阅修复「导入竞态被 persist 整体冲掉」BLOCKER + 明文凭据结构校验）
- [x] M3 真实模型闭环线级验证（`model-loop-verify.cjs` 23 项，真 HTTP mock；审阅修复 responses 模式丢 system/assistant 历史）
- [x] M4 SubAgent 派生 / 编排闭环验证（`scripts/verify-orchestration.mjs` 45 项；修复 `promoteWorkerOutput` 恒 false（FR-10 晋升断裂）/ rootId 同毫秒碰撞 / 委派树只展开一层 / 失败节点被洗白）
- [x] M5 TRACE 脱敏上传离线验证（`scripts/verify-trace-upload.mjs` 36 项；修复 30s 定时器永不上传 / splice 误删队首 / 无配置静默丢单 / 明文凭据可导入）
- [x] M6 vendor 脚本修复（`apps/vendor` → `apps/desktop/vendor` + exports `./` 前缀 + 原地覆盖同步绕开沙箱 bulk-delete 守卫 + build.files 补 `node_modules/@deepseek-ai`），`@deepseek-ai/*` require 探测通过
- [x] 验证体系扩至 **308 项全绿**（11 套件，`npm run verify` EXIT=0）
- [x] 打包 v0.4.0 产物验证（`release/OrchDesk Setup 0.3.1.exe` 82M + portable；asar 含 9 插件 + 包外 `node_modules/@deepseek-ai`；**打包产物内 9/9 插件真实 import 通过**，经 `ELECTRON_RUN_AS_NODE=1 OrchDesk.exe -e "import('app.asar/vendor/plugins/...')"` 实测）
- [x] **BUG-017 真机启动崩溃已修**（用户桌面实测发现）：dsh-runtime 的 CJS 静态 `require('@deepseek-ai/cordis')` 在 asar 内解析不到包外依赖 → 改「多级探测 cordisEntry + 显式路径 ESM 动态加载」（详见 60-BUG）；node 直驱 9/9 激活 + verify 15/15 回归通过
- [ ] GUI 实机复测（BUG-W02 门控，用户桌面双击重装后的 Setup exe 验证 BUG-017 修复）
- [ ] 真实模型闭环 + SubAgent 派生 + TRACE 上传实测（须 API Key / Ollama / GitHub repoUrl + TOKEN）
- [ ] 代码签名

### v0.3.0 / v0.2.0（历史）

- v0.2.0 主题：UI/UX 迭代 + 开发体验（启动并行化、marked.js、模型管理、版本治理）
- 历史发布见 [99-归档](../99-归档/index.md)

---

## 5. 快速接续指南

**首次进入本仓库**：

```bash
git clone https://github.com/ra1nzzz/orchdesk.git
cd orchdesk/apps/desktop
pnpm install
pnpm run build
pnpm start
```

**日常开发**：

```bash
# 开发模式
cd apps/desktop
pnpm run build:main && electron .

# 版本发布
pnpm run release          # 自动递增 + changelog + 打包
git push origin main --follow-tags  # 推送 + 触发 CI
```

**遇到问题**？

| 问题 | 解决 |
|------|------|
| Electron 启动白屏 | 正常现象（mock bridge），正常桌面环境会加载真实桥 |
| 验证套件某项 FAIL | 先 `tsc -p apps/desktop/tsconfig.json` 确认编译，再 `npm run verify` |
| BUG-W02 | 本机 WorkBuddy 环境无法启动 Electron，须正常桌面 |
| 插件编译失败 | 确认 `references/deepseek-harness` 已构建、`scripts/vendor-dsh.cjs` 已跑 |
| 快照失败 | 检查 `userData` 目录权限 |
| `@deepseek-ai/*` require 失败 | 重跑 `node apps/desktop/scripts/vendor-dsh.cjs` 物化依赖到 `apps/vendor/` |

---

*最后更新：2026-08-30（第十批：桌面集成 6 项真实接线（PRD FR-4.2）+ verify 337→346）*
*上游文档：[current-state.md](./current-state.md) | [VERSION-GOVERNANCE.md](./VERSION-GOVERNANCE.md) | [PRD差距补齐复盘](../99-归档/PRD差距补齐-2026-08-29.md) | 变更日志 `apps/desktop/CHANGELOG.md`（仓库根，docs 外）*
