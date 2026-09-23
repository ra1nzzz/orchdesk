# AGENTS.md — OrchDesk

## 工程方法约定（2026-09-23 起）

后续所有方案制定与代码 Review 按以下两个已全局安装的 SKILL 执行：

- **方案/计划 → `yt-aose-agent-self-orchestration-engine`**（YT-AOSE）：
  - 任务开始先输出 Orchestration Decision（Complexity / Risk / Spec Level / Required Artifacts / Parallelizable / Integration Risks / Review Strategy / Convergence Policy）
  - 渐进式规格（L0-L4 按复杂度启用 PRD/SPEC/ADR/PLAN/CHECKPOINT），禁止小需求全套件
  - 并行以契约稳定、低耦合为前提；模块完成须经对抗性 Review 再集成；集成门禁 + CHECKPOINT
- **REVIEW → `yt-dev-review`**（YT-Review 2.0 三维九域 + 收敛验收）：
  - 三维并行评审（质量/效率/可复用性）+ 六大盲区扫描（幂等/安全/可观测/数据完整/并发/依赖韧性）
  - Evidence-Gated 评分；Best Practice ≠ Requirement（区分 Required Gap / Recommended / Future / N/A）
  - P0→P1→P2 分级修复，修复后验证闭环；max_review_rounds=3，边际收益下降即收敛
  - 终态五选一：PASS / FIX / ACCEPT AS-IS / ROLLBACK TO BEST / ESCALATE HUMAN

两个 SKILL 位于用户级 `~/.agents/skills/`，项目级不重复安装。

## 项目铁律（既有）

- UI 不许撒谎：「未接入 ≠ 为空 ≠ 失败」三态区分，不伪造、不静默
- fail-closed：审批/白名单/意图门的不可用状态一律按拒绝处理
- 本地优先：数据不出本机（插件日志经 exporter 落应用日志文件）
