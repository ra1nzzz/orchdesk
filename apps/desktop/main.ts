/// <reference types="electron" />
import { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, safeStorage, shell } from 'electron';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { guanjiClient } from './guanji';
import { hubClient } from './hub';
import { startRuntime, stopRuntime, getService, getRuntime, getPluginStates, setPluginEnabled } from './dsh-runtime';
import { encryptSecret, decryptSecret, isV1Cipher } from './credentials';
import {
  DATA_DIR_NAMES,
  DATA_FILE_NAMES,
  candidateLegacyDirs,
  mergeProvidersData,
  mergeSessionsData,
  migrateDataDirs,
  migrateDataFiles,
  resolveDataDir,
  setDataDirResolver,
  type MigrateFileSpec,
} from './data-dir';
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
// 启动时会从所有历史候选路径迁移：会话/模型配置按 key 合并，凭据类文件与
// skills 目录「目标侧缺失才搬运」（只在乎不丢，绝不覆盖目标侧已有数据）。
// 目录解析与迁移逻辑全在 data-dir.ts（纯逻辑、无 electron 依赖、可单测）。
// ---------------------------------------------------------------------------

const DATA_FILES: MigrateFileSpec[] = [
  { name: DATA_FILE_NAMES.sessions, mode: 'merge-json', merge: mergeSessionsData },
  { name: DATA_FILE_NAMES.models, mode: 'merge-json', merge: mergeProvidersData },
  // 凭据类：整份搬运，禁止深合并——合并会破坏 safeStorage 密文结构。
  { name: DATA_FILE_NAMES.guanji, mode: 'copy-if-absent' },
  { name: DATA_FILE_NAMES.hub, mode: 'copy-if-absent' },
];
const DATA_DIRS = [DATA_DIR_NAMES.skills];

/** 读取 electron 路径；app 未就绪时返回 undefined（不影响候选目录枚举）。 */
function safeGetPath(name: Parameters<typeof app.getPath>[0]): string | undefined {
  try { return app.getPath(name); } catch { return undefined; }
}

/** exe 所在目录（便携模式判定用）。 */
function safeExeDir(): string | undefined {
  try { return path.dirname(app.getPath('exe')); } catch { return undefined; }
}

let resolvedDataDir: string | null = null;

function dataDir(): string {
  if (resolvedDataDir) return resolvedDataDir;
  const userData = safeGetPath('userData');
  const dir = resolveDataDir({
    envHome: process.env.ORCHDESK_HOME,
    isPackaged: app.isPackaged,
    exeDir: safeExeDir(),
    appData: safeGetPath('appData'),
    userData,
    // 必须显式注入：缺省是 () => false，会让便携模式探测恒失败而永远落 %APPDATA%。
    existsSync: (p) => {
      try { return fs.existsSync(p); } catch { return false; }
    },
    canUse: (d) => {
      try {
        fs.mkdirSync(d, { recursive: true });
        return true;
      } catch (err) {
        // 兜底目录（userData）即使创建失败也照原样返回，交由上层报错。
        if (userData && d === userData) return true;
        console.error('[orchdesk] 数据目录不可用，回退 userData:', (err as Error).message);
        return false;
      }
    },
  });
  resolvedDataDir = dir;
  console.log(`[orchdesk] 数据目录: ${dir}`);
  return dir;
}

// guanji / hub 与主进程共用同一目录：由 data-dir 模块转发（惰性闭包，app 就绪
// 后才真正解析），避免它们反向 import main 造成循环依赖。
setDataDirResolver(() => dataDir());

/** 所有历史可能的数据目录（用于迁移）。 */
function legacyDataDirs(): string[] {
  return candidateLegacyDirs({
    userData: safeGetPath('userData'),
    appData: safeGetPath('appData'),
    isPackaged: app.isPackaged,
    exeDir: safeExeDir(),
    moduleDir: __dirname,
    // 排除目标目录本身：候选里可能含同址路径（大小写/尾分隔符不同），自我迁移无意义。
    exclude: [dataDir()],
  });
}

/**
 * 启动迁移：从所有历史候选目录合并数据到规范化目录。
 * 只「补齐」不「覆盖」——目标侧已存在的数据永远优先。
 */
function migrateLegacyData(): void {
  const target = dataDir();
  const sources = legacyDataDirs();
  for (const r of migrateDataFiles({ targetDir: target, sourceDirs: sources, files: DATA_FILES })) {
    if (r.moved) console.log(`[orchdesk] 迁移 ${r.file}（${r.added} 项）：${r.from}`);
  }
  for (const r of migrateDataDirs({ targetDir: target, sourceDirs: sources, dirs: DATA_DIRS })) {
    if (r.moved) console.log(`[orchdesk] 迁移目录 ${r.dir}（${r.copied} 个文件）：${r.from}`);
  }
}

function sessionsFile(): string {
  // 惰性获取：app.getPath 需在 app ready 之后才稳定可用。
  return path.join(dataDir(), DATA_FILE_NAMES.sessions);
}

function projectsFile(): string {
  return path.join(dataDir(), 'orchdesk-projects.json');
}

/** 项目分组（侧栏层级）持久化；此前缺失导致重启后项目全丢。 */
function loadProjects(): Array<Record<string, unknown>> {
  try {
    const file = projectsFile();
    if (!fs.existsSync(file)) return [];
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return Array.isArray(raw) ? raw : [];
  } catch (err) {
    console.error('[orchdesk] 读取项目分组失败:', (err as Error).message);
    return [];
  }
}

function saveProjects(projects: Array<Record<string, unknown>>): void {
  try {
    fs.writeFileSync(projectsFile(), JSON.stringify(projects), 'utf-8');
  } catch (err) {
    console.error('[orchdesk] 写入项目分组失败:', (err as Error).message);
  }
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

const MODELS_FILE = () => path.join(dataDir(), DATA_FILE_NAMES.models);

function loadModelConfig(): ModelConfig {
  try {
    const file = MODELS_FILE();
    if (!fs.existsSync(file)) return { providers: [], defaultProvider: 'ollama', defaultModel: 'qwen3:14b' };
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, unknown>;
    let migrated = false;
    const providers = (raw.providers as Array<Record<string, unknown>> | undefined)?.map(p => {
      const { apiKey: _k, ...rest } = p;
      const prov = rest as unknown as ModelProvider;
      // 明文 key（用户手改 models.json 塞入）就地加密迁移为 apiKeyEnc，不再静默丢弃。
      // 注意：任何分支都禁止把明文写进日志。
      if (typeof p.apiKey === 'string' && p.apiKey) {
        const enc = encryptKey(p.apiKey);
        if (enc) { prov.apiKeyEnc = enc; migrated = true; }
      }
      return prov;
    }) || [];
    const cfg: ModelConfig = {
      providers,
      defaultProvider: (raw.defaultProvider as string | undefined) || 'ollama',
      defaultModel: (raw.defaultModel as string | undefined) || 'qwen3:14b',
      maxToolIterations: (raw.maxToolIterations as number | undefined) || 200,
    };
    const hasPlainKey = migrated;
    if (hasPlainKey) saveModelConfig(cfg);
    return cfg;
  } catch { return { providers: [], defaultProvider: 'ollama', defaultModel: 'qwen3:14b', maxToolIterations: 200 }; }
}

function saveModelConfig(cfg: ModelConfig): void {
  fs.writeFileSync(MODELS_FILE(), JSON.stringify(cfg, null, 2), 'utf-8');
}

/**
 * 加密 API Key。
 * 优先用 PRD 要求的 AES-256-GCM + 机器指纹派生（credentials.ts）；
 * 若该路径失败（极老版本 safeStorage 密文），回落 safeStorage 以保兼容。
 * 无加密后端时**不**写明文，返回空串并告警（PRD NFR：凭据必须加密）。
 */
function encryptKey(key: string): string {
  if (!key) return '';
  try {
    const enc = encryptSecret(key);
    if (enc) return enc;
  } catch (err) {
    console.warn('[orchdesk] AES-256-GCM 加密失败，回落 safeStorage:', (err as Error).message);
  }
  if (!safeStorage.isEncryptionAvailable()) {
    console.error('[orchdesk] 无可用加密后端，API Key 未保存（拒绝明文落盘）');
    return '';
  }
  return safeStorage.encryptString(key).toString('base64');
}

/**
 * 解密 API Key。
 * v1 密文走 AES-256-GCM；历史 safeStorage 密文自动兼容，并在下次保存时升级。
 */
function decryptKey(encB64?: string): string {
  if (!encB64) return '';
  // 1) 新格式：AES-256-GCM（机器指纹派生）
  if (isV1Cipher(encB64)) {
    const v = decryptSecret(encB64);
    if (v) return v;
    console.warn('[orchdesk] AES-256-GCM 密文解密失败（可能换过机器），请在设置页重新填写 API Key');
    return '';
  }
  // 2) 历史格式：safeStorage
  try {
    if (!safeStorage.isEncryptionAvailable()) return '';
    return safeStorage.decryptString(Buffer.from(encB64, 'base64')) as unknown as string;
  } catch {
    return '';
  }
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
  if (!res.ok) throw new Error(`Ollama 返回 HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
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
    // OpenAI Responses 规范：input 接受完整消息数组。system 角色映射为 developer，
    // 并保留 assistant 历史 —— 此前只拼 user 文本，导致 responses 模式丢失系统提示词
    // （含 <tool:> 兜底格式说明）与多轮上下文，多轮对话直接断裂。
    const input = messages.map(m => ({
      role: m.role === 'system' ? 'developer' as const : m.role,
      content: m.content || '',
    }));
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

/**
 * 命令执行的工作目录：必须是**存在**的目录，否则子进程 spawn 直接 ENOENT。
 * 依次尝试 user home → 数据目录 → 当前工作目录 → 系统临时目录。
 */
function resolveShellCwd(): string {
  const candidates: string[] = [];
  try { candidates.push(app.getPath('home')); } catch { /* ignore */ }
  try { candidates.push(os.homedir()); } catch { /* ignore */ }
  try { candidates.push(dataDir()); } catch { /* ignore */ }
  candidates.push(process.cwd(), os.tmpdir());
  for (const c of candidates) {
    try {
      if (c && fs.existsSync(c) && fs.statSync(c).isDirectory()) return c;
    } catch { /* 继续尝试下一个 */ }
  }
  return os.tmpdir();
}

// app.getPath 结果缓存：isPathAllowed 是工具执行热路径（每个 file_* 工具一次），
// 历史实现每次调用都跑 3 次 getPath。app 未就绪时拿不到路径，此时不缓存，下次再试。
let cachedAllowedRoots: string[] | null = null;
function allowedRoots(): string[] {
  if (!cachedAllowedRoots) {
    const roots: string[] = [];
    for (const name of ['home', 'userData', 'temp'] as const) {
      const p = safeGetPath(name);
      if (p) roots.push(path.resolve(p));
    }
    if (roots.length) cachedAllowedRoots = roots;
  }
  return cachedAllowedRoots ?? [];
}

/** 安全沙箱：限制可访问的目录 */
function isPathAllowed(p: string): boolean {
  const resolved = path.resolve(p);
  const roots = [...allowedRoots(), dataDir(), process.cwd()];
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
        if (!cmdName) return { name, result: '', error: '命令为空' };
        if (!ALLOWED_COMMAND_SET.has(cmdName)) {
          return { name, result: '', error: `命令「${cmdName}」不在白名单中。允许: ${ALLOWED_COMMANDS.slice(0, 20).join(', ')}...` };
        }
        // 进程隔离 + 不阻塞主进程：在子进程中异步执行。
        // 此前用 execSync 直接在主进程跑 —— 30 秒超时内整个 UI 无响应，
        // 且命令崩溃会连带主进程。改 exec（异步、独立进程、超时可杀）。
        const { exec } = await import('node:child_process');
        const cwd = resolveShellCwd();
        try {
          const output = await new Promise<string>((resolve, reject) => {
            const child = exec(cmd, {
              cwd,
              encoding: 'utf-8',
              timeout: 30_000,
              maxBuffer: 8 * 1024 * 1024,
              windowsHide: true,
            }, (err, stdout, stderr) => {
              if (err) {
                // 超时被杀也要把已产出的输出交回，便于诊断
                const partial = `${stdout || ''}${stderr ? '\n[stderr]\n' + stderr : ''}`;
                reject(new Error(`${(err as Error).message}${partial ? '：' + partial.slice(0, 500) : ''}`));
                return;
              }
              resolve(`${stdout || ''}${stderr ? '\n[stderr]\n' + stderr : ''}`);
            });
            child.on('error', reject);
          });
          return { name, result: output.slice(0, 50000) };
        } catch (err) {
          return { name, result: '', error: (err as Error).message.slice(0, 2000) };
        }
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

// 插件真实热插拔（FR-3）：启用 = 注册 effect，停用 = 逆回滚，不重启、无残留
ipcMain.handle('orchdesk:plugin-set-enabled', async (_e, name: string, enabled: boolean) => {
  try {
    const state = await setPluginEnabled(String(name || ''), enabled === true);
    return { ok: true, ...state };
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
});
ipcMain.handle('orchdesk:persist-sessions', async (_e, sessions: unknown[]) => {
  store = {};
  (sessions || []).forEach((s: any) => { if (s && s.id && Array.isArray(s.msgs)) store[s.id] = s; });
  saveStore();
  return { ok: true };
});

// 项目分组持久化（BUG：此前只存 sessions，重启后项目全丢、会话退化为「任务」组）
ipcMain.handle('orchdesk:load-projects', async () => loadProjects());
ipcMain.handle('orchdesk:persist-projects', async (_e, projects: unknown[]) => {
  if (!Array.isArray(projects)) return { ok: false, reason: 'projects 必须是数组' };
  saveProjects(projects as Array<Record<string, unknown>>);
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
    // 与运行时钳制一致（1–200，见 runAgentTurn 的 MAX_ITERATIONS），保证所见即所得。
    if (incoming.maxToolIterations) current.maxToolIterations = Math.max(1, Math.min(200, incoming.maxToolIterations));
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
// 授权桥（T-P3-2 + BUG-014 接线）：authz 插件由 dsh-runtime 真实装载后，
// 经 ctx.get('authz') 取得 AuthzService。主进程把 GUI 应答回调注入该服务：
// dsh 工具管道在回合内经 approval/request 等待应答 → 推渲染层弹窗 →
// 用户操作后 submitDecision 回传 outcome（fail-closed：超时/异常 → unavailable）。
//
// 关键修复：此前这里传入占位 ctx（{get: () => undefined}），导致 authzService
// 恒为 null，L0–L4 矩阵 / 审计日志 / 审批弹窗 / 模式切换四块 UI 全部空转。
// ---------------------------------------------------------------------------
type AuthzServiceLike = {
  getMode(sessionId?: string): Promise<string>;
  setMode(mode: string, sessionId?: string): Promise<{ ok: boolean; reason?: string }>;
  getLevels(): Array<{ level: number; label: string; scope: string; requiresApproval: boolean }>;
  getAuditLog(): Array<{ kind: string; ts: number; mode?: string; outcome?: string; toolName?: string; reason?: string; sessionId?: string }>;
  setUiAnswerer(fn: ((req: { toolName: string; reason?: string; sessionId?: string }) => Promise<string>) | null): void;
  getModes?(): Array<{ id: string; label: string; sandboxMode: string; approvalPolicy: string }>;
  subscribe?(cb: (evt: unknown) => void): () => void;
};

let authzService: AuthzServiceLike | null = null;
const pendingApprovals = new Map<string, { resolve: (o: string) => void; timer: NodeJS.Timeout }>();
let approvalSeq = 0;

/**
 * 启动 dsh 运行时并把 GUI 应答方 / SubAgent 运行器注入宿主服务。
 * 失败不阻断启动（应用仍可用），但会明确记录，不静默降级。
 */
async function bootRuntime(): Promise<void> {
  try {
    const runtime = await startRuntime();

    // 1) 授权服务
    const authz = getService<AuthzServiceLike>('authz');
    if (authz) {
      authzService = authz;
      authz.setUiAnswerer(async (req) => {
        const id = `apr-${++approvalSeq}`;
        return new Promise<string>((resolve) => {
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
      });
      console.log('[orchdesk] 授权服务已接入（三模式 + L0–L4 + fail-closed）');
    } else {
      console.warn('[orchdesk] authz 服务不可用（插件未激活）');
    }

    // 2) SubAgent 运行器：复用现有 callModel + 工具循环
    runtime.host?.setAgentRunner(async ({ messages }) => {
      const cfg = loadModelConfig();
      if (!cfg.providers.length) return { text: '（未配置模型）SubAgent 无法执行' };
      const provider = cfg.providers[0]!;
      const model = (provider.models || [])[0] || cfg.defaultModel || 'qwen3:14b';
      const reply = await callModel(provider, model, messages as ApiMessage[]);
      return { text: reply.content };
    });
    console.log('[orchdesk] SubAgent 运行器已接入');
  } catch (err) {
    console.error('[orchdesk] dsh 运行时启动失败，插件能力不可用:', (err as Error).message);
  }
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
// T-P4/T-P5 智能层 + 补偿 + 自进化桥
// ----------------------------------------------------------------------------
// BUG-014 接线：此前这些 handler 统一调用 dshBridgeStub 返回静态占位（11 个），
// 导致记忆/提示词/补偿/自进化四块 UI 永久空转。现在改为调用 dsh-runtime 中
// 真实装载的插件服务；服务不可用时返回 null 并明确告知渲染层「未接入」，
// 而不是塞一份假数据（项目铁律：不伪造、不静默）。
// ----------------------------------------------------------------------------

/** 服务不可用时统一返回结构（渲染层据此显示「未接入」，不显示假数据）。 */
function unavailable(reason: string): { ok: false; unavailable: true; reason: string } {
  return { ok: false, unavailable: true, reason };
}

// ---- 分层记忆（memory 插件）----
interface MemoryServiceLike {
  getStats(): unknown;
  dump(sessionId: string, msgs: unknown[], opts?: unknown): Promise<unknown>;
  recall(query: string, opts?: unknown): Promise<unknown>;
  listDomain?(domain: string): unknown;
}
ipcMain.handle('orchdesk:memory-stats', () => {
  const svc = getService<MemoryServiceLike>('memory');
  return svc ? svc.getStats() : null;
});
ipcMain.handle('orchdesk:memory-recall', async (_e, query: string, opts: unknown) => {
  const svc = getService<MemoryServiceLike>('memory');
  if (!svc) return null;
  return svc.recall(String(query || ''), opts || {});
});

// ---- 系统提示词库（prompt 插件）----
interface PromptServiceLike {
  list(): unknown;
  get(id: string): unknown;
  create(input: unknown): unknown;
  update(id: string, patch: unknown): unknown;
  remove(id: string): unknown;
  mergeForAgent(agentId: string): unknown;
}
ipcMain.handle('orchdesk:prompt-list', () => {
  const svc = getService<PromptServiceLike>('promptLib');
  return svc ? svc.list() : [];
});
ipcMain.handle('orchdesk:prompt-merge', (_e, agentId: string) => {
  const svc = getService<PromptServiceLike>('promptLib');
  return svc ? svc.mergeForAgent(String(agentId || '')) : { sections: [], conflicts: [] };
});
ipcMain.handle('orchdesk:prompt-save', (_e, input: unknown) => {
  const svc = getService<PromptServiceLike>('promptLib');
  if (!svc) return unavailable('提示词库插件未接入');
  try {
    const doc = input as { id?: string } & Record<string, unknown>;
    return doc.id ? svc.update(String(doc.id), doc) : svc.create(doc);
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
});
ipcMain.handle('orchdesk:prompt-delete', (_e, id: string) => {
  const svc = getService<PromptServiceLike>('promptLib');
  if (!svc) return unavailable('提示词库插件未接入');
  return svc.remove(String(id || ''));
});

// ---- 边界外补偿层（compensation 插件）----
interface CompensationServiceLike {
  classify(text: string): unknown;
  requiresWithhold(category: string): unknown;
  withhold(input: unknown): Promise<unknown>;
  compensate(input: unknown): unknown;
  getAudit(): unknown;
}
ipcMain.handle('orchdesk:comp-withhold', async (_e, text: string) => {
  const svc = getService<CompensationServiceLike>('compensation');
  if (!svc) return unavailable('补偿层插件未接入');
  return svc.withhold({ text: String(text || '') });
});
ipcMain.handle('orchdesk:comp-compensate', (_e, input: unknown) => {
  const svc = getService<CompensationServiceLike>('compensation');
  if (!svc) return unavailable('补偿层插件未接入');
  return svc.compensate(input || {});
});
ipcMain.handle('orchdesk:comp-audit', () => {
  const svc = getService<CompensationServiceLike>('compensation');
  return svc ? svc.getAudit() : [];
});

// ---- 自进化（evolution 插件）----
interface EvolutionServiceLike {
  createTempPlugin(spec: unknown, opts?: unknown): Promise<unknown>;
  list(): unknown;
  disposeTempPlugin(id: string): Promise<unknown>;
  getAudit(): unknown;
}
ipcMain.handle('orchdesk:evol-create', async (_e, spec: unknown, opts: unknown) => {
  const svc = getService<EvolutionServiceLike>('evolution');
  if (!svc) return unavailable('自进化插件未接入');
  return svc.createTempPlugin(spec, opts || {});
});
ipcMain.handle('orchdesk:evol-list', () => {
  const svc = getService<EvolutionServiceLike>('evolution');
  return svc ? svc.list() : [];
});
ipcMain.handle('orchdesk:evol-dispose', async (_e, id: string) => {
  const svc = getService<EvolutionServiceLike>('evolution');
  if (!svc) return false;
  return svc.disposeTempPlugin(String(id || ''));
});

// ---- 编排目录（multi 插件）：替换渲染层硬编码的 8 专家 + 3 团 ----
interface OrchestrationServiceLike {
  getCatalog(): unknown;
  getDelegationTree(): unknown;
}
ipcMain.handle('orchdesk:orchestration-catalog', () => {
  const svc = getService<OrchestrationServiceLike>('orchestration');
  return svc ? svc.getCatalog() : null;
});

// ---- 插件运行时状态（供设置页状态条与插件页展示真实数据，替代硬编码常量）----
ipcMain.handle('orchdesk:plugin-runtime', () => {
  const rt = getRuntime();
  return {
    ready: !!rt,
    activeCount: rt?.activeCount ?? 0,
    total: rt?.plugins.length ?? 0,
    plugins: getPluginStates(),
  };
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
    const opts = { properties: ['openDirectory' as const], title: '选择项目本地文件夹' };
    // 主窗可能尚未创建（托盘/菜单触发），勿用非空断言
    const result = mainWindow ? await dialog.showOpenDialog(mainWindow, opts) : await dialog.showOpenDialog(opts);
    if (!result.canceled && result.filePaths.length) return { ok: true, path: result.filePaths[0] };
    return { ok: false, reason: 'cancelled' };
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
});

// ---------------------------------------------------------------------------
// BUG-013 方案 B：数据导出 / 导入（跨机器迁移 + 手动备份，单文件 JSON）
// ----------------------------------------------------------------------------
// 导出 = 数据目录内全部业务数据打包为一个可读 JSON（kind: orchdesk-backup）。
// 导入 = 与启动迁移同一套「只补齐不覆盖」合并策略：
//   sessions/models 走 merge-json（同 id 保留较新），guanji/hub 凭据类走
//   copy-if-absent（不深合并，避免破坏密文结构），projects 按 id 补齐。
// 注意：apiKeyEnc / hub tokenCipher 是机器绑定的密文，跨机器导入后解密会失败
// ——此时对应凭据视为未配置，需在设置页重新填写（导入摘要中提示，不静默）。
// ---------------------------------------------------------------------------
const BACKUP_KIND = 'orchdesk-backup';

/** 备份包内允许出现的数据键（白名单，防止导入包夹带任意文件写入）。 */
const BACKUP_SECTIONS = ['sessions', 'projects', 'models', 'guanji', 'hub'] as const;

/** 导入备份体积上限：超出按无效文件拒绝，防止主进程被超大 JSON 阻塞。 */
const MAX_IMPORT_BYTES = 256 * 1024 * 1024;

/**
 * 凭据类结构校验（fail-closed）：伪造备份不得绕过「无加密后端拒绝明文落盘」。
 * guanji.json = { enc: base64密文 }；hub.json = { url, tokenCipher }。
 */
function credentialSectionValid(name: string, data: unknown): boolean {
  const d = data as Record<string, unknown>;
  if (!d || typeof d !== 'object') return false;
  if (name === DATA_FILE_NAMES.guanji) return typeof d.enc === 'string' && d.enc.length > 0;
  if (name === DATA_FILE_NAMES.hub) {
    return typeof d.url === 'string' && d.url.length > 0 && typeof d.tokenCipher === 'string' && d.tokenCipher.length > 0;
  }
  return false;
}

function readJsonFile(file: string): unknown | null {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch { return null; }
}

/** 把备份包内的凭据类（guanji/hub）搬进数据目录：目标不存在才写，绝不覆盖。 */
function importCredentialSection(root: string, name: string, data: unknown, imported: Record<string, number>): boolean {
  if (data == null || typeof data !== 'object') return false;
  const target = path.join(root, name);
  if (fs.existsSync(target)) return false; // 目标侧已有凭据：保留，不覆盖
  fs.writeFileSync(target, JSON.stringify(data), 'utf-8');
  imported[name.replace(/\.json$/, '')] = 1;
  return true;
}

ipcMain.handle('orchdesk:export-data', async () => {
  try {
    const { dialog } = await import('electron');
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const opts = {
      title: '导出 OrchDesk 数据',
      defaultPath: `orchdesk-backup-${stamp}.json`,
      filters: [{ name: 'OrchDesk 备份', extensions: ['json'] }],
    };
    // 主窗可能尚未创建（如托盘菜单触发）：electron 允许无窗调用，勿用非空断言
    const result = mainWindow ? await dialog.showSaveDialog(mainWindow, opts) : await dialog.showSaveDialog(opts);
    if (result.canceled || !result.filePath) return { ok: false, reason: 'cancelled' };
    const root = dataDir();
    const bundle: Record<string, unknown> = {
      kind: BACKUP_KIND,
      version: 1,
      exportedAt: new Date().toISOString(),
    };
    for (const section of BACKUP_SECTIONS) {
      const file = section === 'projects' ? projectsFile() : path.join(root, DATA_FILE_NAMES[section]);
      bundle[section] = readJsonFile(file);
    }
    fs.writeFileSync(result.filePath, JSON.stringify(bundle, null, 2), 'utf-8');
    return { ok: true, path: result.filePath };
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
});

ipcMain.handle('orchdesk:import-data', async () => {
  try {
    const { dialog } = await import('electron');
    const openOpts = {
      title: '导入 OrchDesk 数据',
      properties: ['openFile' as const],
      filters: [{ name: 'OrchDesk 备份', extensions: ['json'] }],
    };
    const result = mainWindow ? await dialog.showOpenDialog(mainWindow, openOpts) : await dialog.showOpenDialog(openOpts);
    if (result.canceled || !result.filePaths.length) return { ok: false, reason: 'cancelled' };
    const srcFile = result.filePaths[0]!;
    try {
      const stat = fs.statSync(srcFile);
      if (stat.size > MAX_IMPORT_BYTES) {
        return { ok: false, reason: `备份文件过大（${Math.round(stat.size / 1024 / 1024)}MB，上限 256MB）` };
      }
    } catch { /* 文件此刻不可读时交给后续 readJsonFile 报错 */ }
    const raw = readJsonFile(srcFile);
    if (!raw || typeof raw !== 'object' || (raw as Record<string, unknown>).kind !== BACKUP_KIND) {
      return { ok: false, reason: '不是有效的 OrchDesk 备份文件（缺少 kind 标识）' };
    }
    const bundle = raw as Record<string, unknown>;
    const root = dataDir();
    const imported: Record<string, number> = { sessions: 0, projects: 0, providers: 0 };

    // sessions / models：与启动迁移同一套合并器（只补齐不覆盖）
    const sessionsFile = path.join(root, DATA_FILE_NAMES.sessions);
    const sessOutcome = mergeSessionsData(readJsonFile(sessionsFile), bundle.sessions);
    if (sessOutcome && sessOutcome.changed) {
      fs.writeFileSync(sessionsFile, JSON.stringify(sessOutcome.data), 'utf-8');
      imported.sessions = sessOutcome.added;
    }
    const modelsFile = path.join(root, DATA_FILE_NAMES.models);
    const modelOutcome = mergeProvidersData(readJsonFile(modelsFile), bundle.models);
    if (modelOutcome && modelOutcome.changed) {
      fs.writeFileSync(modelsFile, JSON.stringify(modelOutcome.data), 'utf-8');
      imported.providers = modelOutcome.added;
    }

    // projects：按 id 补齐（目标侧已有的项目保持不变）
    const curProjects = loadProjects();
    const srcProjects = Array.isArray(bundle.projects) ? bundle.projects as Array<Record<string, unknown>> : [];
    const known = new Set(curProjects.map((p) => String(p.id ?? '')));
    const addProjects = srcProjects.filter((p) => p && p.id && !known.has(String(p.id)));
    if (addProjects.length) {
      saveProjects([...curProjects, ...addProjects]);
      imported.projects = addProjects.length;
    }

    // 凭据类：copy-if-absent + 结构校验（伪造备份不得写入明文凭据）
    const notes: string[] = [];
    for (const [key, fileName] of [['guanji', DATA_FILE_NAMES.guanji], ['hub', DATA_FILE_NAMES.hub]] as const) {
      const section = bundle[key];
      if (section == null) continue;
      if (!credentialSectionValid(fileName, section)) {
        notes.push(`${key === 'hub' ? 'Hub' : '观雅集'}凭据结构无效，已跳过（拒绝明文凭据落盘）`);
        continue;
      }
      if (importCredentialSection(root, fileName, section, imported)) {
        notes.push(`${key === 'hub' ? 'Hub 配对凭据' : '观雅集 TOKEN'} 已导入（跨机器时密文不可解，需重新配置）`);
      }
    }

    // 内存态重载（渲染层随后自行拉取新会话/项目）
    loadStore();
    return { ok: true, imported, notes, path: srcFile };
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
});

app.whenReady().then(async () => {
  // BUG-013：先把历史位置的数据合并进规范化目录，再加载会话。
  try { migrateLegacyData(); } catch (err) { console.warn('[orchdesk] 数据迁移异常:', (err as Error).message); }
  loadStore();

  // 数据目录确定后告知宿主服务（沙箱状态落盘位置）。
  process.env.ORCHDESK_DATA_DIR = dataDir();

  // BUG-014 根因修复：启动真实 Cordis 运行时（宿主服务 + 9 个插件），
  // 此前 packages/plugin/* 从未被加载，FR-7/9/10/11/12/13 在应用内全是空壳。
  await bootRuntime();

  createWindow();
  createTray();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  // 触发全部插件的逆效应（卸载无残留）
  void stopRuntime();
});
