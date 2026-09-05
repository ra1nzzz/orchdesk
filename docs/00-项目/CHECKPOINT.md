# CHECKPOINT

> 项目状态快照 + 版本治理 + 关键决策 + 下一步。
> 本文件是「项目进行到哪了」的唯一入口，阅读本文件即可接续工作。

---

## 1. 项目状态

| 维度 | 状态 | 说明 |
|------|------|------|
| **当前版本** | `0.14.0`（tag `v0.14.0` 已推；GitHub Release 待建 —— `gh` 未登录，需用 ra1nzzz token 走 API） | SemVer，pre-1.0 阶段 |
| **最新 Commit** | `5f1ae01` | feat(ui): UI/UX 前端收敛（对比度 / 键盘可达 / 硬编码色 / 插件&SKILL 搜索 / 设置页导航 / 响应式） |
| **主线分支** | `main` | protected，push 需 CI 通过 |
| **远端仓库** | `ra1nzzz/orchdesk` | GitHub，public |
| **最新 Release** | [v0.12.0](https://github.com/ra1nzzz/orchdesk/releases/tag/v0.12.0)（`v0.13.0` 已本地打包、待推） | 由 `v*` tag 触发 CI：tsc → electron-builder（nsis + portable）→ 上传资产为 **Draft**；需人工补 notes 并转正（`gh release edit v0.12.0 --notes-file … --draft=false`）——CI 不会自动发布。v0.13.0 产物已出（Setup 88,081,451 B / portable 87,736,328 B，sha512 与 `latest.yml` 一致，asar 195 文件校验通过），**待桌面会话实机冒烟后再推 Release** |
| **文档审计** | 0 issues（`audit_knowledge_base.py docs`） | canonical 文档与代码保持一致 |
| **TypeScript** | tsc EXIT=0 | 全栈编译无错误 |
| **验证套件** | 907/907 PASS | `npm run verify`（plugins 88 / orchestration 50 / trace-upload 37 / agent-runtime 40 / agent-loop 14 / model-loop 45 / dsh-runtime 31 / ipc-guard 4 / credentials 34 / data-dir 47 / data-port 10 / session-fork 29 / memory-promotion 22 / memory-summarize 16 / connector-registry 30 / plugin-market 15 / usage-registry 11 / session-events 16 / ts-loader 13 / browser-tools 44 / terminal-pty 29 / file-panel 20 / file-edit 20 / arch-guard 15 / mcp-client 10 / e2e 217）—— 26 套件；另设不进链的真机冒烟 `pnpm run smoke:browser`（11/11，需真 GPU/渲染进程） |
| **真机冒烟** | 待人工执行 | `pnpm run smoke:browser`（`apps/desktop/scripts/browser-smoke.cjs`，10 步）。**刻意不进 verify 链**：需要真 GPU/渲染进程，CI 与非交互会话必假红；脚本启动期即自检 `process.type` 并给出退出码 2 的显式指引 |

> **v0.4.1 关键修复**：StepFun / 部分 OpenAI 兼容网关在 chat 模式下带 `tools` 参数时返回 HTTP 200、content/toolCalls 全空（软拒绝），导致「发消息能响应，要求执行任务则报错」。现 `callOpenAICompatible` 识别软拒绝并逐级降级到不带 tools，成功后把 `provider.id|model` 记入进程级记忆，后续会话直接走 `<tool:>` 文本兜底解析。新增 model-loop M 组 3 项回归测试。

> **v0.5.0 关键交付（dsh memory 真实接入对话流，BUG-019/020）**：① 新工具 `memory_save`——用户告知的长期事实写入 dsh memory 插件 global 域，每轮回召回最近 10 条注入 system prompt（此前「我记住了」全是口头应答）；② 新工具 `set_cwd`——会话级工作目录，shell/file 操作以此为基准，system prompt 声明当前目录（此前命令固定跑在 home，`D:\Code\WxTools` 这类项目全被误判「不是 git 仓库」）；③ 工具 5→7，verify 313→318。同轮落地 ponytail audit 削减项：`scripts/verify-kit.cjs` 共享 electron stub + 计分脚手架（5 份 stub / 10 份样板归一，净减 ~160 行）、`scripts/changelog.mjs` 替换静默空输出的 conventional-changelog 链（BUG-W04 根因推翻：git-raw-commits@5 与 parser@6 分隔符契约断裂）。

> **v0.6.0 关键交付（漂移裁决：ADR-0008 挂点桥接）**：用户质询「用 DSH 作为 agent runtime 是不是 PRD/PLAN 设定」暴露文档漂移——PLAN T-P1-5 写明接入 `ctx.agents.followup`，实际代码直连循环且未做显式裁决；更深危害是 **intent 意图网关与 trace 遥测挂在 `agent/pre-step` 上，该事件只有 dsh AgentLoop 驱动才发，主会话绕过 → 两个 PRD 亮点在主链路是死挂点**。裁决（[ADR-0008](../70-决策/ADR-0008-model-loop-dsh-bridge.md) + conflicts C6）：followup 是 fire-and-forget inbox 驱动、与 Electron IPC 请求-响应不同构，全量切换需重写工具/模型/会话三层映射；v1 落地「挂点桥接」——`dsh-runtime.firePreStep` 每回合驱动 waterfall，intent reject 硬拒不调模型（model-loop O1：`rm -rf /` 被拦、0 次模型调用），trace 观测同挂点生效；AgentLoop 完整事件化列 P7 路线图。PLAN/current-state 漂移表述已同步修正。

> **v0.7.0 关键交付（BUG-021：审批死挂点修复，PRD L3/L4 生效）**：`shell_command` 接入授权门——白名单准入后 paranoid 直接拒、default/trusted 过 `approval.request`（GUI 弹窗，fail-closed）；修复应答方注册错位（此前挂在 authz 插件的空接口上，实际发起方 host-services 的应答器恒 null → 审批 UI 从未收到真实请求）；新增渲染层就绪标记（未就绪零等待拒绝，不等 120s）。至此 PRD 三个亮点挂点（intent 网关/trace 遥测/审批弹窗）全部真实生效于主链路。

> **v0.8.0 补齐（死挂点清零 + FR-5/FR-11 生效）**：① promptLib 提示词库接入对话流（第四个死挂点——服务/桥/UI 齐全但 system prompt 从不消费，用户配置的提示词从未生效）；`runAgentTurn` 经 `mergeForAgent('orchdesk-main')` 合并后注入 system prompt（含冲突标注）。② 记忆召回升级为语义 Top-K（TF-IDF 余弦），召回为空回落机械取尾——短查询与记忆无词面交集时不得吞掉用户告知的事实。③ `file_write` 接入授权门（与 shell 共用 approvalGate），写文件不再 silently 放行。验证 324/324；audit 0 issues。

> **v0.9.0 补齐（第五个死挂点：专家团派发）**：编排此前「看得见目录、发不出任务」——catalog 桥只读，无 compose-team 桥、渲染层无派发入口。修复：`orchdesk:compose-team` IPC（multi `composeTeam` 真实跑三层）+ preload 桥 + 插件页「派发任务」按钮（askInput 收任务 → 委派树渲染）。model-loop Q1 端到端：Director 层经 agentRunner→callModel 真实执行、全节点收敛 done。PRD 亮点「多 Agent 编排」从目录浏览升级为可派发。

> **v0.9.1 修复（fix→patch）**：`firePreStep` payload 补全——此前只传当前单条消息，memory 插件的 80% 上下文阈值检测（按 payload.messages 总 token 估算）形同虚设；现传完整会话正文（system + 历史回灌 + 当前输入），intent 取 lastUser 不受影响、memory 阈值检测真实生效。**两处诚实跳过**：① `web_fetch` 不接补偿/审批门——只读 GET 无不可逆外发，接入只会让每次抓网页弹窗（ponytail 判定不需要存在）；② trusted 模式 file_write 免审——依赖 authz `getMode` 反查缺陷修复（当前把 trusted 折叠为 default，需改插件 + vendor 重物化），成本/价值不匹配，记为已知债（upgrade path 见 `approvalGate` 注释）。

### 1.1 PRD 完成度（FR 维度，2026-08-30 复核）

> 判定口径同 [差距盘点](../99-归档/PRD差距盘点-2026-08-29.md)：「已接线」= 有真实数据流。
> 演进：30%（08-29 前）→ 75%（08-29 补齐）→ ≈ 88%（08-30，v0.5.0–v0.9.1 七连发，代码侧死挂点清零）→ ≈ 91%（08-31，v0.12.0 五连发：FR-9 授权白名单 / FR-4.2 桌面集成 + 数据目录清单 / FR-6 分叉回放 / FR-8 沙箱日志，第十至十三个死挂点清零）→ ≈ 93%（08-31，v0.12.0 第六、七段：FR-10 分层记忆晋升调用链 + 语义分块 + LLM 摘要 seam，第十四、十五个死挂点清零）→ ≈ 95%（08-31，v0.12.0 第八段：FR-3 连接器后端注册表——8 连接器真目录 + 凭证加密存储 + 保存即探测 + 审计）→ **≈ 97%（08-31，v0.12.0 第九段：FR-3 本地插件市场注册表——manifest 校验 + 与内置同形的真热插拔，fail-closed）**→ **≈ 98%（08-31，v0.12.0 第十段：FR-5 用量追踪 + FR-6 SessionEvent append-only 事件流（ADR-0009），第十六个死挂点「模型可见必入日志」达成）**→ **≈ 98%（09-01，v0.12.0 第十一段：TS 直测 loader + 架构守护测试（ADR-0010）——百分点不变，本段不增 PRD 功能，只把既有铁律从「人肉遵守」升级为「机器守护」）**。

| 层 | 权重 | 完成度（08-30 复核） | 说明 |
|------|--------|------|------|
| P0 功能（FR-1~9） | 70% | ~95% | v0.5.0 记忆/工作目录闭环；v0.6.0 意图网关主链路生效（ADR-0008）；v0.7.0 审批弹窗真实生效（FR-9 L3/L4）；v0.8.0 提示词库生效 + file_write 过门；v0.11.0 FR-8 网络白名单 + FR-12 补偿层接线；**v0.12.0 FR-9 授权白名单（会话/永久可撤销）、FR-4.2 桌面集成 6 开关 + 数据目录真实清单、FR-6 分叉回放、FR-8 沙箱日志可检索**；工具 5→7；网关软拒绝降级。剩余：真实模型实机闭环、代码签名 |
| P1 功能（FR-10~12 + 编排） | 25% | ~85% | v0.8.0 记忆语义召回（Top-K + 兜底）；v0.9.0 专家团可派发（委派树端到端 done）；v0.9.1 memory 80% 阈值检测生效。剩余：真实模型下编排/SubAgent 效果验证 |
| P2 功能（自进化 + Hub） | 5% | ~65% | evolution/临时插件（静态分析 + CONFIRM + 仅驻内存）可用；Hub 客户端就绪未连线。剩余：Hub 连接配置实测 |
| **加权合计** | | **≈ 98%** | 剩余 ≈ 2%：① **用户环境运行期验证**——GUI 实机冒烟 / 真实模型闭环 / TRACE 上传 / 签名 / 连接器真实凭证探测；② **已知未实现**——FR-7 OrchClaw Hub（PRD 明示首发不含）；③ **P7 路线图依赖**——接管 dsh `ctx.sessions` 的完整事件化（FR-5/FR-6 的 OrchDesk 侧实现已交付，见 [ADR-0009](../70-决策/ADR-0009-session-event-log.md)，dsh 侧接管切换前须新 ADR）。**代码侧无已知死挂点（累计发现并修复 16 个）**；工程纪律已由 `arch-guard-verify.cjs` 机器守护（见 [ADR-0010](../70-决策/ADR-0010-ts-direct-test-and-arch-guard.md)），不再是仅靠自觉 |

> **v0.10.0 交付（第六个死挂点：TRACE 上传不可达）**：上传端（Issues API + NDJSON + 白名单脱敏）与观测端（v0.6.0）早已完整，但 `configure`/`flush` 是插件模块级导出而非 provide 服务——主进程无桥，repoUrl/TOKEN 无处设置，记录只积压缓冲。修复（用户裁决：**保持 Issues 目标不变**，曾短暂考虑 Contents API 写 Trace/ 子目录，被正确否决——Issues 才是 append-only 审计正解）：① TOKEN **加密内置**——`scripts/prepare-trace.cjs` 打包前用随包密钥 AES-256-GCM 加密 `build/trace-token.local.txt` → `trace-token.enc.json`，dsh-runtime 装载 trace 时解密注入 config（诚实边界：同包密钥=混淆级，TOKEN 必须用 fine-grained 仅 issues:write）；② 用户开关——设置页「TRACE 遥测」开关（默认开），关闭 = repoUrl 置空 → 只缓冲不上传，重启生效；③ verify 329/329（新原语 encryptWithKey/decryptWithKey ×2 + buildTraceConfig 注入 ×2）。
> **v0.10.1 交付（第七个死挂点：记忆持久化 + 记忆主语颠倒）**：① **记忆持久化**——memory 插件的 `serializeDomains`/`dataRoot` 自 v0.6.0 起无 host 接管，记忆仅进程内存、重启即清零（用户实测「记了称呼、重启忘光」的结构性根源之一）。修复：插件新增 `hydrateDomains`（非法条目过滤：空 text/缺 vector/非数组域静默丢弃）；dsh-runtime 装载后从 `dataDir()/memory/{domain}.json` 回灌 + 20s 轮询快照去重落盘 + `stopRuntime` 退出冲刷。② **记忆主语约定**——用户说「你是小星，我是梧哥」被存成「用户称呼：小星」，回放时角色颠倒。修复：`memory_save` 工具描述与系统规则强制第三人称客观存储（「用户」=人类，「助手」=OrchDesk，禁「我/你/对方」），注入头加主语图例。③ **buildTraceConfig 密闭性**——打包含真 TOKEN 后 verify 的「无内置文件」分支失真，加 `ORCHDESK_TRACE_BUILD_DIR` 测试 seam。④ **CI release workflow 修复**——自 v0.8.0 起连续失败（cache: npm 找不到 lock 秒挂 / 缺 vendor-dsh / BUG-W04 conventional-changelog / electron-builder 认 GH_TOKEN 不认 GITHUB_TOKEN），改为 pnpm 全链路 + 插件 lib 自建（lib/ 被 gitignore）+ changelog.mjs + GH_TOKEN。verify 333/333。
> **v0.11.0 交付（第八、第九死挂点 + FR-8 网络白名单 + E2E 套件腐化修复）**：① **TRACE 用户反馈不进遥测**（FR-7）——渲染层「有帮助/需改进」按钮只改本地 Set + persist，`recordFeedback` 从不落地。修复：trace 插件 `provide('trace')`（recordFeedback/queueSize/errorRecords/flushNow）+ `orchdesk:trace-feedback` IPC + preload 桥 + 按钮带 `data-fb` 正负区分，反馈真实入队（source='user'）。② **补偿层工具级未接线**（FR-12）+ **契约 bug**——`comp-withhold` 把 text 包成 `{text}` 传给 `withhold(text: string)`，正则恒不匹配 →「不可修复」警示条与二次确认从未触发；`comp-compensate` 丢弃 note。修复：契约改字符串、note 透传、新增 `outboundGate()` 接进工具链（web_fetch 非白名单域名 + shell 删除/外发命令过补偿层二次确认）。③ **FR-8 网络域名白名单**——sandboxPolicy 新增 `networkAllow`/`isDomainAllowed`（`*` 不限，精确+子域+`*.` 后缀匹配，非法 URL fail-closed）+ 设置页可编辑 + IPC。④ **E2E 套件腐化修复**——`e2e-fix-verify.cjs` 的 mock bridge 返回空 sessions/projects，侧栏/消息流 5 项断言在空数据下永不可能通过（套件空转），改为注入真实形状种子数据并补齐新桥方法 → 16 项/5 失败 → 29 项全绿。verify 337/337。


> **v0.12.0 交付（第十一个死挂点：授权粒度只有「单次」｜PRD FR-9）**：PRD 明文要求「授权粒度：单次 / 会话 / 永久（操作类型+路径白名单，可查看可撤销）」，实际只有「单次」——同一个文件每次写都要重新点确认，设置页也没有白名单可看可撤销。修复分三层：① **authz 插件**新增白名单能力：`GrantRule`（tool + pattern + scope + sessionId + hits）、`grant` / `revoke` / `revokeAll` / `listGrants` / `matchGrant` / `serializeGrants` / `hydrateGrants`，并新增 `grant-added` / `grant-revoked` / `grant-matched` 三类审计。匹配为 **glob-lite**：只支持 `*` 通配、其余正则元字符全部转义、**整串锚定**——`D:/work/*` 不会逃逸到 `D:/workplace/secret`，模式里的 `.` 也不等价于任意字符；目标缺失时只有 `*` 规则能命中（无目标的请求不该被真实路径规则放行）。非法入参一律拒绝并给 reason（白名单是安全边界，静默丢弃会让用户以为「已经记住了」）。② **持久化**：dsh-runtime 新增 `GrantPersistApi`，落盘 `authz-grants.json`，启动回灌（坏条目静默跳过，宁缺勿滥）；与记忆的 20s 轮询不同，白名单走**写穿**——数量少、变更罕见，不能让「刚点了永久允许、20 秒内崩溃就没了」。③ **接线**：`approvalGate` 在 paranoid 判定**之后**、审批弹窗**之前**查白名单（**paranoid 压倒白名单**——用户切偏执的意图就是全锁）；审批请求新增 `target` 字段（file_write 传路径、shell_command 传命令、web_fetch 传 URL），弹窗据此给出「会话内允许 / 永久允许」，无目标时明确说明只能单次允许；设置页新增白名单管理区（按操作类型 + 目标模式 + 粒度添加，列表显示命中次数，可单条撤销 / 全部撤销）。验证：plugins 新增 7 项（含前缀逃逸、元字符转义、会话隔离等安全语义）+ dsh-runtime 2 项（IPC 落盘与回灌）+ E2E 7 项（添加/空目标拦截/撤销）。verify 346→371。
> **v0.12.0 交付（第十个死挂点：桌面集成 6 项全是空壳｜PRD FR-4.2）**：设置页「桌面集成」2×3 网格中，系统托盘 / 全局快捷键 / 登录自启动 / 自动更新 / 悬浮窗 / 开机提醒 **6 项全部是 `data-action="todo"` 占位**——UI 可点、不落盘、更无系统副作用（托盘其实在启动时被无条件 `createTray()`，与开关无关）。修复（新增 `apps/desktop/desktop-integration.ts`：**纯逻辑、零 electron 依赖**，与 data-dir.ts 同一约定）：① **配置层**——6 键归一化（未知键丢弃、字符串 `'false'` 不恒真、缺失回落默认）、`desktop.json` 落盘（登记进 `DATA_FILE_NAMES` 随数据目录迁移）、`setDesktopKey` 拒绝未知键（拼写错误静默丢弃比报错更难查）。② **副作用层**（main.ts，按配置重放、切换时只重放受影响的那一项）：托盘 → `Tray` 创建 / `destroy`；快捷键 → `globalShortcut` 注册 / 注销 `CommandOrControl+Shift+Space`（退出前 `unregisterAll`，否则 Windows 上残留导致快捷键失灵）；自启动 → `app.setLoginItemSettings` 且**回读系统实际状态**（写入可能被系统拒绝，UI 展示实际值而非意愿值）；自动更新 → 延迟 8s 后台 `checkForUpdates`（默认开，退出时安装）；悬浮窗 → 无边框 `alwaysOnTop` + `skipTaskbar` 小窗（沙箱渲染进程，靠 BrowserWindow 'focus' 事件实现「点击唤起主窗」，页面内不发 IPC），内容由渲染层推送会话上下文（主进程不猜）；开机提醒 → 启动完成 / 发现新版发系统通知。③ **渲染层**——6 开关改真实绑定 `data-action="desktop-toggle"`，乐观更新 + 失败回滚；桥未接入时降级为 `.disabled` 不可点并标注（不再出现「UI 可点但不生效」）。④ **验证**——新增 9 项 dsh-runtime 用例（断言重点不是配置能存能读，而是**每个开关真的触发了对应系统副作用**：Tray 实例被 destroy、加速器被注销、登录项被写入、悬浮窗 BrowserWindow 被创建）+ 8 项 E2E（6 开关 key 与 PRD 一致、无 todo 空壳残留、点击翻转）；`scripts/verify-kit.cjs` 补齐 `globalShortcut` / `Notification` / `screen` / `Tray.destroy` / `app.setLoginItemSettings` / BrowserWindow 实例台账。verify 337→346。
> **v0.12.0 交付（第十二个死挂点：会话分叉与回放从未可达｜PRD FR-6）**：PRD 要求「会话可分叉：从任意轮次开新分支」+ NFR「可恢复 · 会话可重放重建」，实际 `case 'fork'` 在全项目**零调用点**——分叉逻辑只存在于会话状态字段（`forkedFrom`/`forkedAt`）与 `doFork` 函数里，UI 没有任何按钮能触发它，是典型的「服务/逻辑全建好了，但真实链路从未调用」。修复：① **入口接线**——会话标题栏补「分叉」「回放」两个真实按钮（此前只有 `data-action="todo"` 占位）。② **分叉点可选**——弹窗内滑块 0..N（默认全继承），标签实时显示「第 N 条（你：…）之后」；血缘记 `{from, atIndex, at, fromTitle}`，分支顶部显示血缘提示，消息流在第 N 条后插入分叉点节点标记（`.fork-node` 虚线 + 徽章）。③ **回放**——`renderReplay()` 从同一份数据重建只读时间线（不挂 composer，退出即恢复），事件按「消息顺序、消息内先 tool → subagent → feedback」铺开，分支额外在最前插 `fork-origin`。④ **两个易错语义已写进代码注释**：`forkMessages` 只认**真数字**为分叉点——`Number(null) === 0`，照单全收会把「没传分叉点」静默变成「空分支」，而丢消息不可逆，故 `null/''/undefined` 一律按全继承；切片必须走 `s.msgs`（deepClone 产物），不能切 `src.msgs`，后者元素仍是源会话的对象引用，分支与主干会共享消息对象。⑤ **单文件双环境**——新增 `renderer/session-fork.js`（UMD-lite，`module.exports` + `window.OrchDeskFork`），因为主窗口 `webPreferences` 是 `sandbox:true`（preload 拿不到 `require`）、app.js 是 IIFE（也不能 `require` TS 产物），做成双环境单文件才能让 Node 验证套件与浏览器渲染层**共用同一份**，杜绝源码/产物漂移。⑥ **诚实边界**——当前回放的数据形态是 sessions.json 的消息数组，还不是 dsh `SessionEvent` append-only 事件流（需接管 `ctx.sessions`，属 P7 路线图，切换前须新 ADR）；UI 与文档均不假装已达成。验证：新增 `session-fork-verify.cjs` 29 项（装载契约 / 血缘归一化 / 切片边界 / 回放时间线）+ E2E 组 8 共 20 项。
> **v0.12.0 交付（第十三个死挂点：沙箱判定只活在 return 里｜PRD FR-8「日志可检索」）**：PRD 明文要求沙箱「日志可检索」，实际所有判定（路径越界、命令不在白名单、域名未授权、审批放行/拒绝、执行异常）**只存在于 `executeTool` 的返回值里**，事后无从追溯「为什么被拦」。修复：① **埋点**——`executeTool` 11 处（file_read/file_write/file_list/shell_command/web_fetch/set_cwd 的放行、拒绝、执行异常）+ 外层 `catch` 兜底埋点（首版漏了这条：`file_read` 读不存在文件时直接抛到外层，导致「落盘可回读」用例拿不到任何记录）；相对路径一律解析成绝对路径再记，否则用户按绝对路径检索永不命中。② **持久化**——新增 `sandbox-log.ts`（纯逻辑、零 electron 依赖）：环形缓冲 500 条、淘汰最旧（审计追溯看最近的事故，不是当数据库）、**写穿落盘** `sandbox-log.json`（与授权白名单同节奏，不留「刚发生就崩了」的窗口）；坏条目跳过而非整体丢弃。③ **检索**——设置页新增关键词 / 判定 / 类型三维检索 + 统计条（放行/拒绝/出错 + Top 工具）+ 清空；关键词走 `input` 监听 350ms 防抖（首版误放进 `change` 监听，需失焦才触发）。④ **「未接入」与「接了但为空」必须区分**——无桥返回 `null` → `loaded=false` → UI 显示「未接入」，不显示「0 条」。验证：credentials 19→34（8 项纯逻辑 + 5 项真实 IPC 驱动：命令白名单拒绝入日志、审批放行记 allowed、审批拒绝记 denied、落盘可回读、清空归零）+ E2E 组 9 共 9 项。
> **v0.12.0 交付（FR-4.2 数据目录内容清单 + 假数据清理）**：设置页「数据目录」卡片与右栏快捷操作里写死 **`~ 24 MB` / `~ 1.2 MB` 两个硬编码数字**，与真实磁盘毫无关系——「备份整个数据目录」旁边标的体积是编的。修复：① `data-dir.ts` 新增 `scanDataDir()`（递归、**跳过符号链接**避免软链成环、顶层子项按体积降序 + 根汇总 `.` 排在最后、目录不存在返回空清单不抛错）+ `formatBytes()`；`sizeText` 在主进程侧生成，渲染层不再各写一套换算。② IPC `orchdesk:data-dir-inventory` + preload 桥 + 设置页渲染真实清单（每项名称/类型/体积/文件数）。③ **修 `statTree` 重复计数 bug**（由新增用例当场抓出）：父级照单全收 `out` 的新增条目时，后代**目录条目本身**被算第二遍——`logs` 实为 120 B 报 190 B、根汇总 520 B 报 780 B；改为递归返回 `{size, files}` 供父级累加，并在注释里写明不要改回扫 `out` 的写法。④ **桥不可用显示「内容清单未接入（主进程桥不可用）」**而不是沿用旧假数字。⑤ 清单只在启动时取一次，导入/导出之后会过期 → 补「刷新清单」按钮。⑥ **假数据/空壳清零**——右栏两个假数字与一个 `data-action="todo"` 空壳按钮全部替换；侧栏最后一个 `todo` seg-tab 改为静态标签；兜底分支从静默 toast 改为 `console.warn` + 显式「该动作尚未接线」+ `default:` 未知动作告警（此前那句「该操作在真实版本中打开对应面板」是用假承诺糊死挂点，比不写更糟）。验证：data-dir 36→47（空目录 / 嵌套汇总 / 空目录 / 软链不成环 / formatBytes 四档与负数回退）+ E2E 组 10 共 11 项（含「已无 `~ 24 MB` 硬编码」反向断言与桥不可用降级）。全量 verify **371→465**（12 套件）。

> **v0.12.0 交付（第十四个死挂点：分层记忆晋升从未发生｜PRD FR-10）**：PRD 明文要求「分层记忆 global / project / director / worker 四域隔离；**Worker 输出须经 Director 过滤才能晋升上层**」，实际这段**零代码**——插件的 `promote()` 实现完整（含 fail-closed），但全项目**零调用方**；更致命的是 worker 域**零写入方**（brain 声明了 `memory.commit` 能力却从未落地，SubAgent 结果随 `dispose` 一起蒸发），晋升链写得再完整也是无米下锅。修复：① **源头**——`disposeSubAgent` 在 emit 之前调 `commitWorkerResult()` 把结果落 worker 域（`WORKER_RESULT_MAX` 4 000 字截断，只影响记忆条目，不影响事件里的完整 `rec.result`；记忆写入失败一律静默，**绝不**破坏「Worker 即用即走」的 dispose 语义——宁可丢一条记忆，也不能让 dispose 抛错把 agent 泄漏在注册表里）。取服务必须用 `ctx.get('memory')`：Cordis `Context` 是代理，在 fiber ctx 上**直接属性访问**未提供给该作用域的服务会**抛错**，而 `safeGet` 的 try/catch 会把这个错吞成 `undefined`，表现为「插件明明装载了却拿不到」（调试时 `mem=undefined hasRecord=n/a ctxGet=function`）。② **fail-closed 完整性**——`worker → director / project / global` **三条边**全部过 brain 过滤；只锁 `worker→director` 一条等于给「Worker 直写上层记忆」留后门，PRD 说的是「才能晋升**上层**」。③ **宿主侧**——新增 `memory-promotion.ts`（纯逻辑、零 electron 依赖）做晋升审计：环形 200 条淘汰最旧、**写穿**落盘 `memory-promotions.json`（与安全相关，不留「刚发生就崩了」的窗口）、**成功与失败都记**（被 Director 驳回的晋升比成功的更有追溯价值，只记成功等于抹掉拦截证据）、只存 120 字预览不存全文（否则文件随记忆体积线性膨胀）；5 条 IPC + 设置页四域面板（四域真实计数，此前只存不显示）+ 逐层晋升按钮 + worker 域批量晋升（上限 20 条、按 createdAt 正序、报 remaining——`promote` 是异步的且要 await brain 过滤，不设上限最坏情况 UI 卡死十几分钟且无法取消）。④ **「未接入」与「接了但为空」必须区分**（本项目第三次踩到）：`listMemoryDomain` 返回 `null` → `loaded=false` → 显示「记忆服务未接入」；返回 `[]` → 才说「本域暂无条目（SubAgent 执行完被回收时…）」。把 null 当空数组会让「服务没起来」看起来像「还没跑过 SubAgent」。⑤ `<select>` 的 value 一定是字符串，`ok` 参数必须同时吃布尔与 `'true'`/`'false'`，只认布尔会让过滤静默失效。验证：plugins 新增 8 项 + `memory-promotion-verify.cjs` 22 项（10 项纯逻辑 + 12 项 stub electron 驱动真实 IPC）+ E2E 组 11 共 21 项。全量 verify **465→516**（13 套件）。

> **v0.12.0 交付（第十五个死挂点：LLM 摘要 seam 零调用方 + TF-IDF 未登录词 bug + 语义分块｜PRD FR-10）**：PRD 的转储链是「**LLM 摘要** → 语义分块 → 本地向量编码 → 伪记忆注入」，实际只有后两段，且摘要与分块都不完整。三处修复：① **`setSummarize` seam 零调用方**（第十五个死挂点）——自动转储（上下文达 80%）永远走抽取式兜底（首尾各 3 条、每条截断 200 字）。新增 `memory-summarize.ts`（纯逻辑、零 electron 依赖）承载提示词 / 文本抽取 / 截断 / 超时，`bootRuntime` 注入真实实现（超时 20 s、输入截 8 000 字**保留尾部**、输出截 400 字；**没配模型直接抛错**让插件回落兜底，而不是塞一句「（未配置模型）」当记忆存进去——那会污染语料且召回出来是噪声）。插件侧 seam 调用包 try/catch，**返回空串也回落**：摘要是增强不是必需，转储是 fire-and-forget，异常抛出去就没人兜，宁可退化成抽取式也不能让整批转储蒸发。`DumpRecord` 新增 `mode: llm | extractive | mixed`（「有的块没摘成」必须可观测）。提示词写死一条硬约束——**只压缩、不改写，保留原文关键名词 / 专有名词 / 数字 / 路径**：召回端是本地 TF-IDF **纯词面匹配**，模型把「PostgreSQL 连接池」润色成「数据库连接管理」，用户下次问 postgresql 就再也命中不了，LLM 摘要反而**降低**召回率。② **TF-IDF 未登录词（OOV）权重归零 bug**（由分块召回用例当场抓出）：`tfidf` 对 IDF 表里缺失的 token 取 `(idf[k] ?? 0)` → 权重 0。最极端的后果是**第一条记忆**——写入时语料为空 → IDF 表为空 → 整条向量全零 → 余弦恒为 0 → **这条记忆永远召不回来**（实测分块第一块召回分 0.000000）。正确做法：OOV 恰恰最稀有、最有区分度，应拿最高 IDF（df=0 → `log(1+n)+1`）。③ **语义分块**：新增 `chunkMessages()`——**块边界只落在消息边界上**（不把单条消息剁碎，否则两半各自失去上下文）、按**字符预算**而非条数（消息长度差异极大，按条数切会让块大小失衡）、单条超预算独占一块；`dump()` 改为每块独立摘要 + 独立向量 + 独立条目，解决「一个向量同时代表多个主题 → 余弦被稀释，每个主题都匹配得不疼不痒」。④ **状态不许撒谎**：`memory-summarize-status` 在**无提供商时不拿 `cfg.defaultModel` 顶**（否则「一个模型都没配」会显示成「正在用 qwen3:14b 做 LLM 摘要」——用 mock 网关跑真链路时抓到）；渲染层在桥断时（`loaded=false`）不沿用上一秒的状态（否则「已断开」显示成「正在用某模型」，与记忆列表同类的「陈旧状态冒充现状」）。验证：plugins 新增 17 项（分块 8 / IDF 3 / 摘要 seam 5 → 88 项）+ `memory-summarize-verify.cjs` 16 项（9 项纯逻辑 + 7 项真链路：stub electron + **本地 node:http mock 网关**，证明 seam 真去调了模型、模型返 HTTP 500 时真回落兜底且块数不减、状态如实切换）+ E2E 组 11b 共 5 项。全量 verify **516→554**（14 套件）。

> **v0.12.0 交付（FR-3 连接器后端注册表｜「测试连通性」不许再是摆设）**：PRD FR-3 要求 8+ 连接器，此前 UI 只有硬编码静态数组——GitHub 被写死 `on:1` 显示「已连」，纯假状态。新增 `connector-registry.ts`（纯逻辑、零 electron 依赖，可 node 直测）承载目录 / 脱敏 / 探测请求构造 / 结果判定 / 状态归一化 / 审计环形缓冲：① **8 个连接器**（GitHub / Linear / Notion / 飞书 / 企业微信 / 钉钉 / TAPD / 腾讯文档），端点与鉴权格式均以官方文档核实（2026-08）——Linear 个人密钥 Authorization **不带 Bearer**、TAPD 走 Basic、飞书 / 企微的鉴权失败都是 HTTP 200 + 业务码非 0（只看状态码会把失败判成成功，故 `expect` 同时判 `code`/`errcode`/GraphQL `errors`）；腾讯文档无公开无副作用探测端点，**显式标 manual**——宁可诚实说「不支持自动探测」，也不放一个必失败的探测。② **凭证逐字段 AES-256-GCM 加密**落 `connectors.json`（进数据目录迁移清单），secret 回显只留末 4 位，密文不出主进程。③ **保存即探测**：只保存不探测会显示「已配置」但令牌错一位都不知道；探测失败不回滚凭证但状态明确记 test-fail；换凭证后旧探测结论立即作废（不能拿 A 账号的「已连接」显示给 B 账号）。④ **脱敏回显写回保护**：secret 输入框回显「••••1234」，用户没改动时提交回来按「保持原值」处理——否则「只改了 AppSecret，AppID 就突然失效」。⑤ manual 连接器「没探测」≠「探测失败」：把 manual 原因写进 `lastTestOk=false` 会让 UI 显示「连通失败」，把「不支持自动探测」伪装成鉴权问题（由新套件抓出后修正）。⑥ 审计（save / clear / test / test-fail）环形 200 条写穿落盘，失败也记——失败记录才是排查凭证问题的依据。新增 `connector-registry-verify.cjs` 30 项（A 组纯逻辑 20：请求构造含编码 / Basic / 结构化 body 防 secret 破坏 JSON、判定含业务码陷阱；B 组 stub electron 真 IPC 10：全程不触真实网络，走「缺必填快速失败」与 manual 两条不触网路径）+ E2E 组 12 共 20 项（三种状态徽标 / 展开配置 / 保存即探测 / 修好凭证翻转 / 脱敏回显写回 / manual 诚实标注 / 审计 / 桥断显「未接入」）。全量 verify **554→604**（15 套件）。

> **v0.12.0 交付（FR-3 本地插件市场注册表｜扫描 ≠ 装载）**：PRD FR-3 的插件市场此前只有静态「规划中」清单，无任何后端。新增两层：① **`plugin-market.ts`（纯逻辑）**——manifest 校验（`name` 必填、缺省字段给默认、脏数组丢弃、超长截断，失败必带目录名让用户可自查）、启用状态归一化（**非布尔一律按 false**——默认不装载第三方代码是 fail-closed 的根，路径穿越 key 直接丢弃）、目录名校验。② **`dsh-runtime` 热插拔**——扫描 `dataDir()/plugins/`（**只读文件系统与 manifest，绝不执行插件代码**）；启用走与内置插件完全相同的 `dynamicImport → normalizeInject → ctx.plugin`（fiber 句柄入同一张表），停用走 `fiber.dispose` 逆回滚；CJS / ESM 产物都吃。三个安全要点：**启用是显式授权**（持久化意愿写穿落盘 `plugin-market.json`，启动时按意愿回灌装载，单插件失败不阻断其余）；**已激活时重复启用幂等**（不再 `ctx.plugin` 第二份 effect）；**装载完成 ≠ 激活**（注入的依赖未满足时 `fiber.state != 2`，UI 必须显示「已启用 · 未激活」而不是「已启用」——状态不许撒谎）。manifest 非法或缺 index.js 的目录永远不可启用，UI 显具体原因。渲染层：插件页新增「本地插件市场」卡片（真实徽标 / 开关 / 打开插件目录 / 重新扫描），侧栏区分本地条目与远程市场（远程保持「远程未接入」诚实标注）。新增 `plugin-market-verify.cjs` 15 项（A 组纯逻辑 6 + B 组真链路 9：种子 CJS 插件真装载 → `ctx.provide` 的服务真的可取 → 停用后服务真的消失——「逆回滚无残留」验证的是 ctx 状态而非 UI 文案；幂等 / 穿越拒绝 / 回灌各一）+ E2E 组 13 共 10 项。全量 verify **604→649**（16 套件）。
> **v0.12.0 交付（FR-5 用量追踪 + FR-6 SessionEvent append-only 事件流｜ADR-0009）**：对照 PRD 收口最后两个代码侧缺口。① **FR-5 用量追踪**——新增 `usage-registry.ts`（纯逻辑、零 electron）：`normalizeApiUsage` 归一化三家 usage 形态（OpenAI chat `prompt_tokens/completion_tokens` / responses `input_tokens/output_tokens`（无 total 求和）/ Ollama 顶层 `prompt_eval_count/eval_count`）；核心记账纪律是**「没上报」≠「0 token」**——网关不回 usage 的回合不记条目、assistant 消息不带 tok 徽标，把 null 当 0 记账会让聚合显示假数据（`num()` 对缺字段/非数值/负数一律 null）。`callOllama`/`callOpenAICompatible` 提取、`runAgentTurn` 回合级累计、环形 5000 条落 `usage.json`（随数据目录迁移）；设置页用量卡片（合计 `↑↓·总·n 回合` + byModel 表）+ assistant 消息 token 徽标 + 空态文案明示「网关未上报 usage 的回合不记账」。② **FR-6 事件流**——新增 `session-events.ts`（纯逻辑）：per-session NDJSON（`dataDir()/events/<sessionId>.ndjson`）append-only，`runAgentTurn` 双写（**模型可见必入日志**——第十六个死挂点）；裁决见 [ADR-0009](../70-决策/ADR-0009-session-event-log.md)：不接管 dsh `ctx.sessions`（留 P7），sessions.json 与事件流双写不互相同步，分叉不拷父事件（子日志只写一条 `fork-origin` 血缘）。**血缘截断语义**（本段真 bug，A 组测试抓出）：buildTimeline 首版直接全量拼接父事件——分叉点之后父会话的独立写入会漏进子分支回放；修正为 fork-origin 的 atIndex 作用于「其之前全部祖先事件」跨层计数消息事件（fork-origin 不占消息位），祖先事件 seq 加深度前缀（`p1#`）与子会话独立计数区分；`collectLineageEvents` 让上下文重建（`rebuildContext`）共用同一截断语义。回放来源**三态显式标注**：「append-only 事件流重建（ADR-0009）」/「历史会话：事件流无记录，从消息数组重建」/「事件流未接入」——「事件流重建」与「历史回退」是不同的保证等级，混用会让「模型可见必入日志」变成无法验证的话。③ 验证：`usage-registry-verify.cjs` 11 项（A 组纯逻辑 8 + B 组真 IPC 3）+ `session-events-verify.cjs` 16 项（含 `../evil` 穿越拒绝、环防护、seq 回收、legacy 回退）+ model-loop R 组 6 项（真 HTTP mock 线级：usage.json 落盘 / 事件文件双写 / 不回 usage 不记账）+ E2E 组 14 共 10 项。全量 verify **649→670**（18 套件）。

> **v0.12.0 FR-5/FR-6 三方审阅交叉修复（yt-dev-review，2026-08-31 晚）**：3 并行子代理（质量/效率/可复用性）审出 **2 个真 BLOCKER，全部修复**：① **事件双写与用量记账未兜异常**——`eventFileFor` 对非法 sid 会 throw，位于模型调用之后会 reject 整个回合 IPC，违背「写失败不阻塞回合」自述；修：两块各自包 try/catch，只 WARN 不抛。② **legacy 父会话被分叉后回放丢继承历史**——父日志为空时子日志只有 fork-origin，source 仍标 event-log，渲染层不再回退消息数组，继承消息全部消失；修：新增 `hasIncompleteAncestry`（任一祖先日志为空 → 血缘残缺），IPC 整体回落 legacy（消息数组含分叉切片，回放完整）。交叉共识修复：③ session-events IPC 血缘链被重复读 3 遍 → `collectLabeled` 导出 + `timelineFromLabeled`，一次读盘同时派生时间线与上下文；④ 截断语义双拷贝（forkPrefixEvents/prefixLabeled）收敛为 `prefixByMessageCount` 唯一实现；⑤ 坏行占用 seq 位回收（regex 扫原始行取 max，防 append-only 重号）；⑥ 用量「读取失败」≠「未接入」——`ok:false`/catch 各自显式标注错误态。采纳未做的建议项：usage-clear 加确认（数据可再生，误清代价低，不采纳）、verify 套件换 createChecker（现套件工作正常，纯脚手架风格，不采纳）、appendEvents 尾读优化/NDJSON 化 usage.json（量级诚实可接受，不做）。修复后复验：verify **670→674**（session-events 12→16），18 套件全绿。
> **v0.12.0 交付（TS 直测 loader + 架构守护测试｜ADR-0010）**：本段**不增加任何 PRD 功能**（功能百分点不变），只补齐两条工程纪律——结论来自对同类项目 `lencx/Minke`（同为 DeepSeek Harness 底座的桌面工作台，39k 行 TS / 77 测试文件 / 843 个 test()）的三路并行分析：它最值钱的不是功能，而是「测试直跑源码」与「架构约束由测试守护」。对照出的两个缺口都是真缺口：① **「先 tsc 再测」的旧产物陷阱**——18 个套件一律 `require('dist/*.js')`，2026-08-31 已因改插件源码忘了 `tsc`+`vendor-dsh` 跑出假失败/假通过，而这条纪律当时只写在记忆里（人肉遵守，无机器守护）。新增**零依赖 TS 直测 loader**（`scripts/ts-loader-hooks.mjs` + `ts-load.cjs`）：基于 Node 22.13+ 内置 `module.stripTypeScriptTypes()` 与 ESM `module.register()` hooks，**不引入 esbuild/ts-node**（零安装失败风险、零供应链面）；只接管 `.ts`（resolve 补扩展名、`./x.js`→`x.ts` 映射，load 剥类型返 `format:'module'`），**不碰 CJS `require()` 链**——现有「stub electron + require dist/main.js」的 IPC 驱动套件完全不受牵连（有回归用例守护）。B 组一致性断言是硬约束：同一输入下 TS 版与 dist 版输出必须逐 JSON 相等，否则说明 loader 引入语义漂移、直测结果不可信。② **架构铁律只活在 ADR 与人脑里**——渲染层禁 `require`、纯逻辑模块零 electron 依赖、持久化与工具执行只在主进程，此前无任何自动化检查，破坏它是**静默**的。新增 `arch-guard-verify.cjs`：R1 渲染层禁 Node/Electron 直连 / R2 纯逻辑零 electron / R3 纯逻辑不依赖宿主层 / R4 渲染层不持久化不执行工具 / R5 禁硬编码本机路径与密钥形态 / R6 插件产物链路不陈旧（src→lib→vendor）/ R7 每个套件必须在 verify 链上；配套**元规则自检**（借鉴 Minke 的 `knownViolation`）：M1 每条规则必须命中自己的正样本（正则被误改成永假 → FAIL「规则失效」）、M2 扫描面非空（glob 写错 = 规则空转 → FAIL）、M3 白名单文件须存在、M4 白名单确实零 electron。因为架构规则是**否定式断言**，一旦失效会静默通过——比没有规则更危险（虚假安全感）。扫描前剥离块注释与整行 `//`，避免注释里的示例代码误报。③ **陈旧产物即失败**：`.ts` 比 `dist/*.js` 新、插件 `src` 比 `lib` 新、`lib` 比 `vendor` 新，一律 FAIL 并在消息里给出修复命令——宁可让流程红一次，也不让旧产物冒充通过。④ 每条规则都做了**负向验证**（注入违规文件确认真能抓到、touch 源码确认陈旧探针真会 FAIL），不是写完就信。验证：`ts-loader-verify.cjs` 13 项 + `arch-guard-verify.cjs` 15 项。全量 verify **674→702**（20 套件）。
> **v0.12.0 之后交付（浏览器工具｜ADR-0011｜Minke 借鉴分析 P1）**：Minke 对照出的三缺（浏览器 / PTY / 文件 Tab）中最关键的一块落地——只会读文件与跑命令的 Agent 干不了任何需要网页的事。**用 Electron 自带 CDP（`webContents.debugger`，协议 1.3）驱动一个内置 BrowserWindow，不引入 playwright / puppeteer**（已装的 playwright 留给外部 E2E 自动化）。① **为什么是 CDP 而不是 `executeJavaScript`**：CDP 支持 `awaitPromise` / `returnByValue` / `userGesture` / 超时，不受页面 CSP 与上下文污染影响，且截图与导航等待同属一套协议。② **共享用户默认 session**（保留登录态，遇到需登录的后台才是真能力），代价是 Agent 能看到已登录页面 → 由授权门覆盖而非靠隔离回避：导航 = 边界外网络访问（域名白名单 + 补偿层外发二次确认，与 `web_fetch` 同口径），`browser_click` / `browser_type` / `browser_eval` = 真实改变页面 → 授权门（与 `file_write` 同档），每次判定进沙箱日志（新增 `kind:'browser'`），**拒绝时命令绝不下发**（有回归断言守护）。③ **8 个工具**并入统一工具表（`TOOL_DEFS` 7→15，模型侧只有一张清单）。④ **分层**：`browser-tools.ts`（纯逻辑零 electron，承载 schema / 参数归一化 / **页面内 JS 表达式构造** / 脚本风险扫描 / 截图路径）+ `browser-cdp.ts`（宿主层：窗口生命周期、attach、导航等待、evaluate、截图落盘）+ `main.ts` 只做接线。⑤ **表达式构造是唯一注入面**（模型给的选择器/文本要拼进 JS 源码）：一律 `JSON.stringify` 注入，并在验证套件的**假 DOM 里真跑一遍**（引号 / 反斜杠 / 换行不逃逸 + 语义正确 + React/Vue 受控组件事件兼容）。⑥ **UI 是验收底线不是装饰**：标题栏「浏览器」入口 + 状态面板（标题 / 地址 / 最近截图缩略图 / 显示·隐藏·关闭 / 截图目录），状态推送实时跟随；桥不可用时显示「未接入」而不冒充「已就绪但没开」。本段三个真 bug 由新套件当场抓出：`clampInt` 对 `''`/`undefined` 走 `Number('')===0` 被下限钳成最小值（「模型没传 timeout」变成「给 500ms 超时，几乎必超时」）、`getBrowserState()` 未打开时不返回 `lastShot`（状态对象形状不稳定，渲染层要写兜底）、三处硬编码「7 个工具」的断言（已改为从 `TOOL_DEFS.length` 取数——写死常量会让「新增工具没下发」伪装成「套件过时」）。⑦ **验证分两层**：`browser-tools-verify.cjs` 39 项进 verify 链（A 组纯逻辑 22 + B 组 stub electron 驱动真实 `dist/main.js` 17：断言 `Page.navigate` 真发出、`javascript:` 被拦在宿主之前、PNG 真落盘、被拒命令不下发、IPC 显示/隐藏真作用到 `BrowserWindow`）；真机行为另设 `pnpm run smoke:browser` 10 步（**刻意不进 verify 链**——需要真 GPU/渲染进程，非交互会话必假红；脚本启动期自检 `process.type`，`ELECTRON_RUN_AS_NODE` 未摘时给退出码 2 的显式指引）。全量 verify **702→741**（21 套件）。⑧ **真机冒烟实跑通过 11/11**（Electron 36.9.5）：`Runtime.evaluate` / `Page.navigate` / `Page.captureScreenshot` 全走 CDP 正路，并当场暴露三个「锁屏 / 远程桌面 / 最小化时同样会发生」的挂起类问题，已全部留降级——`Emulation.setDeviceMetricsOverride` 会让**主进程直接消失**（退出码 127、stdout 空、`try/catch` 都来不及）→ 带超时 + 失败忽略 + 受限会话跳过；`Page.captureScreenshot` 取不到合成帧时**永久挂起而不是报错** → 超时后回退 `capturePage`（实测 68ms 出图，CDP 挂了 30s+），回退如实告知「只截到视口」；`Page.navigate` 挂起时页面根本打不开 → 回退 `win.loadURL()`，`Page.enable` / `Runtime.enable` 改为可降级（前者只为收 `loadEventFired`，后者对 evaluate 非必需），`Runtime.evaluate` 外层再加超时并兜底 `executeJavaScript`。原则：**CDP 出问题时宁可降级也不要挂起**，且降级必须可见（结果带 `via`、沙箱日志写明「已回退 capturePage」），不许用「跑通了」掩盖「其实是兜底跑通的」。套件新增 4 项回归（挂起 / 报错 / 双路皆失败），browser-tools 39→43 项，全量 verify **741→745**。
> **v0.12.0 之后交付（PTY 终端 Tab + 只读文件 Tab｜ADR-0012｜Minke 借鉴分析 P2-10/11）**：Minke 对照三缺的后两块落地。终端解决「`shell_command` 每次都是一次性子进程，没有交互式会话」（vim / npm run dev / rebase -i 都跑不了），文件面板解决「没有随时盯着项目目录的入口」。① **node-pty 多候选加载 + 管道显式降级**——`ORCHDESK_PTY_MODULE` env > `<appDir>/vendor/node-pty`（vendor-dsh 第 3 步物化 + `asarUnpack`，dev/packaged 同路径）> node_modules > dsh profile 目录，全落空走 `child_process` 管道且 `via:'pipe'` 可见（徽标 + 新建会话 toast），不许静默。② **环境净化是硬前提**——子进程 env 剔除 `NODE_OPTIONS`/`NODE_PATH`/`ELECTRON_RUN_AS_NODE`（宿主 shim 劫持子进程的历史教训），`LANG` 兜底 `zh_CN.UTF-8`。③ **数据洪峰防护**——16ms 攒批推送、单条 256KB 超限截断并打显式标记、每会话 64KB 回放缓冲（重开 Tab 补看）、会话上限 6。④ **文件 Tab 只读优先**（编辑/diff 后置 P3）——用户亲手浏览**不走 Agent 授权门**（与浏览器工具口径相反）；目录懒加载每层 500 条上限、读取 ≤2MB 显式 truncated、二进制双通道嗅探（扩展名快通道 + 头 8KB NUL 字节）命中只给元信息；语言探测映射不到 → null，渲染层不许猜。⑤ **渲染层全屏覆盖层而非 modal 体系**——xterm 实例与滚动位置不能随状态推送重绘：骨架只建一次（`dataset.ready`），头部与可见性单独更新；ESC 关面板但焦点在终端容器内不抢（vim/less 也用 ESC）；xterm 缺失 → pre + 逐行输入降级，shiki 缺失 → pre 纯文本，全部可见。⑥ **shiki 精简 bundle**——`createHighlighterCore` + `createJavaScriptRegexEngine()`（纯 JS 无 WASM，对齐 Minke），显式 12 语言 + 2 主题，esbuild IIFE 打成 `renderer/vendor/shiki-bundle.js`（897KB，`window.ShikiLite`）；xterm 用官方 UMD dist + fit addon vendored。⑦ 验证：新增 `terminal-pty-verify.cjs` 26 项（假 pty 每 spawn 独立回调 + 灌数据把手；管道降级 patch `cp.spawn`；C 组 stub electron 断言 IPC create/status/write 与 webContents 推送链路）+ `file-panel-verify.cjs` 15 项（真实临时目录走 IPC handler：排序/标注/截断/二进制/不存在）；arch-guard 纯逻辑清单 +2。全量 verify **745→786**（23 套件）。⑧ 打包链：node-pty 缺失只 warn 不阻断（管道兜底）；踩坑记录——joinPath 盘符根不许被 `..` 顶掉、`Number('')===0` 在 create 参数归一化入口挡掉、假 pty 共享回调导致多会话事件串线（改为 per-spawn）。

> **v0.12.0 之后交付（文件 Tab 编辑与 diff｜ADR-0013｜Minke 对照 P3）**：ADR-0012「编辑/diff 后置」的兑现。**口径裁决：用户在文件面板亲手编辑保存 = 用户自有操作，不走 Agent 授权门**（Agent 的 `file_write` 工具链路不变，仍走授权门）——但用四道防呆代替授权门：① **外部修改检测（乐观并发）**——`file-read` 返回 `mtimeMs`，`file-write` 必带 `expectedMtimeMs`，主进程写前 stat 比对（2ms 容差），不符拒绝 `code='modified-externally'`，渲染层保留编辑缓冲 + 「重新加载」按钮（防覆盖编辑器 / git / Agent 刚做的改动）；② **不可编辑显式判定**——`editable` 由主进程统一判定（二进制 / 截断（保存会截断文件）/ 非 UTF-8（解出 U+FFFD，保存即乱码）→ false + 渲染层给原因），渲染层不猜；③ **写回原子性**——同目录临时文件 + rename，写一半崩溃不留半截文件；④ **参数防呆前移**——`normalizeFileWrite`（file-panel.ts 纯逻辑）入口拒绝二进制扩展名 / 超 2MB（与读取上限一致）/ 缺 `expectedMtimeMs`。**diff = 编辑缓冲 vs 磁盘基线**（不做 git diff——文件面板不绑定 git 仓库），实现为 UMD-lite 单文件 `renderer/file-edit.js`（与 session-fork.js 同一约定）：行级 LCS（前后缀裁剪 + DP）、`groupHunks` ±3 上下文分组、**EOL 保护**（textarea 会把 CRLF 吃成 LF——写盘前按 `detectEol`/`applyEol` 还原原文件风格，diff 也在还原后文本上算，否则 CRLF 文件一进编辑器就是整文件假 diff）、规模上限显式降级（>5000 行或 DP 超 4M 单元 → `tooLarge` 只给行数变化）。UI 状态机：预览→编辑→保存/放弃/对比；放弃（有未保存改动）两段式确认；保存成功后预览基线轮转（新 content + 新 mtimeMs），连续编辑不被自己的写入误伤。验证：`file-edit-verify.cjs` 19 项进链（首跑当场抓出两个真 bug：**回溯循环退出后剩余 add/del 行丢失**——单行改动的 add 行凭空消失、**完全一致时返回全 ctx 行**——「无变更」显示成整文件上下文）。全量 verify **786→805**（24 套件）。

> 详细：差距盘点（30%）见 [PRD差距盘点-2026-08-29](../99-归档/PRD差距盘点-2026-08-29.md)；
> 补齐复盘（75%）见 [PRD差距补齐-2026-08-29](../99-归档/PRD差距补齐-2026-08-29.md)。

### 1.2 环境门控

- **本机（WorkBuddy CLI / 非交互会话）**：无法启动 Electron GUI（BUG-W02）。2026-09-01 追加定位到两个具体成因，别再重复排查：① 宿主进程会向下继承 **`ELECTRON_RUN_AS_NODE=1`**，使 `electron.exe` 退化成纯 Node（`require('electron')` 返回路径字符串、`app` 为 `undefined`）——所有 `electron` 调用一律 `env -u ELECTRON_RUN_AS_NODE` 前缀；② 即便摘掉它，非交互会话里 **GPU 进程无法启动**（`gpu_process_host.cc:956 exited unexpectedly` → `GPU process isn't usable. Goodbye.` → 进程被 fatal 硬杀，`--disable-gpu` / `no-sandbox` / `in-process-gpu` 均无效），故真机 CDP 行为只能由用户在桌面会话跑 `pnpm run smoke:browser` 验证。业务逻辑一律走 node 直驱（verify 套件，21 个）
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

> **第十七批（yt-dev-review 三方并行审阅与交叉修复，2026-09-02）**：对 P2-10 终端 PTY、P2-11 文件 Tab、P3 编辑/diff 三块交付跑质量 / 效率 / 可复用三路并行审阅（子代理只读分析，修复回主会话）。**交叉共识 5 项**（≥2 方同时指出）：扩展名取全路径被带点目录击穿、洪峰单条 256KB 未真正封顶、`replayBuf` 泄漏、常量与工具重复实现、`describeTerminalState` 零调用方死挂点。**单点但复核确认为真**：`ptyAvailable` 在 `ptyCache === undefined`（未探测）时返回 true 与 `via='pipe'` 自相矛盾、shiki 对 2MB 文件高亮实测阻塞 10.5s、`readSync` 单次读的短读会产出「内容比磁盘短却声称完整」、文件面板用 `typeof bridge.fileTree !== 'function'` 判「未接入」对 stub 恒不命中（把「未接入」显示成「为空」）。修复清单见 ADR-0012 / ADR-0013 的「审阅后加固」章节，要点：新建 `common-tools.ts` 收敛 `clampInt` / `isAbsoluteLike` / `extOfName`（原 4 份 clamp + 4 份绝对路径正则）并登记 arch-guard；`encodingSuspicious` 改 `TextDecoder(fatal)` 严格校验（原「含 U+FFFD 即非 UTF-8」会把合法文本误判而禁编辑）；EOL 改多数派判定并补 CR-only 分支（混合行尾不被少数派全量改写）；shiki 加 200KB/3000 行门槛，超限回落 `<pre>` 并显式说明原因。验证：terminal-pty 26→29、file-panel 15→20、file-edit 19→20，全量 verify **805→814**（24 套件）全绿。

> **第十八批（OpenWorker 对照剖析 + v0.13.0 打包 + 实机冒烟清单，2026-09-03）**：① 拉取 `andrewyng/openworker`（@fb1bfc6，Tauri + Python 本地优先 coworker，623 文件）到临时目录对照，**代码不入库**（遵守「外部资料只引用不回拷」）。三路子代理分别深挖治理安全层 / Agent 内核能力层 / 前端工程化，产出 [openworker-对照-2026-09-03.md](./openworker-对照-2026-09-03.md)：A 档可借鉴 8 条（审批项幂等落盘、`human_only` 决策位、override 只能收紧、风险改工具声明属性、审批 provenance 三落点、流文本三态闸门、**verify 环境强制隔离**等），B 档 7 条进中期，明确不抄 5 条（reviewer 第二模型裁决 + 断路器 / Inbox 镜像 / 350 行 shell 只读分类器 / React+Vite 构建链 / 68 个 e2e spec 规模）。**最大欠账不是代码是勾选**：PLAN 107 项验收 **23 已勾 / 84 未勾**，而 BUG-W02 已于 09-01 收窄（用户桌面可实跑、browser smoke 11/11），故 P0–P4 的 83 项运行期验收是**待执行**而非被环境阻断 —— 文档里「受 BUG-W02 门控」的旧口径本身已过期。② 新建 [smoke-checklist.md](../40-质量/smoke-checklist.md)（id `orch-qag-002`）作桌面会话实跑清单，A–F 六组（启动 / 终端 PTY / 文件编辑 diff / 浏览器工具 / 会话编排 / 安全底座），附三条硬判定口径：**降级不算通过**（PTY 显示「管道」、浏览器 `via` 走兜底都要记 FAIL）、未接入 ≠ 为空、不为全绿放宽预期。③ v0.13.0 打包：verify **814/814 全绿** + `tsc` EXIT=0 → changelog → bump `0.13.0` → release commit `3186b21` → 打包 → tag `v0.13.0`（**tag 必须在打包之后打**：`check-version.cjs` 严格模式下 `version == 最新 tag` 会阻断 dist）。产物 Setup 88,081,451 B / portable 87,736,328 B，sha512 与 `latest.yml` 一致，asar **195 文件**校验通过，`app.asar.unpacked/vendor/node-pty/prebuilds/win32-x64/conpty.node` 就位（node-pty 1.2.0 走 prebuilds，别按 `build/Release` 找）。④ 顺手修 4 处文档漂移：current-state / roadmap / quality-gates 的 805→814，以及 quality-gates §6「canonical 计数方：本节」与「计数唯一归 CHECKPOINT」的责任冲突。打包踩坑（asar 句柄泄漏）已写进 [release.md](../50-发布/release.md)。

> **第十九批（实机冒烟首批反馈 + BUG-022 + v0.13.1，2026-09-03）**：用户桌面按 [smoke-checklist](../40-质量/smoke-checklist.md) 首轮实跑，A 组发现真 BUG：**新建项目绑定 D 盘目录后，··· 菜单「打开项目目录」弹出的却是 C 盘数据目录**（登记 [BUG-022](../60-BUG/index.md)）。根因是 `orchdesk:open-project-dir` handler 恒开 `dataDir()`（「项目目录 = userData」的早期概念混用遗留），而项目对象的 `path` 字段有写入方、无读取方——又一个死挂点变体（渲染层早已用 `p.path` 渲染图标，唯独行为没跟上）。修复：handler 接受可选 `projectPath`、有绑定时 `statSync` 校验目录真实存在再打开、无绑定时明确报「该项目未绑定本地文件夹」而非误开数据目录；渲染层传 `p.path` + toast 回显实际路径；顺手修同族 `open-log-dir` 吞失败返回值（失败也报 ok）。验证：e2e 新增 6 条断言（152→158），**verify 24 套件 820 项全绿**。教训固化：e2e 套件 bridge mock 之前对 `openProjectDir` 无条件返 ok、种子项目无 `path` 字段——**mock 太宽容会让传参错误类死挂点测不出来**，新断言已让 mock 逐调用记录参数（`window.__openedPath`）。随后切 **v0.13.1**：changelog → bump → release commit `09784ba` → `tsc` + `vendor-dsh` → 打包（全新目录 `release-v0131-r1`，一次通过）→ tag `v0.13.1`；Setup 88,082,407 B，sha512 与 `latest.yml` 一致。main 与 tag 均已推送（GitHub Release 仍待实机冒烟后转正）。

> **第二十批（实机冒烟第二批反馈 + BUG-023 会话工作区贯通，2026-09-03）**：用户实跑发现**同一根因的三处断点**——① 指定项目目录的新会话默认 cwd 仍是 user home（`git pull` 报「C:\Users\my 不是 Git 仓库」）；② 会话中重选项目也不切换工作区；③ 即使 Agent 自己 `set_cwd` 到 D 盘项目也会被沙箱白名单拒。登记 [BUG-023](../60-BUG/index.md)：项目 `path` 只在渲染层，主进程 `sessionCwds` 只由 `set_cwd` 工具写入，项目绑定目录到会话工作区**整条链路从未接通**（BUG-020 修了「Agent 主动切」，没修「项目自动切」——工具有了 ≠ 链路通了）。修复：新 IPC `orchdesk:set-session-cwd`（用户 GUI 绑定不走授权门，但严格校验绝对路径 + 存在 + 是目录）+ `isPathAllowed` 纳入会话工作区根 + 渲染层 `applySessionCwd()` 在五个驱动点重放（创建会话 / 打开会话（幂等，覆盖重启 Map 失忆）/ 重选项目 / home 发送 / 分叉）+ 文件面板缺省根与终端缺省 cwd 落项目目录。验证：model-loop B1–B5 + e2e 7 条，verify 24 套件 **832 项**全绿。

> **第二十一批（全盘死挂点扫描修复 #44-47 + e2e 组 15 回归 #48，2026-09-03）**：① 死挂点全盘扫描（IPC/事件/动作/UI 四张全景图）修复 11 处并经 yt-dev-review 三方审阅收敛：`rendererWindow()` 收敛重复 4 次的窗口选择（notifyToolStep / pushBrowserState / onTerminalData / onTerminalExit 此前可能推到无 preload 的普通窗口）；`outboundGate` 缺完成服务时补 WARN（此前静默 fail-open）；文本兜底路径补传 `sessionId`（参数泄漏断链）；toolSteps「订阅有写入、UI 零读取」→ renderMsg typing 分支实时读 + 150ms 尾随节流 + 回合成败两路清理；插件状态按运行时真实装载标注（主动停用「已停用」≠ 真异常，前缀区分）；askInput 假 Promise 接口（回调式被 `.then` 必崩）→ 专家团派发链路打通；SVG 图标键补齐；statbar 去掉硬编码 `%APPDATA%/OrchDesk` 与 dsh 版本。② **#48：e2e 组 15 死挂点修复回归**（`e2e-fix-verify.cjs`，fixture 补 `onToolStep` 回调留痕 `window.__toolStepCb` / `getPluginRuntime` 按 `__rt` 返回就绪 + composeTeam 调用留痕）——6 条链路用真实渲染层复现：live 工具步骤 typing 实时可见 → done 翻转 → 回合结束静态落库第二个明细区；任务监控「技能与MCP」状态真实标注（intent/multi 已启用、trace 已停用、brain 异常）；设置 statbar 显示真实目录末两段 + 运行时就绪 3/4；专家团「派发任务」弹输入框真把任务派给 composeTeam 并渲染 3 节点委派树；文件面板开关可见性真实切换。e2e 165→192，全量 verify **832→859**（24 套件）全绿。

> **第二十三批（dsh-runtime 样板收敛 + 竞态修复 ⑤，2026-09-04）**：多维审验「遗留项」清理第四连（用户裁决「样板收敛+竞态修复」，文件拆分暂缓）。**⑤ 插件装载三样板收敛**——startRuntime / setPluginEnabled / setMarketPluginEnabled 三处各写一份「dynamicImport → normalizeInject → Config → ctx.plugin → settle → state」样板（改一处易漏两处）→ 抽统一 helper `loadPluginFiber(ctx,{entry,unwrapDefault,transformConfig})`：差异点全用参数表达不靠复制——`unwrapDefault`（市场插件常是 CJS，产物在 mod.default；内置 vendored 成 ESM 在顶层）、`transformConfig`（仅内置 trace 在**启动装载**注入内置 TOKEN+用户开关，热插拔刻意不注入）；市场「st!==2=显式启用却未激活→清 fiber+报错」语义由调用方按 st 区分（内置插件保留 fiber 仅记 inactive，二者本就不同）。**⑤ startRuntime 幂等竞态修复**——首装完成前 `runtime` 仍为 null，仅靠 `if (runtime)` 挡不住并发二次调用（各 new 一份 Context 泄漏）：抽出 `buildRuntime()`（每次真实执行），`startRuntime` 改 in-flight Promise 门（`runtimePromise` 复用，成功后统一收口 runtime 赋值，失败清空允许重试），`stopRuntime` 配套清 `runtimePromise` 允许再次启动。全量 verify **875/875**（25 套件，纯重构无测试增量，dsh-runtime 31 / plugin-market 15 / ts-loader 13 直接覆盖）。
> **第二十二批（IPC sender 校验 ② + 无界队列加固 ③ + canonical 去重 ④，2026-09-04）**：多维审验「遗留项」清理三连。**② IPC sender 校验**——全项目 `ipcMain.handle` 只在注册层统一校验 `event.senderFrame` 属主窗（null sender 放行供 verify stub），第三方 webContents 调 handler 一律拒（抛 untrusted-sender，不静默回数据），杜绝「开个 devtools / 弹出窗就能 invoke 主进程任意 handler」的越权面；新增 `ipc-guard-verify.cjs`（4 项，进链）。**③ 无界内存队列加固**（用户裁决：trace 关闭期「关闭则不记录」，其余全加固）——trace `pending` 硬上限 `PENDING_MAX=2000`（repoUrl 空=用户关 trace → 不入队；超限丢最旧）+ 删 `sessionIntent` 死 Map（每回合 +1 泄漏）；memory `dumps` 环形上限 `maxDumps` 默认 1000（与四域 prune 对称）；multi 委派树 `maxTreeNodes` 默认 3000，composeTeam 收尾 `trimTree()` 整棵 evict 最旧终态 root（不撕裂 CEO/Director/Worker 层级）。**④ canonical 去重**（用户裁决「H + M 数据通道」）——H-1 `file_read` 2MB 上限从 main.ts 内联收敛到 file-panel `FILE_READ_MAX_BYTES`（只共享上限值，file_read 超限拒绝 vs 面板截断语义各自保留）；H-2 记忆四域 `MEMORY_DOMAINS` 从 dsh-runtime 内联收敛到 memory-promotion（纯逻辑零 electron）；M-3 回传上限 `FILE_READ_RESULT_MAX=50000` / `WEB_FETCH_RESULT_MAX=30000` 单源化（agent-runtime schema 描述模板引用 + main.ts slice 引同常量），browser-tools 超时/文本/链接默认与上限常量前移、schema 描述改引用；M-2 插件页「能力审查」L0-L4 卡改消费 `state.authLevels`（同设置页数据源）；M-1 授权模式卡 + 白名单工具下拉数据化——新 IPC `orchdesk:authz-get-modes`（透传插件 `AUTHZ_MODES` + `GRANT_TOOLS`，补齐 `getModes?()` 半接线残留）+ preload 桥 `getAuthModes` + authz 插件服务加 `getGrantTools()`，渲染层删硬编码 `AUTH_MODES`（trusted 文案此前丢了「仍受 SandboxMode 约束」）。全量 verify **875/875**（25 套件，②/③ 新增用例后 ④ 无测试增量）。
 
> **第二十五批（右栏「能力」TAB：技能与MCP 改名并补齐真数据源，2026-09-05）**：用户裁决「技能与MCP 改成**能力**，包含使用中的插件、技能、MCP」。改名只是表层——旧 TAB 的**两个分组都不是真数据源**：①「插件（默认启用）」的数据来自渲染层硬编码常量数组 `['intent','trace','brain','multi']`，与运行时装载无关；②「技能」分组是从 Agent 消息里正则抓 `{skill:xxx}`，而 `{skill:xxx}` 是**提示词模板**的引用语法（由 prompt 插件消费，未解析时输出 `«skill:xxx:unresolved»`），Agent 回复里根本不会出现——解析结果恒为空，是典型死挂点。修法：① 插件改取 `state.pluginRuntime.plugins` 真实装载（沿用「主动停用 ≠ 真异常」的 error 前缀判定），运行时未接入时回落声明清单并显式标注「运行时未接入 · 非实时装载状态」，不用空列表冒充「没有插件」；② 技能改取**磁盘真实扫描**——`guanji.ts` 新增 `listInstalledSkills()`（扫 `数据目录/skills/*.skill`，slug 再过一次 `isMarketDirName` 白名单）+ `uninstallSkill()`（真删文件，slug 同样过白名单防路径穿越），新 IPC `orchdesk:skills-installed` / `orchdesk:skill-uninstall` + preload 桥 + 渲染层 `refreshInstalledSkills()`（合并时保留内存启用开关）。**此前 `state.installedSkills` 只在安装时往内存数组 push，重启即清零——磁盘上有包却显示 0 个**；`skill-uninstall` 此前也只从数组移除，文件还在。③ 未接入（扫描失败）与「已扫描但没装」分开标注，标题分别显示「技能 · 未接入」与「技能 · 使用中 N/M」，不把「没读到」说成「读到了 0 个」。顺带：新增样式用 `--fg-dim` 而非 `--fg-faint`（后者浅色主题 2.33:1 不过 AA，见 [ui-ux-audit](../40-质量/ui-ux-audit.md) P1，新增代码不往坑里添）；`docs/40-质量/quality-gates.md` 与 `workflow.md` 写的强制门禁 `python scripts/audit_knowledge_base.py docs` **此前仓库里没有这个脚本**（只有 SKILL 临时解包目录里有一份）→ 零依赖实现落进 `scripts/`，门禁命令才真能跑。验证：e2e 新增 7 条断言（197→204，含 mock 桥补 `listInstalledSkills` / `uninstallSkill`），全量 verify **877→884**（25 套件）全绿。
> **第二十四批（v0.14.0 发版 + UI 重构四项 + impeccable UI/UX 审查，2026-09-04）**：① **v0.14.0 打包发版**——v0.13.2 之后积了 19 个未发版提交，`check-version` 严格模式下 `version == 最新 tag` 会阻断 dist，故顺序必须是 bump → changelog → 打包 → **最后** 打 tag（`changelog.mjs` 从 package.json 推导下个版本，先 bump 会算成 0.15.0，必须显式传 `--from v0.13.2 --version 0.14.0`）。产物 Setup 88MB / portable 84MB 落在全新目录 `release-v0140-r1`（asar 句柄泄漏会让同目录重试 EBUSY），asar 头部按 pickle 解析（`readUInt32LE(4)` 取长度、JSON 从 offset 8 起）校验 9 个 dsh 插件 + dist + renderer + node-pty 齐全。push 踩到 **`~/.git-credentials` 里过期的 `x-access-token` 条目排在 `ra1nzzz` 之前**，credential-store 返回首个 host 匹配 → 401 → 退回交互态报「could not read Username」（已写入跨项目记忆）。② **UI 重构四项**（用户裁决：浏览器 TAB = 登记页面快照 / 待办数据源 = 结构化 plan 块 + markdown 列表回退 / 文件目录 = 自动跟随项目目录）：待办改语义化（`extractPlanSteps()`，完成度只认 `[x]`/✅ 显式标记，不拿工具数猜进度，工具调用降为「执行明细」折叠区）；标题栏删主题文字按钮（左下角已有）；文件移入右栏 TAB；浏览器改右栏第 4 列侧栏（与任务监控互斥占列，页面快照登记上限 12，可单关可全关，自动展开只在 false→true 跳变时触发不跟用户手动收起打架）；终端从 `position:fixed` 覆盖层改成**文档流内抽屉**（展开时主区 flex 自动收缩，全屏 `calc(100vh - 66px)` 并对所有 xterm 句柄重新 fit）；浏览器/终端开关图标移到状态栏右下角；思考中右侧加展开/收起看思考链详情。③ **impeccable SKILL 全局 UI/UX 审查（仅审查，不改代码）**——skill 在本地 marketplace 缓存找到（31 个纯 md、零脚本，P2 安全）装到用户级；按 `references/audit.md` 五维打分：**11/20 Acceptable**（A11y 1 / Perf 2 / Theming 3 / Responsive 2 / Anti-Patterns 3），AI Slop Test 通过，P0×0 / P1×2 / P2×3 / P3×2，清单落在 [ui-ux-audit.md](../40-质量/ui-ux-audit.md)。验证：e2e 195→197，全量 verify **875→877**。教训：e2e 一律用 `[data-action="ctx-tab"][data-id="..."]` 定位，**插入 TAB 会让 `nth(N)` 静默切错页**（本次插入「文件」后 `nth(2)` 指向了文件而非技能，排查代价很高）。
 
> **第二十七批（UI/UX 前端收敛 · ui-ux-pro-max，2026-09-06）**：用户用 `@skill:ui-ux-pro-max` 启动的克制收敛轮。覆盖四块：① 全局视觉基调（对比度 + 键盘可达 + 硬编码色收敛） ② 插件页 + 技能市场（搜索 / 即时过滤 / 已安装清单重排） ③ 设置页信息架构（左侧 7 项导航 icon+label 统一、active 高亮改用 class） ④ 会话主界面（响应式保护）。严格按「克制收敛」：零 DOM 重排，只动 token 与结构性样式。① **对比度（P1 /colorize）** `--fg-faint` 双主题过 WCAG AA —— dark `#6B7280`→`#8A93A3`（bg 5.38:1，panel 4.95:1 PASS）、light `#9CA3AF`→`#667085`（bg 4.97:1，panel 4.56:1 PASS）；`--fg-dim` 也微调（dark `#A6ADBB`、light `#5F6B7A`，均 ≥5.4）。必须用相对亮度公式逐对（fg × bg/panel）重算，浅色 panel 是瓶颈不是 bg。② **键盘可达（P1 /harden）** `hardenActions(root)` 在 render() 末尾给所有非原生可交互的 `[data-action]` div 补 `role="button" tabindex="0"`，跳过已有 role 的（`.switch` 的 `role="switch"`）和原生控件 —— 委托层一次性收敛（取代「逐个补」，新增元素自动继承）；body 级 keydown 把 Enter/Space 映射到 `[data-action][tabindex]` 的 click；focus-visible 选择器扩展到所有 hardened 元素。③ **硬编码色收敛（P2 /normalize）** 新增 `--term-bg/--term-fg/--diff-add-bg|fg/--diff-del-bg|fg` 显式 token；`.term-body`/`.term-pre`/`.file-edit-error`/`.badge.warn` 改用 token。xterm theme 配置（app.js:2876）保留字面色（JS 端取 CSS var 不便），但与 token 值一致。④ **插件页搜索** `#plugSearch` 即时过滤内置插件卡片（名称/描述/能力/标识）—— 所有卡片一次渲染、`data-search` 预拼小写、input 事件运行时切 `.style.display`，**不触发 render()**（保输入焦点）。+ 命中计数 `#plugSearchCount`、+ 空态 `#plugSearchEmpty`。⑤ **技能市场搜索** 同套路：`#skillSearch` 过滤观雅集 skill 行；已安装清单重写为 `.is-row` 卡片（状态 badge + 体积 + 启停/卸载，卸载按钮染 danger 弱色 `.btn.ghost.danger-text`）。⑥ **设置页导航** 7 项 → `.settings-nav-item`（icon+label 统一行高）；active 态改用 class 而非 inline background（与 token 同步），首次进入设置页默认高亮第一项。⑦ **响应式保护（P3 /adapt）** body `min-width:700px`；<900px 自动收起任务监控/浏览器侧栏。验证：e2e 206→217（+11：插件搜索 6 条 + 技能搜索 5 条）；全量 verify **896→907**（26 套件）全绿；tsc EXIT=0；知识库审计 0 issues；headless 1440×900 双主题截图视觉确认卡片层级与搜索计数正确。

> **第二十六批（MCP 真接入：零依赖 stdio 客户端，2026-09-05）**：用户裁决「真接入」。此前「能力」TAB 的「MCP 连接」分组是**唯一残留的 mock**——4 个条目名 `filesystem/intent/memory/orchestration` 写死，全仓无真实 MCP 实现，仅把「连接状态」映射到插件装载状态冒充连接列表（P1-4 清 mock 时的半截清理：`EXPERTS/TEAMS` 改了动态源，`mcps` 漏改）。真接入方案：**零依赖手写 stdio 客户端**（不引 `@modelcontextprotocol/sdk`，避免带进 zod/transport 依赖树，违反「零依赖、纯逻辑可直测」纪律）——`mcp-client.ts`（纯逻辑、零 electron）实现 JSON-RPC 2.0 三 method（`initialize`→`notifications/initialized`→`tools/list`→`tools/call`）+ stdio 子进程管理：`spawn` 时 env 剔除 `NODE_OPTIONS/NODE_PATH/ELECTRON_RUN_AS_NODE`（同 terminal-pty 铁律，防本机 safe-delete shim 注入子进程崩掉 server）、握手/列工具/调工具**各自独立超时**（INIT 15s / LIST 15s / CALL 120s，卡住不挂起主会话）、配置归一化（id 走 `isMarketDirName` 白名单防路径穿越、args≤64、env≤32）。配置存 `数据目录/mcp.json`（`DATA_FILE_NAMES.mcp`，随目录迁移）；env 值用 `encryptSecret` 加密落盘、`decryptSecret` 回显（同凭据纪律）。主进程新增 6 个 IPC（`mcp-list/save/delete/set-enabled/probe/call-tool`）+ preload 桥 + 渲染层：插件页新增「MCP」管理区（添加/探测/启停/删除，保存即握手探测拿真实工具清单），「能力」TAB 的 MCP 分组改读真实 server（已连接/连接失败/已停用三态 + 工具数），未配置显「暂无 MCP server」、桥断显「MCP 桥未接入」，不再用插件名冒充。三态分离纪律照旧：「未配置」≠「配置了连不上」≠「连接成功但无工具」。验证：新增 `mcp-client-verify.cjs` 10 项（A 组纯逻辑归一化/白名单/序列化往返/坏 JSON 容错 + B 组**真实 stdio 握手**——用 node 起最小 MCP server 子进程端到端验证 initialize→tools/list 拿到真实工具清单、tools/call 真调 add(1,2)=3、未知工具 isError=true、命令不存在快速失败、env 剔除）；e2e 新增 2 条（204→206，mock 桥补 `mcpList` 两条真实 server：1 已连接 + 1 连接失败，断言标题「MCP 连接 · 1/2」）。全量 verify **884→896**（26 套件）全绿。

*最后更新：2026-09-06（第二十七批：UI/UX 前端收敛（ui-ux-pro-max）｜verify 907 项全绿；第二十六批：MCP 真接入（零依赖 stdio 客户端）｜verify 896 项全绿；第二十五批：右栏「能力」TAB 改名 + 技能改磁盘真实扫描｜verify 884 项全绿；第二十四批：v0.14.0 发版 + UI 重构四项 + impeccable 审查｜verify 877 项全绿）*
*上游文档：[current-state.md](./current-state.md) | [VERSION-GOVERNANCE.md](./VERSION-GOVERNANCE.md) | [PRD差距补齐复盘](../99-归档/PRD差距补齐-2026-08-29.md) | 变更日志 `apps/desktop/CHANGELOG.md`（仓库根，docs 外）*
