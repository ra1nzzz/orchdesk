---
name: orchdesk-cordis-plugin
description: This skill should be used when scaffolding, writing, or wiring a Cordis plugin for OrchDesk (the local-first multi-agent desktop workbench built on deepseek-harness / dsh). It covers the bundle/patch convention, the function-plugin shape (name/Config/apply), the effect/reversible-plugin lifecycle, the agent/pre-step intent hook, and how to register a plugin row in packages/bundle/desktop/cordis.patch.yml. Use it for any task touching packages/plugin/*, the dsh-desktop bundle patch, or the 5 built-in plugins (intent/trace/brain/multi/hub).
agent_created: true
---

# OrchDesk × Cordis 插件脚手架

为 OrchDesk 新建/修改一个 Cordis 插件时，遵循本 skill。底座是 vendored 的 `deepseek-harness`（Cordis 内核），位于 `references/deepseek-harness`。OrchDesk 的插件与 dsh 原生插件**同构**：都是独立 npm 包，由 bundle 的 `cordis.patch.yml` 声明式引用。

## 何时使用

- 在 `packages/plugin/*` 下新增或扩展一个 OrchDesk 内置插件。
- 修改 `packages/bundle/desktop/cordis.patch.yml`（增删插件 row、改 config）。
- 实现/调整 `agent/pre-step` 钩子（如意图识别网关）。
- 理解 Cordis 的 effect / 可逆插件生命周期、或 `ctx.on`/`ctx.plugin`/`ctx.effect` 用法。
- 任何与 5 内置插件（intent / trace / brain / multi / hub 延后）相关的工程。

## 关键约定（必读）

### 1. 目录结构

- **Bundle（声明层）**：`packages/bundle/desktop/` 持有 `cordis.patch.yml`（插件 row 清单）+ `package.json`（含 `dsh.bundle.patch`）+ `src/index.ts`（仅导出层元数据，不挂载插件）。
- **插件（实现层）**：`packages/plugin/<name>/` 是独立 npm 包，`src/index.ts` 导出 `name`/`Config`/`apply`。
- 插件 `name` **必须** == patch row 的 `name`（模块说明符）。本工程插件包命名 `@orchdesk/dsh-<name>`。
- 工作区 glob `packages/*/*` 已覆盖 `packages/plugin/<name>`，新插件自动纳入 workspace；bundle `package.json` 用 `workspace:*` 依赖它们。

### 2. 插件形态（函数插件）

```ts
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';

export const name = 'orchdesk-intent';

export interface Config { /* ... */ }
export const Config: z<Config> = z.object({ /* ...default(...) */ });

export function apply(ctx: Context, config: Config): void {
  ctx.on('agent/pre-step', async (payload, next) => { /* ... */ return next(); });
}
```

- `Config` 用 `@deepseek-ai/schemastery` 的 `z.object(...).default(...)` 做校验与默认值。
- 需要 dsh 服务时声明 `export const inject = ['agents']`（硬依赖，缺失则插件 PENDING）。

### 3. effect / 可逆插件生命周期（"启用=注册effect，停用=注册回滚"）

- `ctx.on(event, listener)`、`ctx.plugin(child)`、Service 注册**本身都是 effect**，所属 fiber 卸载时自动回滚（逆序执行 disposer）。
- 非 Cordis 托管资源（定时器/连接/监听器）用 `ctx.effect(() => { ...; return () => { 清理 } })` 包裹。
- 卸载 = `fiber.dispose()`；配置变更/HMR/父插件卸载都会递归卸载子插件。**不重启宿主**。

### 4. 意图网关挂点 `agent/pre-step`

- waterfall 事件，每个被提议的 step 在 `step/start` 与模型请求之前触发一次；返回 `PreStepDecision`：
  - `{ kind: 'reject' }` —— 拒绝该 step（关闭并持久化轮次，入日志）
  - `{ kind: 'enter', messages }` —— 放行，`messages` 可改写即改写进模型的 prompt
- 签名（事件声明在 `@deepseek-ai/dsh-agent`）：`(payload: { agent, messages: UserMessage[], turn, step, signal }, next) => Promise<PreStepDecision>`。
- **类型导入易错点**：`UserMessage` **不是** `dsh-agent` 的导出成员，它从 `@deepseek-ai/dsh-session` 导出。正确写法：
  ```ts
  import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent';
  import type { UserMessage } from '@deepseek-ai/dsh-session';
  ```
- **fail-closed**：4-gate（JSON 解析/Schema/Stage allowlist/参数范围）任一失败一律 BLOCK（返回 reject）。
- 本地模型（qwen3:14b / Ollama）调用是运行时 seam；接入前默认放行，不误拦截。

## 操作步骤

1. **确定插件归属 area**：新建目录 `packages/plugin/<name>/`，含 `package.json`（照 `packages/plugin/intent/package.json` 模板，`peerDependencies` 含 `@deepseek-ai/cordis`/`@deepseek-ai/dsh-agent`/`@deepseek-ai/schemastery`）、`tsconfig.json`（`extends ../../../tsconfig.base.json`，`rootDir:src`/`outDir:lib`）、`src/index.ts`。
2. **写插件入口**：`name` 常量 + `Config`（schemastery）+ `apply(ctx, config)`。监听 `agent/pre-step` 或 `ctx.effect` 生命周期；标注运行时 seam（不接入前默认安全行为）。
3. **登记到 bundle patch**：在 `packages/bundle/desktop/cordis.patch.yml` 的 `- insert:` 下加一行 `{ id, name: '@orchdesk/dsh-<name>', config: {...} }`。**不得重复 dsh-base 已声明的 row id**；平台条件用 `disabled: !!js <表达式>`，不写死。
4. **补 bundle 依赖**：在 `packages/bundle/desktop/package.json` 的 `dependencies` 加 `"@orchdesk/dsh-<name>": "workspace:*"`。
5. **OrchClaw Hub 延后项**（T-P2-6）：不加 row，仅渲染层占位卡片标「延后」。

## 构建/运行门控（重要）

### 轻量嵌入 dsh 做类型检查（推荐，免重装）

dsh 已 vendored 在 `references/deepseek-harness` 且 `lib/` 已构建。把 dsh 已构建的 `@deepseek-ai/*` 源包软链进 OrchDesk 根 `node_modules/@deepseek-ai/`，即可让插件 `tsc` 落到 dsh 真实类型，**无需跑 方案 A 超级 workspace 重装（dsh 自身 install 曾 51min + Git Bash 下 BUG-W01）**：

```bash
cd D:/Code/OrchDesk
mkdir -p node_modules/@deepseek-ai
ln -sfn references/deepseek-harness/vendor/cordis            node_modules/@deepseek-ai/cordis
ln -sfn references/deepseek-harness/packages/core/agent      node_modules/@deepseek-ai/dsh-agent
ln -sfn references/deepseek-harness/vendor/schemastery       node_modules/@deepseek-ai/schemastery
ln -sfn references/deepseek-harness/packages/core/session    node_modules/@deepseek-ai/dsh-session   # UserMessage 来源
# 其余 @deepseek-ai/* 在 dsh 树内经各包自身 node_modules 解析，第一跳够了
```

- 进入 dsh-agent 的 `.d.ts` 后，其引用的 `@deepseek-ai/dsh-invariants` 等 peer 与 npm 依赖（`@standard-schema/spec` 等）都会在 dsh 已安装的树内解析，无需逐个软链。
- **插件 tsconfig 自包含**：base 用 `moduleResolution: Bundler`，插件 tsconfig 把 `types` 置空 + 补 `lib: ["ES2022","DOM"]`（取 `AbortSignal` 等 DOM 全局），避免 `@types/node` 跨根软链被 tsc typeRoots 忽略的问题。插件源码未用 node API，故无需 `@types/node`。
- 该软链在 `node_modules`（gitignore），属本地验证辅助；`pnpm install` 会清掉它们。正式的 committed 嵌入仍走 `build.md` §3 的 方案 A（放开 `pnpm-workspace.yaml` 注释）或 方案 B（`file:` 指向 dsh `lib/`）。

### package.json 打包路径

- `tsc` 按 `outDir: lib` 输出声明到 **`lib/index.d.ts`**（不是 `lib/types/index.d.ts`）。插件 `package.json` 的 `types`/`exports.types` 必须写 `./lib/index.d.ts`，`files` 含 `lib/index.js` + `lib/index.d.ts`，否则消费方找不到类型。

### 其它门控

- 正式全量构建才需要激活 dsh workspace 接线（方案 A 或 B）并 `pnpm install`；`pnpm install` 须用**原生 PowerShell**（BUG-W01）。
- 本机 Electron 运行时处阻断（BUG-W02），插件运行期验证须转移到可正常运行 Electron/dsh 的机器。
- 渲染层插件开关（toggle/卸载并回滚）当前驱动 UI 状态 + toast；真正运行时开关需经 dsh 控制通道（插件运行在 main.ts spawn 的 dsh 子进程内，非 Electron 主进程）。

## 参考

详细 Cordis 插件 API 规范（manifest schema、inject/effect 真实代码片段、agent/pre-step 触发点源码行、范本插件 `repeat-tool-reminder`/`schedule`）见 [references/convention.md](references/convention.md)。
