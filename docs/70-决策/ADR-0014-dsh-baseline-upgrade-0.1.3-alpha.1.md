---
id: orch-adr-014
title: ADR-0014 dsh 底座基线升级 99f6f02 → dsh-v0.1.3-alpha.1
status: accepted
date: 2026-09-24
---

# ADR-0014：dsh 底座基线升级 99f6f02 → dsh-v0.1.3-alpha.1

## 背景

ADR-0001 把 deepseek-harness 锁在 `99f6f02fec`（2026-08-17），`dsh.lock` 与
`cordis.patch.yml` 头部均记录该基线。但仓库实际状态早已偏离：

- 本地 `references/deepseek-harness` 位于 `d347e70390`，即 tag `dsh-v0.1.3-alpha.1`
  的 tip，比锁定基线**新 2806 个 commit**；且它正是某个 tag 的 tip（一次有意的
  checkout，不是随手 `git pull` 的产物）。
- 根 `pnpm-lock.yaml` 与该新基线**同步**（`pnpm install --frozen-lockfile` 通过），
  `pnpm-workspace.yaml` 的 `allowBuilds` 也已按新底座的依赖补全
  （node-pty / koffi / fs-ext / protobufjs / @google/genai）。
- 全部本地验证（全链 `pnpm run verify` CHAIN_EXIT=0、tsc EXIT=0、e2e 320/320）
  都跑在这个新底座上。

与此同时 `dsh.lock` 仍是旧值，直接后果是 **CI 自 2026-09-19 起连续 11 次全红**，
且红的点一直在最早期的「Fetch dsh base」步骤——验证链从未在 CI 上真正跑过。

另有第二个独立阻塞：GitHub 不允许 want 一个不是 ref tip 的 SHA
（`uploadpack.allowAnySHA1InWant` 未开），所以 `git fetch --depth 1 origin <SHA>`
恒报 `couldn't find remote ref`。这解释了为什么同一条命令在本地（clone 已存在）
能用、在 CI 上必失败。

## 决策

**基线升级到 `dsh-v0.1.3-alpha.1`（`d347e70390`），并让 CI 按 tag 取、取完校验。**

1. `dsh.lock` 更新为该 commit 的全量 SHA。
2. `ci.yml` / `release.yml` 的取底座步骤改为
   `git fetch --depth 1 origin refs/tags/dsh-v0.1.3-alpha.1`，取完做前缀校验
   （`dsh.lock` 存短 SHA、`rev-parse` 给全量）。上游若移动 tag 或 lock 变更，
   CI 立刻失败并说清原因，而不是静默构建另一套基线。
3. `cordis.patch.yml` 头部注释的基线 commit 同步更新。
4. `pnpm-lock.yaml` 无需变更——它本就与新基线同步（这正是旧 lock 与旧 dsh.lock
   打架的证据）。

不改动 `references/deepseek-harness` 的任何源码（ADR-0001 规则 1）；补丁层仍是
空 patch（`insert: []`），本次只动基线元数据。

## 后果

**正面**
- CI 的两个独立阻塞（按 SHA fetch 被拒 / lock 与基线不符）都消除，验证链第一次
  有机会在 CI 上真实运行。
- 元数据与事实一致：`dsh.lock`、`cordis.patch.yml`、CI 流程、pnpm lock 四者对齐。

**负面 / 风险**
- 底座一次前进 2806 个 commit（dsh 0.1.0-rc.7 → 0.1.3-alpha.1）。本地全链与
  e2e 320/320 是在这个底座上通过的，但**CI 上的验证链尚未跑完过一次**——修好
  取底座后应盯完第一次完整 CI，把它当作这次升级的回归证据。
- 若上游将来移动 `dsh-v0.1.3-alpha.1` 这个 tag，CI 会因校验失败而红——这是有意
  为之（宁红不静默漂移），届时按流程再升一次基线。

## 备选方案

- **回退本地 clone 到 99f6f02**：能让元数据自洽，但要把已验证的环境降级 2806 个
  commit，且 `pnpm-lock.yaml` / `allowBuilds` 都得跟着回退——等于把「能跑的那个
  版本」换成一个从未被验证过的旧版本。否绝。
- **保留按 SHA fetch，只更新 dsh.lock**：不解决 GitHub 拒收非 ref-tip SHA 的
  问题，CI 仍会红在同一行。否绝。
