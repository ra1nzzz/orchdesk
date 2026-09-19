# CHECKPOINT

> 项目状态快照 + 版本治理 + 关键决策 + 下一步。
> 本文件是「项目进行到哪了」的唯一入口，阅读本文件即可接续工作。
> v0.4.1–v0.15 的超长版本日记已迁至 [CHECKPOINT-version-diary-0.4-0.15](../99-归档/CHECKPOINT-version-diary-0.4-0.15.md)。

---

## 1. 项目状态

| 维度 | 状态 | 说明 |
|------|------|------|
| **当前版本** | `0.16.0`（tag `v0.16.0`） | SemVer，权威版本见 `apps/desktop/package.json` |
| **最新 Commit** | `4aa7553` | docs(发布): 补充 v0.16.0 发布记录 |
| **主线分支** | `main` | protected，push 需 CI 通过 |
| **远端仓库** | `ra1nzzz/orchdesk` | GitHub，public |
| **最新 Release** | [v0.16.0](https://github.com/ra1nzzz/orchdesk/releases/tag/v0.16.0) | 发布记录见 [release.md](../50-发布/release.md) |
| **文档审计** | 以知识库审计为准 | canonical 文档与代码保持一致 |
| **TypeScript** | tsc EXIT=0 | 全栈编译无错误 |
| **验证套件** | 以 `apps/desktop` 的 verify 链为准 | 28 套件（含 e2e / event-emit）；计数以实际跑链为准，此处不假装刚跑过 |
| **真机冒烟** | 待人工执行 | GUI 实机仍受环境门控；清单见 [smoke-checklist](../40-质量/smoke-checklist.md) |

### 1.1 PRD 完成度

代码侧 P0–P6 主体已接线（死挂点清零与各版交付见 [版本日记](../99-归档/CHECKPOINT-version-diary-0.4-0.15.md)）；v0.12 时点加权完成度估约 98%。剩余主要是用户环境运行期验证（GUI 实机冒烟 / 真实模型闭环）、FR-7 Hub 联调（PRD 明示首发不含）与 P7 完整事件化。判定口径仍同 [差距盘点](../99-归档/PRD差距盘点-2026-08-29.md)：「已接线」= 有真实数据流。补齐复盘见 [PRD差距补齐-2026-08-29](../99-归档/PRD差距补齐-2026-08-29.md)。

## 下一步

- GUI / PTY / CDP 实机冒烟仍待正常 Windows 桌面按 [smoke-checklist](../40-质量/smoke-checklist.md) 回勾。
- 工程债（已开工、未收口）：`runAgentTurn` 已抽到 `agent-turn.ts`；`executeTool` 已抽到 `tool-exec.ts`；浏览器 / 终端 / 文件面板 / 连接器 / MCP / 本地插件市场 IPC 已抽到 `ipc-browser.ts` / `ipc-terminal.ts` / `ipc-file-panel.ts` / `ipc-connectors.ts` / `ipc-mcp.ts` / `ipc-market.ts`（须在 `ipcMain.handle` sender 门 patch 之后注册）。`main.ts` 仍含会话 / 模型 / 授权 / 沙箱 / 记忆等其余 IPC。O2 双 runtime 与 SessionStore **不要**在本轮做。回合 abort 已接线。chat/ollama **请求 `stream:true`**：SSE/NDJSON 增量 `onDelta`；JSON 网关整包兜底；网关 400/415/422 拒流时同轮改 `stream:false`（含 tool 的 400 仍走工具降级）。`responses`/`completions` 仍非流式。
- 版本治理细节见 [VERSION-GOVERNANCE](./VERSION-GOVERNANCE.md)；打包与 Release 踩坑见 [release.md](../50-发布/release.md)。
- 当前产品状态 canonical 页：[current-state.md](./current-state.md)。

## 关键决策

| 决策 | 方案 | 理由 |
|------|------|------|
| 版本治理 | SemVer + Conventional Commits + bumpp | 行业标准，GitHub 生态原生支持 |
| 自动更新 | electron-updater + GitHub Releases | 零成本，无需自建服务器 |
| CI/CD | GitHub Actions | 仓库原生，无需第三方 |
| 脚本约束 | 唯一版本修改入口 | 避免手动编辑导致版本漂移 |
| 更新前快照 | snapshotData → snapshots/ | 更新失败可回滚 |

完整 ADR 见 [docs/70-决策/](../70-决策/)。

*上游文档：[current-state.md](./current-state.md) | [VERSION-GOVERNANCE.md](./VERSION-GOVERNANCE.md) | [PRD差距补齐复盘](../99-归档/PRD差距补齐-2026-08-29.md) | 变更日志 `apps/desktop/CHANGELOG.md`*
