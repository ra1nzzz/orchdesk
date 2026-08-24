---
id: orch-sbx-001
title: 跨平台沙箱 backend 设计与验证
status: canonical
version: v1.0
updated: 2026-08-19
---

# 跨平台沙箱 backend 设计与验证（T-P3-1）

> 本页是「平台沙箱 backend」的 canonical 责任方。决策依据 [ADR-0005](../70-决策/ADR-0005-sandbox-backends.md)；
> 架构位置见 [architecture.md §1/§5](../10-架构/architecture.md)；约束见 [PLAN T-P3-1](../30-开发/PLAN.md)。
>
> **v1.0 收敛发现**：OrchDesk **不重写沙箱核心**。dsh 的 `@deepseek-ai/dsh-sandbox-local`
> 已按平台自动选择外部沙箱 backend（Linux `bwrap`/`landlock`、macOS `seatbelt`、Windows
> `windows-acl`），且 fail-closed。OrchDesk 的 P3 增量是**接线 + 验证 + GUI 暴露白名单配置**，
> 而非另起沙箱实现（防漂移：遵循论文 §6.3「外部机制」+ ADR-0005 决策）。

## 1. 责任边界（收敛后）

| 能力 | 责任方 | OrchDesk 增量 |
|---|---|---|
| 沙箱抽象服务 `ctx.sandbox` | dsh（`dsh-sandbox` + `dsh-sandbox-local`） | 无（直接复用） |
| 平台 backend 选择（按平台自动） | dsh `sandbox-local`（`PLATFORM_CHAINS`） | 无 |
| 沙箱策略（`SandboxMode` 三档 + 每会话 override） | dsh `dsh-sandbox-policy`（`ctx.sandboxPolicy`） | 无（直接复用 `setSandboxMode`/`resolve`） |
| 白名单目录（workspace root）配置 GUI | OrchDesk 设置页（T-P3-2 授权分组） | **新建**：暴露 workspace 选择 + mode 切换 |
| 拦截日志可检索 | dsh SessionEvent 日志（`sandbox/*` 事件） | **新建**：设置页日志入口（T-P3-2） |
| 跨平台 backend 验证脚本 | OrchDesk（本页 §4） | **新建**：可转移的验证清单 |

## 2. 各平台 backend 机制（来自 dsh 源码事实）

`dsh-sandbox-local` 的 `PLATFORM_CHAINS`（事实，非设想）：

```text
linux:  ['bwrap', 'landlock']   // 优先 bwrap（mount 语义最贴近 mode 词汇），landlock 兜底
darwin: ['seatbelt']            // 单一候选，无需 probe；sandbox-exec CLI（Apple 标记 deprecated 但仍随系统发布）
win32:  ['windows-acl']         // 单一候选，受限令牌 + ACL + Job Object；执行期拒绝 fail-closed
```

### Windows（`sandbox-windows-acl`）
- 受限令牌（restricted token）+ ACL + Job Object 三件套；`WORKING_ASSERT_WRITE_RESTRICTED`。
- 越界写由 NTFS ACL 在 OS 层拒绝，子进程 stderr 出现 `access is denied` / `access to the path` / `permission denied`；runner 自身失败打印 `windows-acl-run: <detail>` 并 `exit 127`（与命令本身的拒绝区分，避免误判"命令未运行"）。
- **`STATIC_ENFORCEMENT` 标注为 `partial`**：NTFS 硬链接可把工作区文件别名到区外路径；backend 强制其余 ACL 可达面，但不承诺绝对保证（已在 dsh 源码注释中明确，不夸大）。
- 越界写被拦截是 **OS 层强制**，不依赖语言级访问控制（满足论文 §6.3）。

### macOS（`seatbelt`）
- dsh 已通过 `sandbox-local` 内置 Seatbelt profile（`seatbeltProfileArgs`）：allow-default + `(deny file-write*)` + 写允许列表。
- 模式映射：`read-only` 仅授予 `/dev/null` 字面量；`workspace-write` 增加 workspace root + `/tmp` + `os.tmpdir()`（mkstemp 族工具的真正临时区，已 canonicalize 因 Seatbelt 匹配解析后路径）。
- **修正 ADR-0005**：macOS 在 dsh 侧**已有 seatbelt 实现**，非"需自建"缺口；状态应为「已实现（基于已 deprecated 但仍随系统发布的 `sandbox-exec` CLI，功能 probe fail-closed）」。见 [ADR-0005 修订](../70-决策/ADR-0005-sandbox-backends.md)。

### Linux（`bwrap` / `landlock`）
- `bwrap` 优先（mount namespace 语义最贴近 mode 词汇）；`landlock` 作为兜底（仅 5.13+ 内核，launcher 在旧 ABI 上 self-report partial）。
- 直接复用，无需 OrchDesk 改动。

## 3. 防漂移约束（T-P3-1）

- **不要从零写沙箱核心**：OrchDesk 复用 `ctx.sandbox` + `sandbox-local` 平台 backend，不新建 Rust/C/Node 沙箱进程。
- **白名单由用户在设置页显式配置**：workspace root 来自 session `cwd`（dsh `SessionHeader.cwd`，创建时不可变），OrchDesk 不静默放宽。
- **拦截事件必须入日志**：所有 `sandbox/*` 事件写入 dsh SessionEvent 日志（dsh 不变量），OrchDesk 仅提供检索入口，不绕过。
- **fail-closed 不可妥协**：任何平台 backend 不可用（probe 失败 / runner 缺失）一律拒绝执行，不降级放行。
- **不跨平台调用错 backend**：`landlock-run` 仅 Linux 5.13+；macOS 不调 landlock；Windows 不调 bwrap（由 `sandbox-local` 的 `PLATFORM_CHAINS` 保证，OrchDesk 不干预）。

## 4. 运行期验证（可转移至正常 Windows 机器）

> 本机（开发机）因 **BUG-W02**（Electron 内置模块无法链接）+ 无显示器，无法实跑 GUI 与 dsh 运行时。
> 以下验证清单转移到**可正常运行 Electron/dsh 的 Windows 机器**执行；代码逻辑与类型已就绪。
> 验证目标对齐 [PLAN T-P3-1 验收清单](../30-开发/PLAN.md)。

### 4.1 Windows 验证清单（win32 ACL）

| # | 验证项 | 操作 | 预期断言 |
|---|---|---|---|
| W1 | 平台 backend 选择 | 在 win32 启动 dsh profile `orchdesk` | `ctx.sandbox` 解析 chain = `windows-acl`，无备选 probe |
| W2 | 文件越界写拦截 | 在 `workspace-write` 模式下，经沙箱执行写 `${workspaceRoot}/../outside.txt` | 子进程 exit ≠ 0，stderr 含 `access is denied`/`access to the path`；**文件未被创建** |
| W3 | 文件白名单内写放行 | 写 `${workspaceRoot}/inside.txt` | 文件创建成功 |
| W4 | 命令白名单 + 参数检查 | 配置命令白名单（dsh `tool-bash`/`tool-pwsh` 的允许命令集），执行白名单外命令 | 被拦截（exit ≠ 0 / 审计 `rejected`） |
| W5 | 网络域名白名单 | 在受限模式下发起白名单外域名的网络请求 | 被拦截（dsh 网络策略）；白名单内放行 |
| W6 | 沙箱日志可检索 | 触发一次越界写后，查询 SessionEvent 日志 | 存在 `sandbox/*` 拒绝事件，设置页日志入口可检索到 |

### 4.2 macOS / Linux 设计态验证（接口预留）

- **macOS**：`darwin` chain = `seatbelt`；在 macOS 机器复跑 4.1 的 W2–W6（把 ACL 换成 Seatbelt deny 信号 `operation not permitted`）。
- **Linux**：`linux` chain = `bwrap`→`landlock`；在 Linux 5.13+ 复跑，断言 Landlock 部分强制告警（旧 ABI `partial enforcement` stderr）不影响 fail-closed。

### 4.3 自动化探针（可选）

`sandbox-local` 已内置功能探针（`defaultProbeSeatbelt` 等）：win32 链为单候选不 probe，但执行期拒绝 fail-closed。OrchDesk 可在 CI 中复用 dsh 的 `packages/sandbox/sandbox-windows-acl` 既有测试（dsh `vitest.config.ts` 已对 win32 专属覆盖做条件排除），无需重复编写。

## 5. 与 T-P3-2 的接口

沙箱策略的**用户可控面**（授权模式三档 + workspace 选择）由 [T-P3-2](PLAN.md) 的 `orchdesk-authz` 插件经 `ctx.sandboxPolicy.setSandboxMode` 暴露到设置页与 composer 授权芯片；本页只负责 backend 层机制与验证，不重复 GUI 接线。
