---
id: orch-rmp-001
title: OrchDesk 路线图
status: canonical
updated: 2026-09-02
---

# OrchDesk 路线图

> 未来工作（P6 之后）。近期分期见 [PLAN](../30-开发/PLAN.md)。继承前身 OrchStar Phase 3 的设想并扩展。

## 近期（当前）

按 [PLAN](../30-开发/PLAN.md) 推进 P0–P6：底座 → 桌面壳 → 核心域 → 安全 → 智能 → 编排 → 生态打磨。

**Minke 对照增强（2026-08-31 ~ 09-02 已交付）**：工程基建（ADR-0010）→ 浏览器工具（ADR-0011）→ 终端 PTY + 文件面板（ADR-0012）→ 文件编辑/diff（ADR-0013），verify 24 套件 814 项全绿（计数以 [CHECKPOINT](../00-项目/CHECKPOINT.md)「验证套件」行为准）。剩余收口：v0.13.0 发版（changelog → tag → dist 链）与真机 GUI 冒烟（终端/文件面板实机点击，须用户桌面会话）。

**Electron 运行时升级（2026-09-20 评估，暂缓执行）**：当前锁定 electron 36.9.5，最新 stable 44.4.3（差 8 个 major，已出 Electron 支持窗口）。评估结论——**不在本 agent 环境盲升**：Chromium 大版本跳跃改变 CSP/contextIsolation/permission 行为与 node-pty native ABI，唯一可信的验证是正常 Windows 桌面实机冒烟，而本环境受 BUG-W02 门控无法启动 Electron GUI；把未经冒烟的新运行时发给用户违反「不伪造验证」纪律。升级 is 一个门控任务：① 用户桌面可用时先把冒烟清单（浏览器工具/终端 PTY/模型调用/授权弹窗/自动更新）跑绿并归档；② 升 major（建议 36→38→44 两步走，每步 rebuild + node-pty ABI 重编）；③ electron-builder 同步升（26.15.3 对 44 的支持矩阵需实测，27.0.0-alpha 不用于生产）；④ 全链 verify + 打包 smoke（见 [build.md 4b](../30-开发/build.md) 的 pnpm 收集器注意事项）。
## 中期（P6 之后）

| 方向 | 说明 | 来源 |
|---|---|---|
| 技能市场生态 | 接入观雅集：浏览/安装/发布技能；灵璧付费技能支持 | 观雅集 API（`guanji` SKILL 约定） |
| macOS 沙箱 backend | sandbox-exec / 独立 helper，补 GAP-02 | [ADR-0005](../70-决策/ADR-0005-sandbox-backends.md) |
| 文件面板编辑器升级 | CodeMirror merge 双栏 diff、大文件流式加载、目录书签 | [ADR-0013](../70-决策/ADR-0013-file-edit-diff.md) 后置项 |
| 向量召回升级 | 本地 embedding 模型替代 TF-IDF | 继承 OrchStar Phase 3 |
| Dreaming 离线评估 | 用历史 SessionEvent 日志离线回放评估意图拦截策略 | 笔记 125 DREAM |
| 可视化工作流编排 | 拖拽式 Agent 协作链（编排层的图形化） | 继承 OrchStar Phase 3 |
| 会话导出/导入/分享 | 含分叉树的会话包 | 继承 OrchStar Phase 3 |

## 远期（探索）

| 方向 | 说明 | 开放问题 |
|---|---|---|
| 自进化深化 | Agent 运行时自建/优化插件，人监督极少 | 自生成插件的更强静态分析（论文遗留） |
| 补偿层形式化 | 边界外补偿的元定理与等价关系 | 论文 §6.1 开放问题，跟踪 cordiverse/paper |
| 多 dsh 实例负载均衡 | 多 runtime 编排 | 继承 OrchStar Phase 3 |
| 跨设备同步 | 本地优先前提下的可选端到端加密同步 | 与「本地优先」哲学的边界 |

## 不进入路线图（非目标重申）

云端集群 / 多人协作服务端 / 模型训练 / 移动端（见 [PRD §7](../20-需求/PRD.md)）。
