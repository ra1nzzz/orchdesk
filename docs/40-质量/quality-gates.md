---
id: orch-qag-001
title: OrchDesk 质量门禁与不变量
status: canonical
updated: 2026-09-02
---

# 质量门禁与不变量

> 本页是「质量门禁与不变量」的 canonical 责任方。执行流程见 [workflow](../30-开发/workflow.md)。

## 1. 运行时不变量（必须始终成立）

| 不变量 | 来源 | 验证 |
|---|---|---|
| **Model-visible means logged**：任何到达模型请求的内容必须能从 SessionEvent 日志重建 | dsh | 新增模型可见输入 = 扩展 `SessionEventMap` 并从日志渲染 |
| **可逆回滚**：插件卸载后无残留（effect 逆回滚） | Cordis | 热插拔用例：装→用→卸→断言环境复原 |
| **approval fail-closed**：审批缺失/异常一律不开门 | dsh | 异常应答注入测试归 `unavailable` |
| **Worker 即用即走**：Worker dispose 后上下文/记忆不泄漏上层 | [ADR-0004](../70-决策/ADR-0004-brain-hands-hierarchy.md) | 隔离测试：dispose 后检索不到 worker 域内容 |
| **沙箱外部机制**：不接受纯语言级拦截；OS 不能强制则不执行（fail-closed） | [ADR-0005](../70-决策/ADR-0005-sandbox-backends.md) | 平台 backend 强制测试 |
| **边界外 emission 有确认或补偿**：发消息/网络/写共享文件 100% 经 CONFIRM 或补偿记录 | FR-12 | 审计日志覆盖率检查 |

## 2. 提交门禁（每次提交前）

```bash
# 代码（随 Phase 建立）
npm run typecheck && npm run test && npm run lint

# 知识库（本 docs/）
python scripts/audit_knowledge_base.py docs
git diff --check
```

（`audit_knowledge_base.py` 来自 `consolidate-project-knowledge-base` SKILL，检查断链/绝对路径链接/越界链接/重复 ID。）

## 3. Phase 退出门禁（防 OrchStar「后端先行、UI 荒废」重演）

- 每个 Phase 退出标准必须**端到端可用**：从 UI 触发到结果可见的完整链路通过。
- 禁止「后端先行、UI 后补」；禁止以「后端 API 就绪」代替「用户可用」作为完成判据。
- 退出标准未达不得进入下一 Phase（见 [PLAN](../30-开发/PLAN.md)）。

## 4. Electron 安全基线

- `contextIsolation: true`、`sandbox: true`、禁用 `remote`、启用 CSP。
- 渲染进程只经 `contextBridge` 拿显式暴露的能力子集。
- 不可信/自生成插件走独立沙箱进程 + 桥接（[架构 §7](../10-架构/architecture.md)）。

## 5. 凭据与数据安全

- API Key：AES-256-GCM 加密存储，密钥派生自机器指纹（继承 OrchStar 设计）。
- Token：SHA-256 哈希比较。
- 密钥/令牌/本机绝对路径**不得**进入 `docs/` 与日志。

## 6. 验证套件链（canonical 计数方：本节；最新批次快照见 CHECKPOINT）

`cd apps/desktop && npm run verify` 为单一全量入口（2026-09-02 起 **24 套件 805 项**，EXIT=0 才算通过）。各计数与套件清单随批次演进，**以 CHECKPOINT「验证套件」行为最新快照**，本节只登记结构性约定：

- **分层覆盖**：纯逻辑（importTs 直测源码）→ 宿主（require dist + stub 注入）→ 接线（stub electron 驱动 dist/main.js 真实 handler）。三层缺一即视为未验证。
- **架构守护**：`arch-guard-verify.cjs` 维护 PURE_MODULES 清单（零 electron 依赖模块），新增纯逻辑模块必须登记。
- **真机冒烟不进 verify 链**：`pnpm run smoke:browser`（CDP 真机 11 步）需真 GPU/渲染进程，非交互会话必假红，刻意隔离在链外；同理，任何需真实渲染进程的验收归入用户桌面会话执行（BUG-W02 门控口径）。
- **计数防漂移口径**：VERIFY 链新增/删除套件或用例数变化时，同批次必须同步更新 CHECKPOINT 状态表；批量断言失败先怀疑实现再怀疑断言（历史教训：两次「疑似断言太严」均为真 bug）。
