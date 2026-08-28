# OrchDesk

本地优先的多 Agent 编排桌面工作台（Electron + Node.js）。

## 当前版本：v0.3.0

### 核心功能

- **模型调用管线**：统一 `callModel()` 入口，支持 Ollama 本地模型 + OpenAI 兼容 API
- **Agent Runtime 引擎**：模型循环调用工具，支持 function-calling，默认最大 200 步迭代
- **5 个内置工具**：`file_read`、`file_write`、`file_list`、`shell_command`、`web_fetch`
- **模型管理**：多提供商配置（Ollama / OpenAI 兼容），选择持久化（localStorage），settings UI 滑块调节迭代上限
- **会话管理**：项目/任务分组、会话归档/分叉/删除、右侧面板（待办/产物/技能与MCP）
- **版本治理**：conventional-changelog + bumpp + electron-updater（GitHub Releases）

### 安装

- Windows：GitHub Releases（NSIS Setup / portable）

### 开发

```bash
cd apps/desktop
pnpm install
pnpm run build:main   # TypeScript 编译
pnpm run dist         # 构建 + electron-builder --publish never
```

### E2E 测试

```bash
cd apps/desktop
node e2e-fix-verify.cjs   # Playwright 验证（29 项）
```

### 架构

```
apps/desktop/
├── main.ts              # Electron 主进程（IPC handlers、模型管线、工具执行）
├── renderer/
│   ├── index.html       # 入口 HTML
│   ├── app.js           # 渲染层（~2100 行单文件，事件委托驱动）
│   └── vendor/
│       └── marked.min.js  # Markdown 渲染
├── build/
│   └── icon.png         # 应用图标
├── package.json
└── tsconfig.json
```

### 技术栈

- **框架**：Electron 36
- **语言**：TypeScript 5.6（主进程），JavaScript（渲染层）
- **构建**：electron-builder 26（NSIS + portable）
- **测试**：Playwright 1.62
- **模型**：Ollama（本地） / OpenAI 兼容（远程 API）
