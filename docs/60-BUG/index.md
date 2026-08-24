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
| BUG-W02 | ~~本机运行时无法链接 Electron 内置 `electron` 模块，GUI 预览被环境级阻断~~ → **已结案（2026-08-24）**：根因是「误用 `node` 跑主进程」——`node main.js` 下 `require('electron')` 解析到 npm 包 `index.js` 返回 exe 路径字符串（无法解构 `app`），`process._linkedBinding('electron')` → "No such binding was linked"。**正确启动方式是 `electron .`**（默认取 `package.json` `main: dist/main.js`，`start` script = `pnpm run build:main && electron .`）。Electron 二进制完整（36.9.5，exe 可执行、`electron --version` exit 0）。**遗留门控**：本机 headless 无显示器（`DISPLAY` 空、`NO_XVFB`），GUI 渲染仍须在可运行 Electron 的机器执行；业务逻辑层（Cordis 插件）可在 node 下直驱验证 | 中（已解除「无法运行」；仅剩无显示器） | resolved | P1 / P5 运行期验证 |

> BUG-W02 结案（2026-08-24）：之前「运行时无法链接 `electron` 内置模块」的诊断基于**用 `node` 跑主进程**的错误启动方式——`node` 下 `require('electron')` 自然解析到 npm 包（返回 exe 路径），`_linkedBinding` 亦不适用，属预期行为而非环境缺陷。以 `electron .` 启动（Electron 二进制会注入其运行时）即可正常运行。本机**剩余唯一门控为 headless 无显示器**（`DISPLAY` 空、`NO_XVFB`），GUI 渲染须转移环境；非 GUI 业务逻辑（Cordis 插件）已在 node 下直驱真实编译产物验证（verify-p5 23/23）。
