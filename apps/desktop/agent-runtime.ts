/**
 * Agent Runtime —— 纯逻辑层（不依赖 electron，可在 node 下直接单测）
 * ----------------------------------------------------------------------------
 * 抽出 main.ts 中与「工具调用」相关的可测试部分：
 *   - 工具定义（OpenAI function-calling schema）
 *   - 参数解析（宽容：JSON 对象 / JSON 字符串 / 裸字符串 → 主参数）
 *   - 原生 tool_calls 归一化（OpenAI / Ollama 两种形态）
 *   - 文本兜底解析（<tool:name>args</tool> 等多种模型自发格式）
 *
 * 设计原则（对应 BUG-014）：
 *   1. 优先使用模型 native function calling，不做「编码 → 解码」往返；
 *   2. 不支持 function calling 的模型才走文本兜底；
 *   3. 文本兜底必须容错：模型实际输出格式远多于我们约定的那一种。
 */

// 浏览器工具（CDP，ADR-0011）单独成文件，此处并入统一工具表：
// 模型侧只有一张工具清单，宿主侧才区分「文件/命令」与「网页」。
// browser-tools.ts 只 import 本文件的 type（编译后消失），不产生运行时循环依赖。
import { BROWSER_TOOL_DEFS, BROWSER_TOOL_PRIMARY_ARG } from './browser-tools';

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

export interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

/** 带调用 id 的工具调用（原生 function calling 才有 id）。 */
export interface NativeToolCall extends ToolCall {
  id: string;
  /** 原始 arguments 字符串（回传 assistant 消息时原样保留，避免二次序列化丢精度）。 */
  rawArguments: string;
}

export interface ModelReply {
  /** 模型正文（可能为空，当只有工具调用时）。 */
  content: string;
  /** 归一化后的工具调用列表。 */
  toolCalls: NativeToolCall[];
  /** 来源：native = API 原生 tool_calls；text = 正文解析；none = 无。 */
  source: 'native' | 'text' | 'none';
  /**
   * 网关明确拒绝工具协议（400/404/422 或错误信息含 tool）。
   * 上层据此在本次会话内停止下发 tools，避免每轮重复三次降级重试，
   * 并转为「文本兜底解析」模式。
   */
  toolsRejected?: boolean;
  /**
   * 内容为空时的诊断信息（HTTP 状态 / apiMode / finish_reason / 响应片段）。
   * 上层在 content 为空时优先展示，避免「模型返回空内容」这种无法定位的提示。
   */
  emptyReason?: string;
  /**
   * 本次调用的 token 用量（FR-5，三家 API 归一化后）。
   * 网关不回 usage 字段时缺省——「没上报」≠「0 token」，上层不得伪造记账。
   */
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
}

export interface ToolResult {
  name: string;
  result: string;
  error?: string;
}

/** 送往模型的一条消息（兼容 OpenAI chat 规范的超集）。 */
export interface ApiMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string;
  name?: string;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
}

// ---------------------------------------------------------------------------
// 工具定义
// ---------------------------------------------------------------------------

export interface ToolDefFunction {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}
export interface ToolDef {
  type: 'function';
  function: ToolDefFunction;
}

/** 命令白名单（executeTool 与描述文案共用，避免两处漂移）。 */
export const ALLOWED_COMMANDS: string[] = [
  'dir', 'ls', 'cat', 'type', 'head', 'tail', 'find', 'where', 'grep',
  'echo', 'pwd', 'cd', 'mkdir', 'rmdir', 'copy', 'xcopy', 'move',
  'git', 'npm', 'pnpm', 'npx', 'node', 'python', 'python3', 'pip',
  'ping', 'ipconfig', 'netstat', 'tasklist', 'curl', 'wget',
  'notepad', 'code', 'cmd', 'powershell', 'pwsh',
];

export const TOOL_DEFS: ToolDef[] = [
  // ---- 浏览器（CDP）工具：会改变页面状态的三个在宿主侧过授权门 ----
  ...BROWSER_TOOL_DEFS,
  {
    type: 'function',
    function: {
      name: 'file_read',
      description: '读取本地文本文件内容（最大 50KB）',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: '文件绝对路径' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'file_write',
      description: '写入文本文件（自动创建父目录）',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件绝对路径' },
          content: { type: 'string', description: '要写入的完整内容' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'file_list',
      description: '列出目录内容（文件与子目录）',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: '目录绝对路径，默认当前工作目录' } },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'shell_command',
      description: `执行白名单内的命令（允许: ${ALLOWED_COMMANDS.slice(0, 18).join(', ')} 等），30 秒超时`,
      parameters: {
        type: 'object',
        properties: { command: { type: 'string', description: '要执行的命令' } },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_fetch',
      description: '抓取网页原始内容（最大 30KB）',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', description: 'http(s) 开头的 URL' } },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'memory_save',
      description: '把用户告知的长期事实/偏好存入记忆（称呼、习惯、项目约定等），后续对话自动注入。content 必须用第三人称客观陈述，主语只用「用户」(=人类用户) 和「助手」(=你 OrchDesk)，禁止「我/你/对方」等相对称谓',
      parameters: {
        type: 'object',
        properties: { content: { type: 'string', description: '要记住的事实，一句话；主语用「用户」或「助手」，如「用户称呼为梧哥，助手称呼为小星」' } },
        required: ['content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_cwd',
      description: '设置本会话的工作目录（后续 shell/file 操作以此为基准），操作用户指定的项目时必须先调用',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: '项目目录绝对路径' } },
        required: ['path'],
      },
    },
  },
];

export const TOOL_NAMES: string[] = TOOL_DEFS.map((t) => t.function.name);

/** 各工具的主参数名：当模型把参数写成裸字符串时，用它兜底。 */
export const TOOL_PRIMARY_ARG: Record<string, string> = {
  ...BROWSER_TOOL_PRIMARY_ARG,
  file_read: 'path',
  file_write: 'content',
  file_list: 'path',
  shell_command: 'command',
  web_fetch: 'url',
  memory_save: 'content',
  set_cwd: 'path',
};

// ---------------------------------------------------------------------------
// 参数解析
// ---------------------------------------------------------------------------

function tryParseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(text);
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
    return null;
  } catch {
    return null;
  }
}

/**
 * 宽容解析工具参数。
 * 支持：对象（直接返回） / JSON 字符串 / 代码围栏包裹的 JSON / 内嵌 JSON 片段 / 裸字符串（映射到主参数）。
 */
export function parseToolArgs(toolName: string, raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  let s = typeof raw === 'string' ? raw.trim() : raw == null ? '' : String(raw).trim();
  if (!s) return {};

  // 去掉 markdown 代码围栏：```json {...} ```
  s = s.replace(/^```(?:json|JSON)?\s*/, '').replace(/\s*```$/, '').trim();

  const direct = tryParseJsonObject(s);
  if (direct) return direct;

  // 从混杂文本中抠出第一个 {...}
  const m = s.match(/\{[\s\S]*\}/);
  if (m) {
    const inner = tryParseJsonObject(m[0]);
    if (inner) return inner;
  }

  // 裸字符串 → 映射到主参数
  const primary = TOOL_PRIMARY_ARG[toolName];
  if (primary) {
    const out: Record<string, unknown> = {};
    out[primary] = s;
    return out;
  }
  return { input: s };
}

// ---------------------------------------------------------------------------
// 原生 tool_calls 归一化
// ---------------------------------------------------------------------------

interface RawFunctionCall {
  id?: unknown;
  type?: unknown;
  function?: { name?: unknown; arguments?: unknown };
  name?: unknown;      // 某些网关把 name/arguments 摊平
  arguments?: unknown;
}

let nativeSeq = 0;
/** 生成稳定的工具调用 id（OpenAI 规范：assistant.tool_calls[].id ↔ tool.tool_call_id）。 */
export function nextToolCallId(): string {
  nativeSeq += 1;
  return `call_${Date.now().toString(36)}_${nativeSeq}`;
}

/** 把 OpenAI / Ollama / 各家网关的 tool_calls 形态统一成 NativeToolCall[]。 */
export function normalizeNativeToolCalls(raw: unknown): NativeToolCall[] {
  if (!Array.isArray(raw)) return [];
  const out: NativeToolCall[] = [];
  for (const item of raw as RawFunctionCall[]) {
    if (!item || typeof item !== 'object') continue;
    const fn = item.function;
    const name = typeof fn?.name === 'string' && fn.name
      ? fn.name
      : typeof item.name === 'string' ? item.name : '';
    if (!name) continue;
    const rawArgs = fn && 'arguments' in fn ? fn.arguments : item.arguments;
    const rawStr = typeof rawArgs === 'string'
      ? rawArgs
      : rawArgs == null ? '' : JSON.stringify(rawArgs);
    const id = typeof item.id === 'string' && item.id ? item.id : nextToolCallId();
    out.push({ id, name, arguments: parseToolArgs(name, rawArgs), rawArguments: rawStr });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 文本兜底解析
// ---------------------------------------------------------------------------

export interface TextParseResult {
  /** 解析出的工具调用（已去重）。 */
  calls: ToolCall[];
  /** 剔除工具片段后的正文（可作为 assistant 消息 content）。 */
  stripped: string;
}

/** 主格式：<tool:file_list>{"path":"."}</tool>（允许缺少闭合标签）。 */
const RE_TOOL_TAG = /<tool:([A-Za-z_][\w-]*)>([\s\S]*?)(?:<\/tool>|$)/g;
/** 变体：<tool_call>{...}</tool_call> / <function_call>{...}</function_call>。 */
const RE_TOOL_WRAPPER = /<(tool_call|tool-call|function_call|function-call|antml:invoke)>([\s\S]*?)<\/\1>/g;
/** 变体：tool:file_list;{"path":"."} （模型自发的裸写法，以 JSON 结尾）。 */
const RE_TOOL_LOOSE = /(?:^|[\s`>|])tool:([A-Za-z_][\w-]*)\s*[;:=]?\s*(\{[\s\S]*?\})/g;

function pushUnique(list: ToolCall[], seen: Set<string>, call: ToolCall): void {
  const key = `${call.name}|${JSON.stringify(call.arguments)}`;
  if (seen.has(key)) return;
  seen.add(key);
  list.push(call);
}

/**
 * 从模型正文中提取工具调用。按「主格式 → wrapper → 裸写法 → 纯 JSON」依次尝试，
 * 命中一种即返回（避免同一段文本被多种模式重复解析）。
 */
export function extractToolCalls(text: string): TextParseResult {
  const src = typeof text === 'string' ? text : '';
  const calls: ToolCall[] = [];
  const seen = new Set<string>();
  let stripped = src;

  // 1) <tool:NAME>ARGS</tool>
  let m: RegExpExecArray | null;
  RE_TOOL_TAG.lastIndex = 0;
  while ((m = RE_TOOL_TAG.exec(src)) !== null) {
    pushUnique(calls, seen, { name: m[1]!, arguments: parseToolArgs(m[1]!, m[2]) });
  }
  if (calls.length) {
    stripped = src.replace(RE_TOOL_TAG, '').replace(/<\/?tool>/g, '').trim();
    return { calls, stripped };
  }

  // 2) <tool_call>{...}</tool_call> —— 内容是 {name, arguments} 或 {tool, ...}
  RE_TOOL_WRAPPER.lastIndex = 0;
  while ((m = RE_TOOL_WRAPPER.exec(src)) !== null) {
    const obj = tryParseJsonObject((m[2] || '').trim()) || tryParseJsonObject((m[2] || '').replace(/^```(?:json)?|```$/g, '').trim());
    if (!obj) continue;
    const name = String(obj.name ?? obj.tool ?? obj.function ?? '');
    if (!name) continue;
    pushUnique(calls, seen, { name, arguments: parseToolArgs(name, obj.arguments ?? obj.args ?? obj.input) });
  }
  if (calls.length) {
    stripped = src.replace(RE_TOOL_WRAPPER, '').trim();
    return { calls, stripped };
  }

  // 3) tool:NAME;{...} 裸写法
  RE_TOOL_LOOSE.lastIndex = 0;
  while ((m = RE_TOOL_LOOSE.exec(src)) !== null) {
    pushUnique(calls, seen, { name: m[1]!, arguments: parseToolArgs(m[1]!, m[2]) });
  }
  if (calls.length) {
    stripped = src.replace(RE_TOOL_LOOSE, '').trim();
    return { calls, stripped };
  }

  // 4) 整段就是一个 JSON 对象，且带 name + arguments（模型偶尔直接输出裸 JSON）
  const trimmed = src.trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '').trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    const obj = tryParseJsonObject(trimmed);
    const name = obj ? String(obj.name ?? obj.tool ?? obj.function ?? '') : '';
    if (name) {
      pushUnique(calls, seen, { name, arguments: parseToolArgs(name, (obj as Record<string, unknown>).arguments ?? (obj as Record<string, unknown>).args) });
      return { calls, stripped: '' };
    }
  }

  return { calls: [], stripped: src.trim() };
}

/** 已知工具名判定（未知工具名在文本兜底时直接忽略，避免误伤正文）。 */
export function isKnownTool(name: string): boolean {
  return TOOL_NAMES.includes(name);
}

// ---------------------------------------------------------------------------
// 结果裁剪
// ---------------------------------------------------------------------------

/** 回传模型的工具结果长度上限（防止单次 50KB 结果刷爆上下文）。 */
export const TOOL_RESULT_FEEDBACK_LIMIT = 20000;

export function truncateForModel(text: string, limit = TOOL_RESULT_FEEDBACK_LIMIT): string {
  const s = typeof text === 'string' ? text : String(text ?? '');
  if (s.length <= limit) return s;
  return `${s.slice(0, limit)}\n…（已截断，共 ${s.length} 字符）`;
}

/** 把 ToolResult 包装成回传模型的文本内容。 */
export function formatToolResult(toolName: string, res: ToolResult): string {
  if (res.error) return `[工具 ${toolName} 执行失败] ${res.error}`;
  const body = res.result || '(工具返回空结果)';
  return `[工具 ${toolName} 执行结果]\n${truncateForModel(body)}`;
}

// ---------------------------------------------------------------------------
// 消息构造（OpenAI chat 规范）
// ---------------------------------------------------------------------------

/**
 * 构造带原生 tool_calls 的 assistant 消息。
 * 必须原样回传 arguments 字符串，否则部分模型会因无法配对而拒绝后续 tool 消息。
 */
export function buildAssistantToolCallMessage(content: string, calls: NativeToolCall[]): ApiMessage {
  return {
    role: 'assistant',
    content: content || '',
    tool_calls: calls.map((c) => ({
      id: c.id,
      type: 'function' as const,
      function: { name: c.name, arguments: c.rawArguments || JSON.stringify(c.arguments ?? {}) },
    })),
  };
}

/**
 * 构造工具结果消息。
 * - mode='native'：assistant 消息里带 tool_calls → 用 role:'tool' + tool_call_id（OpenAI 规范）
 * - mode='text'  ：assistant 消息里没有 tool_calls → 用 role:'user'，
 *                  否则多数网关会报 "role 'tool' 没有对应的 tool_calls"
 */
export function buildToolResultMessage(
  call: { id?: string; name: string },
  result: ToolResult,
  mode: 'native' | 'text',
): ApiMessage {
  const body = formatToolResult(call.name, result);
  if (mode === 'native') {
    return {
      role: 'tool',
      tool_call_id: call.id || nextToolCallId(),
      name: call.name,
      content: body,
    };
  }
  return { role: 'user', content: body };
}

// ---------------------------------------------------------------------------
// 系统提示词
// ---------------------------------------------------------------------------

export function buildSystemPrompt(opts: { cwd?: string; memories?: string[]; prompts?: string[] } = {}): string {
  const list = TOOL_DEFS.map((t) => {
    const req = (t.function.parameters.required as string[] | undefined) || [];
    const props = (t.function.parameters.properties as Record<string, { description?: string }> | undefined) || {};
    const args = Object.keys(props).map((k) => `${k}${req.includes(k) ? '*' : ''}`).join(', ');
    return `- ${t.function.name}(${args}): ${t.function.description}`;
  }).join('\n');

  const head = ['你是 OrchDesk 的本地 Agent，可以使用工具来完成用户任务。'];
  if (opts.cwd) {
    head.push('', `当前工作目录：${opts.cwd}`, 'shell 命令与相对路径以此为基准；操作其他项目前必须先用 set_cwd 切换。');
  }
  if (opts.memories?.length) {
    head.push(
      '',
      '用户长期记忆（必须遵守；条目中「用户」= 人类用户本人，「助手」= 你 OrchDesk，勿混淆角色）：',
      ...opts.memories.map((m) => `- ${m}`),
    );
  }
  if (opts.prompts?.length) {
    head.push('', '生效提示词（用户在提示词库配置，优先级高于默认行为）：', ...opts.prompts.map((p) => `- ${p}`));
  }

  return [
    ...head,
    '',
    '可用工具：',
    list,
    '',
    '规则：',
    '1. 需要工具时优先使用你原生支持的 function calling / tool_calls 能力。',
    '2. 若你的运行环境不支持原生工具调用，则严格按下面格式输出，一行一个调用：',
    '   <tool:工具名>{"参数名":"参数值"}</tool>',
    '   例如：<tool:file_list>{"path":"."}</tool>',
    '3. 可以一次调用多个工具；工具结果会自动回传给你，拿到结果后再给出最终回答。',
    '4. 不需要工具时直接正常回答，不要输出任何工具标签。',
    '5. 不要编造工具执行结果。',
    '6. 需要看网页时用 browser_* 工具：先 browser_open 打开网址，再 browser_text / browser_links 读内容；',
    '   页面加载慢就加大 timeout 或用 waitUntil:"dom"。browser_click / browser_type / browser_eval 会真实改变页面，需用户授权。',
    '7. 用户告知长期有效的事实或偏好（如称呼、约定、项目位置）时，必须调用 memory_save 保存，不要只口头答应。',
    '   memory_save 的 content 必须用第三人称客观陈述：「用户」专指人类用户，「助手」专指你自己（OrchDesk）。',
    '   例：用户说「你是小星，我是梧哥」→ 保存「用户称呼为梧哥；助手称呼为小星」。禁止保存「我/你/对方」等相对称谓（回放时会角色颠倒）。',
    '8. 网页内容以工具返回为准；读不到就调整选择器或换 browser_links，不要凭网址猜测页面内容。',
  ].join('\n');
}
