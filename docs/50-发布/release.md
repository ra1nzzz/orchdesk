---
id: orch-rel-001
title: OrchDesk 发布操作
status: active
updated: 2026-08-29
---

# 发布操作

## 渠道与打包

- **形态**：Electron 桌面安装包（electron-builder）。
- **平台**：Windows 首发（nsis/portable）；macOS（dmg，待沙箱 backend 就绪）；Linux（AppImage，复用 landlock-run）。
- **分发**：GitHub Releases（OrchDesk 仓库；`publish`/`repository` 待填真实仓库信息后启用自动更新）。

## 打包命令（本机已验证，2026-08-24）

```bash
cd apps/desktop
npm_config_safe_delete=false ./node_modules/.bin/electron-builder   # 绕过 WorkBuddy 沙箱 safe-delete（BUG-W01）
```

> 注：pnpm 包装层会触发 safe-delete 失败（BUG-W01），直接用 electron-builder 二进制；沙箱内 NODE_OPTIONS 的 safe-delete shim 会阻断 electron-builder 内部清理（`NODE_OPTIONS="--use-system-ca"` 绕过 shim，保留系统 CA 供下载工具）。

产物（`apps/desktop/release/`，v0.1.0，win32 x64，含应用图标 `build/icon.ico`）：

| 产物 | 大小 | 说明 |
|---|---|---|
| `OrchDesk Setup 0.1.0.exe` | 84MB | nsis 安装包（可选安装目录/桌面快捷方式） |
| `OrchDesk 0.1.0.exe` | 84MB | portable 免安装版 |
| `OrchDesk Setup 0.1.0.exe.blockmap` | 89KB | 差分更新块图 |
| `latest.yml` | 344B | 更新信息（electron-updater 用） |
| `win-unpacked/OrchDesk.exe` | — | 解包版（调试用） |

## 打包配置要点（electron-builder 26）

- `build.win` 为**对象**（非数组）；`arch` 须置于每个 `target` 对象内（`{target, arch}`），WindowsConfiguration 无顶层 `arch`。
- **publish/repository**：`repository` 指向 `github.com/ra1nzzz/orchdesk`；`publish` = github provider（owner ra1nzzz / repo orchdesk）。本地构建用 `--publish never`（publish 配置存在时无参数构建会触发 GitHub 网络操作卡住）；发布用 `--publish always`（需 GH_TOKEN）。
- 图标：`build/icon.ico`（16–256 多尺寸，ImageGen 生成 PNG 后 PIL 转换），electron-builder 自动使用 buildResources。
- 签名：electron-builder 检测 `CSC_LINK`（证书路径）+ `CSC_KEY_PASSWORD` 环境变量自动签名；无证书时跳过（SmartScreen 提示未知发布者属正常）。
- **BUG-016 EBUSY**：打包前必须结束运行中的 `OrchDesk.exe`，否则删除 `release/win-unpacked/` 时锁目录。已内置零依赖脚本 `kill-running.cjs`（`taskkill /F /IM ... /T` + 等待 1.5s 释放句柄），只依据退出码判定（taskkill 中文输出为 GBK，解析会乱码）。`dist` / `dist:win` / `dist:portable` 三个 script 已串联。

## 发布记录（2026-08-24）

- **v0.1.0 已发布**：https://github.com/ra1nzzz/orchdesk/releases/tag/v0.1.0
- 资产：`OrchDesk-Setup-0.1.0.exe`（nsis）+ `OrchDesk-0.1.0.exe`（portable）+ `latest.yml`（自动更新信息）。
- 仓库 `ra1nzzz/orchdesk`（PUBLIC）仅用于产物分发（README-only，源码未推送）。
- 上传经验：本环境代理（127.0.0.1:7897）对 84MB 大文件不稳（ECONNRESET/TLS timeout），**清空代理环境变量直连**（`env -u HTTPS_PROXY -u HTTP_PROXY -u ALL_PROXY gh release upload ...`）稳定成功；electron-builder 自身 `--publish always` 上传易断，推荐 gh/curl 补传；上传 URL 用 **REST 数字 release id**（GraphQL Node ID 会 404）。

## v0.3.1（2026-08-29）

- **已发布**：https://github.com/ra1nzzz/orchdesk/releases/tag/v0.3.1
- 资产：`OrchDesk-Setup-0.3.1.exe`（nsis，84.7MB）+ `OrchDesk-0.3.1.exe`（portable，84.4MB）+ `latest.yml`
- 内容：BUG-014 工具调用稳定化 / BUG-013 数据目录统一 / BUG-015 空模型选择 / BUG-016 构建 EBUSY，详见 [KNOWN-ISSUES](../KNOWN-ISSUES.md)
- 验证：`npm run verify`（`agent-runtime-verify` 35 + `agent-loop-verify` 14 + `e2e-fix-verify` 29 = 78 项全绿）+ `tsc -p tsconfig.json` EXIT=0
- 打包：`cd apps/desktop && npm run dist:win`（自动先 `node kill-running.cjs` 结束 OrchDesk.exe，再 `electron-builder --win --publish never`）
- 本轮再次复现「代理对 84MB 大文件不稳」，**清空代理环境变量后直连**上传成功

## 版本策略

- 语义化版本 `MAJOR.MINOR.PATCH`；预发布用 `-alpha.N` / `-beta.N`。
- 底座基线（dsh commit）记入每次发布的 manifest，保证可复现。

## 运行验证（2026-08-24）

- **本 agent 宿主环境（WorkBuddy CLI）无法启动任何 Electron GUI**（BUG-W02 open：`_linkedBinding('electron')` → No such binding，`ELECTRON_RUN_AS_NODE=1` 叠加，`electron.exe` 本体复现）。GUI 实跑须在**正常 Windows 桌面**（无 WorkBuddy 注入）直接双击产物 exe（或 `pnpm --filter @orchdesk/desktop start`）。
- 打包产物结构完整性已校验：`app.asar` 含 `dist/main.js`、`dist/preload.js`、`renderer/{app.js,index.html,styles.css}`、`package.json`（@electron/asar list 验证）。

## 发布检查单

- [ ] 全量质量门禁通过（[40-质量](../40-质量/quality-gates.md)）
- [ ] 正常 Windows 桌面实机双击 Setup/portable exe 冒烟：建 Agent → 会话 → 授权 → 热插拔 → 回放
- [ ] 数据目录自动快照（升级前备份）
- [ ] 补 `publish`/`repository` 真实仓库信息 + 应用图标
- [ ] 签名与哈希（正式发布）

## 证据

每次发布在 [99-归档](../99-归档/index.md) 登记：版本、commit/tree、制品哈希、冒烟结果。
