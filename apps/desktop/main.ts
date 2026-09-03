/// <reference types="electron" />
import { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, safeStorage, shell, globalShortcut, Notification, screen } from 'electron';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import {
  DEFAULT_DESKTOP_CONFIG,
  DESKTOP_LABELS,
  SHORTCUT_ACCELERATOR,
  SHORTCUT_LABEL,
  floatingWindowHtml,
  isDesktopKey,
  loadDesktopConfig,
  saveDesktopConfig,
  setDesktopKey,
  type DesktopConfig,
  type DesktopKey,
} from './desktop-integration';
import { guanjiClient } from './guanji';
import {
  CONNECTOR_CATALOG,
  CONNECTOR_PROBE_TIMEOUT_MS,
  appendAudit as appendConnectorAudit,
  buildProbeRequest,
  clearCreds,
  emptyConnectorFile,
  getConnectorDef,
  interpretProbeResult,
  isConnectorId,
  normalizeConnectorFile,
  readCreds,
  redactCreds,
  searchAudit as searchConnectorAudit,
  auditStats as connectorAuditStats,
  writeCreds,
  type ConnectorAuditAction,
  type ConnectorAuditEntry,
  type ConnectorFile,
} from './connector-registry';
import { hubClient } from './hub';
import {
  aggregateUsage,
  appendUsageTurn,
  defaultUsageFile,
  normalizeApiUsage,
  readUsageFile,
  writeUsageFile,
  type UsageEntry,
  type UsageFile,
} from './usage-registry';
import {
  appendEvents,
  collectLabeled,
  eventFileFor,
  hasIncompleteAncestry,
  readEvents,
  rebuildContext,
  sanitizeSessionId,
  timelineFromLabeled,
  type SessionEvent,
} from './session-events';
import { startRuntime, stopRuntime, getService, getRuntime, getPluginStates, setPluginEnabled, firePreStep, persistGrantsNow, listMarketPlugins, setMarketPluginEnabled, startupMarketPlugins, marketDir } from './dsh-runtime';
import { normalizeEnabledMap } from './plugin-market';
import { getHostServices } from './host-services';
import {
  normalizeSandboxLog,
  appendSandboxLog,
  searchSandboxLog,
  sandboxLogStats,
  SANDBOX_LOG_MAX,
  type SandboxLogEntry,
  type SandboxLogQuery,
} from './sandbox-log';
import {
  normalizePromotionLog,
  appendPromotionLog,
  searchPromotionLog,
  promotionStats,
  PROMOTION_LOG_MAX,
  isMemoryDomain,
  type PromotionEntry,
  type PromotionLogQuery,
} from './memory-promotion';
import {
  buildSummarizeMessages,
  clampSummary,
  extractSummarizeText,
  withTimeout,
  SUMMARIZE_TIMEOUT_MS,
} from './memory-summarize';
import { encryptSecret, decryptSecret, isV1Cipher } from './credentials';
import { initLogger, mirrorConsole, log, logModel, logFilePath } from './logger';
import {
  DATA_DIR_NAMES,
  DATA_FILE_NAMES,
  candidateLegacyDirs,
  mergeProvidersData,
  mergeSessionsData,
  migrateDataDirs,
  migrateDataFiles,
  formatBytes,
  resolveDataDir,
  scanDataDir,
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
import { isAbsoluteLike } from './common-tools';
import {
  buildClickExpression,
  buildLinksExpression,
  buildTextExpression,
  buildTypeExpression,
  buildWaitForSelectorExpression,
  clipBrowserText,
  describeBrowserState,
  normalizeBrowserArgs,
  scanScriptRisks,
  type BrowserStateSnapshot,
} from './browser-tools';
import {
  browserShotDir,
  closeBrowser as cdpCloseBrowser,
  evalInPage,
  getBrowserState,
  onBrowserStateChange,
  openBrowser as cdpOpenBrowser,
  screenshotBrowser,
  setBrowserVisible,
} from './browser-cdp';
import {
  createTerminal,
  ensurePtyLoaded,
  getTerminalState,
  killTerminal,
  onTerminalData,
  onTerminalExit,
  resizeTerminal,
  writeTerminal,
} from './terminal-pty';
import {
  humanSize,
  languageOf,
  looksBinaryByName,
  normalizeFileRead,
  normalizeFileTree,
  normalizeFileWrite,
  sniffBinary,
  sortTreeEntries,
  FILE_TREE_MAX_ENTRIES,
  SNIFF_WINDOW,
} from './file-panel';

// ============================================================================
// OrchDesk 桌面壳主进程（P1）
// ----------------------------------------------------------------------------
// 桥接契约（渲染进程经 contextBridge 调用，红线：nodeIntegration:false）：
//   orchdesk:load-sessions()             启动时拉取持久化会话（空 = 首次运行）
//   orchdesk:persist-sessions(arr)       任意变更后落盘（userData JSON，可重启回放）
//   orchdesk:run-agent-turn(id,text,opt) 模型回合 seam：真实 dsh ctx / Ollama 在此接入
//
// 设计：渲染进程持有 UI 会话状态；主进程负责「持久化」与「模型运行时」两层。
// run-agent-turn 走主进程自实现的 OpenAI 兼容 HTTP 回合循环（runAgentTurn，
// 工具经 executeTool 双模式：原生 function calling / 文本兜底），未走 dsh 的
// ctx.agents.followup seam（后者留作未来切 dsh 原生于代理循环时的入口）。
// ============================================================================

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
const isDev = !app.isPackaged;

// ---------------------------------------------------------------------------
// IPC sender 校验（遗留项①，纵深防御）：全仓唯一带 preload 的窗口是 mainWindow
// （悬浮窗 floatingWindow 与浏览器窗 browser-cdp 均无 preload → 无 ipcRenderer，
// 发不出 invoke）。故唯一可信 IPC 调用方 = mainWindow.webContents。
//
// fail-closed 语义：
//   - event.sender 为 null/undefined → 放行。这是进程内直调（verify 套件 stub
//     dist/main.js 后以 (null, args) 直调 handler、以及任何无 IPC 上下文的调用），
//     不是来自某个 webContents 的真实 IPC，无渲染层威胁面。
//   - event.sender 是真实 webContents → 必须 === mainWindow.webContents，否则拒绝。
//     当前不存在第二可信窗；未来若加带 preload 的合法窗，在此白名单追加。
//
// 实现：顶层 patch ipcMain.handle 一次。因 92 个 handler 全经 ipcMain.handle 注册
// （模块顶层 + bootRuntime 内），此 patch 在首个注册（orchdesk:tool-execute）之前
// 生效即全覆盖，无需逐个改动。拒绝一律抛错（fail-closed，不静默回假数据）。
// ---------------------------------------------------------------------------
function isTrustedIpcSender(sender: unknown): boolean {
  if (sender == null) return true; // 进程内直调（测试后门等），非真实 webContents
  try {
    return !!(mainWindow && !mainWindow.isDestroyed() && sender === mainWindow.webContents);
  } catch { return false; }
}
// 可被 verify 套件断言（不导出默认走 tsc 无害；仅供测试观测校验决策）
const _ipcHandleOrig = ipcMain.handle.bind(ipcMain);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(ipcMain as any).handle = (channel: string, listener: (event: any, ...args: any[]) => any): void => {
  _ipcHandleOrig(channel, async (event: any, ...args: any[]): Promise<any> => {
    if (!isTrustedIpcSender(event && event.sender)) {
      console.warn(`[orchdesk] 拒绝不可信 IPC sender 调用 ${channel}（仅主窗可信）`);
      throw new Error(`ipc:untrusted-sender:${channel}`);
    }
    return listener(event, ...args);
  });
};

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
  // 沙箱日志：换数据目录后要能接着追溯历史判定，故随目录迁移。
  { name: DATA_FILE_NAMES.sandboxLog, mode: 'copy-if-absent' },
  // 晋升审计：同上。「谁把 Worker 的结论升进了长期记忆」是安全追溯链，不能因换目录断档。
  { name: DATA_FILE_NAMES.promotions, mode: 'copy-if-absent' },
  // 连接器注册表：密文是**机器派生密钥**加密的（见 credentials.ts），跨机器迁移后
  // 解不开。这里仍随目录迁移，是为了保住「哪些连接器配过、上次探测结论」的追溯链；
  // 解不开的凭证会表现为「未配置」，UI 会明确提示重新录入，不会静默当一个能用的连接。
  { name: DATA_FILE_NAMES.connectors, mode: 'copy-if-absent' },
  // FR-5 用量追踪：真实记账不因换目录断档（0 记录也是历史事实）。
  { name: DATA_FILE_NAMES.usage, mode: 'copy-if-absent' },
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
    // 三路径默认一致（20 = 无配置时的保守兜底；用户显式配置最多到 200，见 saveModelConfig 钳制）。
    // 坏文件回落到保守值而非「假装健康」，与项目 fail-closed 纪律一致。
    if (!fs.existsSync(file)) return { providers: [], defaultProvider: 'ollama', defaultModel: 'qwen3:14b', maxToolIterations: 20 };
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
      // ?? 而非 ||：显式配置 0 不应用默认值吞掉（虽随后被消费端钳到 1）。
      maxToolIterations: (raw.maxToolIterations as number | undefined) ?? 20,
    };
    const hasPlainKey = migrated;
    if (hasPlainKey) saveModelConfig(cfg);
    return cfg;
  } catch { return { providers: [], defaultProvider: 'ollama', defaultModel: 'qwen3:14b', maxToolIterations: 20 }; }
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
  const t0 = Date.now();
  logModel('request', { provider: provider.name, model, apiMode: 'ollama', url, toolCalls: toolDefs.length });
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  }).catch((err) => {
    logModel('error', { provider: provider.name, model, apiMode: 'ollama', url, ms: Date.now() - t0, error: (err as Error).message });
    throw err;
  });
  if (!res.ok) throw new Error(`Ollama 返回 HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const rawBody = await res.text();
  let data: {
    message?: { content?: string; tool_calls?: unknown };
    error?: string;
    done_reason?: string;
  };
  try {
    data = JSON.parse(rawBody) as typeof data;
  } catch {
    throw new Error(`Ollama 返回非 JSON 响应（HTTP ${res.status}）: ${rawBody.slice(0, 200)}`);
  }
  if (data.error) throw new Error(data.error);

  const toolCalls = normalizeNativeToolCalls(data.message?.tool_calls);
  const content = data.message?.content || '';
  logModel('response', {
    provider: provider.name, model, apiMode: 'ollama', url,
    status: res.status, ms: Date.now() - t0,
    contentLen: content.length, toolCalls: toolCalls.length,
  });
  return {
    content,
    toolCalls,
    source: toolCalls.length ? 'native' : 'none',
    // FR-5：Ollama 顶层 prompt_eval_count / eval_count → 归一化 usage
    usage: normalizeApiUsage(data) || undefined,
    emptyReason: (!content && !toolCalls.length)
      ? emptyContentReason({
          provider: provider.name,
          model,
          mode: 'ollama',
          status: res.status,
          finish: data.done_reason,
          bodySnippet: rawBody.slice(0, 200),
        })
      : undefined,
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
  // content 可能是字符串，也可能是分段数组（[{type:'text',text:'…'}]，常见于多模态
  // 网关 / 新版模型）—— 只按字符串处理会把后者误判为「模型返回空内容」。
  const raw = (data as { choices?: Array<{ message?: { content?: unknown } }> }).choices?.[0]?.message?.content;
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) {
    return raw.map((c) => (c && typeof c === 'object' && typeof (c as { text?: unknown }).text === 'string'
      ? (c as { text: string }).text
      : '')).join('');
  }
  return '';
}

/** HTTP 200 但拿不到正文时，构造可定位的诊断信息（不含密钥，响应体本身无敏感值）。 */
function emptyContentReason(opts: { provider: string; model: string; mode: string; status: number; finish?: unknown; bodySnippet: string }): string {
  const parts = [
    '模型返回空内容',
    `provider=${opts.provider}`,
    `model=${opts.model}`,
    `apiMode=${opts.mode}`,
    `HTTP ${opts.status}`,
  ];
  if (opts.finish !== undefined) parts.push(`finish_reason=${String(opts.finish)}`);
  if (opts.bodySnippet) parts.push(`响应片段: ${opts.bodySnippet}`);
  return `（${parts.join(' · ')}）`;
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
    const t0 = Date.now();
    logModel('request', {
      provider: provider.name, model, apiMode: mode, url,
      toolCalls: att.tools ? toolDefs.length : 0,
      ...(att.tools ? {} : { error: canUseTools ? `tools 降级（att.tools=${att.tools}）` : undefined }),
    });

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120_000),
      });
    } catch (err) {
      logModel('error', { provider: provider.name, model, apiMode: mode, url, ms: Date.now() - t0, error: (err as Error).message });
      throw new Error(`请求模型接口失败：${(err as Error).message}`);
    }

    if (!res.ok) {
      const txt = await res.text();
      lastErr = `模型 API 返回 HTTP ${res.status}: ${txt.slice(0, 300)}`;
      logModel('error', { provider: provider.name, model, apiMode: mode, url, status: res.status, ms: Date.now() - t0, error: txt.slice(0, 200) });
      // 工具相关参数被拒绝 → 降级重试；其余错误直接抛出。
      if (att.tools && [400, 404, 415, 422].includes(res.status)) continue;
      throw new Error(lastErr);
    }

    const rawBody = await res.text();
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(rawBody) as Record<string, unknown>;
    } catch {
      // HTTP 200 但非 JSON（如网关返回 HTML 错误页）——给出可定位的诊断而非「空内容」
      throw new Error(`模型 API 返回非 JSON 响应（HTTP ${res.status} · apiMode=${mode}）: ${rawBody.slice(0, 200)}`);
    }
    const errMsg = (data as { error?: { message?: string } }).error?.message;
    if (errMsg) {
      lastErr = errMsg;
      if (att.tools && /tool|function/i.test(errMsg)) continue;
      throw new Error(errMsg);
    }

    const choice = (data as { choices?: Array<{ message?: { content?: string; tool_calls?: unknown }; finish_reason?: unknown }> }).choices?.[0];
    const toolCalls = normalizeNativeToolCalls(choice?.message?.tool_calls);
    const content = pickOpenAIContent(data, mode) || (typeof choice?.message?.content === 'string' ? choice.message.content : '');
    const finish = choice?.finish_reason;

    // 软拒绝：带 tools 时网关返回 200 但 content/toolCalls 全空（StepFun 等网关行为），
    // 继续降级到不带 tools，避免把空响应当成最终答案。
    if (!content && !toolCalls.length && att.tools) {
      lastErr = emptyContentReason({ provider: provider.name, model, mode, status: res.status, finish, bodySnippet: rawBody.slice(0, 200) });
      logModel('error', { provider: provider.name, model, apiMode: mode, url, status: res.status, ms: Date.now() - t0, error: `[softReject] ${lastErr}` });
      continue;
    }

    logModel('response', {
      provider: provider.name, model, apiMode: mode, url,
      status: res.status, ms: Date.now() - t0,
      contentLen: content.length, toolCalls: toolCalls.length,
    });
    return {
      content,
      toolCalls,
      source: toolCalls.length ? 'native' : 'none',
      // FR-5：chat（prompt_tokens）与 responses（input_tokens）两种形态统一归一化；
      // 网关不回 usage → undefined，上层不伪造 0。
      usage: normalizeApiUsage(data) || undefined,
      // 只有「去掉 tools 后成功拿到非空响应」才算真正的工具拒绝，
      // 若去掉 tools 仍是空响应，则不应把工具能力永久关闭。
      toolsRejected: canUseTools && !att.tools && content ? true : undefined,
      emptyReason: (!content && !toolCalls.length)
        ? emptyContentReason({ provider: provider.name, model, mode, status: res.status, finish, bodySnippet: rawBody.slice(0, 200) })
        : undefined,
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
// ============================================================================

// --- 工具执行引擎（Agent Runtime 核心） ---
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

// 网关软拒绝 tools 的持久化记忆：key = providerId|model。
// 一旦某 provider+model 在带 tools 时返回 200 空内容或硬 4xx，后续会话直接走文本兜底，
// 避免每轮都重复三次降级重试。
const toolRejectMemo = new Map<string, true>();
function toolRejectKey(provider: ModelProvider, model: string): string {
  return `${provider.id}|${model}`;
}
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
  // BUG-023：会话工作区（用户在 GUI 里绑定的项目目录）也是白名单根——
  // 否则 cwd 切到 D 盘项目后，file_*/set_cwd 全被沙箱拒绝，「工作区」名存实亡。
  // sessionCwds 只能经 set-session-cwd（用户驱动）写入，Agent 无法借此扩权。
  const roots = [...allowedRoots(), dataDir(), process.cwd(), ...sessionCwds.values()];
  return roots.some(root => resolved === root || resolved.startsWith(root + path.sep));
}

/** 允许执行的命令白名单（集合形式，O(1) 判定）。 */
const ALLOWED_COMMAND_SET = new Set(ALLOWED_COMMANDS);

// 会话级工作目录：set_cwd 写入，shell/file 操作读取。进程内 Map，重启即失——
// ponytail: 升级路径 = 持久化到 sessions.json 的会话字段。
const sessionCwds = new Map<string, string>();

function sessionCwd(sessionId?: string): string {
  const set = sessionId ? sessionCwds.get(sessionId) : undefined;
  return set || resolveShellCwd();
}

/**
 * 授权门（PRD L3/L4 / T-P3-2）：paranoid（只读）直接拒；default/trusted 过 GUI 审批；
 * 审批链路不可用一律 fail-closed（与 ADR-0008 intent 的「基础设施缺失放行」边界不同——
 * 走此门的操作兜底不足：命令白名单含万能 shell、file_write 可覆盖白名单内任意文件）。
 * @returns null = 放行；字符串 = 拒绝原因。
 */
async function approvalGate(toolName: string, reason: string, sessionId?: string, target?: string): Promise<string | null> {
  let mode = 'default';
  try { mode = (await authzService?.getMode()) || 'default'; } catch { /* 缺省 default */ }
  lastAuthMode = mode;
  // 偏执模式压倒白名单：用户切到 paranoid 的意图就是「全锁」，
  // 此前点过的「永久允许」不该悄悄再把门打开（可在设置页撤销白名单）。
  if (mode === 'paranoid') return 'paranoid（只读）模式下禁止该操作';

  // PRD FR-9：会话 / 永久白名单命中 → 直接放行（插件侧已 hits++ 并入审计）。
  const grant = authzService?.matchGrant?.({ toolName, target, sessionId });
  if (grant) {
    log('INFO', 'authz', `白名单放行：${toolName} · ${grant.pattern}（${grant.scope}，累计 ${grant.hits} 次）`);
    return null;
  }

  const approval = getHostServices()?.approval;
  if (!approval) return '授权审批服务不可用，操作被拒绝（fail-closed）';
  const outcome = await approval.request({ toolName, reason: reason.slice(0, 200), sessionId, target });
  return outcome === 'allowed-once' ? null : `操作未获批准（${outcome}）`;
}

/**
 * 边界外补偿门（PRD FR-12，第九死挂点修复）。
 * 三类高危（删除文件 / 对外发送 / 不可逆操作）经补偿层 withhold 判定 → 需确认时走
 * 审批弹窗二次确认；无补偿服务/无审批通道时按 fail-open 放行但记 WARN——
 * 与 firePreStep 同策略：基础设施缺失不锁死对话，但绝不静默。
 */
async function outboundGate(text: string, sessionId?: string): Promise<string | null> {
  const svc = getService<CompensationServiceLike>('compensation');
  if (!svc) {
    // BUG（全盘死挂点扫描）：原实现无服务时直接放行且不落任何日志，与函数注释
    // 「fail-open 放行但记 WARN、绝不静默」不符；与 approvalGate 的 fail-closed(795)
    // 形成无理由双标。补偿层缺失=外发无预判门，必须可见。
    log('WARN', 'compensation', '补偿层服务未接入，外发预判放行（fail-open，无确认门）');
    return null;
  }
  let verdict: { needsConfirm?: boolean; category?: string; reason?: string } | null = null;
  try {
    const raw = await svc.withhold(String(text || ''));
    verdict = raw as { needsConfirm?: boolean; category?: string; reason?: string } | null;
  } catch (err) {
    log('WARN', 'compensation', `外发预判失败（放行）: ${(err as Error).message}`);
    return null;
  }
  if (!verdict?.needsConfirm) return null;
  const category = String(verdict.category || 'other');
  const denied = await approvalGate(`outbound:${category}`, String(verdict.reason || '跨边界/不可逆外发操作'), sessionId);
  return denied;
}

// ---------------------------------------------------------------------------
// PRD FR-8 沙箱日志（可检索）
// 此前所有沙箱判定只活在 executeTool 的 return 里，事后无法回答「Agent 刚才
// 对磁盘 / 网络做了什么、哪次被拦下」。这里做统一埋点 + 写穿落盘。
// 落盘失败只 WARN：日志是观测设施，不是安全门，绝不因为记不下来就拒绝执行。
// ---------------------------------------------------------------------------

let sandboxLog: SandboxLogEntry[] = [];

function sandboxLogFile(): string {
  return path.join(dataDir(), DATA_FILE_NAMES.sandboxLog);
}

/** 启动装载：坏文件 / 缺文件 → 空日志（与白名单同策略，不猜内容）。 */
function loadSandboxLog(): number {
  try {
    sandboxLog = normalizeSandboxLog(JSON.parse(fs.readFileSync(sandboxLogFile(), 'utf-8')));
  } catch {
    sandboxLog = [];
  }
  return sandboxLog.length;
}

/** 写穿落盘（与授权白名单同一节奏：安全审计不留「刚发生就崩了」的窗口）。 */
function persistSandboxLog(): boolean {
  try {
    const file = sandboxLogFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(sandboxLog, null, 2), 'utf-8');
    return true;
  } catch (err) {
    log('WARN', 'sandbox', `沙箱日志落盘失败（不影响工具执行）: ${(err as Error).message}`);
    return false;
  }
}

/**
 * 记一条沙箱判定。
 * 入参缺 tool / target / decision 会被 normalizeSandboxEntry 丢弃 —— 那种条目
 * 存进去也检索不到，不如不留。
 */
function recordSandbox(input: {
  tool: string;
  kind: SandboxLogEntry['kind'];
  target: string;
  decision: SandboxLogEntry['decision'];
  reason?: string;
  sessionId?: string;
}): void {
  const before = sandboxLog.length;
  sandboxLog = appendSandboxLog(sandboxLog, {
    ...input,
    mode: lastAuthMode,
    ts: Date.now(),
  });
  if (sandboxLog.length !== before) persistSandboxLog();
}

/** 最近一次读到的授权模式（getMode 是异步的，日志只能留快照）。 */
let lastAuthMode = 'default';

// ---------------------------------------------------------------------------
// 浏览器工具（ADR-0011：Electron 自带 CDP，零额外依赖）
// ---------------------------------------------------------------------------
// 安全口径沿用既有工具：
//   - 导航 = 边界外网络访问 → 域名白名单，非白名单过补偿层外发二次确认（同 web_fetch）
//   - 点击 / 输入 / 执行脚本 = 真实改变页面（下单、发帖、删数据都可能）→ 授权门（同 file_write）
//   - 每一次判定都进沙箱日志：事后能回答「Agent 在哪个网页上点了什么」
// 浏览器共享用户默认 session（保留登录态）——这是能力的一半，也是为什么写操作必须过门。

/** 浏览器工具在沙箱日志里的判定对象（不记录输入文本，避免把密码写进日志）。 */
function browserTargetOf(name: string, args: Record<string, unknown>): string {
  const st = getBrowserState();
  const where = st.open && st.url ? st.url : '(浏览器未打开)';
  if (name === 'browser_type') return `${where} · 输入到 ${String(args.selector || '').slice(0, 80)}`;
  if (name === 'browser_click') return `${where} · 点击 ${String(args.selector || '').slice(0, 80)}`;
  if (name === 'browser_eval') return `${where} · 执行脚本 ${String(args.expression || '').length} 字符`;
  if (name === 'browser_open') return String(args.url || '').slice(0, 300) || '(空 URL)';
  return where;
}

async function executeBrowserTool(name: string, args: Record<string, unknown>, sessionId?: string): Promise<ToolResult> {
  const parsed = normalizeBrowserArgs(name, args);
  if (!parsed.ok) {
    recordSandbox({ tool: name, kind: 'browser', target: browserTargetOf(name, args), decision: 'error', reason: parsed.error, sessionId });
    return { name, result: '', error: parsed.error };
  }
  const v = parsed.value;
  const fail = (reason: string, decision: 'denied' | 'error' = 'error'): ToolResult => {
    recordSandbox({ tool: name, kind: 'browser', target: browserTargetOf(name, args), decision, reason, sessionId });
    return { name, result: '', error: reason };
  };

  switch (v.name) {
    case 'browser_open': {
      const policy = getHostServices()?.sandboxPolicy;
      const allowed = policy?.isDomainAllowed ? policy.isDomainAllowed(v.url) : true;
      if (!allowed) {
        const denied = await outboundGate(`访问网页 ${v.url}`, sessionId);
        if (denied) return fail(`域名不在白名单：${denied}`, 'denied');
      }
      try {
        const st = await cdpOpenBrowser(v.url, { waitUntil: v.waitUntil, timeoutMs: v.timeoutMs });
        recordSandbox({
          tool: name, kind: 'browser', target: v.url, decision: 'allowed',
          reason: st.title ? `已打开：${st.title}`.slice(0, 200) : '已打开', sessionId,
        });
        return { name, result: describeBrowserState(st) };
      } catch (err) {
        return fail((err as Error).message.slice(0, 500));
      }
    }

    case 'browser_text': {
      if (!getBrowserState().open) return fail('浏览器未打开（先用 browser_open 打开网址）');
      const r = await evalInPage(buildTextExpression(v.selector, v.maxChars));
      if (!r.ok) return fail(r.error || '读取页面文本失败');
      recordSandbox({
        tool: name, kind: 'browser', target: browserTargetOf(name, args), decision: 'allowed',
        reason: `读取 ${String(r.value || '').length} 字符`, sessionId,
      });
      return { name, result: clipBrowserText(r.value || '', v.maxChars) };
    }

    case 'browser_links': {
      if (!getBrowserState().open) return fail('浏览器未打开（先用 browser_open 打开网址）');
      const r = await evalInPage(buildLinksExpression(v.selector, v.limit));
      if (!r.ok) return fail(r.error || '读取链接失败');
      recordSandbox({
        tool: name, kind: 'browser', target: browserTargetOf(name, args), decision: 'allowed',
        reason: '列出页面链接', sessionId,
      });
      return { name, result: r.value || '(页面内没有链接)' };
    }

    case 'browser_click': {
      const st = getBrowserState();
      if (!st.open) return fail('浏览器未打开（先用 browser_open 打开网址）');
      const denied = await approvalGate('browser_click', `在网页上点击 ${v.selector}`, sessionId, st.url || '');
      if (denied) return fail(denied, 'denied');
      const wait = await evalInPage(buildWaitForSelectorExpression(v.selector, v.timeoutMs));
      if (!wait.ok) return fail(wait.error || `等待元素 ${v.selector} 超时`);
      const r = await evalInPage(buildClickExpression(v.selector));
      if (!r.ok) return fail(r.error || '点击失败');
      recordSandbox({
        tool: name, kind: 'browser', target: browserTargetOf(name, args), decision: 'allowed',
        reason: r.value, sessionId,
      });
      return { name, result: `${r.value}（${v.selector}）` };
    }

    case 'browser_type': {
      const st = getBrowserState();
      if (!st.open) return fail('浏览器未打开（先用 browser_open 打开网址）');
      const denied = await approvalGate('browser_type', `在网页输入框填入 ${v.text.length} 个字符`, sessionId, st.url || '');
      if (denied) return fail(denied, 'denied');
      const r = await evalInPage(buildTypeExpression(v.selector, v.text, { clear: v.clear, pressEnter: v.pressEnter }));
      if (!r.ok) return fail(r.error || '填入失败');
      recordSandbox({
        tool: name, kind: 'browser', target: browserTargetOf(name, args), decision: 'allowed',
        reason: r.value, sessionId,
      });
      return { name, result: r.value || '已填入' };
    }

    case 'browser_screenshot': {
      const st = getBrowserState();
      if (!st.open) return fail('浏览器未打开（先用 browser_open 打开网址）');
      const shot = await screenshotBrowser({ fullPage: v.fullPage, timeoutMs: v.timeoutMs }, dataDir());
      if (!shot.ok) return fail(shot.error || '截图失败');
      recordSandbox({
        tool: name, kind: 'browser', target: shot.path || '(截图)', decision: 'allowed',
        reason: `已保存截图${v.fullPage ? '（整页）' : ''}${shot.via === 'capturePage' ? '（CDP 截图不可用，已回退 capturePage）' : ''}`, sessionId,
      });
      // 回退路径只在视口大小，如实告诉模型，别让它以为拿到了整页
      const tail = shot.via === 'capturePage' ? '（视口截图：CDP 整页/合成截图在本环境不可用）' : '';
      return { name, result: `截图已保存：${shot.path}${tail}` };
    }

    case 'browser_eval': {
      const st = getBrowserState();
      if (!st.open) return fail('浏览器未打开（先用 browser_open 打开网址）');
      const risks = scanScriptRisks(v.expression);
      const reason = `执行脚本${risks.length ? `（涉及：${risks.join('、')}）` : ''}：${v.expression.slice(0, 160)}`;
      const denied = await approvalGate('browser_eval', reason, sessionId, st.url || '');
      if (denied) return fail(denied, 'denied');
      const r = await evalInPage(v.expression, v.timeoutMs);
      if (!r.ok) {
        recordSandbox({
          tool: name, kind: 'browser', target: browserTargetOf(name, args), decision: 'error',
          reason: (r.error || '脚本执行失败').slice(0, 300), sessionId,
        });
        return { name, result: '', error: r.error || '脚本执行失败' };
      }
      recordSandbox({
        tool: name, kind: 'browser', target: browserTargetOf(name, args), decision: 'allowed',
        reason: risks.length ? `风险项：${risks.join('、')}` : '页面内求值', sessionId,
      });
      return { name, result: r.value || '(脚本返回空值)' };
    }

    case 'browser_close': {
      const closed = cdpCloseBrowser();
      recordSandbox({
        tool: name, kind: 'browser', target: '(关闭浏览器)', decision: 'allowed',
        reason: closed ? '浏览器窗口已关闭' : '浏览器本来就没打开', sessionId,
      });
      return { name, result: closed ? '浏览器已关闭（登录态保留）' : '浏览器未打开，无需关闭' };
    }

    default:
      return fail(`未接线的浏览器工具：${name}`);
  }
}

async function executeTool(tool: ToolCall, sessionCtx?: { sessionId?: string }): Promise<ToolResult> {
  const { name, arguments: args } = tool;
  const cwd = sessionCwd(sessionCtx?.sessionId);
  try {
    switch (name) {
      case 'file_read': {
        const filePath = path.resolve(cwd, String(args.path || ''));
        const sid = sessionCtx?.sessionId;
        if (!isPathAllowed(filePath)) {
          recordSandbox({ tool: name, kind: 'path', target: filePath, decision: 'denied', reason: '路径不在允许范围内', sessionId: sid });
          return { name, result: '', error: '路径不在允许范围内' };
        }
        // 防御超大文件：工具承诺最大回传 50KB，但整读不入上限文件会阻塞主进程并吃内存尖峰。
        // 先 stat 拿尺寸，超上限直接拒绝（不整读），与渲染层 file 面板的 2MB 读取上限呼应。
        let size = -1;
        try {
          size = fs.statSync(filePath).size;
        } catch (err) {
          recordSandbox({ tool: name, kind: 'path', target: filePath, decision: 'error', reason: `stat 失败：${(err as Error).message}`, sessionId: sid });
          return { name, result: '', error: `无法读取文件：${(err as Error).message}` };
        }
        const MAX_READ_BYTES = 2 * 1024 * 1024; // 与渲染层 file 面板读取上限一致（2MB）
        if (size > MAX_READ_BYTES) {
          recordSandbox({ tool: name, kind: 'path', target: filePath, decision: 'denied', reason: `文件 ${size} 字节超过 2MB 读取上限`, sessionId: sid });
          return { name, result: '', error: `文件过大（${size} 字节），超过 2MB 读取上限，请用文件面板或分段读取` };
        }
        const content = fs.readFileSync(filePath, 'utf-8');
        recordSandbox({ tool: name, kind: 'path', target: filePath, decision: 'allowed', sessionId: sid });
        return { name, result: content.slice(0, 50000) }; // 限制 50KB 回传
      }
      case 'file_write': {
        const filePath = path.resolve(cwd, String(args.path || ''));
        const content = String(args.content || '');
        const sid = sessionCtx?.sessionId;
        if (!isPathAllowed(filePath)) {
          recordSandbox({ tool: name, kind: 'path', target: filePath, decision: 'denied', reason: '路径不在允许范围内', sessionId: sid });
          return { name, result: '', error: '路径不在允许范围内' };
        }
        // 写文件可覆盖白名单内任意内容 → 同样过授权门（与 shell 同一 helper）
        const denied = await approvalGate('file_write', `写入 ${filePath}`, sessionCtx?.sessionId, filePath);
        if (denied) {
          recordSandbox({ tool: name, kind: 'approval', target: filePath, decision: 'denied', reason: denied, sessionId: sid });
          return { name, result: '', error: denied };
        }
        const dir = path.dirname(filePath);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(filePath, content, 'utf-8');
        recordSandbox({
          tool: name, kind: 'approval', target: filePath, decision: 'allowed',
          reason: `已写入 ${path.basename(filePath)} (${content.length} 字节)`, sessionId: sid,
        });
        return { name, result: `已写入 ${path.basename(filePath)} (${content.length} 字节)` };
      }
      case 'file_list': {
        const dirPath = path.resolve(cwd, String(args.path || '.'));
        const sid = sessionCtx?.sessionId;
        if (!isPathAllowed(dirPath)) {
          recordSandbox({ tool: name, kind: 'path', target: dirPath, decision: 'denied', reason: '路径不在允许范围内', sessionId: sid });
          return { name, result: '', error: '路径不在允许范围内' };
        }
        const entries = fs.readdirSync(dirPath, { withFileTypes: true });
        const items = entries.map(e => `${e.isDirectory() ? '📁' : '📄'} ${e.name}`).join('\n');
        recordSandbox({ tool: name, kind: 'path', target: dirPath, decision: 'allowed', sessionId: sid });
        return { name, result: items || '(空目录)' };
      }
      case 'shell_command': {
        const cmd = String(args.command || '');
        const cmdName = (cmd.split(/[\s/\\]+/)[0] || '').toLowerCase();
        const sid = sessionCtx?.sessionId;
        if (!cmdName) return { name, result: '', error: '命令为空' };
        if (!ALLOWED_COMMAND_SET.has(cmdName)) {
          recordSandbox({
            tool: name, kind: 'command', target: cmd, decision: 'denied',
            reason: `命令「${cmdName}」不在白名单中`, sessionId: sid,
          });
          return { name, result: '', error: `命令「${cmdName}」不在白名单中。允许: ${ALLOWED_COMMANDS.slice(0, 20).join(', ')}...` };
        }
        // ---- 授权门（PRD L3/L4 / T-P3-2）：命令执行必须过审批 ----
        // 此前审批 UI 已建但工具链路从不触发（与 intent/trace 同款死挂点，BUG-021 修复）。
        const denied = await approvalGate('shell_command', cmd, sessionCtx?.sessionId, cmd);
        if (denied) {
          recordSandbox({ tool: name, kind: 'approval', target: cmd, decision: 'denied', reason: denied, sessionId: sid });
          return { name, result: '', error: denied };
        }
        // PRD FR-12：删除 / 对外发送 / 不可逆命令在授权门之上再加一道补偿层二次确认
        // （L4 双确认）。普通命令（git/npm/ls…）判定为 other，不额外打扰。
        const outboundDenied = await outboundGate(cmd, sessionCtx?.sessionId);
        if (outboundDenied) {
          recordSandbox({ tool: name, kind: 'outbound', target: cmd, decision: 'denied', reason: outboundDenied, sessionId: sid });
          return { name, result: '', error: outboundDenied };
        }
        // 进程隔离 + 不阻塞主进程：在子进程中异步执行。
        // cwd 用会话工作目录（set_cwd 可切换），缺省回落 resolveShellCwd()。
        const { exec } = await import('node:child_process');
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
          recordSandbox({ tool: name, kind: 'approval', target: cmd, decision: 'allowed', sessionId: sid });
          return { name, result: output.slice(0, 50000) };
        } catch (err) {
          recordSandbox({
            tool: name, kind: 'command', target: cmd, decision: 'error',
            reason: (err as Error).message, sessionId: sid,
          });
          return { name, result: '', error: (err as Error).message.slice(0, 2000) };
        }
      }
      case 'web_fetch': {
        const url = String(args.url || '');
        const sid = sessionCtx?.sessionId;
        if (!url.startsWith('http://') && !url.startsWith('https://')) {
          recordSandbox({ tool: name, kind: 'network', target: url, decision: 'denied', reason: 'URL 必须以 http(s) 开头', sessionId: sid });
          return { name, result: '', error: 'URL 必须以 http(s) 开头' };
        }
        // PRD FR-8：网络请求域名白名单。非白名单域名 = 边界外外发 → 补偿层二次确认。
        // 此前 v0.9.1 以「只读 GET 无不可逆外发」为由跳过，与 FR-12 明文冲突（外发即边界外 emission）。
        const policy = getHostServices()?.sandboxPolicy;
        const allowed = policy?.isDomainAllowed ? policy.isDomainAllowed(url) : true;
        if (!allowed) {
          const denied = await outboundGate(`请求接口 ${url}`, sessionCtx?.sessionId);
          if (denied) {
            recordSandbox({ tool: name, kind: 'network', target: url, decision: 'denied', reason: `域名不在白名单：${denied}`, sessionId: sid });
            return { name, result: '', error: `域名不在白名单：${denied}` };
          }
          recordSandbox({ tool: name, kind: 'outbound', target: url, decision: 'allowed', reason: '非白名单域名经外发二次确认后放行', sessionId: sid });
        }
        try {
          const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
          // 响应体积护栏：承诺只回传 30KB，但不能因此整读超大响应进内存（防 OOM / 主进程阻塞）。
          // content-length 预检 + 流式读满上限即停，两重保险。
          const MAX_FETCH_BYTES = 1 * 1024 * 1024;
          const declared = Number(res.headers.get('content-length') || '0');
          if (declared > MAX_FETCH_BYTES) {
            recordSandbox({ tool: name, kind: 'network', target: url, decision: 'denied', reason: `响应声明 ${declared} 字节超 ${MAX_FETCH_BYTES} 上限`, sessionId: sid });
            return { name, result: '', error: `响应过大（${declared} 字节），超过读取上限` };
          }
          if (!res.body) {
            const buf = Buffer.from(await res.arrayBuffer());
            recordSandbox({ tool: name, kind: 'network', target: url, decision: 'allowed', sessionId: sid });
            return { name, result: buf.toString('utf-8').slice(0, 30000) };
          }
          const chunks: Buffer[] = [];
          let total = 0;
          for await (const chunk of res.body) {
            const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            total += b.length;
            if (total > MAX_FETCH_BYTES) break; // 超上限即截停，不整读
            chunks.push(b);
          }
          recordSandbox({ tool: name, kind: 'network', target: url, decision: 'allowed', sessionId: sid });
          return { name, result: Buffer.concat(chunks).toString('utf-8').slice(0, 30000) };
        } catch (err) {
          recordSandbox({ tool: name, kind: 'network', target: url, decision: 'error', reason: (err as Error).message, sessionId: sid });
          return { name, result: '', error: (err as Error).message.slice(0, 2000) };
        }
      }
      // ---- 浏览器（CDP）工具：导航 / 读页面 / 点击 / 输入 / 截图 / 求值 / 关闭 ----
      case 'browser_open':
      case 'browser_text':
      case 'browser_links':
      case 'browser_click':
      case 'browser_type':
      case 'browser_screenshot':
      case 'browser_eval':
      case 'browser_close':
        return await executeBrowserTool(name, args, sessionCtx?.sessionId);
      case 'memory_save': {
        // dsh memory 服务（global 域）落地——「记住 X」从口头应答变成真实持久化
        const content = String(args.content || '').trim();
        if (!content) return { name, result: '', error: '内容为空' };
        const svc = getService<MemoryServiceLike>('memory');
        if (!svc?.record) return { name, result: '', error: '记忆服务未就绪（运行时未启动）' };
        svc.record('global', content, { origin: 'agent:memory_save' });
        return { name, result: `已记住：${content.slice(0, 100)}` };
      }
      case 'set_cwd': {
        const resolved = path.resolve(String(args.path || ''));
        const sid = sessionCtx?.sessionId;
        if (!isPathAllowed(resolved)) {
          recordSandbox({ tool: name, kind: 'path', target: resolved, decision: 'denied', reason: '路径不在允许范围内', sessionId: sid });
          return { name, result: '', error: '路径不在允许范围内' };
        }
        let isDir = false;
        try { isDir = fs.statSync(resolved).isDirectory(); } catch { /* not exist */ }
        if (!isDir) return { name, result: '', error: `目录不存在：${resolved}` };
        if (sessionCtx?.sessionId) sessionCwds.set(sessionCtx.sessionId, resolved);
        recordSandbox({ tool: name, kind: 'path', target: resolved, decision: 'allowed', sessionId: sid });
        return { name, result: `工作目录已切换：${resolved}` };
      }
      default:
        return { name, result: '', error: `未知工具: ${name}` };
    }
  } catch (err) {
    // 执行期异常也是要可追溯的事实（file_read 读不存在的文件、磁盘满、权限被拒…）。
    // 此前这类错误直接返回，沙箱日志里一条都没有，事后查不到「Agent 到底碰了什么」。
    const message = (err as Error).message;
    recordSandbox({
      tool: name,
      kind: sandboxKindOf(name),
      target: sandboxTargetOf(name, args, cwd),
      decision: 'error',
      reason: message,
      sessionId: sessionCtx?.sessionId,
    });
    return { name, result: '', error: message };
  }
}

/** 工具 → 判定类型（异常路径没有显式 kind，按工具归类以便检索）。 */
function sandboxKindOf(toolName: string): SandboxLogEntry['kind'] {
  if (toolName === 'shell_command') return 'command';
  if (toolName === 'web_fetch') return 'network';
  if (toolName.startsWith('browser_')) return 'browser';
  return 'path';
}

/** 工具 → 判定对象（取最能说明「碰了什么」的那一个入参）。 */
function sandboxTargetOf(toolName: string, args: Record<string, unknown> | undefined, cwd: string): string {
  const a = args || {};
  const raw = toolName === 'shell_command' ? a.command
    : toolName === 'web_fetch' ? a.url
      : (a.path ?? a.content);
  if (raw === undefined || raw === null || raw === '') return cwd;
  const s = String(raw);
  // 相对路径解析成绝对路径再记，否则检索「D:/x/y.txt」永远命中不了。
  if (/^[a-zA-Z]:[\\/]|^\//.test(s)) return s;
  try { return path.resolve(cwd, s); } catch { return s; }
}


// --- Agent Runtime：模型回合 + 工具调用循环 ---

/** 取可下发 IPC 的渲染窗口：mainWindow 优先，回退首个未销毁窗。
 * 桌面集成开启后悬浮窗先建排第 0，但无 preload 不订阅业务事件，不能当推送目标。
 * 全库此前散落 4 份同款三元式（浏览器状态/终端数据/终端退出/工具步骤），统一收口。 */
function rendererWindow(): BrowserWindow | null {
  try {
    if (mainWindow && !mainWindow.isDestroyed()) return mainWindow;
    return BrowserWindow.getAllWindows().find((x) => !x.isDestroyed()) || null;
  } catch { return null; }
}

/** 把一次工具执行同步给渲染层（步骤条 + 通知）。 */
function notifyToolStep(sessionId: string, name: string, ph: 'running' | 'done' | 'error', result?: string): void {
  try {
    // BUG（全盘死挂点扫描）：原实现取 BrowserWindow.getAllWindows()[0] —— 桌面集成开启
    // 悬浮窗后，悬浮窗先建排第 0（无 preload、不订阅 tool-step），工具步骤全发向死窗，
    // 渲染层订阅方永远收不到。改走统一 helper rendererWindow()（mainWindow 优先）。
    const w = rendererWindow();
    if (w) w.webContents.send('orchdesk:tool-step', { sessionId, name, ph, result: result || '' });
  } catch { /* 忽略：窗口可能已关闭 */ }
}

async function runAgentTurn(sessionId: string, text: string, opts: { models?: string[]; thinkLevel?: string }): Promise<{
  text: string;
  intent: string;
  /** 本回合工具轨迹（n/ph/result）。渲染层据此在 agent 消息下展示「N 步 · M 个动作」。 */
  tools?: Array<{ n: string; ph: 'running' | 'done' | 'error'; result?: string }>;
  steps?: number;
}> {
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
  // dsh 服务接入对话流：记忆语义召回（FR-7）+ 提示词库合并（FR-5/FR-11）+ 会话工作目录。
  // 召回/合并失败不阻塞回合（提示词只影响 system prompt，不影响执行侧 fail 边界）。
  let memories: string[] = [];
  try {
    const memSvc = getService<MemoryServiceLike>('memory');
    if (memSvc?.recall) {
      // 语义召回（TF-IDF Top-K）：相关优先；但短查询与记忆无词面交集时余弦为 0，
      // 此时回落机械取尾——「用户告知的事实」必须可见，不能被召回算法吞掉。
      const hits = (memSvc.recall(text, { k: 5 }) as Array<{ entry?: { text?: string }; score?: number }> | undefined) || [];
      memories = hits.filter((h) => (h.score ?? 0) > 0).map((h) => String(h.entry?.text || '')).filter(Boolean);
    }
    if (!memories.length && memSvc?.listDomain) {
      memories = ((memSvc.listDomain('global') as Array<{ text?: string }> | undefined) || [])
        .map((e) => String(e?.text || '')).filter(Boolean).slice(-10);
    }
  } catch { /* 记忆召回失败不阻塞回合 */ }

  let prompts: string[] = [];
  try {
    const promptSvc = getService<PromptServiceLike>('promptLib');
    if (promptSvc?.mergeForAgent) {
      const merged = promptSvc.mergeForAgent('orchdesk-main') as { sections?: Array<{ fromTitle?: string; body?: string; conflict?: boolean }> } | null;
      prompts = (merged?.sections || [])
        .map((s) => `【${s?.fromTitle || '提示词'}】${String(s?.body || '').trim()}${s?.conflict ? '（与其他提示词冲突，按用户最新意图取舍）' : ''}`)
        .filter((p) => p.length > 6);
    }
  } catch { /* 提示词合并失败不阻塞回合 */ }

  apiMessages.unshift({ role: 'system', content: buildSystemPrompt({ cwd: sessionCwd(sessionId), memories, prompts }) });
  apiMessages.push({ role: 'user', content: text });

  const toolSteps: Array<{ n: string; ph: 'running' | 'done' | 'error'; result?: string }> = [];
  let finalReply = '';
  let stepCount = 0;
  // FR-5：本回合累计 token 用量。null = 网关从未上报 usage（「没上报」≠「0 token」，
  // 此时本回合不记用量条目，聚合里也不会出现这次回合）。
  let turnUsage: { p: number; c: number; t: number } | null = null;
  const MAX_ITERATIONS = Math.max(1, Math.min(200, modelCfg.maxToolIterations || 20));
  // 网关明确拒绝工具协议 → 停止下发 tools，转「文本兜底解析」，
  // 避免每一轮都重复三次降级重试。进程级记忆让同 provider+model 的后续会话直接跳过 tools。
  const rejectKey = toolRejectKey(provider, model);
  let providerRejectsTools = toolRejectMemo.has(rejectKey);

  // 工具调用循环
  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    // ---- dsh 挂点桥接（ADR-0008）：用户意图必经 agent/pre-step waterfall ----
    // intent 意图网关（F1-F4 规则漏斗 → reject 硬拒）与 trace 遥测都在该事件上；
    // 仅对用户输入门控一次（iter=0），后续工具 step 由沙箱白名单/命令白名单兜底。
    // 运行时未启动 → firePreStep 返回 null → 放行（基础设施缺失不锁死对话）。
    if (iter === 0) {
      let gate: { kind?: string; reason?: string } | null = null;
      try {
        gate = await firePreStep({
          sessionId, text,
          // 完整会话正文（system + 历史 + 当前输入）：memory 80% 阈值按总 token 估算
          messages: apiMessages.map((m) => String(m.content || '')).filter(Boolean),
        });
      } catch (err) {
        log('WARN', 'intent', `pre-step waterfall 异常（放行）: ${(err as Error).message}`);
      }
      if (gate?.kind === 'reject') {
        finalReply = `（意图网关拦截）该请求被判定为高风险操作，已拒绝执行。${gate.reason ? `原因：${gate.reason}` : '可在设置页调整意图识别策略。'}`;
        break;
      }
    }
    const wantsTools = !providerRejectsTools;
    let reply: ModelReply;
    try {
      reply = await callModel(provider, model, apiMessages, wantsTools ? TOOL_DEFS : []);
    } catch (err) {
      return { text: `（模型调用失败）${(err as Error).message}`, intent: 'CONFIRM' };
    }
    if (reply.usage) {
      const u = reply.usage;
      turnUsage = turnUsage
        ? { p: turnUsage.p + u.promptTokens, c: turnUsage.c + u.completionTokens, t: turnUsage.t + u.totalTokens }
        : { p: u.promptTokens, c: u.completionTokens, t: u.totalTokens };
    }
    if (reply.toolsRejected) {
      providerRejectsTools = true;
      toolRejectMemo.set(rejectKey, true);
      console.warn(`[orchdesk] 提供商「${provider.name}」不接受工具定义，后续会话转为文本兜底解析。`);
    }

    // ---- 模式 1：原生 function calling（优先）----
    if (reply.toolCalls.length) {
      const assistantMsg = buildAssistantToolCallMessage(reply.content, reply.toolCalls as NativeToolCall[]);
      apiMessages.push(assistantMsg);

      for (const tc of reply.toolCalls) {
        stepCount++;
        notifyToolStep(sessionId, tc.name, 'running');
        const result = await executeTool(tc, { sessionId });
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
      finalReply = reply.content || reply.emptyReason || '（模型返回空内容）';
      break;
    }

    apiMessages.push({ role: 'assistant', content: parsed.stripped || `（调用工具：${usable.map(c => c.name).join(', ')}）` });
    for (const tc of usable) {
      stepCount++;
      notifyToolStep(sessionId, tc.name, 'running');
      // BUG（全盘死挂点扫描）：文本兜底模式此前漏传 sessionId —— 对照同函数上文原生
      // 路径的 executeTool 调用（不要用行号互指，编辑漂移会让注释失真）。
      // 不传则 executeTool 内 sessionCtx?.sessionId 恒假：set_cwd 静默失效、cwd 回落
      // home、session 级 grant 匹配不到、沙箱日志 sessionId 全空。会话工作区整链在该
      // 模式断（用户「git pull 找不到仓库」的第三种形态）。
      const result = await executeTool(tc, { sessionId });
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
  const turnTs = Date.now();
  if (s) {
    const msgs = (s.msgs as Array<Record<string, unknown>>) || [];
    msgs.push({ role: 'user', text, t: nowTime(), ts: new Date(turnTs).toISOString() });
    msgs.push({
      role: 'assistant', text: finalReply, model, t: nowTime(), ts: new Date(turnTs).toISOString(),
      tools: toolSteps, steps: stepCount,
      // FR-5：单回合 token 用量徽标（网关没上报就没有该字段，UI 不显示）
      ...(turnUsage ? { tok: { p: turnUsage.p, c: turnUsage.c } } : {}),
    });
    s.msgs = msgs;
    s.updated = new Date().toISOString();
    saveStore();
  }

  // ---- SessionEvent append-only 双写（FR-6，ADR-0009）----
  // 「模型可见必入日志」：用户输入与模型回复（含工具步骤、token 用量）在同一
  // 持久化点追加进事件流。写失败不阻塞回合（事件流是回放权威源，不是运行态依赖）
  // ——整块兜异常（eventFileFor 对非法 sid 会抛错），只 WARN 不 reject 回合。
  try {
    const evFile = eventFileFor(dataDir(), sessionId);
    const evs: Array<Omit<SessionEvent, 'seq'>> = [
      { ts: turnTs, kind: 'user', text },
      {
        ts: turnTs, kind: 'assistant', text: finalReply, model,
        tools: toolSteps.map((t) => ({ name: t.n, phase: t.ph, result: t.result })),
        ...(turnUsage ? { tok: { p: turnUsage.p, c: turnUsage.c } } : {}),
      },
    ];
    const w = appendEvents(evFile, evs);
    if (!w.ok) log('WARN', 'events', `会话事件追加失败: ${w.reason}`);
  } catch (err) {
    log('WARN', 'events', `会话事件双写异常: ${(err as Error).message}`);
  }

  // ---- FR-5 用量记账：一回合一条目（网关从未上报 usage → 不记，不伪造 0）----
  // 记账失败同样不阻塞回合——宁可丢一条统计，不能让回合 IPC 因落盘问题失败。
  if (turnUsage) {
    try {
      const entry: UsageEntry = {
        ts: new Date(turnTs).toISOString(),
        sessionId, provider: provider.name, model,
        promptTokens: turnUsage.p, completionTokens: turnUsage.c, totalTokens: turnUsage.t,
        steps: stepCount,
      };
      const usageFile = path.join(dataDir(), DATA_FILE_NAMES.usage);
      const cur = readUsageFile(usageFile);
      const next = appendUsageTurn(cur, entry);
      const wr = writeUsageFile(usageFile, next);
      if (!wr.ok) log('WARN', 'usage', `用量记账落盘失败: ${wr.reason}`);
    } catch (err) {
      log('WARN', 'usage', `用量记账异常: ${(err as Error).message}`);
    }
  }

  // BUG（全盘死挂点扫描）：此前返回值只有 { text, intent }，渲染层收不到本回合工具
  // 轨迹 → doSend 从不写 m.tools，renderMsg 里「N 步 · M 个动作」的展示形态永远为空
  // （工具实时推送 tool-step 虽有订阅，state.toolSteps 存了却无人读取 = 存而不显）。
  return { text: finalReply, intent: 'ACT', tools: toolSteps, steps: stepCount };
}

// 测试后门（非渲染层桥）：browser-tools-verify / credentials-verify 经此驱动
// executeTool 做接线级断言。渲染层不触达（preload 无对应 invoke），生产仅作
// 单工具执行入口（无会话装配/回放记账）——测试专用，勿接 UI。
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
  // 导航防护（安全纵深）：主窗口永远只载本地 file:// 页面。一旦被导航到远端，
  // preload 暴露的 bridge API 就落进外部内容手里——即使 contextIsolation 也在，
  // 也应在源头堵死。内部浏览器走独立 BrowserWindow（browser-cdp.ts），不在此窗口导航。
  mainWindow.webContents.on('will-navigate', (event) => {
    event.preventDefault();
  });
  // 拒绝 window.open / target=_blank 逃逸（无 popup 需求；内部打开走别通道）。
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
}

// ---------------------------------------------------------------------------
// 桌面集成（PRD FR-4.2）：系统托盘 / 全局快捷键 / 登录自启动 / 自动更新 / 悬浮窗 / 开机提醒
// ----------------------------------------------------------------------------
// 第十个死挂点：设置页这 6 个开关此前全是 data-action="todo" 空壳 —— UI 可点、不落盘、
// 更无任何系统副作用。这里按「配置落 desktop.json，副作用在此重放」接线：
// 切换开关时只重放**受影响的那一项**，避免每次点击都去写系统登录项。
// 纯逻辑（归一化 / 落盘 / 悬浮窗内容）在 desktop-integration.ts（零 electron 依赖）。
let desktopConfig: DesktopConfig = { ...DEFAULT_DESKTOP_CONFIG };
let floatingWindow: BrowserWindow | null = null;
/** 悬浮窗展示的上下文（由渲染层在切换会话时推送，避免主进程猜「当前会话」）。 */
let floatingContext: { title: string; sessions: number } = { title: '', sessions: 0 };

function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

/** 全局快捷键语义：没有窗口 → 创建；可见且聚焦 → 隐藏；否则 → 唤起。 */
function toggleMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  if (mainWindow.isVisible() && mainWindow.isFocused()) mainWindow.hide();
  else showMainWindow();
}

function createTray(): void {
  if (tray) return;
  tray = new Tray(nativeImage.createEmpty());
  const contextMenu = Menu.buildFromTemplate([
    { label: '打开主窗', click: () => showMainWindow() },
    { label: '退出', click: () => app.quit() },
  ]);
  tray.setToolTip('OrchDesk');
  tray.setContextMenu(contextMenu);
  tray.on('click', () => showMainWindow());
  tray.on('double-click', () => showMainWindow());
}

function destroyTray(): void {
  if (!tray) return;
  try {
    tray.destroy();
  } catch {
    // 已销毁：destroy 抛错不应阻断开关切换
  }
  tray = null;
}

/** 系统托盘：关闭后是否继续常驻。 */
function applyTray(on: boolean): void {
  if (on) createTray();
  else destroyTray();
}

/** 全局快捷键 Ctrl(Cmd)+Shift+Space：注册/注销唯一加速器。 */
function applyShortcut(on: boolean): void {
  try {
    if (on) {
      if (globalShortcut.isRegistered(SHORTCUT_ACCELERATOR)) return;
      const ok = globalShortcut.register(SHORTCUT_ACCELERATOR, () => toggleMainWindow());
      if (!ok) log('WARN', 'desktop', `全局快捷键注册失败（${SHORTCUT_LABEL}）：可能被其它应用占用`);
    } else {
      globalShortcut.unregister(SHORTCUT_ACCELERATOR);
    }
  } catch (err) {
    log('WARN', 'desktop', `全局快捷键接线异常：${(err as Error).message}`);
  }
}

/** 读系统登录项真实状态（写入可能被系统拒绝，UI 必须展示实际值而非意愿值）。 */
function readLoginItemSettings(): { openAtLogin?: boolean } {
  try {
    return app.getLoginItemSettings() as { openAtLogin?: boolean };
  } catch {
    return {};
  }
}

/** 登录自启动：写系统登录项（Windows 注册表 / macOS LaunchAgent）。 */
function applyAutostart(on: boolean): { ok: boolean; reason?: string } {
  try {
    app.setLoginItemSettings({ openAtLogin: on, openAsHidden: on });
    return { ok: true };
  } catch (err) {
    const reason = (err as Error).message;
    log('WARN', 'desktop', `登录自启动写入失败：${reason}`);
    return { ok: false, reason };
  }
}

/** 开机提醒：关键事件（启动完成 / 更新可用）发系统通知。 */
function notifyDesktop(title: string, body: string): boolean {
  if (!desktopConfig.notify) return false;
  try {
    if (Notification.isSupported && !Notification.isSupported()) return false;
    new Notification({ title, body }).show();
    return true;
  } catch (err) {
    log('WARN', 'desktop', `系统通知发送失败：${(err as Error).message}`);
    return false;
  }
}

/** 自动更新：延迟后台检查（不阻塞首屏），有新版时按配置发通知。 */
function applyAutoUpdate(on: boolean): void {
  if (!on) return;
  setTimeout(() => {
    void checkForUpdates()
      .then((r) => {
        if (r?.update?.available) {
          notifyDesktop('OrchDesk 有新版本', String(r.update.note || `v${r.update.version || ''} 已下载，退出后安装`));
        }
      })
      .catch((err) => log('WARN', 'desktop', `自动更新检查异常：${(err as Error).message}`));
  }, 8000);
}

function floatingPosition(): { x: number; y: number } {
  try {
    const area = screen.getPrimaryDisplay().workAreaSize;
    return { x: Math.max(0, area.width - 288 - 16), y: Math.max(0, area.height - 120 - 48) };
  } catch {
    return { x: 0, y: 0 };
  }
}

function renderFloatingWindow(): void {
  if (!floatingWindow || floatingWindow.isDestroyed()) return;
  const title = floatingContext.title || 'OrchDesk';
  const html = floatingWindowHtml({
    title,
    subtitle: floatingContext.title ? '当前会话' : '未选择会话',
    sessions: floatingContext.sessions,
  });
  void floatingWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
}

function createFloatingWindow(): void {
  if (floatingWindow && !floatingWindow.isDestroyed()) {
    renderFloatingWindow();
    return;
  }
  floatingWindow = new BrowserWindow({
    width: 288,
    height: 96,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    ...floatingPosition(),
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
  });
  floatingWindow.on('closed', () => { floatingWindow = null; });
  // 导航防护与主窗一致（纵深防御）：悬浮窗内容全由主进程 loadURL(data:) 生成，
  // 无渲染层合法导航；禁止渲染层内部任何导航逃逸。
  floatingWindow.webContents.on('will-navigate', (event) => { event.preventDefault(); });
  floatingWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  // 悬浮窗是沙箱渲染进程，页面内无 ipcRenderer —— 用窗口聚焦事件实现「点击唤起主窗」。
  floatingWindow.on('focus', () => showMainWindow());
  floatingWindow.once('ready-to-show', () => floatingWindow?.show());
  renderFloatingWindow();
}

function destroyFloatingWindow(): void {
  if (!floatingWindow) return;
  try {
    if (!floatingWindow.isDestroyed()) floatingWindow.close();
  } catch {
    // 已关闭
  }
  floatingWindow = null;
}

function applyFloating(on: boolean): void {
  if (on) createFloatingWindow();
  else destroyFloatingWindow();
}

/**
 * 全量重放（启动时）。顺序无关，但自启动写系统项放最后，失败不影响其余。
 * 整体 try/catch：桌面集成为增强项，任一系统能力不可用都不该阻断主窗启动。
 */
function applyDesktopConfig(): void {
  try {
    applyTray(desktopConfig.tray);
    applyShortcut(desktopConfig.shortcut);
    applyFloating(desktopConfig.floating);
    applyAutoUpdate(desktopConfig.autoupdate);
    const r = applyAutostart(desktopConfig.autostart);
    if (!r.ok) log('WARN', 'desktop', `登录自启动未生效：${r.reason}`);
    log('INFO', 'desktop', `桌面集成已应用：${desktopSummary()}`);
  } catch (err) {
    log('WARN', 'desktop', `桌面集成应用异常：${(err as Error).message}`);
  }
}

function desktopSummary(): string {
  return (Object.keys(desktopConfig) as DesktopKey[])
    .map((k) => `${DESKTOP_LABELS[k]}=${desktopConfig[k] ? '开' : '关'}`)
    .join(' / ');
}

// ---------------------------------------------------------------------------
// 桥接：渲染进程 → 主进程（持久化 + 模型回合）
// ---------------------------------------------------------------------------
// 渲染层就绪标记：审批弹窗只在渲染层可应答时才发起（见 uiAnswerer）。
// 渲染层 init 的首个 IPC（load-sessions）即视为就绪——在那之前不存在用户输入源。
let rendererReady = false;

ipcMain.handle('orchdesk:load-sessions', async () => {
  rendererReady = true;
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

// ---- FR-6 SessionEvent 事件流桥接（ADR-0009）----
/** 血缘加载器：沿 fork-origin 链读父日志；非法 sid / 缺文件 → 空日志（回放不中断）。 */
function loadEventLog(sid: string): SessionEvent[] {
  const clean = sanitizeSessionId(sid);
  if (!clean) return [];
  try {
    return readEvents(eventFileFor(dataDir(), clean));
  } catch {
    return [];
  }
}

/** 回放数据源：事件流时间线（沿血缘链拼接）；日志为空 → source='legacy'（渲染层回退消息数组重建并显式标注）。 */
ipcMain.handle('orchdesk:session-events', async (_e, sid: string) => {
  try {
    const key = String(sid || '');
    const events = loadEventLog(key);
    if (!events.length) return { ok: true, source: 'legacy', count: 0, timeline: [] };
    // 血缘链上任一祖先日志为空（如 legacy 历史会话先被分叉）→ 事件流缺继承前缀，
    // 整体回落 legacy：消息数组含分叉时拷贝的切片，回放完整——不拿残缺事件流冒充 event-log。
    if (hasIncompleteAncestry(loadEventLog, key)) return { ok: true, source: 'legacy', count: 0, timeline: [] };
    // 一次收集（loadLog 链只走 1 遍），时间线与上下文从同一份派生
    // （审阅修复：此前 buildTimeline 与 collectLineageEvents 各自重读同一批 NDJSON，血缘链被读 3 遍）。
    const labeled = collectLabeled(loadEventLog, key);
    return {
      ok: true,
      source: 'event-log',
      count: events.length,
      timeline: timelineFromLabeled(labeled),
      // 上下文重建走全量血缘链（祖先前缀按 atIndex 截断后拼接），分叉子分支的
      // 模型上下文不依赖消息数组切片（ADR-0009 §4）。
      context: rebuildContext(labeled.map((x) => x.ev)),
    };
  } catch (err) {
    return { ok: false, reason: (err as Error).message, source: 'legacy', count: 0, timeline: [] };
  }
});

/** 分叉落事件（渲染层 doFork 调用）：子日志只写一条 fork-origin 血缘，不拷贝父事件。 */
ipcMain.handle('orchdesk:fork-event', async (_e, payload: unknown) => {
  const p = (payload || {}) as Record<string, unknown>;
  const newId = sanitizeSessionId(p.newId);
  if (!newId) return { ok: false, reason: '非法的新会话 id' };
  const from = sanitizeSessionId(p.from);
  if (!from) return { ok: false, reason: '非法的源会话 id' };
  const atIndex = Number(p.atIndex);
  if (!Number.isFinite(atIndex) || atIndex < 0) return { ok: false, reason: '分叉点必须是真数字（null 语义由渲染层夹紧）' };
  try {
    const w = appendEvents(eventFileFor(dataDir(), newId), [{
      ts: Number(p.at) || Date.now(),
      kind: 'fork-origin',
      from, fromTitle: String(p.fromTitle || ''), atIndex: Math.floor(atIndex),
    }]);
    if (!w.ok) return { ok: false, reason: w.reason };
    return { ok: true, count: w.written?.length || 0 };
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
});

// ---- FR-5 用量追踪桥接 ----
ipcMain.handle('orchdesk:usage', async () => {
  try {
    const file = readUsageFile(path.join(dataDir(), DATA_FILE_NAMES.usage));
    return { ok: true, ...aggregateUsage(file.entries) };
  } catch (err) {
    return { ok: false, reason: (err as Error).message, total: { promptTokens: 0, completionTokens: 0, totalTokens: 0, turns: 0 }, byModel: [], bySession: [] };
  }
});
ipcMain.handle('orchdesk:usage-clear', async () => {
  const wr = writeUsageFile(path.join(dataDir(), DATA_FILE_NAMES.usage), defaultUsageFile());
  return wr.ok ? { ok: true } : { ok: false, reason: wr.reason };
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
  // ---- PRD FR-9：会话 / 永久授权白名单 ----
  listGrants?(): GrantRuleLike[];
  grant?(input: unknown): { ok: boolean; rule?: GrantRuleLike; reason?: string };
  revoke?(id: string): boolean;
  revokeAll?(): number;
  matchGrant?(q: { toolName?: string; target?: string; sessionId?: string }): GrantRuleLike | null;
};

export interface GrantRuleLike {
  id: string;
  tool: string;
  pattern: string;
  scope: 'session' | 'permanent';
  sessionId?: string;
  createdAt: number;
  hits: number;
  note?: string;
}

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
      // 审批应答方（同一回调注册到两个组件）：
      // - host-services.approval.request：**实际发起方**（executeTool 授权门走这里）
      // - authz 插件 setUiAnswerer：接口对称保留
      // 此前只注册了 authz 侧 → approval.request 的 uiAnswerer 恒 null → 一律
      // 立即 unavailable（悬空接线，审批 UI 从未收到过真实请求）。
      const uiAnswererFn = async (req: { toolName?: string; reason?: string; sessionId?: string; target?: string }) => {
        // 渲染层未就绪 → 零等待 fail-closed：没有渲染层就没有用户输入源，
        // 审批弹窗不可能被应答，与其等满超时不如立即拒绝（与 host-services
        // 「无应答方」同语义的快路径）。
        if (!rendererReady || !mainWindow || mainWindow.isDestroyed()) return 'unavailable';
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
            // PRD FR-9：带上具体目标，弹窗才能给「会话内 / 永久允许」两个记住选项。
            target: req.target,
            sessionId: req.sessionId,
          });
        });
      };
      authz.setUiAnswerer(uiAnswererFn);
      runtime.host?.setUiAnswerer(uiAnswererFn as never);
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

    // 3) FR-10 记忆摘要 seam：自动转储走真实 LLM 摘要。
    //    第十五个死挂点：插件的 setSummarize 实现完整，但全项目零调用方 ——
    //    上下文达 80% 触发的自动转储一直走「首尾各 3 条截断 200 字」的抽取式
    //    兜底，PRD 要求的「LLM 摘要 → 语义分块 → 向量编码」只完成了后两步。
    //    失败语义：模型未配置 / 超时 / 报错一律**抛错**，由插件侧回落抽取式
    //    （摘要是增强不是必需，绝不能让整批转储蒸发）。
    const memoryApi = getService<MemoryServiceLike>('memory');
    if (memoryApi?.setSummarize) {
      memoryApi.setSummarize(async (messages) => {
        const cfg = loadModelConfig();
        const provider = cfg.providers[0];
        // 没配模型就直接抛 —— 让插件走兜底，而不是在这塞一句「（未配置模型）」
        // 当记忆存进去（那会污染语料，且召回出来是噪声）。
        if (!provider) throw new Error('no-provider');
        const model = (provider.models || [])[0] || cfg.defaultModel || 'qwen3:14b';
        const texts = (messages || []).map(extractSummarizeText);
        const reply = await withTimeout(
          callModel(provider, model, buildSummarizeMessages(texts) as ApiMessage[]),
          SUMMARIZE_TIMEOUT_MS,
        );
        return clampSummary(reply.content);
      });
      memorySummarizeSeam = true;
      console.log('[orchdesk] 记忆摘要已接入 LLM（FR-10，未配置模型时回落抽取式兜底）');
    } else {
      console.warn('[orchdesk] memory 服务不可用，自动转储将全部走抽取式兜底');
    }

    // 3b) Director 放行门（FR-10 / ②半接线修复）：brain 的 promoteWorkerOutput 默认
    //    fail-closed 永拒（director-filter-pending）——此前 worker 记忆晋升永远不成功，
    //    但 UI 文案表现得像「Director 认真裁决后驳回」。本桌面版的 worker→director 晋升
    //    由**用户主动点击**触发（已做人工审查），用户即 Director，故注入恒放行门。
    //    未来若引入 Worker 自动晋升通道，可在此换成 LLM 裁决门（保持 seam 不变）。
    const brainApi = getService<{ setFilter?: (fn: ((o: string) => boolean) | null) => void }>('brainHands');
    if (brainApi?.setFilter) {
      brainApi.setFilter(() => true); // 用户即 Director：手动晋升直接放行
      console.log('[orchdesk] Director 放行门已注入（用户即 Director：手动 worker 晋升直接放行）');
    }
  } catch (err) {
    console.error('[orchdesk] dsh 运行时启动失败，插件能力不可用:', (err as Error).message);
  }

  // 4) PRD FR-3 本地插件市场：回灌持久化里 enabled=true 的第三方插件。
  //    enabled 是用户显式的装载授权；单个插件装载失败不阻断其余（结果打日志）。
  //    注意直接读文件：bootRuntime 早于启动序列里的状态装载，用模块变量会拿到空表。
  try {
    const results = await startupMarketPlugins(loadMarketEnabled());
    for (const r of results) {
      if (r.ok) log('INFO', 'market', `市场插件 ${r.dir} 已随启动装载`);
      else log('WARN', 'market', `市场插件 ${r.dir} 启动装载失败：${r.error || '未知原因'}`);
    }
  } catch (err) {
    console.warn('[orchdesk] 市场插件回灌失败:', (err as Error).message);
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

// ---------------------------------------------------------------------------
// PRD FR-9：授权白名单（操作类型 + 路径白名单，可查看可撤销）
// ---------------------------------------------------------------------------
// 粒度三选一此前只实现了「单次」——每次写同一个文件都要重新点确认。
// 这里补 session / permanent 两种记住粒度；持久化走 dsh-runtime 写穿落盘
// （authz-grants.json），撤销立即生效并全部入审计。
ipcMain.handle('orchdesk:authz-list-grants', async () => {
  if (!authzService?.listGrants) return [];
  try { return authzService.listGrants(); } catch { return []; }
});

ipcMain.handle('orchdesk:authz-grant', async (_e, input: unknown) => {
  if (!authzService?.grant) return { ok: false, reason: '授权服务未加载' };
  const res = authzService.grant(input);
  if (res.ok) persistGrants();
  else log('WARN', 'authz', `白名单规则被拒：${res.reason}`);
  return { ...res, grants: authzService.listGrants?.() ?? [] };
});

ipcMain.handle('orchdesk:authz-revoke-grant', async (_e, id: string) => {
  if (!authzService?.revoke) return { ok: false, reason: '授权服务未加载' };
  const ok = authzService.revoke(String(id || ''));
  if (ok) persistGrants();
  return { ok, grants: authzService.listGrants?.() ?? [] };
});

ipcMain.handle('orchdesk:authz-revoke-all-grants', async () => {
  if (!authzService?.revokeAll) return { ok: false, reason: '授权服务未加载' };
  const revoked = authzService.revokeAll();
  persistGrants();
  return { ok: true, revoked, grants: authzService.listGrants?.() ?? [] };
});

/** 写穿落盘（白名单数量少、变更罕见，不走记忆那套 20s 轮询）。 */
function persistGrants(): void {
  try {
    if (!persistGrantsNow()) log('WARN', 'authz', '授权白名单落盘失败（本次会话仍生效，重启后丢失）');
  } catch (err) {
    log('WARN', 'authz', `授权白名单落盘异常：${(err as Error).message}`);
  }
}

// ---- TRACE 上报开关（TOKEN 加密内置于包内；用户仅可开关，默认开）----
// enabled=false → dsh-runtime 装载 trace 时 repoUrl 置空 → 只缓冲不上传（观测照旧）。
// 切换写 <dataDir>/trace.json，**重启生效**（config 在插件装载时注入）。
ipcMain.handle('orchdesk:trace-status', () => {
  const dataDir = process.env.ORCHDESK_DATA_DIR || process.env.ORCHDESK_HOME || '';
  let enabled = true;
  if (dataDir) {
    try {
      const f = JSON.parse(fs.readFileSync(path.join(dataDir, 'trace.json'), 'utf-8')) as { enabled?: boolean };
      if (typeof f.enabled === 'boolean') enabled = f.enabled;
    } catch { /* 缺省开 */ }
  }
  let builtin = false;
  try {
    fs.accessSync(path.join(__dirname, '..', 'build', 'trace-token.enc.json'));
    builtin = true;
  } catch { /* 未内置（dev 或未跑 prepare-trace）→ 只缓冲 */ }
  return { enabled, builtin };
});
ipcMain.handle('orchdesk:trace-set-enabled', (_e, enabled: boolean) => {
  const dataDir = process.env.ORCHDESK_DATA_DIR || process.env.ORCHDESK_HOME || '';
  if (!dataDir) return { ok: false, reason: '数据目录未就绪' };
  try {
    fs.writeFileSync(path.join(dataDir, 'trace.json'), JSON.stringify({ enabled: !!enabled }, null, 2), 'utf-8');
    return { ok: true, requiresRestart: true };
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
});

// PRD FR-8：沙箱策略（模式 + 网络域名白名单）
ipcMain.handle('orchdesk:sandbox-get', () => {
  const policy = getHostServices()?.sandboxPolicy;
  return {
    mode: policy?.resolve?.().mode || 'workspace-write',
    networkAllow: policy?.getNetworkAllow ? policy.getNetworkAllow() : ['*'],
  };
});
ipcMain.handle('orchdesk:sandbox-set-network-allow', (_e, list: string[]) => {
  const policy = getHostServices()?.sandboxPolicy;
  if (!policy?.setNetworkAllow) return { ok: false, reason: '沙箱服务未就绪' };
  policy.setNetworkAllow(Array.isArray(list) ? list : []);
  const next = policy.getNetworkAllow ? policy.getNetworkAllow() : ['*'];
  // 放宽网络白名单是安全相关配置变更 → 入沙箱日志，事后可追溯「什么时候放开了哪些域名」。
  recordSandbox({
    tool: 'sandbox.network',
    kind: 'config',
    target: next.join(','),
    decision: 'allowed',
    reason: `网络域名白名单已更新（${next.length} 项）`,
  });
  return { ok: true, networkAllow: next };
});

// PRD FR-8：沙箱日志检索（设置页入口）
ipcMain.handle('orchdesk:sandbox-log', (_e, q: SandboxLogQuery | undefined) => {
  const query = (q && typeof q === 'object' ? q : {}) as SandboxLogQuery;
  return {
    entries: searchSandboxLog(sandboxLog, query),
    stats: sandboxLogStats(sandboxLog),
    total: sandboxLog.length,
    max: SANDBOX_LOG_MAX,
  };
});
ipcMain.handle('orchdesk:sandbox-log-clear', () => {
  const cleared = sandboxLog.length;
  sandboxLog = [];
  persistSandboxLog();
  return { ok: true, cleared, entries: [], stats: sandboxLogStats(sandboxLog) };
});

// TRACE 用户反馈（PRD FR-7，第八死挂点修复）：渲染层每条 Agent 消息底部
// 「有帮助 / 需改进」→ 真实写入 trace 遥测队列（source='user'）。
// 此前按钮只改渲染层本地 Set + persist()，反馈从未进入遥测链路。
interface TraceServiceLike {
  recordFeedback(intent: string, feedback: string, sessionKey?: string, messageKey?: string): void;
  queueSize(): { pending: number; retry: number; errors: number };
}
ipcMain.handle(
  'orchdesk:trace-feedback',
  (_e, payload: { intent?: string; feedback?: string; sessionKey?: string; messageKey?: string }) => {
    const svc = getService<TraceServiceLike>('trace');
    if (!svc) return { ok: false, reason: 'TRACE 插件未接入' };
    const feedback = payload?.feedback === 'negative' ? 'negative' : payload?.feedback === 'neutral' ? 'neutral' : 'positive';
    try {
      svc.recordFeedback(
        String(payload?.intent || 'unknown'),
        feedback,
        payload?.sessionKey ? String(payload.sessionKey) : undefined,
        payload?.messageKey ? String(payload.messageKey) : undefined,
      );
      return { ok: true, queue: svc.queueSize() };
    } catch (err) {
      return { ok: false, reason: (err as Error).message };
    }
  },
);

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
  /** 语义召回（TF-IDF Top-K 余弦，同步）；插件 provide 的原始形态。 */
  recall?(query: string, opts?: { domain?: string; k?: number }): unknown;
  listDomain?(domain: string): unknown;
  record?(domain: string, text: string, source: { origin: string }): unknown;
  /**
   * 晋升（异步：worker 出域要 await Director 过滤）。
   * 返回 { ok, reason }；reason 形如 `promoted:worker->director` /
   * `director-rejected:<原因>` / `brain-filter-unavailable` / `entry-not-found`。
   */
  promote?(id: string, from: string, to: string): Promise<{ ok: boolean; reason: string }>;
  /** 注入 LLM 摘要实现（FR-10 seam；未注入时插件走抽取式兜底）。 */
  setSummarize?(fn: (messages: unknown[]) => Promise<string>): void;
}
/** FR-10：摘要 seam 是否已由宿主注入（设置页据此显示当前摘要方式）。 */
let memorySummarizeSeam = false;

ipcMain.handle('orchdesk:memory-stats', () => {
  const svc = getService<MemoryServiceLike>('memory');
  return svc ? svc.getStats() : null;
});
/**
 * 当前摘要方式（可观测性）：seam 注入了 + 配置了模型才走 LLM，
 * 否则自动转储一律走抽取式兜底 —— 这个值就是判断依据，避免「以为在用
 * LLM 摘要，其实一直在兜底」这种无从发现的降级。
 */
ipcMain.handle('orchdesk:memory-summarize-status', () => {
  let providerName = '';
  let model = '';
  try {
    const cfg = loadModelConfig();
    const p = cfg.providers[0];
    providerName = p?.name ? String(p.name) : '';
    // 没有提供商就**不要**拿 cfg.defaultModel 顶上（默认是 'qwen3:14b'）——
    // 那会让「一个模型都没配」显示成「正在用 qwen3:14b 做 LLM 摘要」，
    // 恰恰是这个功能最需要避免的假象（用 mock 网关跑真链路时抓到的）。
    model = p ? String((p.models || [])[0] || cfg.defaultModel || '') : '';
  } catch { /* 配置读取失败按「未配置」处理，不阻断设置页渲染 */ }
  const ready = memorySummarizeSeam && !!model;
  return { seam: memorySummarizeSeam, provider: providerName, model, mode: ready ? 'llm' : 'extractive' };
});

// ---------------------------------------------------------------------------
// PRD FR-10：分层记忆晋升（第十四个死挂点）
// ---------------------------------------------------------------------------
// 插件里 promote() 的实现是完整的 —— worker→director 走 brain 过滤、fail-closed、
// 默认拒绝，全都写好了。但全项目**零调用方**：没有任何代码、没有任何按钮调用它。
// 后果是 Worker 域的条目进来就出不去，四域实际退化为「global 域 + 三个摆设」，
// PRD 那句「Worker 输出须经 Director 过滤才能晋升上层」等于没落地。
//
// 这里补的是调用链（桥），不是能力本身：
//   - 单条晋升：用户在设置页点，方向任意，worker 出域必过 Director 过滤。
//   - 批量晋升：一次性把 worker 域的结论过一遍 Director（见 PROMOTE_BATCH_MAX 注释）。
//   - 晋升审计：成功与失败都记，写穿落盘（PRD「须显式操作并写审计」）。
// ---------------------------------------------------------------------------

let promotionLog: PromotionEntry[] = [];

function promotionFile(): string {
  return path.join(dataDir(), DATA_FILE_NAMES.promotions);
}

// ---------------------------------------------------------------------------
// PRD FR-3 连接器注册表
// ---------------------------------------------------------------------------
// 目录定义 / 探测请求构造 / 结果判定 / 审计环形缓冲全在 connector-registry.ts
// （纯逻辑、零 electron）。这里只管三件必须摸到本机的事：文件读写、真实 HTTP 探测、
// 以及把结论挂到 IPC 上。
// ---------------------------------------------------------------------------

let connectorFile: ConnectorFile = emptyConnectorFile();

function connectorsFilePath(): string {
  return path.join(dataDir(), DATA_FILE_NAMES.connectors);
}

/** 启动装载：坏文件 / 缺文件 → 空注册表（凭证丢了可以重录，不该阻断启动）。 */
function loadConnectors(): number {
  try {
    connectorFile = normalizeConnectorFile(JSON.parse(fs.readFileSync(connectorsFilePath(), 'utf-8')));
  } catch {
    connectorFile = emptyConnectorFile();
  }
  return Object.values(connectorFile.creds).length;
}

/**
 * 写穿落盘（与沙箱日志 / 晋升审计同节奏）。
 * 失败只 WARN：凭证已经写进内存里的注册表，UI 上就是可用的状态；因为落盘失败就
 * 回滚，会让用户刚填完的凭证凭空消失且没有任何提示。
 */
function persistConnectors(): boolean {
  try {
    const file = connectorsFilePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(connectorFile, null, 2), 'utf-8');
    return true;
  } catch (err) {
    log('WARN', 'connector', `连接器注册表落盘失败（内存态仍生效）: ${(err as Error).message}`);
    return false;
  }
}

// ---- 本地插件市场（PRD FR-3）：启用意愿持久化（插件代码在 dataDir()/plugins/）----
let marketEnabledMap: Record<string, boolean> = {};

function marketStateFile(): string {
  return path.join(dataDir(), DATA_FILE_NAMES.market);
}

function loadMarketEnabled(): Record<string, boolean> {
  try {
    const raw = JSON.parse(fs.readFileSync(marketStateFile(), 'utf-8'));
    return normalizeEnabledMap(raw && typeof raw === 'object' ? (raw as Record<string, unknown>).enabled : null);
  } catch {
    return {};
  }
}

/** 写穿：启停是用户的授权决定，「重启后丢了」比落盘失败严重得多。 */
function persistMarketEnabled(): void {
  try {
    fs.mkdirSync(path.dirname(marketStateFile()), { recursive: true });
    fs.writeFileSync(marketStateFile(), JSON.stringify({ enabled: marketEnabledMap }, null, 2), 'utf-8');
  } catch (err) {
    log('WARN', 'market', `插件市场状态落盘失败: ${(err as Error).message}`);
  }
}

function recordConnectorAudit(id: string, action: ConnectorAuditAction, message: string): void {
  const entry: ConnectorAuditEntry = {
    id,
    ts: Date.now(),
    action,
    message: String(message || '').slice(0, 240),  };
  connectorFile.audit = appendConnectorAudit(connectorFile.audit, entry);
  persistConnectors();
}

/** 执行一次真实探测（只发请求，不落状态；状态更新由调用方决定）。 */
async function probeConnector(id: string): Promise<{ ok: boolean; message: string; manual?: boolean }> {
  const def = getConnectorDef(id);
  if (!def) return { ok: false, message: `未知连接器: ${id}` };
  // manual 连接器没有探测端点，直接把原因回给用户，不要伪造一个「已连接」。
  if (def.probe.kind !== 'http') {
    return { ok: false, manual: true, message: def.probe.manualReason || '该连接器不支持自动探测' };
  }
  const creds = readCreds(connectorFile, id);
  const built = buildProbeRequest(def, creds);
  if (!built.ok) return { ok: false, message: built.error };

  try {
    const req = built.request;
    const res = await fetch(req.url, {
      method: req.method,
      headers: req.headers,
      ...(req.body ? { body: req.body } : {}),
      signal: AbortSignal.timeout(CONNECTOR_PROBE_TIMEOUT_MS),
    });
    const text = await res.text();
    let body: unknown = null;
    try { body = JSON.parse(text); } catch { body = null; }
    return interpretProbeResult(def, { status: res.status, body });
  } catch (err) {
    const e = err as Error;
    // AbortSignal.timeout 抛出的是 TimeoutError，单独说人话。
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
      return { ok: false, message: `探测超时（${CONNECTOR_PROBE_TIMEOUT_MS / 1000}s）：网络不可达或被拦截` };
    }
    return { ok: false, message: `网络请求失败：${e?.message || String(err)}` };
  }
}

/** 探测并把结论写进状态表（成功与失败都要记 —— 失败记录才是排查凭证问题的依据）。 */
async function testConnector(id: string): Promise<{ ok: boolean; message: string; manual?: boolean }> {
  const result = await probeConnector(id);
  const st = connectorFile.states[id];
  if (st) {
    if (!result.manual) {
      st.lastTestAt = Date.now();
      st.lastTestOk = result.ok;
      st.lastTestMessage = result.message;
    } else {
      // manual 连接器「没探测」不等于「探测失败」：把 manual 原因写进 lastTestOk=false
      // 会让 UI 显示「连通失败」，把「不支持自动探测」伪装成鉴权问题。
      st.lastTestAt = null;
      st.lastTestOk = null;
      st.lastTestMessage = '';
    }
  }
  if (!result.manual) {
    recordConnectorAudit(id, result.ok ? 'test' : 'test-fail', result.message);
  } else {
    persistConnectors();
  }
  return result;
}

/** 供渲染层列表用的一条连接器视图（凭证已脱敏，密文绝不出主进程）。 */
function connectorView(id: string) {
  const def = getConnectorDef(id)!;
  const creds = readCreds(connectorFile, id);
  return {
    id: def.id,
    name: def.name,
    kind: def.kind,
    desc: def.desc,
    caps: def.caps,
    docsUrl: def.docsUrl,
    manual: def.probe.kind !== 'manual' ? false : true,
    manualReason: def.probe.manualReason || '',
    manualHint: def.probe.manualHint || '',
    fields: def.fields.map((f) => ({
      key: f.key, label: f.label, type: f.type,
      placeholder: f.placeholder || '', hint: f.hint || '', required: f.required !== false,
    })),
    values: redactCreds(def, creds),
    state: connectorFile.states[id] || null,
  };
}

/** 启动装载：坏文件 / 缺文件 → 空审计（与沙箱日志同策略，不猜内容）。 */
function loadPromotionLog(): number {
  try {
    promotionLog = normalizePromotionLog(JSON.parse(fs.readFileSync(promotionFile(), 'utf-8')));
  } catch {
    promotionLog = [];
  }
  return promotionLog.length;
}

/** 写穿落盘（与沙箱日志同节奏）。落盘失败只 WARN —— 审计不是安全门，
 *  绝不能因为记不下来就回滚已经完成的晋升（那样 UI 会显示失败但实际已生效）。 */
function persistPromotionLog(): boolean {
  try {
    const file = promotionFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(promotionLog, null, 2), 'utf-8');
    return true;
  } catch (err) {
    log('WARN', 'memory', `晋升审计落盘失败（不影响晋升结果）: ${(err as Error).message}`);
    return false;
  }
}

/** 取条目正文做审计摘要。取不到留空 —— 预览缺失不该让审计整条丢掉。 */
function promotionPreview(svc: MemoryServiceLike | null, domain: string, id: string): string {
  try {
    const list = (svc?.listDomain?.(domain) as Array<{ id?: string; text?: string }> | undefined) || [];
    const hit = list.find((e) => e && e.id === id);
    return String(hit?.text || '');
  } catch {
    return '';
  }
}

/** 记一条晋升审计（成功与失败都记：被拦下的晋升比成功的更有追溯价值）。 */
function recordPromotion(input: {
  from: string;
  to: string;
  memoryId: string;
  preview: string;
  ok: boolean;
  reason: string;
  actor: 'user' | 'auto';
}): void {
  if (!isMemoryDomain(input.from) || !isMemoryDomain(input.to)) return;
  const before = promotionLog.length;
  promotionLog = appendPromotionLog(promotionLog, { ...input, ts: Date.now() });
  if (promotionLog.length !== before) {
    persistPromotionLog();
    log('INFO', 'memory', `记忆晋升${input.ok ? '成功' : '被拦'}：${input.from}→${input.to} · ${input.reason}（${input.actor}）`);
  }
}

/** 列出某域条目（渲染层展示用；正文字段原样透传，截断由 UI 决定）。 */
ipcMain.handle('orchdesk:memory-list', async (_e, domain: string) => {
  const svc = getService<MemoryServiceLike>('memory');
  if (!svc?.listDomain) return null;
  if (!isMemoryDomain(domain)) return null;
  try {
    const list = (svc.listDomain(domain) as Array<unknown> | undefined) || [];
    return list.map((e) => {
      const r = e as { id?: string; text?: string; source?: { origin?: string; agent?: string }; createdAt?: number };
      return {
        id: String(r.id || ''),
        text: String(r.text || ''),
        origin: String(r.source?.origin || ''),
        agent: String(r.source?.agent || ''),
        createdAt: Number(r.createdAt) || 0,
      };
    });
  } catch {
    return null;
  }
});

/** 单条晋升。domain 非法 / 服务缺失 → 拒绝且不入审计（参数错误不值得留痕）。 */
ipcMain.handle('orchdesk:memory-promote', async (_e, input: unknown) => {
  const r = (input || {}) as { id?: string; from?: string; to?: string };
  const svc = getService<MemoryServiceLike>('memory');
  if (!svc?.promote) return { ok: false, reason: 'memory-service-unavailable' };
  if (!isMemoryDomain(r.from) || !isMemoryDomain(r.to)) return { ok: false, reason: 'bad-domain' };
  const id = String(r.id || '').trim();
  if (!id) return { ok: false, reason: 'bad-id' };

  const preview = promotionPreview(svc, r.from, id);
  let result: { ok: boolean; reason: string };
  try {
    result = await svc.promote(id, r.from, r.to);
  } catch (err) {
    result = { ok: false, reason: `error:${(err as Error).message}` };
  }
  recordPromotion({
    from: r.from, to: r.to, memoryId: id, preview,
    ok: result.ok, reason: result.reason, actor: 'user',
  });
  return result;
});

/**
 * 批量晋升 worker 域 → director（自动通道：每条都要过 Director 过滤）。
 *
 * 为什么设上限：promote 是异步的，worker 出域要 await brain 过滤（默认 5s 超时）。
 * worker 域理论上限 200 条，不设上限最坏情况是 UI 卡死十几分钟且无法中途取消。
 * 一次处理 PROMOTE_BATCH_MAX 条（按时间正序，先处理最早的），剩下的报 remaining，
 * 用户想继续再点一次 —— 宁可多按几下，也不要一个点不动的按钮。
 */
const PROMOTE_BATCH_MAX = 20;

ipcMain.handle('orchdesk:memory-promote-worker', async (_e, input: unknown) => {
  const r = (input || {}) as { to?: string };
  const svc = getService<MemoryServiceLike>('memory');
  if (!svc?.promote || !svc?.listDomain) return { ok: false, reason: 'memory-service-unavailable' };
  const to = isMemoryDomain(r.to) ? r.to : 'director';
  const list = ((svc.listDomain('worker') as Array<{ id?: string; text?: string; createdAt?: number }> | undefined) || [])
    .filter((e) => e && String(e.id || ''))
    .sort((a, b) => Number(a.createdAt) - Number(b.createdAt));

  const batch = list.slice(0, PROMOTE_BATCH_MAX);
  const out = { ok: true, total: list.length, attempted: batch.length, promoted: 0, rejected: 0, remaining: Math.max(0, list.length - batch.length), reasons: [] as Array<{ id: string; ok: boolean; reason: string }> };
  for (const item of batch) {
    const id = String(item.id || '');
    let result: { ok: boolean; reason: string };
    try {
      result = await svc.promote(id, 'worker', to);
    } catch (err) {
      result = { ok: false, reason: `error:${(err as Error).message}` };
    }
    if (result.ok) out.promoted++;
    else out.rejected++;
    out.reasons.push({ id, ok: result.ok, reason: result.reason });
    recordPromotion({
      from: 'worker', to, memoryId: id, preview: String(item.text || ''),
      ok: result.ok, reason: result.reason, actor: 'auto',
    });
  }
  return out;
});

/** 晋升审计可查（关键词 / 源域 / 目标域 / 成功失败 四维过滤）。 */
ipcMain.handle('orchdesk:memory-promotions', async (_e, query: unknown) => {
  const q = (query || {}) as PromotionLogQuery;
  return {
    entries: searchPromotionLog(promotionLog, q),
    stats: promotionStats(promotionLog),
    total: promotionLog.length,
    max: PROMOTION_LOG_MAX,
  };
});

/** 外链白名单：渲染层 <a href> 会导航整个窗口，必须走 shell.openExternal；且只放行 http/https。 */
ipcMain.handle('orchdesk:open-external', async (_e, url: unknown) => {
  const u = String(url || '');
  if (!/^https?:\/\//i.test(u)) return { ok: false, reason: '仅允许 http/https 链接' };
  try { await shell.openExternal(u); return { ok: true }; }
  catch (err) { return { ok: false, reason: (err as Error).message }; }
});

// ---------------------------------------------------------------------------
// 浏览器（CDP）IPC：渲染层「浏览器」面板
// ---------------------------------------------------------------------------
// 面板不是装饰：Agent 默认在**后台隐藏窗口**里操作网页，用户若没有一个入口
// 查看「现在在哪个页面 / 截了什么图 / 能随时关掉」，浏览器工具就是黑箱。
// 这也是本 Phase 的「端到端可用」底线（禁止后端先行、UI 后补）。

/** 状态推送：浏览器窗口由工具或用户改变时，面板实时跟着变。 */
function pushBrowserState(st?: BrowserStateSnapshot): void {
  const snapshot = st || getBrowserState();
  try {
    const w = rendererWindow();
    if (w) w.webContents.send('orchdesk:browser-state', snapshot);
  } catch { /* 窗口已关闭 */ }
}

onBrowserStateChange((st) => pushBrowserState(st));

/** 浏览器状态（含最近截图缩略图与截图目录）。 */
ipcMain.handle('orchdesk:browser-status', async () => {
  const st = getBrowserState();
  return { ...st, shotsDir: browserShotDir(dataDir()) };
});

/** 显示 / 隐藏浏览器窗口（false = 收回后台）。 */
ipcMain.handle('orchdesk:browser-toggle-visible', async (_e, visible: unknown) => {
  const st = setBrowserVisible(Boolean(visible));
  return { ok: st.open, state: st };
});

/** 关闭浏览器窗口（面板的「关闭」按钮 = 用户侧的紧急制动）。 */
ipcMain.handle('orchdesk:browser-close', async () => {
  const closed = cdpCloseBrowser();
  return { ok: true, closed, state: getBrowserState() };
});

/** 在系统文件管理器中打开截图目录。 */
ipcMain.handle('orchdesk:browser-open-shot-dir', async () => {
  const dir = browserShotDir(dataDir());
  try {
    fs.mkdirSync(dir, { recursive: true });
    const opened = await shell.openPath(dir);
    // openPath 返回空串表示成功；非空是错误信息。
    return { ok: opened === '', dir, reason: opened || undefined };
  } catch (err) {
    return { ok: false, dir, reason: (err as Error).message };
  }
});

// ---------------------------------------------------------------------------
// 终端（PTY）IPC：渲染层「终端」Tab（吸收计划 P2-10）
// ---------------------------------------------------------------------------
// 终端是「用户亲手操作」的入口，不走 Agent 授权门；但环境净化（NODE_OPTIONS 等
// shim 变量）在 terminal-pty.ts 的 sanitizeTerminalEnv 里强制执行。
// 数据/退出事件用推送（与 browser-state 同模式），Tab 栏状态用拉取。

/** 终端应用目录：dev = apps/desktop，packaged = app.asar（asarUnpack 透明重定向）。 */
const TERMINAL_APP_DIR = path.resolve(__dirname, '..');

/** dsh 运行时自建的 profile node_modules（dev 环境常有 node-pty，作最后候选）。 */
function terminalExtraPtyDirs(): string[] {
  const cands = [
    path.join(TERMINAL_APP_DIR, '..', '.dsh-home', 'profiles', 'node_modules'),
    path.join(process.cwd(), '.dsh-home', 'profiles', 'node_modules'),
  ];
  return [...new Set(cands)];
}

/** 终端数据推送：攒批后的输出块（节流在 terminal-pty.ts 内）。 */
onTerminalData((ev) => {
  try {
    const w = rendererWindow();
    if (w) w.webContents.send('orchdesk:terminal-data', ev);
  } catch { /* 窗口已关闭 */ }
});

/** 终端退出推送：Tab 栏把该会话标记为已退出（不自动关闭，保留回看）。 */
onTerminalExit((ev) => {
  try {
    const w = rendererWindow();
    if (w) w.webContents.send('orchdesk:terminal-exit', ev);
  } catch { /* 窗口已关闭 */ }
});

/** 创建终端会话。via='pipe' 时渲染层必须显示「管道模式」提示（降级可见）。 */
ipcMain.handle('orchdesk:terminal-create', async (_e, input: unknown) => {
  const req = (input && typeof input === 'object' ? input : {}) as { cwd?: string; cols?: number | string; rows?: number | string };
  // BUG-023：渲染层会把项目绑定目录作为终端 cwd 传入——目录可能已被删/移动，
  // 此时回退宿主默认（删除该字段），不让整个终端创建失败；会话返回的 cwd
  // 字段反映真实落点，降级可见。
  if (typeof req.cwd === 'string' && req.cwd.trim()) {
    let dirOk = false;
    try { dirOk = fs.statSync(req.cwd.trim()).isDirectory(); } catch { /* 不存在 */ }
    if (!dirOk) delete req.cwd;
  }
  return createTerminal(
    req,
    {
      appDir: TERMINAL_APP_DIR,
      extraPtyDirs: terminalExtraPtyDirs(),
      fallbackCwd: process.cwd(),
    },
  );
});

/** 写入用户键入。 */
ipcMain.handle('orchdesk:terminal-write', async (_e, id: unknown, data: unknown) => {
  if (typeof id !== 'string' || typeof data !== 'string') {
    return { ok: false, reason: '参数不合法' };
  }
  return { ok: writeTerminal(id, data) };
});

/** 调整尺寸（管道模式 no-op）。 */
ipcMain.handle('orchdesk:terminal-resize', async (_e, id: unknown, cols: unknown, rows: unknown) => {
  if (typeof id !== 'string') return { ok: false, reason: '参数不合法' };
  return { ok: resizeTerminal(id, cols, rows) };
});

/** 关闭会话（幂等）。 */
ipcMain.handle('orchdesk:terminal-kill', async (_e, id: unknown) => {
  if (typeof id !== 'string') return { ok: false, reason: '参数不合法' };
  return { ok: killTerminal(id) };
});

/** 全量状态：Tab 栏 + 每会话回放缓冲（重开 Tab 补看历史输出）。 */
ipcMain.handle('orchdesk:terminal-status', async () => getTerminalState());

// ---------------------------------------------------------------------------
// 文件 Tab IPC（吸收计划 P2-11，只读优先）
// ---------------------------------------------------------------------------
// 目录逐层懒加载（每次只列一层，防巨大目录树一次全量扫描）；
// 文件读取限 2MB + 二进制嗅探（NUL 字节），「截断」必须显式返回，不许静默。

ipcMain.handle('orchdesk:file-tree', async (_e, input: unknown) => {
  const norm = normalizeFileTree(input as { dir?: string; depth?: number | string });
  if (!norm.ok) return { ok: false as const, reason: norm.reason };
  try {
    const dirents = fs.readdirSync(norm.dir, { withFileTypes: true });
    const raw: Array<{ name: string; kind: 'file' | 'dir'; size: number; mtime: number }> = [];
    let overflow = false;
    // scanned 与 raw 分开计数：被跳过（符号链接/无权限）的条目也计入扫描量，
    // 否则一个 5 万条目、绝大部分是坏链接的目录会被全量 stat 一遍才肯停。
    let scanned = 0;
    for (const de of dirents) {
      if (raw.length >= FILE_TREE_MAX_ENTRIES || scanned >= FILE_TREE_MAX_ENTRIES * 4) {
        overflow = true;
        break;
      }
      scanned++;
      // 目录不 stat：渲染层不显示目录大小，省下 500 次里的大半 syscall
      // （实测 500 次 statSync ≈ 17ms，主进程同步阻塞）。
      if (de.isDirectory()) {
        raw.push({ name: de.name, kind: 'dir', size: 0, mtime: 0 });
        continue;
      }
      if (!de.isFile()) continue; // 符号链接等其它类型：跳过（防环）。
      try {
        const st = fs.statSync(path.join(norm.dir, de.name));
        raw.push({ name: de.name, kind: 'file', size: st.size, mtime: st.mtimeMs });
      } catch {
        // 无权限 / 竞态删除：跳过该条目，不让一个坏条目毁掉整棵树。
      }
    }
    return {
      ok: true as const,
      dir: norm.dir,
      entries: sortTreeEntries(raw),
      truncated: overflow,
      total: dirents.length,
    };
  } catch (err) {
    return { ok: false as const, reason: (err as Error).message };
  }
});

ipcMain.handle('orchdesk:file-read', async (_e, input: unknown) => {
  const norm = normalizeFileRead(input as { path?: string });
  if (!norm.ok) return { ok: false as const, reason: norm.reason };
  try {
    const st = fs.statSync(norm.path);
    if (st.isDirectory()) return { ok: false as const, reason: '目标是目录，不是文件' };
    // languageOf / looksBinaryByName 都接受完整路径（内部先切 basename），
    // 不在这里自己 lastIndexOf('.')——路径里有带点目录时会取错扩展名。
    const lang = languageOf(norm.path);
    const binaryByName = looksBinaryByName(norm.path);
    // 只读 maxBytes 字节；是否截断由 stat.size 与 maxBytes 比较得出（显式字段）。
    const fd = fs.openSync(norm.path, 'r');
    try {
      const want = Math.min(st.size, norm.maxBytes);
      const buf = Buffer.alloc(want);
      // readSync 不保证一次读满（大文件 / 网络盘常见短读）。循环读满 want，
      // 否则会产出「内容比磁盘短却声称完整」的假象——「截断必须显式」的底线。
      let read = 0;
      while (read < want) {
        const n = fs.readSync(fd, buf, read, want - read, read);
        if (n <= 0) break;
        read += n;
      }
      const head = buf.subarray(0, Math.min(read, SNIFF_WINDOW));
      const binary = binaryByName || sniffBinary(head);
      if (binary) {
        // 二进制文件：只给元信息，不吐内容（渲染层显示「二进制文件」占位）。
        return {
          ok: true as const, path: norm.path, binary: true, truncated: false,
          size: st.size, sizeLabel: humanSize(st.size), lang: null, content: '',
          mtimeMs: st.mtimeMs, encodingSuspicious: false, editable: false,
        };
      }
      const truncated = st.size > norm.maxBytes || read < want;
      // 编辑资格判定（P3）：截断过的文件保存会丢数据、非 UTF-8 保存即乱码
      // ——一律 editable=false 且渲染层显式给原因。
      // 严格校验用 TextDecoder(fatal) 而不是「解出 U+FFFD 就判定」：后者会把
      // 本来就合法含 U+FFFD 的文本（译不准的占位符很常见）误判成非 UTF-8，
      // 结果是可编辑的文件被禁掉编辑。
      const decoded = buf.subarray(0, read).toString('utf8');
      let encodingSuspicious = false;
      try {
        new TextDecoder('utf-8', { fatal: true }).decode(buf.subarray(0, read));
      } catch {
        encodingSuspicious = true;
      }
      return {
        ok: true as const, path: norm.path, binary: false, truncated,
        size: st.size, sizeLabel: humanSize(st.size), lang,
        content: decoded,
        mtimeMs: st.mtimeMs, encodingSuspicious,
        editable: !truncated && !encodingSuspicious,
      };
    } finally {
      fs.closeSync(fd);
    }
  } catch (err) {
    return { ok: false as const, reason: (err as Error).message };
  }
});

ipcMain.handle('orchdesk:file-write', async (_e, input: unknown) => {
  const norm = normalizeFileWrite(input as {
    path?: string; content?: string; expectedMtimeMs?: number | string;
  });
  if (!norm.ok) return { ok: false as const, reason: norm.reason };
  try {
    const st = fs.statSync(norm.path);
    if (st.isDirectory()) return { ok: false as const, reason: '目标是目录，不是文件' };
    // 乐观并发检查：读取之后磁盘上又被改过（编辑器 / git / Agent 工具）就拒绝。
    // mtimeMs 是浮点，不同文件系统精度不一，留 2ms 容差。
    if (Math.abs(st.mtimeMs - norm.expectedMtimeMs) > 2) {
      return {
        ok: false as const, code: 'modified-externally' as const,
        reason: '文件在读取后被外部修改过，保存会覆盖那些改动；请先重新加载',
      };
    }
    // 同目录临时文件 + rename：写一半崩溃不会留下半截文件损坏原文件。
    const tmp = path.join(path.dirname(norm.path), '.' + path.basename(norm.path) + '.orchdesk-tmp');
    fs.writeFileSync(tmp, norm.content, 'utf8');
    try {
      fs.renameSync(tmp, norm.path);
    } catch (err) {
      try { fs.unlinkSync(tmp); } catch { /* 临时文件清理失败可忽略 */ }
      throw err;
    }
    const st2 = fs.statSync(norm.path);
    return {
      ok: true as const, path: norm.path,
      size: st2.size, sizeLabel: humanSize(st2.size), mtimeMs: st2.mtimeMs,
    };
  } catch (err) {
    return { ok: false as const, reason: (err as Error).message };
  }
});

ipcMain.handle('orchdesk:memory-promotions-clear', async () => {  const cleared = promotionLog.length;
  promotionLog = [];
  persistPromotionLog();
  return { ok: true, cleared };
});

// ---------------------------------------------------------------------------
// PRD FR-3 连接器 IPC
// ---------------------------------------------------------------------------

/** 连接器列表（含脱敏后的凭证回显与探测状态）。 */
ipcMain.handle('orchdesk:connectors', async () => {
  const items = CONNECTOR_CATALOG.map((c) => connectorView(c.id));
  const states = Object.values(connectorFile.states);
  return {
    items,
    stats: {
      total: items.length,
      configured: states.filter((s) => s.configured).length,
      tested: states.filter((s) => s.lastTestOk !== null).length,
      ok: states.filter((s) => s.lastTestOk === true).length,
    },
  };
});

/**
 * 保存凭证并立即探测一次。
 * 为什么保存即探测：只保存不探测的话，界面会显示「已配置」，而用户完全不知道
 * 令牌是不是打错了一位 —— 「配了但连不上」正是连接器最典型的假状态。
 * 探测失败**不回滚凭证**（可能是临时网络问题），但状态里明确记 test-fail。
 */
ipcMain.handle('orchdesk:connector-save', async (_e, id: unknown, creds: unknown) => {
  if (!isConnectorId(id)) return { ok: false, reason: `未知连接器: ${String(id)}` };
  const def = getConnectorDef(id)!;
  const prev = readCreds(connectorFile, id);
  const src = (creds && typeof creds === 'object' ? creds as Record<string, unknown> : {});
  const clean: Record<string, string> = {};
  for (const f of def.fields) {
    const raw = typeof src[f.key] === 'string' ? String(src[f.key]).trim() : '';
    // secret 字段在 UI 上只回显「••••1234」，用户没改动时会原样提交回来。
    // 必须按「保持原值」处理：直接写回去会把真凭证覆盖成一串圆点 ——
    // 表现为「我只改了 AppSecret，AppID 怎么突然失效了」。
    // 空串是用户主动清空，不沿用旧值，否则没法单独删掉某个字段。
    clean[f.key] = /^••••/.test(raw) ? String(prev[f.key] || '') : raw;
  }
  writeCreds(connectorFile, id, clean);
  const missing = def.fields.filter((f) => f.required !== false && !clean[f.key]).map((f) => f.key);
  recordConnectorAudit(id, 'save', missing.length ? `凭证已保存（不完整：缺少 ${missing.join(', ')}）` : '凭证已保存');

  if (missing.length) {
    return { ok: true, configured: false, state: connectorFile.states[id] || null, probe: null };
  }
  const probe = await testConnector(id);
  return { ok: true, configured: true, state: connectorFile.states[id] || null, probe };
});

/** 清除凭证（含探测结论：凭证都没了，旧结论同样是过期信息）。 */
ipcMain.handle('orchdesk:connector-clear', async (_e, id: unknown) => {
  if (!isConnectorId(id)) return { ok: false, reason: `未知连接器: ${String(id)}` };
  clearCreds(connectorFile, id);
  recordConnectorAudit(id, 'clear', '凭证已清除');
  return { ok: true, state: connectorFile.states[id] || null };
});

/** 用已存凭证重新探测。 */
ipcMain.handle('orchdesk:connector-test', async (_e, id: unknown) => {
  if (!isConnectorId(id)) return { ok: false, reason: `未知连接器: ${String(id)}` };
  const probe = await testConnector(id);
  // ok 必须取 probe 的：展开顺序写反的话外层恒 true，探测失败也会显示成功。
  return { ok: probe.ok, message: probe.message, manual: probe.manual, state: connectorFile.states[id] || null };
});

/** 连接器审计（按连接器 / 动作 / 关键词过滤）。 */
ipcMain.handle('orchdesk:connector-audit', async (_e, query: unknown) => {
  const q = (query || {}) as Parameters<typeof searchConnectorAudit>[1];
  return {
    entries: searchConnectorAudit(connectorFile.audit, q || {}),
    stats: connectorAuditStats(connectorFile.audit),
    total: connectorFile.audit.length,
    max: 200,
  };
});

ipcMain.handle('orchdesk:connector-audit-clear', async () => {
  const cleared = connectorFile.audit.length;
  connectorFile.audit = [];
  persistConnectors();
  return { ok: true, cleared };
});

// ---- 本地插件市场（PRD FR-3）----
ipcMain.handle('orchdesk:market-plugins', async () => {
  return {
    items: listMarketPlugins(marketEnabledMap),
    dir: marketDir(),
    count: Object.values(marketEnabledMap).filter(Boolean).length,
  };
});

ipcMain.handle('orchdesk:market-toggle', async (_e, dir: unknown, enabled: unknown) => {
  if (typeof dir !== 'string' || typeof enabled !== 'boolean') {
    return { ok: false, reason: '参数非法' };
  }
  try {
    const state = await setMarketPluginEnabled(dir, enabled);
    marketEnabledMap[dir] = enabled;
    persistMarketEnabled();
    // 未激活也要如实回传：装载完成 ≠ 激活（依赖未满足时 fiber.state != 2）。
    return { ok: true, state };
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
});

ipcMain.handle('orchdesk:market-open-dir', async () => {
  const dir = marketDir();
  try {
    fs.mkdirSync(dir, { recursive: true });
    const err = await shell.openPath(dir);
    return err ? { ok: false, reason: err } : { ok: true, dir };
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
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
  withhold(text: string): Promise<unknown> | unknown;
  compensate(text: string, note?: string): unknown;
  getAudit(): unknown;
}
ipcMain.handle('orchdesk:comp-withhold', async (_e, text: string) => {
  const svc = getService<CompensationServiceLike>('compensation');
  if (!svc) return unavailable('补偿层插件未接入');
  // 契约修正（第九死挂点）：插件 withhold(text: string)，此前主进程包成 { text }
  // 传给正则匹配 → 恒为 'other' →「不可撤销」警示条与二次确认从未触发。
  return svc.withhold(String(text || ''));
});
ipcMain.handle('orchdesk:comp-compensate', (_e, text: string, note?: string) => {
  const svc = getService<CompensationServiceLike>('compensation');
  if (!svc) return unavailable('补偿层插件未接入');
  // 契约修正：插件 compensate(text, note)，此前只收首参，note 被丢弃。
  return svc.compensate(String(text || ''), note ? String(note) : undefined);
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
  // BUG（全盘死挂点扫描）：原实现透传 opts（无 agent 字段）→ evolution 插件的
  // requireConfirm=true 授权门（默认值）在「缺 agent 句柄」时恒返「授权门控未通过」，
  // 设置页「新建临时插件」按钮恒失败，UI 却写着「创建后在此列出」。桌面宿主无 dsh
  // Agent 句柄，但审批实际走 UI 弹窗（approval.request 不读 agent 字段，见 host-services
  // 的 uiAnswerer 通道）——补最小占位即可让用户点击 → 真实审批弹窗 → 放行后创建。
  const base = (opts && typeof opts === 'object' ? opts : {}) as Record<string, unknown>;
  const merged = { ...base, agent: base.agent ?? { id: 'orchdesk-desktop', meta: { origin: 'ui' } } };
  return svc.createTempPlugin(spec, merged);
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
  getDelegationTree(rootId?: string): unknown;
  /** CEO→Director→Worker 三层编排（后台经 agentRunner 跑真实 LLM，耗时较长）。 */
  composeTeam?(teamId: string, task: string): Promise<unknown>;
}
ipcMain.handle('orchdesk:orchestration-catalog', () => {
  const svc = getService<OrchestrationServiceLike>('orchestration');
  return svc ? svc.getCatalog() : null;
});
ipcMain.handle('orchdesk:compose-team', async (_e, teamId: string, task: string) => {
  const svc = getService<OrchestrationServiceLike>('orchestration');
  if (!svc?.composeTeam) return { error: '编排服务未就绪（multi 插件未激活）' };
  try {
    return await svc.composeTeam(String(teamId || 'team-custom'), String(task || ''));
  } catch (err) {
    return { error: `编排失败: ${(err as Error).message}` };
  }
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

// ---------------------------------------------------------------------------
// 桌面集成（PRD FR-4.2）：设置页 6 个开关此前是 data-action="todo" 空壳
// ---------------------------------------------------------------------------
ipcMain.handle('orchdesk:desktop-get', async () => {
  desktopConfig = loadDesktopConfig(dataDir());
  return {
    config: { ...desktopConfig },
    shortcutLabel: SHORTCUT_LABEL,
    labels: { ...DESKTOP_LABELS },
    /** 自启动真实生效状态（系统可能拒绝写入，UI 需如实展示）。 */
    autostartEffective: readLoginItemSettings().openAtLogin === true,
  };
});

ipcMain.handle('orchdesk:desktop-set', async (_e, key: unknown, value: unknown) => {
  const res = setDesktopKey(desktopConfig, key, value);
  if (!res.ok || !res.key) return { ok: false, config: { ...desktopConfig }, reason: res.reason };
  desktopConfig = saveDesktopConfig(res.config, dataDir());
  // 只重放受影响的那一项：切换「自动更新」不该去动系统登录项。
  switch (res.key) {
    case 'tray': applyTray(desktopConfig.tray); break;
    case 'shortcut': applyShortcut(desktopConfig.shortcut); break;
    case 'autostart': {
      const r = applyAutostart(desktopConfig.autostart);
      if (!r.ok) return { ok: true, config: { ...desktopConfig }, warning: `系统未接受自启动设置：${r.reason}` };
      break;
    }
    case 'autoupdate': if (desktopConfig.autoupdate) applyAutoUpdate(true); break;
    case 'floating': applyFloating(desktopConfig.floating); break;
    case 'notify': if (desktopConfig.notify) notifyDesktop('OrchDesk', '系统通知已开启'); break;
  }
  log('INFO', 'desktop', `桌面集成开关变更：${DESKTOP_LABELS[res.key]} → ${desktopConfig[res.key] ? '开' : '关'}`);
  return {
    ok: true,
    config: { ...desktopConfig },
    changed: res.changed,
    autostartEffective: readLoginItemSettings().openAtLogin === true,
  };
});

/** 悬浮窗上下文：渲染层切换会话时推送（主进程不猜「当前会话」）。 */
ipcMain.handle('orchdesk:desktop-floating-context', async (_e, ctx: { title?: string; sessions?: number }) => {
  const safeTitle = String(ctx?.title || '').trim().slice(0, 80);
  const safeSessions = Number.isFinite(ctx?.sessions) ? Math.max(0, Math.trunc(Number(ctx.sessions))) : 0;
  floatingContext = { title: safeTitle, sessions: safeSessions };
  if (floatingWindow && !floatingWindow.isDestroyed()) renderFloatingWindow();
  return { ok: true, context: { ...floatingContext } };
});

/**
 * 打开项目绑定的本地文件夹（项目 `··` 菜单）或数据目录（设置页）。
 * 传 `boundPath` → 打开该项目绑定的目录；不传 → 打开数据目录（语义由调用方决定）。
 *
 * BUG-022：此前恒打开 `dataDir()`，**绑定的项目目录形同虚设**——而创建项目弹窗还写着
 * 「绑定后可通过『打开项目目录』快速访问」，等于用假承诺糊住一个死挂点。
 *
 * 关键口径：绑定路径不存在 / 不是目录时**明确报错**，绝不静默回退数据目录。
 * 静默回退会让用户以为打开的是项目目录，与「降级必须可见」冲突，且掩盖数据错配。
 */
ipcMain.handle('orchdesk:open-project-dir', async (_e, boundPath?: string) => {
  const raw = typeof boundPath === 'string' ? boundPath.trim() : '';
  const source: 'bound' | 'data' = raw ? 'bound' : 'data';
  try {
    const target = raw ? path.resolve(raw) : dataDir();
    if (source === 'bound') {
      // 目录可能已被删/移动过：渲染层只知道「当初绑的是什么」，真实性由主进程兜底
      const st = fs.statSync(target);
      if (!st.isDirectory()) return { ok: false, source, reason: `绑定的路径不是文件夹：${target}` };
    }
    const openErr = await shell.openPath(target); // 成功返回 ''，失败返回错误描述（旧代码忽略了它 → 失败也报 ok）
    if (openErr) return { ok: false, source, reason: openErr };
    return { ok: true, source, path: target };
  } catch (err) {
    return {
      ok: false,
      source,
      reason: source === 'bound' ? `绑定的目录不可访问：${(err as Error).message}` : (err as Error).message,
    };
  }
});

/** 打开日志目录（诊断模型调用 / 插件加载问题）。 */
ipcMain.handle('orchdesk:open-log-dir', async () => {
  try {
    const dir = path.join(dataDir(), 'logs');
    fs.mkdirSync(dir, { recursive: true });
    const openErr = await shell.openPath(dir); // 与 BUG-022 同款：成功返回 ''，忽略返回值会让失败也报 ok
    if (openErr) return { ok: false, reason: openErr };
    return { ok: true, file: logFilePath() ?? undefined };
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
});

/**
 * 设置会话工作区（BUG-023）：项目绑定目录 → 会话默认 cwd 的唯一贯通点。
 * 渲染层在「创建会话 / 打开会话 / 重选项目 / 分叉」时调用；主进程 sessionCwds 是
 * 进程内 Map（重启即失），所以渲染层每次重放，主进程不负责持久化。
 *
 * 口径：这是**用户在 GUI 里亲手绑定**的目录（原生对话框选择 / 手输），与 file Tab
 * 「用户亲手操作不走授权门」同理，不做 isPathAllowed 预检——否则绑 D 盘项目永远
 * 设不上（白名单只有 home/userData/temp）。但校验必须严格：绝对路径 + 存在 + 是目录；
 * 通过后该目录成为此会话 file_* 与 set_cwd 的沙箱白名单根（见 isPathAllowed）。
 * 失败如实返回 reason，渲染层 toast 可见——静默失败会让工作区悄悄回落 user home，
 * Agent 又在 C:\\Users\\my 里找 git 仓库，正是本 BUG 的形态。
 */
ipcMain.handle('orchdesk:set-session-cwd', async (_e, sessionId: unknown, dir: unknown) => {
  const sid = typeof sessionId === 'string' ? sessionId.trim() : '';
  const raw = typeof dir === 'string' ? dir.trim() : '';
  if (!sid) return { ok: false, reason: '缺少会话 ID' };
  if (!raw || !isAbsoluteLike(raw)) return { ok: false, reason: '需要绝对路径的项目目录' };
  const resolved = path.resolve(raw);
  let isDir = false;
  try { isDir = fs.statSync(resolved).isDirectory(); } catch { /* 不存在 */ }
  if (!isDir) return { ok: false, reason: `目录不存在或不是文件夹：${resolved}` };
  sessionCwds.set(sid, resolved);
  recordSandbox({
    tool: 'set_session_cwd', kind: 'path', target: resolved, decision: 'allowed',
    reason: '用户绑定项目工作区（GUI 驱动，非 Agent 路径）', sessionId: sid,
  });
  return { ok: true, path: resolved };
});

/**
 * PRD FR-4.2「数据目录 · 内容清单」：真实扫描数据目录。
 * 设置页此前写死「~ 24 MB」——与实际磁盘无关的数字，等于拿假数据向用户承诺备份体积。
 * 扫描失败（目录不存在 = 首次运行）返回空清单而不是报错。
 */
ipcMain.handle('orchdesk:data-dir-inventory', () => {
  try {
    const inv = scanDataDir(dataDir());
    // 体积文案在主进程侧格式化（复用 data-dir.formatBytes），渲染层不再各写一套换算。
    return {
      ok: true,
      ...inv,
      items: inv.items.map((i) => ({ ...i, sizeText: formatBytes(i.size) })),
      totalSizeText: formatBytes(inv.totalSize),
    };
  } catch (err) {
    return { ok: false, reason: (err as Error).message, dir: dataDir(), items: [], totalSize: 0, totalFiles: 0, totalSizeText: '0 B', errors: [] };
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
  // 日志系统最先初始化：后续迁移 / 运行时启动 / 模型调用全部留痕
  initLogger(dataDir());
  mirrorConsole();
  log('INFO', 'boot', `OrchDesk 启动（版本 ${typeof app.getVersion === 'function' ? app.getVersion() : 'dev'}，数据目录 ${dataDir()}）`);

  // BUG-013：先把历史位置的数据合并进规范化目录，再加载会话。
  try { migrateLegacyData(); } catch (err) { console.warn('[orchdesk] 数据迁移异常:', (err as Error).message); }
  loadStore();

  // 数据目录确定后告知宿主服务（沙箱状态落盘位置）。
  process.env.ORCHDESK_DATA_DIR = dataDir();

  // 终端（P2-10）：启动期探测 node-pty 可用性，让 getTerminalState 的
  // ptyAvailable 从一开始就是确定值（未探测 ≠ 不可用，不许混淆）。
  try {
    const ok = ensurePtyLoaded(TERMINAL_APP_DIR, terminalExtraPtyDirs());
    log('INFO', 'terminal', ok ? 'node-pty 已加载（真 PTY 模式）' : 'node-pty 不可用，终端将以管道模式降级');
  } catch (err) {
    log('WARN', 'terminal', 'node-pty 探测异常：' + (err as Error).message);
  }

  // BUG-014 根因修复：启动真实 Cordis 运行时（宿主服务 + 9 个插件），
  // 此前 packages/plugin/* 从未被加载，FR-7/9/10/11/12/13 在应用内全是空壳。
  await bootRuntime();

  // PRD FR-8：沙箱日志装载（必须在 migrateLegacyData 之后——日志随数据目录迁移）。
  // 坏文件 → 空日志，不阻断启动：日志是观测设施。
  try {
    const n = loadSandboxLog();
    if (n > 0) log('INFO', 'sandbox', `沙箱日志已装载：${n} 条（${sandboxLogFile()}）`);
  } catch (err) {
    console.warn('[orchdesk] 沙箱日志装载失败:', (err as Error).message);
  }

  // PRD FR-10：晋升审计装载（同样在 migrateLegacyData 之后，审计随目录迁移）。
  try {
    const n = loadPromotionLog();
    if (n > 0) log('INFO', 'memory', `晋升审计已装载：${n} 条（${promotionFile()}）`);
  } catch (err) {
    console.warn('[orchdesk] 晋升审计装载失败:', (err as Error).message);
  }

  // PRD FR-3：连接器注册表装载（凭证密文随目录迁移，跨机器解不开会表现为「未配置」）。
  try {
    const n = loadConnectors();
    if (n > 0) log('INFO', 'connector', `连接器注册表已装载：${n} 个已配置（${connectorsFilePath()}）`);
  } catch (err) {
    console.warn('[orchdesk] 连接器注册表装载失败:', (err as Error).message);
  }

  // PRD FR-3：本地插件市场启用状态装载（插件代码在 dataDir()/plugins/，这里只存意愿）。
  try {
    marketEnabledMap = loadMarketEnabled();
  } catch (err) {
    console.warn('[orchdesk] 插件市场状态装载失败:', (err as Error).message);
  }

  // PRD FR-4.2：桌面集成开关全量重放（此前 6 项全是设置页空壳，见第十个死挂点）。
  // 必须在 createWindow 之前——全局快捷键/托盘都依赖 mainWindow 存在与否。
  desktopConfig = loadDesktopConfig(dataDir());
  applyDesktopConfig();

  createWindow();
  // 托盘由 applyTray 按配置决定是否创建；此处不再无条件 createTray()。
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  // 开机提醒（FR-4.2）：启动完成发一条系统通知，配置关闭时静默跳过。
  if (desktopConfig.notify) notifyDesktop('OrchDesk 已启动', '点击托盘图标或按 ' + SHORTCUT_LABEL + ' 唤起主窗');
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  // 注销全局快捷键：不注销会在进程退出后残留加速器（Windows 上表现为快捷键失灵）
  try { globalShortcut.unregisterAll(); } catch { /* 忽略 */ }
  destroyFloatingWindow();
  // 触发全部插件的逆效应（卸载无残留）
  void stopRuntime();
});
