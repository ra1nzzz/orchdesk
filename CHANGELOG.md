# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] - 2026-08-29

### Added
- Agent Runtime 工具执行引擎：支持模型循环调用工具（`<tool:name>args</tool>` 格式）
- 模型调用管线：`callModel()` → `callOllama()` / `callOpenAICompatible()`，支持 function-calling
- 5 个内置工具：`file_read`、`file_write`、`file_list`、`shell_command`、`web_fetch`
- maxToolIterations 配置（默认 200，上限 500），settings UI 滑块
- 系统提示注入：每次 agent loop 自动注入工具定义 + 格式约定
- OrchDesk 自定义图标（orchstar.png → build/icon.png）
- E2E 验证套件（Playwright，29/29 通过）
- IPC 桥接：`orchdesk:tool-execute`、`orchdesk:run-agent-turn`、`orchdesk:models-save`
- 状态栏动态 Commit 显示（GitHub API 拉取 latest commit sha）
- 架构审计：主进程/渲染层职责分离、安全门控

### Fixed
- TS1128/TS2300 编译错误（重复导入、孤儿代码）
- 类型冲突（`@types/node` 与 electron-builder），tsconfig `types` 收窄为 `["electron"]`
- 工具调用正则误匹配（`<\/?>` → `<\/tool>`），工具调用不再被当作文本显示
- E2E mock 缺失 providers 数据导致 `selectedModels` 为空、消息发送失败

### Changed
- 构建流程：`electron-builder` 支持 NSIS + portable 双目标
- 自动更新：`electron-updater` 配置 GitHub Releases 源
- 版本号：0.2.0 → 0.3.0

## [0.2.0] - 2026-08-08

### Added
- 版本治理：conventional-changelog + bumpp 工作流
- 自动更新（electron-updater）
- CI/CD 配置
- CHECKPOINT 机制
