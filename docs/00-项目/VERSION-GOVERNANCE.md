# 版本治理方案

> OrchDesk 版本号自动递增 + 自动更新 + CHANGELOG 生成规范。

## 1. 版本号规则

| 区间 | 含义 | 触发条件 |
|------|------|----------|
| `0.x.0` | 功能版本（pre-1.0 的 MINOR） | `feat:` 提交 |
| `0.1.x` | 补丁版本 | `fix:` 提交 |
| `1.0.0` | 正式发布 | 首个生产就绪里程碑 |
| `x.0.0` | 大版本 | `BREAKING CHANGE:` 或架构级变更 |

**约定提交格式（Conventional Commits）**:
```
<type>(<scope>): <subject>

[optional body]

[optional footer(s)]
```

| type | 版本影响 | 示例 |
|------|----------|------|
| `feat:` | MINOR 递增 | `feat(renderer): 新增智能推荐按钮` |
| `fix:` | PATCH 递增 | `fix(model): 清理 MODELS 残留引用` |
| `BREAKING CHANGE:` | MAJOR 递增 | `feat(renderer): 重构消息格式!` |
| `docs:` | 无影响 | `docs: 更新 PLAN P2 验收` |
| `chore:` | 无影响 | `chore: 升级 electron 36.9.5` |
| `refactor:` | 无影响 | `refactor: 并行化 init() IPC` |
| `test:` | 无影响 | `test: 补充 verify-p5 用例` |

## 2. 版本自动递增

### 本地使用

```bash
# 根据当前提交自动判断版本号并递增
pnpm run version:bump

# 会上前提示选择递增类型（patch/minor/major），默认按 conventional commits 推断
# 执行后自动：
#   1. 更新 package.json version
#   2. 生成 CHANGELOG.md
#   3. 提交变更 ([skip ci])
#   4. 打 git tag
```

### CI/CD（GitHub Actions）

```bash
# 推送 tag 触发自动构建 + 发布
git push origin v0.2.0
# → GitHub Actions 自动构建 → 发布到 GitHub Releases
# → 用户端 electron-updater 检测到新版本
```

## 3. NPM 脚本

| 脚本 | 用途 |
|------|------|
| `pnpm run version:bump` | 交互式版本递增（bumpp） |
| `pnpm run changelog` | 手动触发 CHANGELOG.md 重新生成 |
| `pnpm run version:show` | 显示当前版本 + git tag + 最近版本 |
| `pnpm run release` | `version:bump` + `build` + `dist` 一条龙 |

## 4. 自动更新通道

- **更新源**: GitHub Releases（`latest.yml` / `RELEASES`）
- **检测时机**: 应用启动时 + 用户点击「检查更新」
- **更新策略**: electron-updater 自动下载 → 用户确认后安装
- **回滚**: 通过 `snapshotData()` 保存数据快照，更新前自动创建

## 5. CHANGELOG.md

- 自动从 git 提交生成（conventional-changelog 规范）
- 按版本分组，包含 `Added`/`Changed`/`Fixed`/`Removed`
- 由 `version:bump` 自动更新

## 6. 不可变的原则

1. **版本号 = package.json version = git tag = GitHub Release tag**，三者一致
2. **打 tag 之前必须先有 CHANGELOG.md 条目**
3. **`version:bump` 是唯一修改版本号的入口**，禁止手动编辑 package.json version
4. **所有代码变更必须通过 conventional commits**，否则 `version:bump` 无法正确推断版本类型
