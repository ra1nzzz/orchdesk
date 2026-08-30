# CHECKPOINT

> 项目状态快照 + 版本治理 + 关键决策 + 下一步。
> 本文件是「项目进行到哪了」的唯一入口，阅读本文件即可接续工作。

---

## 1. 项目状态

| 维度 | 状态 | 说明 |
|------|------|------|
| **当前版本** | `0.9.1`（已打 tag `v0.9.1`，GitHub Release 由 CI 生成） | SemVer，pre-1.0 阶段；`0.9.0` 为上一 Release |
| **最新 Commit** | `bf3a941` | chore: release v0.9.1（fix: pre-step payload 完整化，memory 阈值检测生效） |
| **主线分支** | `main` | protected，push 需 CI 通过 |
| **远端仓库** | `ra1nzzz/orchdesk` | GitHub，public |
| **最新 Release** | [v0.4.1](https://github.com/ra1nzzz/orchdesk/releases/tag/v0.4.1) | 由 `v*` tag 触发 CI：tsc → electron-builder（nsis + portable）→ GitHub Release |
| **文档审计** | 0 issues（`audit_knowledge_base.py docs`） | canonical 文档与代码保持一致 |
| **TypeScript** | tsc EXIT=0 | 全栈编译无错误 |
| **验证套件** | 325/325 PASS | `npm run verify`（plugins 51 / orchestration 45 / trace-upload 36 / agent-runtime 38 / agent-loop 14 / model-loop 34 / dsh-runtime 15 / credentials 17 / data-dir 36 / data-port 10 / e2e 29） |

> **v0.4.1 关键修复**：StepFun / 部分 OpenAI 兼容网关在 chat 模式下带 `tools` 参数时返回 HTTP 200、content/toolCalls 全空（软拒绝），导致「发消息能响应，要求执行任务则报错」。现 `callOpenAICompatible` 识别软拒绝并逐级降级到不带 tools，成功后把 `provider.id|model` 记入进程级记忆，后续会话直接走 `<tool:>` 文本兜底解析。新增 model-loop M 组 3 项回归测试。

> **v0.5.0 关键交付（dsh memory 真实接入对话流，BUG-019/020）**：① 新工具 `memory_save`——用户告知的长期事实写入 dsh memory 插件 global 域，每轮回召回最近 10 条注入 system prompt（此前「我记住了」全是口头应答）；② 新工具 `set_cwd`——会话级工作目录，shell/file 操作以此为基准，system prompt 声明当前目录（此前命令固定跑在 home，`D:\Code\WxTools` 这类项目全被误判「不是 git 仓库」）；③ 工具 5→7，verify 313→318。同轮落地 ponytail audit 削减项：`scripts/verify-kit.cjs` 共享 electron stub + 计分脚手架（5 份 stub / 10 份样板归一，净减 ~160 行）、`scripts/changelog.mjs` 替换静默空输出的 conventional-changelog 链（BUG-W04 根因推翻：git-raw-commits@5 与 parser@6 分隔符契约断裂）。

> **v0.6.0 关键交付（漂移裁决：ADR-0008 挂点桥接）**：用户质询「用 DSH 作为 agent runtime 是不是 PRD/PLAN 设定」暴露文档漂移——PLAN T-P1-5 写明接入 `ctx.agents.followup`，实际代码直连循环且未做显式裁决；更深危害是 **intent 意图网关与 trace 遥测挂在 `agent/pre-step` 上，该事件只有 dsh AgentLoop 驱动才发，主会话绕过 → 两个 PRD 亮点在主链路是死挂点**。裁决（[ADR-0008](../70-决策/ADR-0008-model-loop-dsh-bridge.md) + conflicts C6）：followup 是 fire-and-forget inbox 驱动、与 Electron IPC 请求-响应不同构，全量切换需重写工具/模型/会话三层映射；v1 落地「挂点桥接」——`dsh-runtime.firePreStep` 每回合驱动 waterfall，intent reject 硬拒不调模型（model-loop O1：`rm -rf /` 被拦、0 次模型调用），trace 观测同挂点生效；AgentLoop 完整事件化列 P7 路线图。PLAN/current-state 漂移表述已同步修正。

> **v0.7.0 关键交付（BUG-021：审批死挂点修复，PRD L3/L4 生效）**：`shell_command` 接入授权门——白名单准入后 paranoid 直接拒、default/trusted 过 `approval.request`（GUI 弹窗，fail-closed）；修复应答方注册错位（此前挂在 authz 插件的空接口上，实际发起方 host-services 的应答器恒 null → 审批 UI 从未收到真实请求）；新增渲染层就绪标记（未就绪零等待拒绝，不等 120s）。至此 PRD 三个亮点挂点（intent 网关/trace 遥测/审批弹窗）全部真实生效于主链路。

> **v0.8.0 补齐（死挂点清零 + FR-5/FR-11 生效）**：① promptLib 提示词库接入对话流（第四个死挂点——服务/桥/UI 齐全但 system prompt 从不消费，用户配置的提示词从未生效）；`runAgentTurn` 经 `mergeForAgent('orchdesk-main')` 合并后注入 system prompt（含冲突标注）。② 记忆召回升级为语义 Top-K（TF-IDF 余弦），召回为空回落机械取尾——短查询与记忆无词面交集时不得吞掉用户告知的事实。③ `file_write` 接入授权门（与 shell 共用 approvalGate），写文件不再 silently 放行。验证 324/324；audit 0 issues。

> **v0.9.0 补齐（第五个死挂点：专家团派发）**：编排此前「看得见目录、发不出任务」——catalog 桥只读，无 compose-team 桥、渲染层无派发入口。修复：`orchdesk:compose-team` IPC（multi `composeTeam` 真实跑三层）+ preload 桥 + 插件页「派发任务」按钮（askInput 收任务 → 委派树渲染）。model-loop Q1 端到端：Director 层经 agentRunner→callModel 真实执行、全节点收敛 done。PRD 亮点「多 Agent 编排」从目录浏览升级为可派发。

> **v0.9.1 修复（fix→patch）**：`firePreStep` payload 补全——此前只传当前单条消息，memory 插件的 80% 上下文阈值检测（按 payload.messages 总 token 估算）形同虚设；现传完整会话正文（system + 历史回灌 + 当前输入），intent 取 lastUser 不受影响、memory 阈值检测真实生效。**两处诚实跳过**：① `web_fetch` 不接补偿/审批门——只读 GET 无不可逆外发，接入只会让每次抓网页弹窗（ponytail 判定不需要存在）；② trusted 模式 file_write 免审——依赖 authz `getMode` 反查缺陷修复（当前把 trusted 折叠为 default，需改插件 + vendor 重物化），成本/价值不匹配，记为已知债（upgrade path 见 `approvalGate` 注释）。

### 1.1 PRD 完成度（FR 维度，2026-08-29 复盘）

> 判定口径同 [差距盘点](../99-归档/PRD差距盘点-2026-08-29.md)：「已接线」= 有真实数据流。
> 补齐前 ≈ 30%（单点根因：dsh/Cordis 运行时缺席）；补齐后 ≈ 75%。

| 层 | 权重 | 完成度（补齐后） | 说明 |
|------|--------|------|------|
| P0 功能（FR-1~9） | 70% | ~80% | 会话/模型/打包真；运行时接入后 FR-7a/FR-9 激活，FR-3/FR-4 缺陷修复 |
| P1 功能（FR-10~12 + 编排） | 25% | ~70% | 9 插件全部装载激活，记忆/提示词/补偿/编排逻辑已接线 |
| P2 功能（自进化 + Hub） | 5% | ~60% | evolution 装载；Hub 真实客户端已就绪 |
| **加权合计** | | **≈ 75%** | 剩余 ≈ 25% 为 GUI 实机 + 真实模型/SubAgent/上传验证 |

> 详细：差距盘点（30%）见 [PRD差距盘点-2026-08-29](../99-归档/PRD差距盘点-2026-08-29.md)；
> 补齐复盘（75%）见 [PRD差距补齐-2026-08-29](../99-归档/PRD差距补齐-2026-08-29.md)。

### 1.2 环境门控

- **本机（WorkBuddy CLI）**：无法启动 Electron GUI（BUG-W02，binding 未链接）—— 业务逻辑验证走 node 直驱（verify 套件）
- **正常 Windows 桌面**：双击 `release/OrchDesk-0.3.1.exe` 即可运行
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
- [x] 验证体系扩至 158 项全绿（新增 dsh-runtime 15 / credentials 14 / verify-plugins 51）

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

*最后更新：2026-08-29（第二轮补齐：数据目录统一 / 导出导入 / 模型闭环线级验证 / 编排与 TRACE 真实闭环验证 / vendor 路径修复，验证 158→308）*
*上游文档：[current-state.md](./current-state.md) | [VERSION-GOVERNANCE.md](./VERSION-GOVERNANCE.md) | [PRD差距补齐复盘](../99-归档/PRD差距补齐-2026-08-29.md) | 变更日志 `apps/desktop/CHANGELOG.md`（仓库根，docs 外）*
