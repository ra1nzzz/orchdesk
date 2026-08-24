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
| BUG-W02 | **宿主环境（WorkBuddy CLI）对 Electron 二进制存在环境级阻断**：`process._linkedBinding('electron')` → "No such binding was linked: electron"；`require('electron')` 解析到 npm 包 `index.js` 返回 exe 路径字符串（`electron_1.app` undefined → 主进程启动即崩）。**二次验证（2026-08-24 打包后实跑）**：直接运行 `node_modules/electron/dist/electron.exe`（unset `ELECTRON_RUN_AS_NODE`、NODE_OPTIONS 仅 `--use-system-ca`、无沙箱）仍复现 binding 缺失；叠加 WorkBuddy CLI 默认设置 `ELECTRON_RUN_AS_NODE=1`（强制 Node 模式）。**2026-08-24 早间「误用 node」结案为误判，已推翻**。任何 Electron GUI 无法在本 agent 宿主环境启动 | 高（阻断本 agent 环境 GUI 实跑；打包产物本身完整） | open | P1 / 打包实跑验证 |

> BUG-W02 二次验证（2026-08-24 打包后实跑，推翻早间结案）：早间「误用 `node` 跑主进程」的结案**不成立**——以 `electron .` 启动 dev 模式、直接运行 `node_modules/electron/dist/electron.exe`（unset `ELECTRON_RUN_AS_NODE`、NODE_OPTIONS 仅 `--use-system-ca`、无沙箱）均复现 `process._linkedBinding('electron')` → "No such binding was linked"；`process.versions.electron=36.9.5` 存在但核心 binding 未链接，`require('electron')` 因此解析到 npm 包返回 exe 路径。叠加 WorkBuddy CLI 默认 `ELECTRON_RUN_AS_NODE=1`（强制 Node 模式，无 Chromium 初始化）。结论：**本 agent 宿主环境无法启动任何 Electron GUI**（环境级阻断，非产物缺陷）。electron-builder 打包产物（nsis Setup 84MB + portable 84MB + win-unpacked，asar 结构校验完整）在**正常 Windows 桌面**（无 WorkBuddy 注入）预期可运行，须用户实机双击验证；本 agent 环境内 GUI 实跑验证继续受 BUG-W02 门控，业务逻辑层验证走 node 直驱（verify-p5 23/23）。
