# BUG 知识库补充（2026-08-29 接力）

> 本文档记录两类长期未解的核心问题，供后续 Agent 接力修复。

---

## 一、重新打包后项目数据丢失（BUG-013）

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

### 修复方向

1. **方案 A（推荐）**：在 `userData` 内添加迁移逻辑 —— 启动时扫描所有历史可能的 userData 路径（解包目录旁、AppData、dev 目录），合并数据
2. **方案 B**：在侧栏顶栏添加「导出数据」按钮（JSON 文件），重装后「导入」
3. **短期缓解**：在 `release/win-unpacked` 同级目录添加 `.orchdesk-home/` 软链到 AppData 目录，确保 portable 和 NSIS 使用同一目录

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

### 修复方向建议

**核心原则：用模型的 native function-calling，不要自造格式。**

#### 方案：双模式适配

```
模式 1（Ollama / 支持 function calling 的模型）：
  - 传给模型：标准 OpenAI tool 定义（TOOL_DEFS）
  - 从模型拿到：choice.message.tool_calls[]
  - 直接执行工具，结果以 tool role 消息回传
  - 循环

模式 2（不支持 function calling 的模型）：
  - 传给模型：纯 system prompt（描述可用工具 + JSON format 要求）
  - 从模型拿到：普通文本回复
  - 用 JSON.parse 尝试提取 {name, arguments}
  - 无法提取 → 直接返回给用户
```

#### 关键改动点

1. **删除 `runAgentTurn` 中的正则解析**，改用 `choice.message.tool_calls` 直接取工具调用
2. **工具结果回传用正确的 `role: 'tool'`**（OpenAI API 规范），不再用 `role: 'system'`
3. **Tool definition 统一在 `callModel` 层处理**，不在 `runAgentTurn` 层做编码/解码
4. **对话历史裁剪**：保留最近 N 轮，但保留完整 tool call → result 循环

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

### BUG-015：`selectedModels` 空数组导致发送失败

- `doSend()` 在 L1106 检查 `state.selectedModels.length === 0` → toast + return
- init 流程中如果 `bridge.getModelConfig()` 抛错或返回空 providers，`selectedModels` 被清空
- **修复**：`autoSelectModels` 清空后应有 fallback（至少选第一个工具 list 中的模型）；E2E mock 已覆盖

### BUG-016：构建时 EBUSY 锁目录

- `electron-builder` 删除 `release/win-unpacked/` 时，如果旧进程还在运行就 EBUSY
- **修复**：打包前自动 `taskkill //F //IM OrchDesk.exe`，或用临时目录跳过清理
