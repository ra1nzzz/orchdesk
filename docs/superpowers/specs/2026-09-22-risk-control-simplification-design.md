# 风控简化方案设计：意图门误伤修复（A）+ 三模式档位演进（C）

- 日期：2026-09-22
- 状态：已批准，待实施
- 决策路径：D（先修误伤，档位化作为演进）→ A1（门失败降级 CONFIRM 而非放开 allowlist）→ C1（信任模式 = 意图门纯审计 + 网络白名单预置 + 补偿层保留）

## 1. 背景与问题

当前风控是四层叠加：**意图门**（prompt 级关键词漏斗 + 4-gate）→ **L0-L4 授权**（工具执行级弹窗）→ **补偿层**（外发/不可逆二次确认）→ **沙箱**（Windows ACL + 网络域名白名单，空 = 全拒）。每层单独看都合理，叠加后日常操作摩擦过大。

实测的误伤链路（用户报告"安装 SKILL 的提示词都被拦截"）：

1. 用户 prompt 含 `pnpm` / `npm` / `git` / `执行` / `运行` 等词
2. intent 插件 F2 规则将 stage 判为 `exec-command`
3. g3 stage allowlist 默认为 `['read', 'query', 'write-file']`，`exec-command` 不在内
4. 4-gate 为 fail-closed：g3 失败 → **BLOCK**
5. `agent-turn.ts` 收到 `{kind:'reject'}`，回合当场杀死，回复"（意图网关拦截）该请求被判定为高风险操作"

根因：prompt 级的关键词漏斗无法区分"提到命令"与"真要执行"，而 BLOCK 是硬拒绝。注意 CONFIRM 分支在现有实现中已是纯放行软信号（`index.ts:415` 注释明确"真实交互确认在下游 approval seam"），唯一有害路径就是 BLOCK。

## 2. 目标 / 非目标

目标：

- 消除 prompt 级误伤：提到命令词、域名、密钥词不再杀死回合
- 保留唯一 prompt 级硬拦截：漏斗判定"不可逆 + 系统/外部爆炸半径"的真危险模式
- 执行层三道强制点（L3/L4 弹窗、补偿层、沙箱 ACL）原样保留
- 三模式（默认安全 / 信任 / 偏执）成为风控总开关，friction 可按场景自选
- 补上 intent 门决策矩阵的测试覆盖（当前为零）

非目标（YAGNI）：

- 不改 L0-L4 分级定义、补偿层 withhold 逻辑、沙箱 ACL
- 不做 per-session 风控细粒度
- 不升级意图门本地模型编译（M1-M3 保留现状）
- 不做网络白名单"一键全放行"

## 3. 设计原则

**提到 ≠ 要做；要做的事在执行层拦。** prompt 层降级为"分级标记 + 审计"，执行层是唯一强制点。

## 4. 方案 A：意图门误伤修复（本次实现）

### 4.1 改动点（单处）

`packages/plugin/intent/src/index.ts` 的 `deriveDecision`：

| 情形 | 现在 | 改后 |
|---|---|---|
| 任一硬门失败（g1/g2/g3/g4） | BLOCK | **CONFIRM**（放行 + 审计标记） |
| `funnel.score ≥ riskThreshold` 且 destructive（不可逆 + system/external 半径） | BLOCK | **BLOCK（保留，唯一硬拦截）** |
| `funnel.score ≥ riskThreshold` 非 destructive | CONFIRM | CONFIRM（不变） |
| 无本地模型 → `defaultFallback` | CONFIRM | CONFIRM（不变） |
| 干净通过 | ACT | ACT（不变） |

### 4.2 语义与配置

- `allowedStages` / `externalAllowlist` / `riskThreshold` 配置项全部保留；`allowedStages` 语义从"白名单外枪毙"变为"白名单外需确认"（文档注释同步更新）
- 审计输出不变：BLOCK/CONFIRM/ACT 全量记录（决策、原因、门详情、funnel），设置页审计可查——降级不降低可观测性
- `agent-turn.ts` 的 reject 消费路径不变；只有真危险模式才会走到

### 4.3 为什么只改这一处

CONFIRM 已是纯放行（不篡改 prompt、不弹窗、不阻断），BLOCK 是唯一杀死回合的路径。改 `deriveDecision` 一个分支即消除全部 prompt 级误伤，其余三层零改动。

## 5. 方案 C：三模式档位演进（spec 目标态，实现可分两期）

扩展现有三模式（`packages/plugin/authz/src/index.ts` 的 `AUTHZ_MODES` 已有 default/trusted/paranoid 雏形，当前仅映射 sandbox mode + approval policy）：

| 模式 | 意图门 | 网络白名单 | 补偿层 | defaultFallback |
|---|---|---|---|---|
| 默认安全 | 方案 A 修好后的形态 | 用户自管（空 = 全拒，不变） | 开 | CONFIRM |
| 信任 | 纯审计（pre-step 永不 reject，destructive BLOCK 也退化为审计记录） | 预置开发常用域名（见 5.2），用户可增删 | 开 | CONFIRM |
| 偏执 | 现状 + BLOCK 全保留 | 用户自管 | 开 | BLOCK |

### 5.1 实现要点

- 意图门档位：不新增独立配置项。intent 插件订阅 authz 的 mode 事件（与 `setMode` 同一真源）推导档位——默认安全/偏执 = enforce，信任 = audit-only（pre-step 只跑漏斗 + 审计，永不返回 reject）；偏执模式额外将 `defaultFallback` 置为 `'BLOCK'`
- 模式切换走既有 `sandbox/mode` + `approval/policy` 事件持久化通道（authz 插件 `setMode` 已实现持久化与审计），intent 插件订阅同一 mode 事件对齐档位——单一 mode 真源，不引入第二套开关
- 设置页授权模式卡片文案同步三档风控语义（当前 blurb 只描述 sandbox，需补意图门/白名单维度）

### 5.2 预置开发常用域名（信任模式白名单种子）

常量清单（可在设置页网络白名单 textarea 中增删，合并语义 = 预置 ∪ 用户自填）：

- `github.com`、`raw.githubusercontent.com`、`registry.npmjs.org`、`pypi.org`、`files.pythonhosted.org`、`models.dev`、`api.deepseek.com`、`api.moonshot.cn`、`open.bigmodel.cn`、`dashscope.aliyuncs.com`

不做"一键全放行"；清单本身走配置常量，不放飞。

## 6. 数据流（改后）

```
用户 prompt
  → agent/pre-step waterfall
    → intent 门：F1–F4 漏斗 + 4-gate → ACT / CONFIRM（放行+审计）/ BLOCK（仅 destructive）
  → 模型回合
    → 工具调用
      → authz L3/L4：弹窗确认 / 白名单命中放行（不变）
      → 补偿层 withhold：外发/不可逆二次确认（不变）
      → 沙箱：Windows ACL + 网络白名单执行（不变）
```

## 7. 测试策略

- **新增 `intent-gate-verify.cjs`（或并入 verify-plugins）覆盖决策矩阵**（当前 intent 零门测试）：
  - g3 失败（exec-command 不在 allowlist）→ CONFIRM 且放行（不再 reject）
  - g4 失败（network-send 主机不在 externalAllowlist / 系统路径）→ CONFIRM
  - destructive（删除所有文件类，score ≥ 0.7 + 不可逆 + system 半径）→ BLOCK
  - 低分 query → ACT；无本地模型 → defaultFallback=CONFIRM
  - 审计记录每种决策
- 信任模式：pre-step 对 destructive 输入也只审计不 reject
- e2e 增组：默认模式下"用 pnpm 安装这个 skill"类 prompt 不再被拦截，回合正常到达模型桩并返回
- 既有断言不受影响（verify-plugins 的 intent 段无 BLOCK 断言；agent-loop-verify 的 intent 字段为桩返回值）

## 8. 风险与回滚

- 风险：prompt 级防御减少后，危险 prompt 依赖执行层兜底——L3/L4 弹窗与补偿层是既有成熟路径，且 destructive BLOCK 保留，风险受控
- 可观测性不降级：全部决策仍入审计
- 回滚：改动集中在 `deriveDecision` 一个分支 + 模式档位推导，git 单提交可回退

## 9. 实施顺序（供 writing-plans 细化）

1. 方案 A：`deriveDecision` 门失败降级 + 注释/文档同步 + intent 决策矩阵测试
2. e2e 误伤回归组
3. 方案 C：模式档位贯通（authz mode 事件 → intent enforcement）+ 预置域名常量 + 设置页文案 + 档位测试
