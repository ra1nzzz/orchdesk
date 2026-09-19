# OrchDesk

本地优先的多 Agent 编排桌面工作台（Electron + Node.js）。

当前版本：v0.16.0

权威版本以 [`apps/desktop/package.json`](apps/desktop/package.json) 为准。

## 定位

OrchDesk 把多 Agent 编排放进本地桌面：会话是一等公民，模型循环调用工具，插件 / 技能 / MCP 作为能力装入同一运行时。数据优先落在本机，不把云端当作默认后端。

## 开发

仓库使用 pnpm workspace，桌面应用在 `apps/desktop`。

```bash
pnpm install
pnpm --filter @orchdesk/desktop run start
pnpm --filter @orchdesk/desktop run build:main
pnpm --filter @orchdesk/desktop run verify
```

| 命令 | 作用 |
|------|------|
| `start` | 编译主进程并启动 Electron |
| `build:main` | 仅 `tsc` 编译主进程 |
| `verify` | 桌面 verify 链（含 e2e / event-emit 等套件） |

## 文档

知识库入口：[docs/README.md](docs/README.md)

项目接续入口：[docs/00-项目/CHECKPOINT.md](docs/00-项目/CHECKPOINT.md)

## 安装

Windows 安装包与 portable 见 [GitHub Releases](https://github.com/ra1nzzz/orchdesk/releases)。

## 技术栈

- **壳**：Electron 36
- **语言**：TypeScript（主进程），JavaScript（渲染层）
- **包管理**：pnpm workspace
- **打包**：electron-builder（NSIS + portable）
