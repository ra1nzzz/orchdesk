---
id: orch-cmp-001
title: OpenWorker 对照分析（2026-09-03）
status: canonical
updated: 2026-09-03
---

# OpenWorker 对照分析

> 本页是「外部项目对照分析」的 canonical 责任方。外部资料一律**只引用不回拷**，不落地 OpenWorker 源码；引用地址为上游仓库而非本机路径。
>
> **对照对象**：`github.com/andrewyng/openworker` @ `fb1bfc6`（2026-08-30），MIT，Beta。Tauri 2 桌面壳 + React 18 UI + Python 本地 agent server（FastAPI/uvicorn，127.0.0.1:8765），623 个文件（`coworker/` 148 py、`surfaces/` 198、`tests/` 132）。底座 aisuite。
>
> **对照目的**：给 OrchDesk 找「可借鉴的机制」与「尚未完成的缺口」。结论分三部分：① 值得借鉴（分三档）② 不值得抄 ③ 对照 PRD / 架构 / PLAN 的未完成盘点。

## 0. 结论速览

1. **同构度很高，但路线相反**：两者都是「本地优先 + 桌面壳 + 本地 agent server + 审批门 + 审计」。差异在治理哲学——OpenWorker 把治理当**产品**（三层自治阶梯 + 硬地板 + reviewer 模型 + 审计 provenance），OrchDesk 把治理当**插件**（`orchdesk-authz` 挂 dsh seam）。OpenWorker 的治理深度明显更厚，值得定向搬 4 条机制。
2. **OrchDesk 的最大欠账不是代码，是验证与勾选**：PLAN 107 项验收中 23 项已勾、**84 项未勾**，但其中绝大多数属「运行期类」且 BUG-W02 已于 2026-09-01 收窄（用户桌面可实跑，真机冒烟 11/11 已过）——即**执行条件已具备，差的是逐项执行与勾选**。
3. **结构性真缺口 6 项**（没有任何代码）：MCP 客户端、SKILL 文件化与渐进披露、persona manifest 文件化、审批落盘与 provenance、治理自保护地板、测试环境强制隔离。见 §3.2。

## 1. 值得借鉴（A 档：成本低、收益明确，建议进近期）

| # | 机制（OpenWorker 出处） | 收益 | OrchDesk 现状 | 建议落点 |
|---|---|---|---|---|
| A1 | **审批项幂等落盘 + 恢复重投**：`coworker/server/app.py:2064-2093` 先把审批写 Inbox（按 `(session_id, tool_call_id)` 幂等）再 `await inbox.wait(id)` | 掉线/窗口重载/主进程重启后审批不丢、不重复弹 | **无**：`main.ts:1890` `pendingApprovals` 为内存 Map + timer，重启即丢 | 落 `dataDir()` 下 `pending-approvals.json`，启动重投；纯逻辑进新模块并登记 arch-guard |
| A2 | **`human_only` 决策位**：`permissions.py:85-90, 383-403` —— 决策带「保留给人类」标志，使 reviewer/allowlist/bypass 同时失效 | 一个布尔值表达「地板」语义，比逐类特判便宜 | **部分有**：authz 有 L0–L4（`requiresApproval: L3/L4=true`），但**无**「治理自身文件不可写」地板（授权配置/审计库/规则表） | `authz` 加 `PROTECTED_PATHS` + `humanOnly` 位；防「批准一条正常命令 → 它悄悄改规则文件 → 未来更宽松」 |
| A3 | **override 只能收紧不能放松**：`risk.py:90-110` | 新增工具不必改权限引擎；用户不会意外降低风险档 | **无**：风险等级是常量表，用户 override 无方向约束 | `risk.classify` 式单点判定 + override 方向校验 |
| A4 | **风险是工具的声明属性，非名字集合**：工具自带 `__aisuite_tool_metadata__` 声明 `risk_level`/`requires_approval` | 工具从 15 个继续增长时权限不腐化 | **无**：`TOOL_DEFS` 的授权判定分散在 `executeTool` 各分支（见 `main.ts:957/1003/1059/1099`） | 给 `TOOL_DEFS` 每项补 `risk`/`requiresApproval` 元数据，审批判定收敛为单点 |
| A5 | **中断/拒绝必补 tool-error**：`engine.py:748, 856-867` —— 被中断或被拒的 tool_call 也补一条错误消息 | 历史无孤儿 tool_call，resume 安全 | **待核实**（`agent-runtime.ts` 需确认是否有等价保护） | 若无则补，并配一条回归断言 |
| A6 | **审批 provenance 三落点**：`engine.py:1393-1450` —— `{origin: reviewer\|user\|bypass, note, grant}` 同时进 transcript 侧车、UI 事件、审计行 | 事后能回答「这一步是模型放的还是我放的、理由是什么」 | **无**：沙箱日志有 `kind:'approval'` 但无 `origin`/`grant` 字段 | `recordSandbox` 补 `origin`/`grant` 两字段 |
| A7 | **流文本三态闸门**：`surfaces/gui/src/streamGate.ts` —— 40 词阈值分流文本为 hold/quiet/answer/none | 消灭「agent 边说边做时满屏乱跳的碎段落」；纯函数 + 一个常量即可实现 | **无**：渲染层流式直出 | `renderer/` 加一个纯函数（可进 UMD-lite 单文件并配 verify 断言，符合双环境单文件方案） |
| A8 | **测试环境强制隔离**：`tests/conftest.py:17-27` `autouse` fixture 把 state dir 全部重定向到 `tmp_path` 并 `delenv` token | 源头杜绝「测试读到开发者真实 state」 | **无**：verify 套件直接用真实 `dataDir()` 解析 | verify-kit 加统一 env 重定向（注释要写明事故教训：OpenWorker 曾因此向 prod 遥测灌垃圾数据） |

## 2. 值得借鉴（B 档：需要设计，建议进中期）

| # | 机制 | 说明 | OrchDesk 缺口 |
|---|---|---|---|
| B1 | **SKILL 文件化 + 渐进披露**：`<dir>/<name>/SKILL.md` = frontmatter + 正文，目录只注入一行，`load_skill` 时才给正文（`skills/base.py:64-136`） | 能力可沉淀、菜单不占上下文；禁用后注入显式「停止遵循」指令 | **无**：有 `prompt-lib` 提示词库与观雅集安装技能，但无 SKILL.md 式按需指令包 |
| B2 | **Persona manifest 文件化 + 角色即工具集**：`personas/manifest.md`（YAML frontmatter + 正文即 system prompt），`tools:` 字段声明能力，`catalog.expand()` 按上下文裁剪 | lead 天生无 shell/git —— 最小权限在装配层就成立 | **部分有**：8 专家 + 3 团硬编码在 `multi` 插件常量里，用户不可编排、无工具面裁剪 |
| B3 | **看板 = append-only 事件日志 + 哈希链，board 只是投影**：`teams/store.py:1-22` | 多 Agent 唯一真相，可 replay 可审计 | **无**：brain/multi 的委派树为内存态 |
| B4 | **兴趣跟随分配关系的 feed 投影 + 游标**：`teams/store.py:332-391` | 不建 mailbox，可见性 = 订阅；worker 只收自己 slice 的事件 | **无** |
| B5 | **摘要 + 机械 working-state 双轨压缩**：`compaction.py:219-266` —— 压缩区 = LLM 8 段摘要 + 代码机械提取的「写过哪些文件/跑过什么命令+退出码/产物」 | 压缩后不丢机械事实（纯 LLM 摘要必丢） | **部分有**：memory 插件有摘要，**缺机械提取**，建议补 |
| B6 | **MCP 客户端 + per-tool 控制**：`mcp/client.py:136-205`（stdio/http 双 transport）+ `include_tools`/`exclude_tools`/`requires_approval` 配置 | 生态接入能力 | **无**（PRD 亦未列，属能力外延而非欠账） |
| B7 | **一次性 → 会话 → 常驻 → 配置的四级递进，且服务端复校验**：`manager.py:4171-4211` —— 不信任调用方字符串，UI 未提供的档位降级为一次性并记 `grant_refused` | 防「REST 传个 always 就换到任意参数放行」 | **无**：PRD FR-9 要求「单次/会话/永久」三粒度，实现仅单次 |

## 3. 不值得抄（反面教材）

| # | OpenWorker 的做法 | 为什么不抄 |
|---|---|---|
| C1 | **reviewer 第二模型自动裁决 + 断路器 + shadow 评测**（`reviewer.py` 150 行提示词） | 为「人不在屏幕前」设计。OrchDesk 用户即操作者，收益（少点几次确认）抵不上延迟、token 成本与「判断 vs 保证」的沟通成本。只抄两点：`human_only` 让某些动作永不过模型；真要做先 shadow-only 跑数据 |
| C2 | **Inbox / 多 inbox 路由 / Slack 频道镜像 / 按钮编解码** | 前提是「会话在你离开时仍需你」。单机桌面无跨设备触达需求，纯负债。**只抄 A1 这一个原子能力** |
| C3 | **`readonly.py` 的 shell 静态分类器**（350 行逐命令逐 flag 白名单，注释自承有未覆盖 flag） | 维护成本与误判风险双高。用户就是操作者时，「多一次确认」代价远小于「误放行一次」。OrchDesk 更适合「执行前 diff 预览 + 一次确认」 |
| C4 | **React + Vite + Tailwind 构建链**（`package-lock.json` 221KB、18 devDependencies） | 直接违背 OrchDesk「零构建、零新依赖」。其 `App.tsx` 2412 行承载 59 个 useState 恰是反例——手写事件总线 + 单一 state 树更干净 |
| C5 | **68 个 Playwright hermetic spec（fixtures.ts 2268 行）** | 方向对、规模不该抄。OrchDesk 应先建「假 server 说真协议 + 事件驱动断言」的最小骨架，只覆盖审批门/工具调用/流式三条主动脉 |
| C6 | **workspace_trust 的 canonical-path 信任 + 哈希链防篡改** | 前提是「仓库级配置可被第三方投递」，OrchDesk 无此威胁面。但**原则要留**：任何能提高自主度的配置字段，须区分「用户全局可写」与「项目可写」 |
| C7 | **受控安装外部二进制（pin + SHA256）、托盘常驻、语音转写 sidecar** | 平台矩阵维护成本高 / 产品形态差异，非架构优势 |

## 4. 未完成盘点

### 4.1 PLAN 验收勾选：23 / 107

| Phase | 未勾 | 性质 |
|---|---|---|
| P0 底座 | 5 | 运行期（`pnpm install`/`build`/cli 端到端会话/profile 启动/回归）——证据已在 current-state，属**未回勾** |
| P1 桌面壳 | 28 | 运行期（GUI 实跑、真实模型闭环、重启回放、托盘通知） |
| P2 内置插件 | 27 | 运行期（拦截验证、TRACE 上传可见、SubAgent 芯片、三层编排闭环） |
| P3 安全底座 | 11 | 运行期（沙箱越界拦截、L3/L4 弹窗、fail-closed 用例、白名单撤销） |
| P4 智能层 | 12 | 运行期（80% 阈值转储、语义召回、四域隔离、提示词合并冲突） |
| P5 / P6 | 0 | 已按「代码/配置类」口径勾完 |

> **口径漂移（需修正）**：PLAN §「验收勾选口径」与各 Phase 状态块写于 2026-08-18 ~ 08-24，当时的门控理由是「BUG-W02：本 agent 环境无法启动 Electron」。**BUG-W02 已于 2026-09-01 收窄**（仅指 agent 宿主会话；用户桌面实跑已验证可行 —— `pnpm run smoke:browser` 11/11）。因此 P0–P4 的 83 项运行期验收**不再是环境阻断，而是「待用户桌面逐项执行并回勾」**。建议：把 P0–P4 状态块的门控表述统一改为「待用户桌面会话执行」，并补一张可勾选的实跑清单（否则 84 项永远停在未勾状态，形成新的假挂点）。

### 4.2 结构性真缺口（无任何代码，与勾选无关）

| 缺口 | 对应 | 说明 |
|---|---|---|
| MCP 客户端 | PRD 未列 | 能力外延；OpenWorker 有，OrchDesk 无（B6） |
| SKILL 文件化 / 渐进披露 | FR-11 部分 | 只有提示词库，无按需指令包（B1） |
| Persona manifest 文件化 | FR-7 多 Agent 编排 | 专家/团硬编码，用户不可编排（B2） |
| 审批落盘 + provenance | FR-9「决定可审计」 | 内存 pending，重启丢；审计无 `origin`/`grant`（A1/A6） |
| 治理自保护地板 + override 方向约束 | FR-9 | 有 L0–L4 但无 protected paths、无「只能收紧」（A2/A3） |
| 测试环境强制隔离 | 质量门禁 | verify 用真实 dataDir，有污染风险（A8） |
| 定时/自动化任务 | PRD 未列 | OpenWorker 有 standing automations（含落盘 TaskRun + 常驻规则绑定），OrchDesk 无。属需求外延，若要补需先改 PRD |

> 说明：OrchDesk **无独立 SPEC 文件**——规格职责由 `20-需求/ui-ux.md`（UI 规格）与 `10-架构/architecture.md`（系统规格）分担。对照时以上述两页 + PRD + PLAN 为准。

### 4.3 文档漂移（本次核实发现）

> 2026-09-03 已就地修正前三项，第四项（PLAN 门控口径）留待组织实跑清单时一并改写。

| 位置 | 问题 | 处理 |
|---|---|---|
| `00-项目/current-state.md` 验证规模段 | 写「24 套件 **805 项**」，漏掉同日第十七批审阅修复 | 已改为 313 → 805 → **814** 的演进链，并注明计数以 CHECKPOINT 为准 |
| `80-路线图/roadmap.md` 近期段 | 写「805 项全绿」 | 已改为 814 并指向 CHECKPOINT |
| `40-质量/quality-gates.md §6` | 标题自称「canonical 计数方：本节」，与「计数唯一归 CHECKPOINT」冲突；正文写 805 项 | 已改为「canonical 计数方：CHECKPOINT，本节不复制计数」，删除过期数字 |
| `30-开发/PLAN.md` P0–P4 状态块 | 仍用「BUG-W02 门控」旧口径 | **未改**（见 4.1，需先组织实跑清单） |

## 5. 建议的下一步排序

1. **先清账（低成本、高确定性）**：4.3 三处计数漂移 + PLAN 门控口径改写（纯文档，半小时内）。
2. **A 档打包推进**：A1（审批落盘）+ A6（provenance 字段）+ A4（工具风险元数据）同一批次做，落在 `authz` 与 `TOOL_DEFS`，各配 verify 断言 —— 这三条直接把 FR-9「决定可审计、授权可追溯」从「有弹窗」升级为「有账本」。
3. **A8 独立做**：verify env 隔离是地基，越晚做污染风险越大。
4. **验收执行**：由用户在桌面会话逐项跑 P0–P4 实跑清单并回勾（agent 环境无法代跑，刻意不进 verify 链）。
5. **B 档按需求排序**：B1（SKILL 文件化）与 B2（persona manifest）互相成就，建议同批；B5（压缩机械提取）可单独小批。

## 6. 引用

- 上游仓库：`github.com/andrewyng/openworker` @ `fb1bfc6`（本次分析快照，位于临时目录，不入库）
- 关键文件：`coworker/{permissions,risk,engine,reviewer,audit,compaction,unattended}.py`、`coworker/{skills,personas,teams,mcp}/`、`surfaces/gui/src/`、`tests/conftest.py`
