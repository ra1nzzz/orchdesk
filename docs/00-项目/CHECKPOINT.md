# CHECKPOINT

> 项目状态快照 + 版本治理 + 关键决策 + 下一步。
> 本文件是「项目进行到哪了」的唯一入口，阅读本文件即可接续工作。

---

## 1. 项目状态

| 维度 | 状态 | 说明 |
|------|------|------|
| **当前版本** | `0.2.0` | SemVer，pre-1.0 阶段 |
| **最新 Commit** | `2de3d07` | feat: UI/UX 迭代 + marked.js + 启动并行化 + 模型管理增强 |
| **主线分支** | `main` | protected，push 需 CI 通过 |
| **远端仓库** | `ra1nzzz/orchdesk` | GitHub，public |
| **最新 Release** | [v0.2.0](https://github.com/ra1nzzz/orchdesk/releases/tag/v0.2.0) | 含 Setup + portable + latest.yml |
| **文档审计** | 21 files, 0 issues | canonical 文档与代码保持一致 |
| **TypeScript** | tsc EXIT=0 | 全栈编译无错误 |
| **E2E** | 26/29 PASS | 3 项为 mock bridge 限制（预期内） |

### 1.1 六阶段完成度

| 阶段 | 完成度 | 说明 |
|------|--------|------|
| P0 底座打通 | ✅ 100% | deepseek-harness 基线 99f6f02 |
| P1 桌面壳 + 会话优先 UI | ✅ 100% | 4 列布局、会话 CRUD、模型多选、composer |
| P2 内置插件 | ✅ 100% | 意图识别/TRACE/脑手解耦/多Agent编排 |
| P3 安全底座 | ✅ 100% | authz 三模式 + L0-L4 分级 + fail-closed |
| P4 智能层 | ✅ 100% | 记忆分层 + 提示词库 + 四域隔离 |
| P5 补偿层 + 自进化 | ✅ 100% | withhold/compensate + staticGate + temp plugin |
| P6 生态与发布 | ✅ 100% | 观雅集 + Hub + electron-builder + 自动更新 |

### 1.2 环境门控

- **本机（WorkBuddy CLI）**：无法启动 Electron GUI（BUG-W02，binding 未链接）
- **正常 Windows 桌面**：双击 `release/OrchDesk 0.2.0.exe` 即可运行
- **真实模型闭环**：需配置 API Key（OpenAI 兼容）或本地 Ollama

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

### 2.7 NPM 脚本一览

| 脚本 | 用途 |
|------|------|
| `pnpm run version:bump` | 交互式版本递增（bumpp） |
| `pnpm run changelog` | 手动重新生成 CHANGELOG.md |
| `pnpm run version:show` | 显示当前版本 + 最新 tag |
| `pnpm run release` | `changelog` → `version:bump` → `dist` 一条龙 |
| `pnpm run build` | `tsc` → `electron-builder` |
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

### v0.2.0（当前，2026-08-28）

**主题**：UI/UX 迭代 + 开发体验

- [x] 启动并行化（init Promise.allSettled）
- [x] 智能推荐按钮
- [x] 动态时段问候语
- [x] 欢迎页垂直居中布局
- [x] marked.js Markdown 渲染
- [x] 模型管理默认模型下拉
- [x] 下拉浮窗层级修复
- [x] 项目选择器点击修复
- [x] 白屏防护（backgroundColor）
- [x] Emoji → SVG 全覆盖
- [x] 版本治理方案落地（bumpp + changelog + electron-updater + CI）
- [x] docs 知识库 + CHECKPOINT 更新

### v0.3.0（下一版本，待规划）

- [ ] 真实模型闭环（dsh ctx.agents.followup 接入）
- [ ] 意图识别本地模型接入（Ollama qwen3:14b F1-F4）
- [ ] TRACE 脱敏遥测真实上传（GitHub Gist/ Releases）
- [ ] 插件热加载（无需重启）
- [ ] 多语言 i18n（中文/英文）
- [ ] 主题系统扩展（自定义 accent 色）
- [ ] 会话搜索 + 标签

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
| E2E 3 项失败 | mock bridge 限制，非 bug |
| BUG-W02 | 本机 WorkBuddy 环境无法启动 Electron，须正常桌面 |
| 插件编译失败 | 确认 `references/deepseek-harness` 已构建 |
| 快照失败 | 检查 `userData` 目录权限 |

---

*最后更新：2026-08-28 by ZCode assistant*
*上游文档：[current-state.md](../00-项目/current-state.md) | [VERSION-GOVERNANCE.md](./VERSION-GOVERNANCE.md) | [CHANGELOG.md](../apps/desktop/CHANGELOG.md)*
