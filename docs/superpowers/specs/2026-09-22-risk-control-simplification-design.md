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
- **mode id 持久化（实施中发现并解决）**：历史实现只存 `(sandboxMode, approvalPolicy)`，而 default 与 trusted 在这两个值上同参——反推法永远分不出两者，“信任模式”实际是空操作且重启后回 default。现改为在 sandbox 磁盘态（`host-services.ts` 的 `SandboxState`）新增 `authMode` 字段，`sandboxPolicy` 服务暴露 `getAuthMode/setAuthMode`；authz 的 `getMode` 优先读存储 id，老宿主无该方法时回落反推法（兼容 verify 桩）
- 网络种子：`effectiveNetworkAllow(state)` = 用户自填 ∪（trusted 时的 `TRUSTED_NETWORK_SEED` 10 域名）；`getNetworkAllow`/`isDomainAllowed` 都走生效口径（UI 与执行层同一视图），存储态永远是用户自填；SSRF 防护独立生效不受种子影响
- 模式切换走既有 `sandbox/mode` + `approval/policy` 事件持久化通道；设置页授权模式卡片文案同步三档风控语义（当前 blurb 只描述 sandbox，需补意图门/白名单维度）

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

- **新建 `scripts/intent-gate-verify.cjs` 覆盖决策矩阵**（当前 intent 零门测试；真实 Cordis waterfall + 真实插件，接 verify 链）：
  - g3 失败（"用 pnpm 安装这个 skill"）→ CONFIRM 放行（A1 核心回归）
  - g4 失败（外发主机不在 allowlist）→ CONFIRM 放行
  - destructive（"把所有日志文件全部删除"）→ BLOCK；destructive 且门失败 → 仍 BLOCK（顺序防线）
  - 低风险 query → enter；无本地模型 → defaultFallback=CONFIRM 放行
  - C1 档位：trusted → destructive 纯审计放行；paranoid → 无模型回退 BLOCK；档位不可知 → default 形态
  - 审计出口（修复 1）：root ctx 注册捕获型 exporter，断言 BLOCK 决策行（error 级）+ 结构化审计行到达 sink
- **`agent-loop-verify.cjs` C0 段：意图门端到端**（修复 2；真实 IPC handler + 真实 9 插件 runtime，模型走 fetch 桩——UI e2e 的桥桩在渲染层即返回，到不了主进程，门在 UI 层零覆盖）：
  - "用 pnpm 安装这个 skill" → 模型被调用 1 次且拿到回复
  - "把所有日志文件全部删除" → 模型零调用 + 回复含「意图网关拦截」
  - 前置就绪等待（`getRuntime()` 非空；runtime 未就绪时 firePreStep 返回 null = 门静默放行）
- **`verify-plugins.mjs` intent 段同步**：新增"命令词 prompt 放行"用例；原"外发意图被拦截"用例保留但更正注释——该 reject 实际来自补偿层 headless fail-closed（无 GUI 应答方），非意图门
- **`dsh-runtime-verify.cjs`**：authMode 可分辨 + trusted 种子合并/default 不合并

## 7.1 审计出口（修复 1：从「不可见」到落文件日志）

此前后续核查更正一个误判：审计路径**不是死代码**——探针证实 `ctx.logger?.info?.()` 在插件 fiber 上有效、消息进入 logger buffer；真正缺口是 **Cordis 没有注册 exporter**，消息只进缓冲、任何地方不可见（应用日志亦无）。另发现 Cordis 默认级别会**过滤 warn/debug**（enum WARN=2 > INFO=1，只有 info/error 可见）。修复：

- intent 审计改命名 logger `ctx.logger('orchdesk-intent')`，BLOCK 决策行走 **error** 级（安全事件语义 + 保证可见）
- `dsh-runtime.ts` `buildRuntime` 注册 exporter，把插件日志转发到应用文件日志（`startRuntime({ log })`，main.ts 传入）；verify 桩可不传
- `intent-gate-verify.cjs` 以捕获型 exporter 直接验证该链路

## 7.2 实施中顺带修复的三个问题

1. **`firePreStep` 不下穿 abort signal**（预存潜在 bug）：意图门本地模型探测等 pre-step 长耗时 fetch 不可被 abort——端点挂起会楔死整个回合（abort 也救不回）。现 `firePreStep` 接受并下穿 `signal`（补偿层的审批请求也因此可中止）
2. **agent-loop-verify 的 fetch 桩污染**：意图门探测请求被模型网关桩记录并消费 scenario 应答，runtime 就绪时序不定必炸——桩现对 `/api/generate` 探测请求不记录、不消费场景
3. **memo 测试意外通过**：原计数式桩让 attempts 第二档（tools 无 tool_choice）成功——提供方支持 tools 只是不支持 tool_choice，**不写 memo 是正确行为**，旧测试实际断言在探测请求上（碰巧无 tools）。桩改 body 感知（任何带 tools 的请求都拒），memo 测试第一次真正验证 intended 行为

## 8. 风险与回滚

- 风险：prompt 级防御减少后，危险 prompt 依赖执行层兜底——L3/L4 弹窗与补偿层是既有成熟路径，且 destructive BLOCK 保留，风险受控
- 可观测性不降级：全部决策仍入审计
- 回滚：改动集中在 `deriveDecision` 一个分支 + 模式档位推导，git 单提交可回退

## 9. 实施顺序（供 writing-plans 细化）

1. 方案 A：`deriveDecision` 门失败降级 + 注释/文档同步 + intent 决策矩阵测试
2. e2e 误伤回归组
3. 方案 C：模式档位贯通（authz mode 事件 → intent enforcement）+ 预置域名常量 + 设置页文案 + 档位测试
