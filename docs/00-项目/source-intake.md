---
id: orch-int-001
title: OrchDesk 来源并入记录
status: canonical
updated: 2026-08-17
---

# 来源并入记录（Source Intake）

> 记录每份进入 OrchDesk 知识体系的来源快照与处置（disposition）。
> 规则：外部仓库一律保持原位（镜像/快照），不整体回拷；只把**裁决后的结论**写入 canonical 文档。
> 本机绝对路径按治理规则不写入共享库；前身仓库的物理位置记录于工作区记忆（`.workbuddy/memory/`）。

## 快照清单

### S1. deepseek-harness（底座）

```yaml
type: source-intake
source_repository: deepseek-ai/deepseek-harness
source_ref: master
source_commit: 99f6f02fecdb
captured_at: 2026-08-17
local_mirror: references/deepseek-harness
disposition: canonical-base   # 作为运行时底座（非文档 canonical，文档结论以裁决为准）
```

要点：Cordis 一切皆插件；append-only SessionEvent 日志 + `ctx.sessions.fork`；Profiles+Bundles+`cordis.patch.yml`；`agent/pre-step` 必经拦截点；`approval` seam fail-closed；`landlock-run` 仅 Linux 5.13+；`apps/` 仅 cli+web。

### S2. orchclaw（业务能力参考）

```yaml
type: source-intake
source_repository: ra1nzzz/orchclaw
source_ref: main
source_commit: d1a041e35dff
captured_at: 2026-08-17
local_mirror: references/orchclaw
disposition: reference   # 会话/任务/工作流/记忆等业务能力移植参考，不作底座
```

### S3. Cordis 论文（理论地基）

```yaml
type: source-intake
source_repository: cordiverse/paper
source_ref: master
source_commit: 948a07b369c6
captured_at: 2026-08-17
local_mirror: references/paper   # 含 paper.pdf、paper.txt、README_精读.md
disposition: reference   # 理论来源；draft 2026-08-13 仍为活跃 preprint
```

要点：可逆效应（时间可组合性）、响应式共效应（空间可组合性）、统一 Context Γ∞、系统边界（§6.1 边界外 emission 不可逆，仅 withhold/compensation）、沙箱须外部机制（§6.3）、结论点名「自进化 Agent harness」为最重要验证方向。

### S4. Fast Note Sync 笔记（7 条，公开分享）

```yaml
type: source-intake
source_repository: sync.ytaiv.com 公开分享链接（无 git）
captured_at: 2026-08-17
local_mirror: references/ytaiv-notes   # <id>.md + raw/<id>.json + INDEX.md
disposition: reference
```

| ID | 标题 | 用途 |
|---|---|---|
| 383 | DeepSeek Harness 精读整理 | dsh 机制解读，含「对 OrchClaw Hub 的启发」 |
| 117 | DREAM 机制 →「上游意图 Agent」架构映射 | 意图网关设计来源 |
| 125 | DREAM 精读稿 | F1-F4 Funnel、M1-M3、4-gate、default fallback |
| 124 | Prompt Funnel / 语用学 / Agent 调研报告 | 背景调研 |
| 126 | ACL 2026 语用学 + Agent 论文跟进 | 背景调研 |
| 121 / 118 | 抖音视频精读稿 / 转写笔记 | 方法论参考 |

### S5. 三方交叉对照（本项目生成物）

```yaml
type: source-intake
source: references/cross-reference-OrchDesk.md
captured_at: 2026-08-17
disposition: absorbed   # 结论已并入 docs/70-决策 与 docs/10-架构；原文件留作证据
```

### S6. 前身项目 OrchStar（历史来源）

```yaml
type: source-intake
source_repository: local/orchstar   # 本机前身仓库；物理路径见工作区记忆，不入共享库
source_ref: master
source_commit: 1756e3a4747210d2ffe1ccac65ff83b4b2b789a8
source_tree: fcef20654f019ae32737fe97cb30c12c882e37d4
captured_at: 2026-08-17
disposition: archived   # 历史来源：需求基线继承，代码不回迁；文档保留原位并回链（见 99-归档）
```

脏工作树说明：OrchStar 工作树含未提交制品（`fix_*.py` 构建修复脚本、smoke 测试截图 6 张、`release/`、`_testdata/`、整合版 PDF）。**这些未提交文件不纳入 OrchDesk**；若日后清理 OrchStar 工作树，未提交制品删除后**无法从 Git 恢复**，须先另行备份。

### S7. 工作区记忆日志

```yaml
type: source-intake
source: .workbuddy/memory/2026-08-17.md
disposition: absorbed   # 事实性结论已并入本知识库；日志继续作为过程记录
```

## 处置原则回放

- **canonical-base**（S1）：代码底座，但文档结论以 [70-决策](../70-决策/) 裁决为准。
- **reference**（S2/S3/S4）：引用不回拷，链接到 `references/` 原位。
- **absorbed**（S5/S7）：结论已进 canonical 文档，原件留证。
- **archived**（S6）：历史来源，见 [99-归档/index.md](../99-归档/index.md)。
