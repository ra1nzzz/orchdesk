---
id: orch-rmp-001
title: OrchDesk 路线图
status: canonical
updated: 2026-08-17
---

# OrchDesk 路线图

> 未来工作（P6 之后）。近期分期见 [PLAN](../30-开发/PLAN.md)。继承前身 OrchStar Phase 3 的设想并扩展。

## 近期（当前）

按 [PLAN](../30-开发/PLAN.md) 推进 P0–P6：底座 → 桌面壳 → 核心域 → 安全 → 智能 → 编排 → 生态打磨。

## 中期（P6 之后）

| 方向 | 说明 | 来源 |
|---|---|---|
| 技能市场生态 | 接入观雅集：浏览/安装/发布技能；灵璧付费技能支持 | 观雅集 API（`guanji` SKILL 约定） |
| macOS 沙箱 backend | sandbox-exec / 独立 helper，补 GAP-02 | [ADR-0005](../70-决策/ADR-0005-sandbox-backends.md) |
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
