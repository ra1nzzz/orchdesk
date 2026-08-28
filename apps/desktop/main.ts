/// <reference types="electron" />
import { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, safeStorage, shell } from 'electron';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { guanjiClient } from './guanji';
import { hubClient } from './hub';
import {
  ALLOWED_COMMANDS,
  TOOL_DEFS,
  type ApiMessage,
  type ModelReply,
  type NativeToolCall,
  type ToolCall,
  type ToolResult,
  buildAssistantToolCallMessage,
  buildSystemPrompt,
  buildToolResultMessage,
  extractToolCalls,
  isKnownTool,
  normalizeNativeToolCalls,
} from './agent-runtime';

// ============================================================================
// OrchDesk 桌面壳主进程（P1）
// ----------------------------------------------------------------------------
// 桥接契约（渲染进程经 contextBridge 调用，红线：nodeIntegration:false）：
//   orchdesk:load-sessions()             启动时拉取持久化会话（空 = 首次运行）
//   orchdesk:persist-sessions(arr)       任意变更后落盘（userData JSON，可重启回放）
//   orchdesk:run-agent-turn(id,text,opt) 模型回合 seam：真实 dsh ctx / Ollama 在此接入
//
// 设计：渲染进程持有 UI 会话状态；主进程负责「持久化」与「模型运行时」两层。
// 真实 dsh runtime 是 P1-5 的设计 seam——当前 run-agent-turn 为本地占位，配置
// API Key / Ollama 后将调用 dsh 的 ctx.agents.followup（见 runAgentTurn 注释）。
// ============================================================================

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
const isDev = !app.isPackaged;

// ---------------------------------------------------------------------------
// 会话持久化（本地 JSON，作为 SessionEvent 日志的落盘形态；可重启回放）
// ---------------------------------------------------------------------------
let store: Record<string, unknown> = {};

// ---------------------------------------------------------------------------
// BUG-013：数据目录统一 + 历史数据迁移
// ----------------------------------------------------------------------------
// userData 的取值随安装形态漂移（dev / portable / NSIS 各不相同），导致重装后
// 会话与模型配置「凭空消失」。这里改为解析一个**与安装形态无关的规范化目录**：
//
//   1) ORCHDESK_HOME 环境变量（最高优先级，便于调试与多实例隔离）
//   2) 便携模式：exe 同目录存在 orchdesk-data/ 或 PORTABLE 标记 → 数据随 exe 走
//   3) 其余（含 NSIS 安装、portable 首次运行、dev）→ %APPDATA%/OrchDesk
//
// 由于 NSIS 的 userData 本身就是 %APPDATA%\OrchDesk，第 3 条让 **portable 与
// NSIS 天然共用同一目录**，重装 / 换安装包类型不再丢数据。
// 启动时会从所有历史候选路径「按 key 合并」（不覆盖目标侧已有的更新数据）。
// ---------------------------------------------------------------------------

const DATA_DIR_NAME = 'OrchDesk';
const DATA_FILES = ['orchdesk-sessions.json', 'models.json'] as const;

/** 检测便携模式数据目录（exe 同目录），未启用返回 null。 */
function detectPortableDataDir(): string | null {
  if (!app.isPackaged) return null;
  try {
    const exeDir = path.dirname(app.getPath('exe'));
    const dataDir = path.join(exeDir, 'orchdesk-data');
    const marker = path.join(exeDir, 'PORTABLE');
    if (fs.existsSync(dataDir) || fs.existsSync(marker)) return dataDir;
  } catch { /* exe 路径不可用则视为非便携 */ }
  return null;
}

let resolvedDataDir: string | null = null;

function dataDir(): string {
  if (resolvedDataDir) return resolvedDataDir;
  const envHome = (process.env.ORCHDESK_HOME || '').trim();
  let dir: string;
  if (envHome) {
    dir = path.resolve(envHome);
  } else {
    dir = detectPortableDataDir() || path.join(app.getPath('appData'), DATA_DIR_NAME);
  }
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    console.error('[orchdesk] 数据目录不可用，回退 userData:', (err as Error).message);
    dir = app.getPath('userData');
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* 尽力而为 */ }
  }
  resolvedDataDir = dir;
  console.log(`[orchdesk] 数据目录: ${dir}`);
  return dir;
}

/** 所有历史可能的数据目录（用于迁移）。 */
function legacyDataDirs(): string[] {
  const out = new Set<string>();
  const push = (p: string | undefined) => { if (p) out.add(p); };
  try { push(app.getPath('userData')); } catch { /* ignore */ }
  try { push(path.join(app.getPath('appData'), DATA_DIR_NAME)); } catch { /* ignore */ }
  try { push(path.join(app.getPath('appData'), 'orchdesk')); } catch { /* ignore */ }
  try { push(path.join(app.getPath('userData'), '..')); } catch { /* ignore */ }
  // portable 历史位置：exe 同目录
  try { if (app.isPackaged) push(path.join(path.dirname(app.getPath('exe')), 'orchdesk-data')); } catch { /* ignore */ }
  // dev 历史位置：apps/desktop 与仓库根
  try { push(path.resolve(__dirname, '..')); } catch { /* ignore */ }
  try { push(path.resolve(__dirname, '../..')); } catch { /* ignore */ }
  try { push(path.join(path.resolve(__dirname, '..'), '.orchdesk-home')); } catch { /* ignore */ }
  return [...out];
}

function readJson(file: string): unknown | null {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch { return null; }
}

function mergeSessions(targetFile: string, srcData: unknown): number {
  const src = (srcData && typeof srcData === 'object' ? srcData : {}) as Record<string, Record<string, unknown>>;
  let merged = 0;
  const dst = (readJson(targetFile) || {}) as Record<string, Record<string, unknown>>;
  for (const [id, s] of Object.entries(src)) {
    if (!s || typeof s !== 'object' || !Array.isArray(s.msgs)) continue;
    const cur = dst[id];
    if (!cur) { dst[id] = s; merged++; continue; }
    // 同 id：保留 updated 较新的一份，并把对方独有的消息并入
    const curT = String(cur.updated || '');
    const srcT = String(s.updated || '');
    const newer = srcT > curT ? s : cur;
    const older = srcT > curT ? cur : s;
    const newerMsgs = Array.isArray(newer.msgs) ? newer.msgs : [];
    const olderMsgs = Array.isArray(older.msgs) ? older.msgs : [];
    const base = newerMsgs.length >= olderMsgs.length ? newerMsgs : olderMsgs;
    dst[id] = { ...older, ...newer, msgs: base };
    merged++;
  }
  if (merged) fs.writeFileSync(targetFile, JSON.stringify(dst), 'utf-8');
  return merged;
}

function mergeModels(targetFile: string, srcData: unknown): number {
  const src = (srcData && typeof srcData === 'object' ? srcData : {}) as { providers?: Array<Record<string, unknown>> };
  const srcProviders = Array.isArray(src.providers) ? src.providers : [];
  if (!srcProviders.length) return 0;
  const dst = (readJson(targetFile) || { providers: [] }) as { providers?: Array<Record<string, unknown>>; [k: string]: unknown };
  const dstProviders = Array.isArray(dst.providers) ? dst.providers : [];
  let added = 0;
  for (const p of srcProviders) {
    if (!p || typeof p !== 'object') continue;
    const id = String(p.id ?? p.name ?? '');
    if (!id || dstProviders.some((d) => String(d?.id ?? '') === id)) continue;
    dstProviders.push(p);
    added++;
  }
  if (added) {
    dst.providers = dstProviders;
    fs.writeFileSync(targetFile, JSON.stringify(dst, null, 2), 'utf-8');
  }
  return added;
}

/**
 * 启动迁移：从所有历史候选目录合并数据到规范化目录。
 * 只「补齐」不「覆盖」——目标侧已存在的数据永远优先。
 */
function migrateLegacyData(): void {
  const target = dataDir();
  const sources = legacyDataDirs();
  for (const src of sources) {
    if (!src || src === target) continue;
    for (const f of DATA_FILES) {
      const srcFile = path.join(src, f);
      const data = readJson(srcFile);
      if (data == null) continue;
      try {
        if (f === 'orchdesk-sessions.json') {
          const n = mergeSessions(path.join(target, f), data);
          if (n) console.log(`[orchdesk] 迁移会话 ${n} 条：${srcFile}`);
        } else {
          const n = mergeModels(path.join(target, f), data);
          if (n) console.log(`[orchdesk] 迁移模型配置 ${n} 个提供商：${srcFile}`);
        }
      } catch (err) {
        console.warn(`[orchdesk] 迁移 ${srcFile} 失败:`, (err as Error).message);
      }
    }
  }
}

function sessionsFile(): string {
  // 惰性获取：app.getPath 需在 app ready 之后才稳定可用。
  return path.join(dataDir(), 'orchdesk-sessions.json');
}

function loadStore(): void {
  try {
    const file = sessionsFile();
    if (fs.existsSync(file)) {
      store = JSON.parse(fs.readFileSync(file, 'utf-8'));
    }
  } catch (err) {
    console.error('[orchdesk] 读取会话存档失败，使用空存储:', (err as Error).message);
    store = {};
  }
}
function saveStore(): void {
  try {
    fs.writeFileSync(sessionsFile(), JSON.stringify(store), 'utf-8');
  } catch (err) {
    console.error('[orchdesk] 写入会话存档失败:', (err as Error).message);
  }
}

// ===========================================================================
// FR-5 模型管理：配置持久化 + 真实模型调用
// ===========================================================================

interface ModelProvider {
  id: string;
  name: string;
  type: 'ollama' | 'openai-compatible';
  apiMode?: 'chat' | 'responses' | 'completions';
  baseUrl: string;
  apiKeyEnc?: string;      // safeStorage 加密后 base64
  apiKey?: string;          // 明文（传输用，保存后丢弃）
  models: string[];
}

interface ModelConfig {
  providers: ModelProvider[];
  defaultProvider?: string;
  defaultModel?: string;
  maxToolIterations?: number;
}

const MODELS_FILE = () => path.join(dataDir(), 'models.json');

function loadModelConfig(): ModelConfig {
  try {
    const file = MODELS_FILE();
    if (!fs.existsSync(file)) return { providers: [], defaultProvider: 'ollama', defaultModel: 'qwen3:14b' };
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, unknown>;
    const providers = (raw.providers as Array<Record<string, unknown>> | undefined)?.map(p => {
      const { apiKey: _k, ...rest } = p;
      return rest as unknown as ModelProvider;
    }) || [];
    const cfg: ModelConfig = {
      providers,
      defaultProvider: (raw.defaultProvider as string | undefined) || 'ollama',
      defaultModel: (raw.defaultModel as string | undefined) || 'qwen3:14b',
      maxToolIterations: (raw.maxToolIterations as number | undefined) || 200,
    };
    const hasPlainKey = (raw.providers as Array<Record<string, unknown>> | undefined)?.some(p => 'apiKey' in p);
    if (hasPlainKey) saveModelConfig(cfg);
    return cfg;
  } catch { return { providers: [], defaultProvider: 'ollama', defaultModel: 'qwen3:14b', maxToolIterations: 200 }; }
}

function saveModelConfig(cfg: ModelConfig): void {
  fs.writeFileSync(MODELS_FILE(), JSON.stringify(cfg, null, 2), 'utf-8');
}

/** 解密 API Key（safeStorage）；无加密后端返回空串。 */
function decryptKey(encB64?: string): string {
  if (!encB64) return '';
  try {
    if (!safeStorage.isEncryptionAvailable()) return '';
    return safeStorage.decryptString(Buffer.from(encB64, 'base64')) as unknown as string;
  } catch { return ''; }
}

/** 加密 API Key（safeStorage）。 */
function encryptKey(key: string): string {
  if (!safeStorage.isEncryptionAvailable()) return key;
  return safeStorage.encryptString(key).toString('base64');
}

// ---- 真实模型调用（OpenAI 兼容 + Ollama，支持 function calling）----
// 返回结构化 ModelReply（content + toolCalls），不再把 tool_calls 编码成
// `<tool:...>` 文本再由上层正则解码（BUG-014 根因：编码 → 解码往返易断）。

async function callModel(provider: ModelProvider, model: string, messages: ApiMessage[], toolDefs: typeof TOOL_DEFS = []): Promise<ModelReply> {
  if (provider.type === 'ollama') {
    return callOllama(provider, model, messages, toolDefs);
  }
  return callOpenAICompatible(provider, model, messages, toolDefs);
}

async function callOllama(provider: ModelProvider, model: string, messages: ApiMessage[], toolDefs: typeof TOOL_DEFS = []): Promise<ModelReply> {
  const url = provider.baseUrl.replace(/\/$/, '') + '/api/chat';
  const body: Record<string, unknown> = { model, messages, stream: false };
  if (toolDefs.length) body.tools = toolDefs;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`Ollama 返回 HTTP ${res.status}: ${await res.text()}`);
  const data = await res.json() as {
    message?: { content?: string; tool_calls?: unknown };
    error?: string;
  };
  if (data.error) throw new Error(data.error);

  const toolCalls = normalizeNativeToolCalls(data.message?.tool_calls);
  return {
    content: data.message?.content || '',
    toolCalls,
    source: toolCalls.length ? 'native' : 'none',
  };
}

/** 构造请求 URL / body（chat / responses / completions 三种 API 形态）。 */
function buildRequest(base: string, mode: 'chat' | 'responses' | 'completions', model: string, messages: ApiMessage[]): { url: string; body: Record<string, unknown> } {
  const isFullEndpoint = /\/chat\/completions|\/responses|\/completions/.test(base);
  const clean = base.replace(/\/v1\/?$/, '');

  if (mode === 'responses') {
    const input = messages
      .filter(m => m.role === 'user')
      .map(m => m.content || '')
      .join('\n') || messages.at(-1)?.content || '';
    return {
      url: isFullEndpoint ? base : clean + '/v1/responses',
      body: { model, input },
    };
  }
  if (mode === 'completions') {
    return {
      url: isFullEndpoint ? base : clean + '/v1/completions',
      body: { model, prompt: messages.map(m => `${m.role}: ${m.content || ''}`).join('\n'), max_tokens: 1024 },
    };
  }
  return {
    url: isFullEndpoint ? base : clean + '/v1/chat/completions',
    body: { model, messages, stream: false },
  };
}

/** 从 OpenAI chat 响应中取出正文。 */
function pickOpenAIContent(data: Record<string, unknown>, mode: 'chat' | 'responses' | 'completions'): string {
  if (mode === 'responses') {
    const direct = (data as { output_text?: string }).output_text;
    if (typeof direct === 'string' && direct) return direct;
    const out = (data as { output?: Array<{ type?: string; content?: Array<{ text?: string }> }> }).output;
    if (Array.isArray(out)) {
      const parts: string[] = [];
      for (const item of out) {
        if (item?.type === 'message' && Array.isArray(item.content)) {
          for (const c of item.content) if (typeof c?.text === 'string') parts.push(c.text);
        }
      }
      if (parts.length) return parts.join('\n');
    }
    return '';
  }
  if (mode === 'completions') {
    return ((data as { choices?: Array<{ text?: string }> }).choices?.[0]?.text || '');
  }
  return ((data as { choices?: Array<{ message?: { content?: string } }> }).choices?.[0]?.message?.content || '');
}

async function callOpenAICompatible(provider: ModelProvider, model: string, messages: ApiMessage[], toolDefs: typeof TOOL_DEFS = []): Promise<ModelReply> {
  const apiKey = decryptKey(provider.apiKeyEnc);
  if (!apiKey) throw new Error(`提供商「${provider.name}」未配置 API Key，请先在设置页配置`);
  const mode = provider.apiMode || 'chat';
  const base = provider.baseUrl.replace(/\/+$/, '');

  // 只有 chat 形态支持 OpenAI function calling；responses/completions 不发 tools。
  const canUseTools = mode === 'chat' && toolDefs.length > 0;
  // 逐级降级：完整 → 不带 tool_choice → 完全不带 tools（部分网关不支持会 400/404/422）。
  const attempts: Array<{ tools: boolean; toolChoice: boolean }> = canUseTools
    ? [{ tools: true, toolChoice: true }, { tools: true, toolChoice: false }, { tools: false, toolChoice: false }]
    : [{ tools: false, toolChoice: false }];

  let lastErr = '';
  for (const att of attempts) {
    const { url, body } = buildRequest(base, mode, model, messages);
    if (att.tools) {
      body.tools = toolDefs;
      if (att.toolChoice) body.tool_choice = 'auto';
    }

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120_000),
      });
    } catch (err) {
      throw new Error(`请求模型接口失败：${(err as Error).message}`);
    }

    if (!res.ok) {
      const txt = await res.text();
      lastErr = `模型 API 返回 HTTP ${res.status}: ${txt.slice(0, 300)}`;
      // 工具相关参数被拒绝 → 降级重试；其余错误直接抛出。
      if (att.tools && [400, 404, 415, 422].includes(res.status)) continue;
      throw new Error(lastErr);
    }

    const data = await res.json() as Record<string, unknown>;
    const errMsg = (data as { error?: { message?: string } }).error?.message;
    if (errMsg) {
      lastErr = errMsg;
      if (att.tools && /tool|function/i.test(errMsg)) continue;
      throw new Error(errMsg);
    }

    const choice = (data as { choices?: Array<{ message?: { content?: string; tool_calls?: unknown } }> }).choices?.[0];
    const toolCalls = normalizeNativeToolCalls(choice?.message?.tool_calls);
    const content = pickOpenAIContent(data, mode) || choice?.message?.content || '';
    return {
      content,
      toolCalls,
      source: toolCalls.length ? 'native' : 'none',
      // 本次是靠「去掉 tools」才成功的 → 告知上层别再下发工具定义。
      toolsRejected: canUseTools && !att.tools ? true : undefined,
    };
  }
  throw new Error(lastErr || '模型调用失败（未知原因）');
}

/** 时间戳 helper */
function nowTime(): string { return new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }); }

// ============================================================================
// OrchDesk 桌面壳主进程（P1–P6）
// ----------------------------------------------------------------------------
// 桥接契约（渲染进程经 contextBridge 调用，红线：nodeIntegration:false）：
//   orchdesk:load-sessions()             启动时拉取持久化会话
//   orchdesk:persist-sessions(arr)       任意变更后落盘
//   orchdesk:run-agent-turn(id,text,opt) Agent 回合（工具调用 + 真实模型）
//   orchdesk:tool-execute(name,args)     执行 Agent 工具（文件/命令/浏览器）
// ============================================================================

// --- 工具执行引擎（Agent Runtime 核心） ---

// --- 工具执行引擎（Agent Runtime 核心）---
// 类型（ToolCall / ToolResult / ApiMessage）与工具定义（TOOL_DEFS / ALLOWED_COMMANDS）
// 统一在 agent-runtime.ts 中定义，便于在 node 下直接单测。

/** 安全沙箱：限制可访问的目录 */
function isPathAllowed(p: string): boolean {
  const resolved = path.resolve(p);
  const roots = [app.getPath('home'), app.getPath('userData'), app.getPath('temp'), dataDir(), process.cwd()];
  return roots.some(root => resolved === root || resolved.startsWith(root + path.sep));
}

/** 允许执行的命令白名单（集合形式，O(1) 判定）。 */
const ALLOWED_COMMAND_SET = new Set(ALLOWED_COMMANDS);

async function executeTool(tool: ToolCall): Promise<ToolResult> {
  const { name, arguments: args } = tool;
  try {
    switch (name) {
      case 'file_read': {
        const filePath = String(args.path || '');
        if (!isPathAllowed(filePath)) return { name, result: '', error: '路径不在允许范围内' };
        const content = fs.readFileSync(filePath, 'utf-8');
        return { name, result: content.slice(0, 50000) }; // 限制 50KB
      }
      case 'file_write': {
        const filePath = String(args.path || '');
        const content = String(args.content || '');
        if (!isPathAllowed(filePath)) return { name, result: '', error: '路径不在允许范围内' };
        const dir = path.dirname(filePath);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(filePath, content, 'utf-8');
        return { name, result: `已写入 ${path.basename(filePath)} (${content.length} 字节)` };
      }
      case 'file_list': {
        const dirPath = String(args.path || '.');
        if (!isPathAllowed(dirPath)) return { name, result: '', error: '路径不在允许范围内' };
        const entries = fs.readdirSync(dirPath, { withFileTypes: true });
        const items = entries.map(e => `${e.isDirectory() ? '📁' : '📄'} ${e.name}`).join('\n');
        return { name, result: items || '(空目录)' };
      }
      case 'shell_command': {
        const cmd = String(args.command || '');
        const cmdName = (cmd.split(/[\s/\\]+/)[0] || '').toLowerCase();
        if (!ALLOWED_COMMAND_SET.has(cmdName)) {
          return { name, result: '', error: `命令「${cmdName}」不在白名单中。允许: ${ALLOWED_COMMANDS.slice(0, 20).join(', ')}...` };
        }
        const { execSync } = await import('node:child_process');
        const output = execSync(cmd, { cwd: app.getPath('home'), encoding: 'utf-8', timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'] });
        return { name, result: output.slice(0, 50000) };
      }
      case 'web_fetch': {
        const url = String(args.url || '');
        if (!url.startsWith('http://') && !url.startsWith('https://')) return { name, result: '', error: 'URL 必须以 http(s) 开头' };
        const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
        const text = await res.text();
        return { name, result: text.slice(0, 30000) };
      }
      default:
        return { name, result: '', error: `未知工具: ${name}` };
    }
  } catch (err) {
    return { name, result: '', error: (err as Error).message };
  }
}


// --- Agent Runtime：模型回合 + 工具调用循环 ---

/** 把一次工具执行同步给渲染层（步骤条 + 通知）。 */
function notifyToolStep(sessionId: string, name: string, ph: 'running' | 'done' | 'error', result?: string): void {
  try {
    const win = BrowserWindow.getAllWindows()[0];
    if (win && !win.isDestroyed()) {
      win.webContents.send('orchdesk:tool-step', { sessionId, name, ph, result: result || '' });
    }
  } catch { /* 忽略：窗口可能已关闭 */ }
}

async function runAgentTurn(sessionId: string, text: string, opts: { models?: string[]; thinkLevel?: string }): Promise<{ text: string; intent: string }> {
  const modelCfg = loadModelConfig();
  if (!modelCfg.providers.length) return { text: '（未配置模型）请先在设置页「模型管理」中添加模型提供商。', intent: 'CONFIRM' };

  const provider = modelCfg.providers[0]!;
  const availableModels = provider.models || [];
  const requested = (opts?.models || [])[0];
  const modelPick = availableModels.includes(requested || '') ? requested : (availableModels[0] || modelCfg.defaultModel);
  const model = modelPick || 'qwen3:14b';

  // 会话不存在时先建壳，避免「渲染层尚未持久化会话」导致本轮消息丢失。
  if (!store[sessionId]) {
    store[sessionId] = { id: sessionId, msgs: [], created: new Date().toISOString(), updated: new Date().toISOString() };
  }

  // 历史：只取 user/assistant 正文（tool 步骤消息是 UI 记录，不回灌模型）。
  const sessionMsgs = (store[sessionId] as { msgs?: Array<{ role?: string; text?: string }> } | undefined)?.msgs || [];
  const apiMessages: ApiMessage[] = sessionMsgs
    .filter(m => (m.role === 'user' || m.role === 'assistant') && m.text)
    .slice(-20)
    .map(m => ({ role: m.role as 'user' | 'assistant', content: m.text as string }));
  apiMessages.unshift({ role: 'system', content: buildSystemPrompt() });
  apiMessages.push({ role: 'user', content: text });

  const toolSteps: Array<{ n: string; ph: 'running' | 'done' | 'error'; result?: string }> = [];
  let finalReply = '';
  let stepCount = 0;
  const MAX_ITERATIONS = Math.max(1, Math.min(200, modelCfg.maxToolIterations || 20));
  // 网关明确拒绝工具协议 → 停止下发 tools，转「文本兜底解析」，
  // 避免每一轮都重复三次降级重试。
  let providerRejectsTools = false;

  // 工具调用循环
  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    const wantsTools = !providerRejectsTools;
    let reply: ModelReply;
    try {
      reply = await callModel(provider, model, apiMessages, wantsTools ? TOOL_DEFS : []);
    } catch (err) {
      return { text: `（模型调用失败）${(err as Error).message}`, intent: 'CONFIRM' };
    }
    if (reply.toolsRejected) {
      providerRejectsTools = true;
      console.warn(`[orchdesk] 提供商「${provider.name}」不接受工具定义，本轮起转为文本兜底解析。`);
    }

    // ---- 模式 1：原生 function calling（优先）----
    if (reply.toolCalls.length) {
      const assistantMsg = buildAssistantToolCallMessage(reply.content, reply.toolCalls as NativeToolCall[]);
      apiMessages.push(assistantMsg);

      for (const tc of reply.toolCalls) {
        stepCount++;
        notifyToolStep(sessionId, tc.name, 'running');
        const result = await executeTool(tc);
        toolSteps.push({ n: tc.name, ph: result.error ? 'error' : 'done', result: result.error || result.result });
        notifyToolStep(sessionId, tc.name, result.error ? 'error' : 'done', result.error || result.result);
        // OpenAI 规范：工具结果用 role='tool' + tool_call_id 回传。
        apiMessages.push(buildToolResultMessage(tc, result, 'native'));
      }
      continue;
    }

    // ---- 模式 2：文本兜底（模型不支持 native tool_calls）----
    const parsed = extractToolCalls(reply.content);
    const usable = parsed.calls.filter(c => isKnownTool(c.name));
    if (!usable.length) {
      finalReply = reply.content || '（模型返回空内容）';
      break;
    }

    apiMessages.push({ role: 'assistant', content: parsed.stripped || `（调用工具：${usable.map(c => c.name).join(', ')}）` });
    for (const tc of usable) {
      stepCount++;
      notifyToolStep(sessionId, tc.name, 'running');
      const result = await executeTool(tc);
      toolSteps.push({ n: tc.name, ph: result.error ? 'error' : 'done', result: result.error || result.result });
      notifyToolStep(sessionId, tc.name, result.error ? 'error' : 'done', result.error || result.result);
      // 文本兜底模式下 assistant 消息里没有 tool_calls，
      // 此时若强行发 role='tool' 会被多数网关判定为非法 → 用 user 角色回传。
      apiMessages.push(buildToolResultMessage({ name: tc.name }, result, 'text'));
    }
  }

  if (!finalReply) finalReply = `（已完成 ${stepCount} 个工具步骤，但模型未给出最终总结）`;

  // 持久化
  const s = store[sessionId] as Record<string, unknown> | undefined;
  if (s) {
    const msgs = (s.msgs as Array<Record<string, unknown>>) || [];
    msgs.push({ role: 'user', text, t: nowTime(), ts: new Date().toISOString() });
    msgs.push({ role: 'assistant', text: finalReply, model, t: nowTime(), ts: new Date().toISOString(), tools: toolSteps, steps: stepCount });
    s.msgs = msgs;
    s.updated = new Date().toISOString();
    saveStore();
  }

  return { text: finalReply, intent: 'ACT' };
}

// IPC
ipcMain.handle('orchdesk:tool-execute', async (_e, tool: ToolCall) => {
  const result = await executeTool(tool);
  return result;
});

// ---------------------------------------------------------------------------
// 模型回合（FR-5 真实闭环）
// 当前实现：OpenAI 兼容 API + Ollama 本地模型；配置存储于 userData/models.json，
// API Key 经 safeStorage 加密。
// ---------------------------------------------------------------------------
function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    center: true,
    show: false,
    backgroundColor: '#1E1E1E',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
}

function createTray(): void {
  tray = new Tray(nativeImage.createEmpty());
  const contextMenu = Menu.buildFromTemplate([
    { label: '打开主窗', click: () => mainWindow?.show() },
    { label: '退出', click: () => app.quit() },
  ]);
  tray.setToolTip('OrchDesk');
  tray.setContextMenu(contextMenu);
}

// ---------------------------------------------------------------------------
// 桥接：渲染进程 → 主进程（持久化 + 模型回合）
// ---------------------------------------------------------------------------
ipcMain.handle('orchdesk:load-sessions', async () => {
  // 只返回有效会话（有真实消息的）；忽略过期数据
  const all = Object.values(store);
  return all.filter((s: any) => s && s.id && Array.isArray(s.msgs) && s.msgs.length > 0);
});
ipcMain.handle('orchdesk:persist-sessions', async (_e, sessions: unknown[]) => {
  store = {};
  (sessions || []).forEach((s: any) => { if (s && s.id && Array.isArray(s.msgs)) store[s.id] = s; });
  saveStore();
  return { ok: true };
});
ipcMain.handle('orchdesk:run-agent-turn', async (_e, sessionId: string, text: string, opts: unknown) => {
  return runAgentTurn(sessionId, text, opts as { models?: string[]; thinkLevel?: string });
});

// ---- FR-5 模型管理桥接 ----
ipcMain.handle('orchdesk:models-get', async () => {
  const cfg = loadModelConfig();
  return { providers: cfg.providers.map(p => ({ id: p.id, name: p.name, type: p.type, baseUrl: p.baseUrl, models: p.models })), defaultProvider: cfg.defaultProvider, defaultModel: cfg.defaultModel, maxToolIterations: cfg.maxToolIterations };
});

ipcMain.handle('orchdesk:models-save', async (_e, config: unknown) => {
  try {
    const current = loadModelConfig();
    const incoming = config as ModelConfig;
    current.providers = incoming.providers.map(p => {
      const existing = current.providers.find(e => e.id === p.id);
      const apiKeyEnc = (p as unknown as Record<string, unknown>).apiKey ? encryptKey((p as unknown as Record<string, unknown>).apiKey as string) : (existing?.apiKeyEnc || '');
      const { apiKey: _k, ...rest } = p as unknown as Record<string, unknown>;
      return { ...rest, apiKeyEnc } as unknown as ModelProvider;
    });
    if (incoming.defaultProvider) current.defaultProvider = incoming.defaultProvider;
    if (incoming.defaultModel) current.defaultModel = incoming.defaultModel;
    if (incoming.maxToolIterations) current.maxToolIterations = Math.max(1, Math.min(500, incoming.maxToolIterations));
    saveModelConfig(current);
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
});

ipcMain.handle('orchdesk:models-test', async (_e, providerId: string, model: string) => {
  const cfg = loadModelConfig();
  const provider = cfg.providers.find(p => p.id === providerId);
  if (!provider) return { ok: false, error: '提供商不存在' };
  const t0 = Date.now();
  try {
    await callModel(provider, model, [{ role: 'user', content: 'ping' }]);
    return { ok: true, latencyMs: Date.now() - t0 };
  } catch (err) {
    return { ok: false, error: (err as Error).message, latencyMs: Date.now() - t0 };
  }
});

// ---------------------------------------------------------------------------
// 授权桥（T-P3-2）：authz 插件经 dsh ctx 暴露 AuthzService；主进程在 dsh ctx
// 就绪后注入 UI 应答回调（把 GUI 弹窗经 IPC 转发渲染层，回传 outcome），
// 并暴露模式读取/切换/分级/审计给渲染层。
//
// 设计：审批弹窗是 GUI 异步参与 —— dsh 工具管道在 open turn 内经 approval/request
// 等待应答；主进程持有 pending resolver map，经 IPC 把请求推给渲染层弹窗，
// 渲染层用户操作后 submitDecision 回传 outcome（fail-closed：超时/异常 → unavailable）。
// ---------------------------------------------------------------------------
type AuthzServiceLike = {
  getMode(sessionId?: string): Promise<string>;
  setMode(mode: string, sessionId?: string): Promise<{ ok: boolean; reason?: string }>;
  getLevels(): Array<{ level: number; label: string; scope: string; requiresApproval: boolean }>;
  getAuditLog(): Array<{ kind: string; ts: number; mode?: string; outcome?: string; toolName?: string; reason?: string; sessionId?: string }>;
  setUiAnswerer(fn: ((req: { toolName: string; reason?: string; sessionId?: string }) => Promise<string>) | null): void;
};

let authzService: AuthzServiceLike | null = null;
const pendingApprovals = new Map<string, { resolve: (o: string) => void; timer: NodeJS.Timeout }>();
let approvalSeq = 0;

/** 在 dsh ctx 就绪后调用（P1-5 接入点）；把 GUI 应答回调注入 authz 插件。 */
export function initAuthzBridge(dshCtx: { get(service: string): unknown }): void {
  const svc = dshCtx.get('authz') as AuthzServiceLike | undefined;
  if (!svc) {
    console.warn('[orchdesk] authz 服务未在 dsh ctx 就绪（authz 插件未加载？）');
    return;
  }
  authzService = svc;
  // 注入 UI 应答回调：dsh approval/request → 推渲染层弹窗 → 等 submitDecision。
  svc.setUiAnswerer(async (req) => {
    const id = `apr-${++approvalSeq}`;
    const outcome = await new Promise<string>((resolve) => {
      const timer = setTimeout(() => {
        pendingApprovals.delete(id);
        resolve('unavailable'); // fail-closed：超时不开门
      }, 120000);
      pendingApprovals.set(id, { resolve, timer });
      mainWindow?.webContents.send('orchdesk:authz-approval-request', {
        id,
        toolName: req.toolName,
        reason: req.reason,
      });
    });
    return outcome;
  });
}

ipcMain.handle('orchdesk:authz-get-mode', async () => {
  if (!authzService) return { mode: 'default' };
  try { return { mode: await authzService.getMode() }; } catch { return { mode: 'default' }; }
});
ipcMain.handle('orchdesk:authz-set-mode', async (_e, mode: string) => {
  if (!authzService) return { ok: false, reason: '授权服务未加载' };
  try { return await authzService.setMode(mode); } catch { return { ok: false, reason: '切换异常' }; }
});
ipcMain.handle('orchdesk:authz-get-levels', async () => {
  if (!authzService) return [];
  try { return authzService.getLevels(); } catch { return []; }
});
ipcMain.handle('orchdesk:authz-get-audit', async () => {
  if (!authzService) return [];
  try { return authzService.getAuditLog(); } catch { return []; }
});
ipcMain.on('orchdesk:authz-submit-decision', (_e, id: string, outcome: string) => {
  const pending = pendingApprovals.get(id);
  if (!pending) return;
  clearTimeout(pending.timer);
  pendingApprovals.delete(id);
  const allowed = ['allowed-once', 'rejected', 'cancelled', 'unavailable'];
  pending.resolve(allowed.includes(outcome) ? outcome : 'unavailable'); // 归一化非法值 → unavailable
});

// ---------------------------------------------------------------------------
// T-P4/T-P5 智能层 + 补偿 + 自进化桥（dsh 服务 seam：ctx.memory / ctx.promptLib /
// ctx.compensation / ctx.evolution）
// 说明：这些服务运行在 dsh in-process ctx（P1-5 runProfile 接入后经 ctx.get 获取，
// 见 runAgentTurn 注释）。当前 dsh ctx 未接入 → 返回与渲染层浏览器预览一致的静态
// 占位值 + warn 日志（不伪造 dsh 数据、不静默）；接入点即 P1-5 runProfile seam。
// ---------------------------------------------------------------------------
function dshBridgeStub(channel: string): void {
  console.warn(`[orchdesk] dsh 服务桥接 ${channel} 未接入（P1-5 runProfile seam），返回静态占位。`);
}
ipcMain.handle('orchdesk:memory-stats', () => {
  dshBridgeStub('memory');
  return null;
});
ipcMain.handle('orchdesk:prompt-list', () => {
  dshBridgeStub('prompt');
  return [];
});
ipcMain.handle('orchdesk:prompt-merge', () => {
  dshBridgeStub('prompt');
  return { sections: [], conflicts: [] };
});
ipcMain.handle('orchdesk:prompt-save', () => {
  dshBridgeStub('prompt');
  return { ok: false };
});
ipcMain.handle('orchdesk:prompt-delete', () => {
  dshBridgeStub('prompt');
  return { ok: false };
});
ipcMain.handle('orchdesk:comp-withhold', () => {
  dshBridgeStub('compensation');
  return { needsConfirm: false, category: 'other', reason: '', warning: '' };
});
ipcMain.handle('orchdesk:comp-compensate', () => {
  dshBridgeStub('compensation');
  return { id: 'cmp-' + Date.now().toString(36), ts: Date.now(), text: '', note: '', action: '' };
});
ipcMain.handle('orchdesk:comp-audit', () => {
  dshBridgeStub('compensation');
  return [];
});
ipcMain.handle('orchdesk:evol-create', () => {
  dshBridgeStub('evolution');
  return { ok: false, reason: '未接入' };
});
ipcMain.handle('orchdesk:evol-list', () => {
  dshBridgeStub('evolution');
  return [];
});
ipcMain.handle('orchdesk:evol-dispose', () => {
  dshBridgeStub('evolution');
  return { ok: false, reason: '未接入' };
});

// ---------------------------------------------------------------------------
// T-P6-1 观雅集技能市场桥（复用 guanji SKILL API 约定；TOKEN 由用户配置）
// ---------------------------------------------------------------------------
ipcMain.handle('orchdesk:guanji-token-status', async () => guanjiClient.tokenStatus());
ipcMain.handle('orchdesk:guanji-set-token', async (_e, token: string) => guanjiClient.setToken(token));
ipcMain.handle('orchdesk:guanji-list', async () => {
  try { return await guanjiClient.listSkills(); } catch { return []; }
});
ipcMain.handle('orchdesk:guanji-install', async (_e, skill: { slug: string; name: string; description: string; caps: string[]; auth: 0 | 1 }, authorized = false) => {
  return guanjiClient.installSkill(skill, authorized === true);
});
ipcMain.handle('orchdesk:guanji-publish', async (_e, input: { slug: string; alias?: string; filePath: string }) => {
  return guanjiClient.publishSkill(input);
});

// ---------------------------------------------------------------------------
// T-P6-2 OrchClaw Hub 联调桥（配对凭据经 safeStorage 加密存储）
// ---------------------------------------------------------------------------
ipcMain.handle('orchdesk:hub-status', async () => hubClient.status());
ipcMain.handle('orchdesk:hub-pair', async (_e, url: string, token: string) => hubClient.pair(url, token));
ipcMain.handle('orchdesk:hub-send', async (_e, text: string) => hubClient.sendTask(text));
ipcMain.handle('orchdesk:hub-result', async (_e, taskId: string) => hubClient.getResult(taskId));

// ---------------------------------------------------------------------------
// T-P6-3 数据快照 + 更新检查（发布前自动快照数据目录）
// ---------------------------------------------------------------------------
function snapshotData(): { ok: boolean; dir?: string; reason?: string } {
  try {
    const root = dataDir();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const snapshotsDir = path.join(root, 'snapshots');
    const snapDir = path.join(snapshotsDir, stamp);
    fs.mkdirSync(snapDir, { recursive: true });
    fs.cpSync(root, snapDir, { recursive: true, filter: (src) => src === root || !src.startsWith(snapshotsDir) });
    return { ok: true, dir: snapDir };
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
}

/** 更新前必须完成数据快照（PLAN 红线：不要更新后补）。 */
async function checkForUpdates(): Promise<{ snapshot: { ok: boolean; dir?: string }; update?: { available: boolean; version?: string; note?: string }; reason?: string }> {
  const snapshot = snapshotData();
  try {
    const { autoUpdater } = await import('electron-updater');
    // 仅在生产包（asar）中启用自动更新，开发模式跳过
    if (!app.isPackaged) {
      return { snapshot, update: { available: false, note: '开发模式，跳过自动更新检查' } };
    }
    autoUpdater.setFeedURL({
      provider: 'github',
      owner: 'ra1nzzz',
      repo: 'orchdesk',
    });
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    const res = await autoUpdater.checkForUpdates();
    return {
      snapshot,
      update: {
        available: !!res?.updateInfo?.version,
        version: res?.updateInfo?.version,
        note: res?.updateInfo?.version
          ? `发现新版本 ${res.updateInfo.version}，正在后台下载…`
          : '已是最新',
      },
    };
  } catch (err) {
    return { snapshot, reason: `更新检查异常：${(err as Error).message}` };
  }
}

ipcMain.handle('orchdesk:snapshot-data', async () => snapshotData());
ipcMain.handle('orchdesk:check-updates', async () => checkForUpdates());

/** 用系统默认文件管理器打开数据目录（项目目录 = userData）。 */
ipcMain.handle('orchdesk:open-project-dir', async () => {
  try {
    await shell.openPath(dataDir());
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
});

/** 打开文件夹选择对话框 */
ipcMain.handle('orchdesk:pick-folder', async () => {
  try {
    const { dialog } = await import('electron');
    const result = await dialog.showOpenDialog(mainWindow!, {
      properties: ['openDirectory'],
      title: '选择项目本地文件夹'
    });
    if (!result.canceled && result.filePaths.length) return { ok: true, path: result.filePaths[0] };
    return { ok: false, reason: 'cancelled' };
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
});

app.whenReady().then(() => {
  // BUG-013：先把历史位置的数据合并进规范化目录，再加载会话。
  try { migrateLegacyData(); } catch (err) { console.warn('[orchdesk] 数据迁移异常:', (err as Error).message); }
  loadStore();
  createWindow();
  createTray();
  // T-P3-2 授权桥 seam：真实 dsh ctx（P1-5 runProfile）接入后，把这里的占位 ctx 换成
  // 真实 in-process ctx（ctx.get('authz') 返回 AuthzService）。当前阶段调用以确保
  // seam 可见性：ctx 未就绪 → 打印 warn，不静默。
  initAuthzBridge({ get: () => undefined });
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
