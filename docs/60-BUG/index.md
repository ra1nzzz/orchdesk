---
id: orch-bug-000
title: OrchDesk 活跃 BUG 与缺口索引
status: canonical
updated: 2026-08-17
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

## 待定 BUG

| ID | 描述 | 级别 | 状态 | 归属 |
|---|---|---|---|---|
| BUG-W01 | pnpm 11 在 Git Bash / 沙箱下 `safe-delete`（回收站清理临时目录）失败，install 中止 exit 1，`node_modules` 未生成；需 `--config.safe-delete=false`（或环境变量 `npm_config_safe_delete=false`）让 pnpm 直删替代回收站 | 高（阻塞 Windows 构建） | open | P0 / T-P0-1 |
| BUG-W02 | **本机运行时无法链接 Electron 内置 `electron` 模块**，GUI 预览被环境级阻断。`require('electron')` 解析到 npm 包 `index.js` 返回 exe 路径字符串（无法解构 `app`）；`process._linkedBinding('electron')` → "No such binding was linked"；`electron*`/`atom*` 系 linked binding 全部不可用。v33/v36、官方 GitHub 下载副本、去 `NODE_OPTIONS` 对照均复现，**非代码缺陷 / 非镜像损坏 / 非版本问题 / 非 NODE_OPTIONS 污染** | 高（阻塞本机 GUI 预览，须换环境） | open | P1 / 「执行启动预览」验证 |

> BUG-W02 根因：Electron 内置模块通过 `process._linkedBinding('electron')` 在运行时链接，本运行时对该 binding 始终未被链接（所有版本、官方副本、去 NODE_OPTIONS 均复现），故任何 Electron 应用（含默认 `default_app`）在本机都无法拿到 `app`/`BrowserWindow` 等内置对象。结论：**本机为 Electron 运行环境级阻断**，GUI 预览须转移到可正常运行 Electron 的机器（不同机器或修复运行时链接）。Electron 二进制本身完整（36.9.5，202MB，exe 可执行、`electron --version` exit 0 返回其绑定 Node 版本 `v22.19.0`，属正常行为）。注意：`electron.asar` 缺失为误判（官方 zip 仅含 `default_app.asar`，内置模块编译进二进制）。
