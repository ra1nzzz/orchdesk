# BUG 知识库补充（2026-08-29 接力）

> 本文档记录两类长期未解的核心问题，供后续 Agent 接力修复。

> **2026-08-29 更新**：BUG-013、BUG-014、BUG-015、BUG-016 均已在 v0.3.1 修复并通过
> 自动化验证（agent-runtime-verify 35 项 + agent-loop-verify 14 项 + e2e-fix-verify 29 项，
> 共 78 项全绿）。下方各节保留原始分析，并在开头标注「已修复」与实现位置。

---

## 一、重新打包后项目数据丢失（BUG-013）

> **✅ 已修复（v0.3.1）**。实现见 `apps/desktop/main.ts` 的 `dataDir()` / `migrateLegacyData()`
> 与 `apps/desktop/agent-loop-verify.cjs` 的「A. 数据目录统一与迁移」用例。

### 现象

- 用户在 portable 模式下使用 OrchDesk，创建了项目/会话/消息
- 重新安装（NSIS 覆盖）或替换 `win-unpacked/` 目录后，所有数据消失
- 即使不重装，切换 dev ↔ packaged 模式，数据也不互通

### 根因分析

```
app.getPath('userData') 返回值依赖安装形态：
  dev 模式：     <repo>/apps/desktop/  （asar 未打包）
  portable：     <exe所在目录>/resources/app.asar.unpacked/ 上层 → 实际在 <exe旁>/orchdesk-data/
  NSIS 安装：    C:\Users\<user>\AppData\Roaming\OrchDesk\
```

当前代码在 `main.ts` 中：
- 会话：`path.join(app.getPath('userData'), 'orchdesk-sessions.json')`
- 模型：`path.join(app.getPath('userData'), 'models.json')`

**跨安装形态路径完全不同，数据不迁移。**

### 影响范围

| 数据 | 存储位置 | 丢失场景 |
|---|---|---|
| 会话（msgs、项目结构） | `orchdesk-sessions.json` in userData | 重装、换安装包类型 |
| 模型配置（providers、apiKeyEnc） | `models.json` in userData | 同上 |
| localStorage(`orchdesk.modelSelection`) | 浏览器 LocalStorage（每个 exe 独立） | 同上 |

**采用的修复（方案 A + 保底条款）**：

1. **规范化数据目录** `dataDir()`，与安装形态解耦：
   - `ORCHDESK_HOME` 环境变量（最高优先级，便于调试与多实例隔离）
   - 便携模式：`exe 同目录/orchdesk-data/`（需已存在该目录或 exe 旁有 `PORTABLE` 标记）
   - 其余（**含 NSIS 安装、portable 首次运行、dev**）→ `%APPDATA%/OrchDesk`
   - 由于 NSIS 的 `userData` 本身就是 `%APPDATA%\OrchDesk`，第 3 条让 **portable 与 NSIS
     天然共用同一目录**，满足「至少保底 portable 和 NSIS 同目录」的要求
2. **启动迁移** `migrateLegacyData()`：扫描全部历史候选目录
   （`app.getPath('userData')`、`%APPDATA%/OrchDesk`、exe 旁的 `orchdesk-data`、
   `apps/desktop`、仓库根），按 key 合并到规范化目录：
   - 会话：同 id 时保留 `updated` 较新的一份，并把两侧消息合并（取更长的一列）
   - 模型：按 provider `id` 合并，不覆盖目标侧已有配置
   - **只补齐不覆盖**，目标侧数据永远优先

> 注：`guanji.json` / `hub.json` 仍走 `app.getPath('userData')`，未纳入本次迁移范围
> （观雅集 TOKEN 与 Hub 配对凭据，影响面小，留待后续统一）。

### 当前代码参考

```typescript
// apps/desktop/main.ts L30-33
function sessionsFile(): string {
  return path.join(app.getPath('userData'), 'orchdesk-sessions.json');
}

// apps/desktop/main.ts L76
const MODELS_FILE = () => path.join(app.getPath('userData'), 'models.json');
```

---

## 二、Agent Runtime（DSH）回合管线未稳定（BUG-014）

> **✅ 已修复（v0.3.1）**。工具调用逻辑抽到零依赖的纯模块 `apps/desktop/agent-runtime.ts`
> （可在 node 下直接单测），`main.ts` 只保留需要 electron 的 `executeTool`。
> 验证：`agent-runtime-verify.cjs`（35 项）+ `agent-loop-verify.cjs`（14 项，含 OpenAI
> 消息契约断言）。

### 现象

- 用户输入 "复用本地鉴权，检查与远程 GITHUB 版本差异"
- 模型返回 `tool:file_list;{"path":"."}<$0`（或类似格式的工具调用）
- **工具调用被当成纯文本显示在对话中**，没有被执行

### 历史修复记录

| 时间 | 修复内容 | 结果 |
|---|---|---|
| 第一轮 | 工具调用正则 `/<tool:(\w+)>([\s\S]*?)<\/?>/g`（`<\/?>` 能匹配 `</tool>`） | **误判有效** — 正则实际不匹配 `</tool>`（只能匹配 `<>` 或 `</>`），工具调用被当成文本 |
| 第二轮 | 修为正则 `/<tool:(\w+)>([\s\S]*?)<\/tool>/g` | 正则能匹配了，但**模型回传格式不匹配**，解析后 args 为空/错误 |
| 第三轮 | 修正 args 解析 + 添加更多工具定义 | 解决 E2E 测试中的 FAIL，但**真实模型调用仍然不稳定** |

### 根因深度分析

Agent Runtime 的核心循环在 `main.ts` `runAgentTurn()` (L353-451)：

```
1. 构建 apiMessages（历史 + system prompt + user text）
2. 调用 callModel(provider, model, apiMessages, TOOL_DEFS)
3. 用正则解析 reply 中的 <tool:name>args</tool>
4. 对每个工具调用 → executeTool() → 把结果喂回 apiMessages
5. 循环直到模型不再返回工具调用
```

**每个环节都有独立问题：**

#### 问题 1：模型工具调用格式不匹配

- **代码期望**：`<tool:file_list>{"path":"."}</tool>`
- **模型实际返回**：格式取决于模型 — Qwen/DeepSeek 系列返回 function-call JSON 或自定义格式
- **硬编码格式**：system prompt 教唆模型使用 `<tool:name>args</tool>`，但这不是任何模型的 native format
- **当前 `callOpenAICompatible` 会尝试把 tool-call 转回 `<tool:>` 格式**（L200-204），但仅处理 `choice.message.tool_calls` 的情况

#### 问题 2：`callModel` / `callOpenAICompatible` 的双重解析

在 `callOpenAICompatible` (L150-210)：
- L191-205：如果 API 返回了 `tool_calls`，会把它们转成 `<tool:name>args</tool>` 格式
- 然后在 `runAgentTurn` 中用正则再解析回来

这形成了一个 **编码→解码循环**，如果任何一步出问题就断掉。

#### 问题 3：对话历史格式

- apiMessages 用 `{role, content}` 格式
- 工具结果被塞进 `role: 'system'` 的消息中 (L428)：`apiMessages.push({role:'system', content:'工具 "X" 执行结果:\nY'})`
- **大多数模型不支持 `system` role 中间插入**（system prompt 只能是第一条）

**已落地的修复（双模式适配，不删正则、不做编码往返）**：

1. **`callModel` 返回结构化 `ModelReply{content, toolCalls, source, toolsRejected}`**，
   不再把 `tool_calls` 编码成 `<tool:...>` 文本再让上层解码 —— 消除了编码/解码往返断点。
2. **模式 1（原生 function calling，优先）**：`normalizeNativeToolCalls()` 统一
   OpenAI / Ollama / 摊平三种 `tool_calls` 形态，**保留全部调用**（旧实现只取第一个），
   缺失 `id` 时自动生成。
3. **模式 2（文本兜底）**：`extractToolCalls()` 按
   `<tool:name>json</tool>` → `<tool_call>{...}</tool_call>` → `tool:name;{...}` → 纯 JSON
   依次尝试，命中一种即返回；支持缺少闭合标签、代码围栏、正文混排；结果去重，
   并用 `isKnownTool()` 过滤未知工具名避免误伤正文。
4. **参数解析 `parseToolArgs()`**：支持对象 / JSON 字符串 / 围栏 JSON / 混杂文本抠 JSON /
   裸字符串（映射到该工具主参数）。**旧实现把整个 args 塞进 `{input: "..."}`，
   导致 `executeTool` 永远读不到 `path`/`command`，这是工具执行失败的真正根因。**
5. **工具结果回传符合 OpenAI 规范**：
   - 原生模式 → `{role:'tool', tool_call_id, name, content}`，`tool_call_id` 与上一轮
     `assistant.tool_calls[].id` 严格一一对应
   - 文本兜底模式 → `{role:'user', content}`（assistant 消息里没有 `tool_calls` 时，
     发 `role:'tool'` 会被多数网关判为非法）
   - **不再使用 `role:'system'` 中途插入工具结果**
6. **assistant 消息原样回传 `arguments` 字符串**（`rawArguments`），避免二次序列化丢精度。
7. **网关降级**：`tool_choice`/`tools` 被拒（400/404/415/422 或错误信息含 tool）时，
   按「完整 → 去 tool_choice → 去 tools」逐级重试；成功后置 `toolsRejected`，
   本次会话内不再下发工具定义，转为文本兜底，避免每轮重复三次重试。
8. **历史清理**：回灌模型的历史只取 `user`/`assistant` 正文（tool 步骤消息是 UI 记录，
   不回灌）；工具结果裁剪到 20KB 再回传，防止刷爆上下文。
9. **会话壳自动创建**：`store[sessionId]` 不存在时先建壳，避免渲染层尚未持久化会话时
   本轮消息丢失。

### 相关文件索引

| 文件 | 关键行 | 职责 |
|---|---|---|
| `apps/desktop/main.ts` | L353-446 | `runAgentTurn()` — Agent 回合主循环 |
| `apps/desktop/main.ts` | L120-210 | `callModel()` / `callOllama()` / `callOpenAICompatible()` |
| `apps/desktop/main.ts` | L306-347 | `TOOL_DEFS` — 5 个内置工具定义 |
| `apps/desktop/main.ts` | L254-303 | `executeTool()` — 工具执行引擎 |
| `apps/desktop/main.ts` | L449-502 | IPC handlers：`tool-execute`、`run-agent-turn`、`persist-sessions` |
| `apps/desktop/renderer/app.js` | L1102-1122 | `doSend()` — 渲染层发送逻辑 |
| `apps/desktop/renderer/app.js` | L1532-1565 | `home-send` handler |
| `apps/desktop/renderer/app.js` | L1741-1771 | `model-toggle` / `model-confirm` handler |
| `references/cross-reference-OrchDesk.md` | — | DSH 理论依据 |

---

## 三、次优先级问题

### BUG-015：`selectedModels` 空数组导致发送失败 ✅ 已修复（v0.3.1）

- **修复**：
  1. `doSend()` 在拦截前先重试一次 `autoSelectModels()`（配置可能刚在设置页更新，
     或上一次 `getModelConfig()` 请求失败）
  2. 仍为空时不再抛出死胡同提示，而是 **自动跳转到「设置 → 模型管理」**
     并 toast「未检测到可用模型 · 已跳转到「设置 → 模型管理」」
  3. init 中 `getModelConfig()` 返回空或抛错时，不再无条件 `state.selectedModels = []`，
     改由 `autoSelectModels()` 决策（避免瞬时失败清空用户选择）

### BUG-016：构建时 EBUSY 锁目录 ✅ 已修复（v0.3.1）

- **修复**：新增零依赖脚本 `apps/desktop/kill-running.cjs`，在打包前结束
  `OrchDesk.exe` / `electron.exe`（`taskkill /F /IM ... /T`）并等待 1.5s 释放文件句柄。
  只依据 taskkill 退出码判定成功与否（其中文输出为 GBK，解析会乱码）。
- **用法**：`pnpm run dist` / `dist:win` / `dist:portable` 已内置该步骤；
  也可单独执行 `node kill-running.cjs`。
