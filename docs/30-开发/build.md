---
id: orch-build-001
title: 构建链路（build）
status: canonical
updated: 2026-09-20
---

# OrchDesk 构建链路

> 本页是「如何在本机构建 OrchDesk 与 dsh 底座」的 canonical 责任方。对应 PLAN [T-P0-1](../30-开发/PLAN.md)、[T-P0-2](../30-开发/PLAN.md)。

## 1. 环境要求

| 工具 | 版本 | 说明 |
|---|---|---|
| Node | `^22.19.0 \|\| >=24.0.0` | dsh 引擎约束；本机 managed 22.22.2 满足 |
| pnpm | `@11.7.0`（工程用 11.8.0） | dsh `packageManager` 声明；本机全局 11.8.0 满足 |
| Rust | 仅 Linux 沙箱需要 | `native/landlock-run` 是 Linux 5.13+ only，**Windows 不编译** |
| Electron | `^36`（桌面壳，P1 引入） | 桌面壳运行时 |

Windows 注意：dsh 在 win32 自动挂载 `pwsh-sandbox`/`tool-pwsh` 链（`bash` 在 win32 禁用），沙箱走 `dsh-sandbox-windows-acl` 受限令牌链。见 §5。

## 2. dsh 底座构建（vendor，锁定基线）

```bash
# 基线 commit：deepseek-ai/deepseek-harness @ 99f6f02（2026-08-17 锁定，ADR-0001）
cd references/deepseek-harness

# ⚠️ install 必须在「原生 PowerShell」下跑（见 §5 BUG-W01）：Git Bash/MinGW 下
#    pnpm 11 启动阶段的 safe-delete trash 会 fatal，连 `pnpm --version` 都失败。
pnpm install                 # PowerShell 下 EXIT=0 即通过（warning 入 60-BUG）

# build 在 Git Bash 即可（tsc/tsdown 无 trash 操作）
pnpm run build:lib           # tsc -b host + client，产出 lib/（含 apps/cli/lib/bin.js）
pnpm run build:web           # web 前端（可选，web-app 模式需要）
```

**P0 验收（确定性，无需 API key）** —— profile 启动 + bundle 合成链：

```bash
node apps/cli/lib/bin.js --dump-default-config --profile web      # base+web-app 合成，EXIT=0
node apps/cli/lib/bin.js --dump-default-config --profile headless # base+headless 合成，EXIT=0
node apps/cli/lib/bin.js --dump-default-config                   # 无 --profile → 报错 required（印证必须显式 profile）
```

`--dump-default-config` 打印按 `dsh.profile.bundles` 顺序叠加的 cordis patch 树（每行带 `# == @deepseek-ai/...` 来源标注），是「底座构建成功 + profile 机制可用」的最强确定性证据。**真实会话需要 LLM API key**，故 P0 仅要求 config-dump 通过；端到端会话验证留给 P1/P4（OrchDesk 接本地模型或 mock LLM 后）。

**SessionEvent 不变量**：dsh 的会话日志是 append-only；每条模型可见内容都应入日志。P4 接入真实 LLM 后用 `--print-events`（或会话导出）确认无内容绕过。

> OrchDesk 的 runtime 走自定义 profile `orchdesk`（bundles=[`@deepseek-ai/dsh-base`, `@orchdesk/dsh-desktop`]），由桌面壳主进程经 contextBridge 桥接（渲染进程持有 UI 状态，主进程负责持久化 + 模型回合 seam）。dsh 的**真实 in-process 集成**（`runProfile` + `ctx.agents.followup`）是 P1-5 模型回合的设计 seam，在 `main.ts:runAgentTurn` 接入（被 API Key / 显示器门控）。dsh **没有 `-b` 参数**，启动单位是 profile。

## 3. 工程拓扑（OrchDesk 如何引用 dsh）

OrchDesk **不 fork** dsh，把它当 vendor 底座。dsh 是 pnpm monorepo，包以 `workspace:^` 互引。OrchDesk 的新包要引用 dsh 包，两种方案（选其一后放开 `pnpm-workspace.yaml` 注释）：

- **方案 A · 超级 workspace（推荐）**：OrchDesk 根 glob 纳入 dsh 的全部包，由 OrchDesk 的 `pnpm-lock` 统一解析。
- **方案 B · file: 引用构建产物**：OrchDesk 包 `file:` 指向 dsh 的 `lib/`（要求 dsh 先 `build:lib`）。

`dsh-desktop` bundle 与 `apps/desktop` 在 OrchDesk 自有 workspace 内（`packages/bundle/desktop`、`apps/desktop`）。

## 4. OrchDesk 工程构建

```bash
# 根（拓扑敲定后）
pnpm install
pnpm run build:dsh          # 触发 dsh 构建（方案 A）或依赖 file: 产物（方案 B）

# 桌面壳（P1）
pnpm --filter @orchdesk/desktop run start   # electron .
```

`dsh-desktop` bundle 以 `dsh-base` 为第一层，通过 `cordis.patch.yml` 的 `insert` 叠加桌面壳 rows；profile 的 `dsh.profile.bundles` 顺序：`dsh-base → dsh-desktop → 用户/profile patch`。

## 4b. 打包链路已知坑（2026-09-20 实跑记录）

- **electron-builder 的包管理器检测怪癖**：app 目录（`apps/desktop/`）一旦存在
  `package-lock.json`，文件检测在同一目录同时命中 npm 与（根的）pnpm 生态，收集器
  回退到「process environment」→ 多数本机 shell 的 `npm_config_user_agent` 指向 npm →
  用 `npm list` 收集依赖树；而 `vendor-dsh` 物化进 `node_modules/@deepseek-ai/*` 的
  目录对 npm 是 extraneous（`ELSPROBLEMS`，stderr 污染输出）→ `No JSON content found in
  output`，打包中断。**对策：项目由 pnpm 统一管理，`apps/desktop/package-lock.json` 已
  gitignore（曾误入库又被 a96a1e4 移除、c7f0659 再次误入，2026-09-20 第三次清理并加
  规则防护）；打包统一走 `pnpm --filter @orchdesk/desktop run dist:portable`（pnpm 的
  UA 让收集器走 pnpm 路径，读取根 `node_modules/.pnpm`，无 extraneous 问题）。**
- 必须走 `scripts/vendor-dsh.cjs`（`dist:*` 脚本已内嵌）：asar 内插件 ESM 与
  `@deepseek-ai/*` 依赖都靠它物化成真实目录；漏跑 = arch-guard R6 红。
- `release/win-unpacked(.tmp)` 被旧进程/索引器锁定时 `rm` 报 `Device or resource busy`，
  连改名都 Permission denied——换个 `--config.directories.output` 输出目录即可绕过，
  不要与文件锁搏斗。

## 5. Windows native 坑（记录进 60-BUG）

- `native/landlock-run` 是 Linux only，**Windows 跳过**（CI 有 `ci-windows-*` gates 不编译它）。不要把 landlock 调用写进 win32 路径。
- win32 默认 `pwsh-sandbox`/`tool-pwsh`；`bash-sandbox`/`tool-bash` 在 win32 通过 `disabled: !!js process.platform === 'win32'` 关闭。
- 权限边界：`sandbox`/`sandbox-policy` 走 Windows ACL 受限令牌（`dsh-sandbox-windows-acl`），`fs-sandbox` 持续围栏 `ctx.fs` 写。挂载 `dsh-fs-local` 会与 `fs-sandbox` 双注册 `ctx.fs` 而 load 失败——勿重复挂载。

## 6. 验收命令速查（T-P0-1 ✓ 已通过）

| 验收 | 命令 | 结果 |
|---|---|---|
| install 无 fatal | `pnpm install`（原生 PowerShell） | EXIT=0（51min，2026-08-18） |
| 产出可执行 cli | `pnpm run build:lib` | `apps/cli/lib/bin.js` 存在 |
| profile 启动 + bundle 合成 | `node apps/cli/lib/bin.js --dump-default-config --profile web` | EXIT=0，打印 base+web-app 合成树 |
| headless 路径同样可用 | `--profile headless` | EXIT=0 |
| 必须显式 profile | 不带 `--profile` | 报错 `required`（印证无默认 profile） |
| 基线记录 | `cordis.patch.yml` 含 commit `99f6f02` + 空 patch | ✓ |
| 文档化 | 本文件 | ✓ |

**防漂移**：不要试图给 dsh 加 `-b` 参数；不要改 `references/deepseek-harness` vendor 源码；不要升级基线 commit（除非走 ADR）；install 一律 PowerShell。
