/// <reference types="electron" />
import { app, BrowserWindow, ipcMain, safeStorage, shell, globalShortcut } from 'electron';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import {
  DESKTOP_LABELS,
  SHORTCUT_LABEL,
  loadDesktopConfig,
  saveDesktopConfig,
  setDesktopKey,
} from './desktop-integration';
import * as bootDesktop from './boot-desktop';
import { guanjiClient } from './guanji';
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
import { emitCanonicalEvent, setEnvelopeConsumer } from './event-emit';
import { startRuntime, stopRuntime, getService, getRuntime, getPluginStates, setPluginEnabled, firePreStep, persistGrantsNow, startupMarketPlugins } from './dsh-runtime';
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
import { initLogger, mirrorConsole, log, logFilePath } from './logger';
import {
  DATA_DIR_NAMES,
  DATA_FILE_NAMES,
  candidateLegacyDirs,
  mergeProvidersData,
  mergeSessionsData,
  migrateDataDirs,
  migrateDataFiles,
  formatBytes,
  getDataDir,
  resolveDataDir,
  scanDataDir,
  setDataDirResolver,
  type MigrateFileSpec,
} from './data-dir';
import {
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
  MAX_TOOL_ITERATIONS_CAP,
  MAX_TOOL_ITERATIONS_DEFAULT,
} from './agent-runtime';
import { isAbsoluteLike } from './common-tools';
import { callModel as callModelHttp, initModelClient } from './model-client';
import { abortAgentTurn, clearToolRejectMemo, initAgentTurn, runAgentTurn } from './agent-turn';
import { executeTool, initToolExec, sessionCwd, setSessionCwd } from './tool-exec';
import { registerBrowserIpc } from './ipc-browser';
import { preloadTerminalPty, registerTerminalIpc } from './ipc-terminal';
import { registerFilePanelIpc } from './ipc-file-panel';
import { connectorsFilePath, initConnectors, loadConnectors, registerConnectorIpc } from './ipc-connectors';
import { initMcp, loadMcp, mcpFilePath, registerMcpIpc } from './ipc-mcp';
import { hydrateMarketEnabled, initMarket, loadMarketEnabled, registerMarketIpc } from './ipc-market';
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

const isDev = !app.isPackaged;
bootDesktop.initBootDesktop({
  log: (level, scope, msg) => log(level === 'ERROR' || level === 'WARN' ? level : 'INFO', scope, msg),
  checkForUpdates,
});
initModelClient({ decryptKey });

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
    return !!(bootDesktop.mainWindow && !bootDesktop.mainWindow.isDestroyed() && sender === bootDesktop.mainWindow.webContents);
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
  // MCP 配置：env 密文同连接器（机器派生密钥），跨机器解不开表现为「连接失败」。
  { name: DATA_FILE_NAMES.mcp, mode: 'copy-if-absent' },
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
    // 三路径默认一致（MAX_TOOL_ITERATIONS_DEFAULT = 200；用户显式配置最多到 500，见 saveModelConfig 钳制）。
    // 坏文件回落到保守值而非「假装健康」，与项目 fail-closed 纪律一致。
    if (!fs.existsSync(file)) return { providers: [], defaultProvider: 'ollama', defaultModel: 'qwen3:14b', maxToolIterations: MAX_TOOL_ITERATIONS_DEFAULT };
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
      maxToolIterations: (raw.maxToolIterations as number | undefined) ?? MAX_TOOL_ITERATIONS_DEFAULT,
    };
    const hasPlainKey = migrated;
    if (hasPlainKey) saveModelConfig(cfg);
    return cfg;
  } catch { return { providers: [], defaultProvider: 'ollama', defaultModel: 'qwen3:14b', maxToolIterations: MAX_TOOL_ITERATIONS_DEFAULT }; }
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

// ---- 真实模型调用：实现见 model-client.ts（可注入 AbortSignal）----
async function callModel(
  provider: ModelProvider,
  model: string,
  messages: ApiMessage[],
  toolDefs: typeof TOOL_DEFS = [],
  signal?: AbortSignal,
  onDelta?: (chunk: string) => void,
): Promise<ModelReply> {
  return callModelHttp(provider, model, messages, toolDefs, { signal, onDelta });
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

// --- 工具执行引擎：见 tool-exec.ts ---

/**
 * 授权门（PRD L3/L4 / T-P3-2）：paranoid（只读）直接拒；default/trusted 过 GUI 审批；
 * 审批链路不可用一律 fail-closed（与 ADR-0008 intent 的「基础设施缺失放行」边界不同——
 * 走此门的操作兜底不足：命令白名单含万能 shell、file_write 可覆盖白名单内任意文件）。
 * @returns null = 放行；字符串 = 拒绝原因。
 */
async function approvalGate(toolName: string, reason: string, sessionId?: string, target?: string, signal?: AbortSignal): Promise<string | null> {
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
  // M-8：signal 下传——回合中止时审批请求一并取消，不等用户应答/超时。
  const outcome = signal?.aborted ? 'cancelled' : await approval.request({ toolName, reason: reason.slice(0, 200), sessionId, target }, signal);
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

// --- Agent Runtime：模型回合 + 工具调用循环 ---

/** 取可下发 IPC 的渲染窗口：mainWindow 优先，回退首个未销毁窗。
 * 桌面集成开启后悬浮窗先建排第 0，但无 preload 不订阅业务事件，不能当推送目标。
 * 全库此前散落 4 份同款三元式（浏览器状态/终端数据/终端退出/工具步骤），统一收口。 */
function rendererWindow(): BrowserWindow | null {
  try {
    if (bootDesktop.mainWindow && !bootDesktop.mainWindow.isDestroyed()) return bootDesktop.mainWindow;
    return BrowserWindow.getAllWindows().find((x) => !x.isDestroyed()) || null;
  } catch { return null; }
}

function sendToRenderer(channel: string, payload: unknown): void {
  try {
    const w = rendererWindow();
    if (w) w.webContents.send(channel, payload);
  } catch { /* 窗口已关闭 */ }
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

/** 模型增量文本（JSON 整包一次；SSE 解析后按 chunk）。 */
function notifyAgentDelta(sessionId: string, text: string): void {
  if (!text) return;
  try {
    const w = rendererWindow();
    if (w) w.webContents.send('orchdesk:agent-delta', { sessionId, text });
  } catch { /* 忽略：窗口可能已关闭 */ }
}

initToolExec({
  dataDir,
  getAppPath: (name) => safeGetPath(name),
  approvalGate,
  outboundGate,
  recordSandbox,
});
initConnectors({ dataDir });
initMcp({ dataDir });
initMarket({ dataDir });

initAgentTurn({
  loadModelConfig,
  getSession: (id) => store[id] as { msgs?: Array<{ role?: string; text?: string } & Record<string, unknown>> } | undefined,
  ensureSession: (id) => {
    if (!store[id]) {
      store[id] = { id, msgs: [], created: new Date().toISOString(), updated: new Date().toISOString() };
    }
  },
  saveStore,
  dataDir,
  sessionCwd,
  executeTool,
  notifyAgentDelta,
  notifyToolStep,
});

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
ipcMain.handle('orchdesk:abort-agent-turn', async (_e, sessionId: string) => {
  return abortAgentTurn(String(sessionId || ''));
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
    // 与运行时钳制一致（1–500，单源常量 MAX_TOOL_ITERATIONS_CAP），保证所见即所得。
    if (incoming.maxToolIterations) current.maxToolIterations = Math.max(1, Math.min(MAX_TOOL_ITERATIONS_CAP, incoming.maxToolIterations));
    // M-1：模型配置变更后失效「网关拒 tools」毒化 memo，重新尝试原生协议。
    clearToolRejectMemo();
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
  getModes?(): Array<{ id: string; label: string; sandboxMode: string; approvalPolicy: string; blurb: string }>;
  getGrantTools?(): readonly string[];
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
        if (!rendererReady || !bootDesktop.mainWindow || bootDesktop.mainWindow.isDestroyed()) return 'unavailable';
        const id = `apr-${++approvalSeq}`;
        return new Promise<string>((resolve) => {
          const timer = setTimeout(() => {
            pendingApprovals.delete(id);
            resolve('unavailable'); // fail-closed：超时不开门
          }, 120000);
          pendingApprovals.set(id, { resolve, timer });
          bootDesktop.mainWindow?.webContents.send('orchdesk:authz-approval-request', {
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
// ④M-1：授权模式卡 / 白名单工具下拉数据化（canonical = packages/plugin/authz AUTHZ_MODES + GRANT_TOOLS）。
// 此前渲染层 app.js 硬编码 AUTH_MODES（trusted 文案已漂移，丢了「仍受 SandboxMode 约束」），
// getModes() 在 AuthzServiceLike 已声明却从未接 IPC —— 半接线残留。此处补齐透传通道。
ipcMain.handle('orchdesk:authz-get-modes', async () => {
  if (!authzService?.getModes) return { modes: [], grantTools: [] };
  try {
    return {
      modes: authzService.getModes(),
      grantTools: authzService.getGrantTools?.() ?? ['*'],
    };
  } catch {
    return { modes: [], grantTools: ['*'] };
  }
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
  let enabled = true;
  try {
    const dataDir = getDataDir();
    try {
      const f = JSON.parse(fs.readFileSync(path.join(dataDir, 'trace.json'), 'utf-8')) as { enabled?: boolean };
      if (typeof f.enabled === 'boolean') enabled = f.enabled;
    } catch { /* 缺省开 */ }
  } catch { /* 数据目录未就绪：保持缺省开，builtin 探测照常 */ }
  let builtin = false;
  try {
    fs.accessSync(path.join(__dirname, '..', 'build', 'trace-token.enc.json'));
    builtin = true;
  } catch { /* 未内置（dev 或未跑 prepare-trace）→ 只缓冲 */ }
  return { enabled, builtin };
});
ipcMain.handle('orchdesk:trace-set-enabled', (_e, enabled: boolean) => {
  let dataDir = '';
  try { dataDir = getDataDir(); } catch { return { ok: false, reason: '数据目录未就绪' }; }
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
    networkAllow: policy?.getNetworkAllow ? policy.getNetworkAllow() : [],
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

// --- 面板 IPC：见 ipc-browser.ts / ipc-terminal.ts / ipc-file-panel.ts ---
registerBrowserIpc(ipcMain, { dataDir, notify: sendToRenderer });
registerTerminalIpc(ipcMain, { notify: sendToRenderer });
registerFilePanelIpc(ipcMain);

ipcMain.handle('orchdesk:memory-promotions-clear', async () => {  const cleared = promotionLog.length;
  promotionLog = [];
  persistPromotionLog();
  return { ok: true, cleared };
});

registerConnectorIpc(ipcMain);
registerMcpIpc(ipcMain);
registerMarketIpc(ipcMain);

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
// 本地已安装技能：真实扫描数据目录/skills（此前只存渲染层内存，重启即显示 0 个）。
// ok=false = 扫描失败，与「已扫描但没装」区分，UI 分别标注「未接入」与「暂无」。
ipcMain.handle('orchdesk:skills-installed', () => guanjiClient.listInstalledSkills());
ipcMain.handle('orchdesk:skill-uninstall', async (_e, slug: string) => guanjiClient.uninstallSkill(String(slug || '')));

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
  bootDesktop.setDesktopConfig(loadDesktopConfig(dataDir()));
  return {
    config: { ...bootDesktop.desktopConfig },
    shortcutLabel: SHORTCUT_LABEL,
    labels: { ...DESKTOP_LABELS },
    /** 自启动真实生效状态（系统可能拒绝写入，UI 需如实展示）。 */
    autostartEffective: bootDesktop.readLoginItemSettings().openAtLogin === true,
  };
});

ipcMain.handle('orchdesk:desktop-set', async (_e, key: unknown, value: unknown) => {
  const res = setDesktopKey(bootDesktop.desktopConfig, key, value);
  if (!res.ok || !res.key) return { ok: false, config: { ...bootDesktop.desktopConfig }, reason: res.reason };
  bootDesktop.setDesktopConfig(saveDesktopConfig(res.config, dataDir()));
  // 只重放受影响的那一项：切换「自动更新」不该去动系统登录项。
  switch (res.key) {
    case 'tray': bootDesktop.applyTray(bootDesktop.desktopConfig.tray); break;
    case 'shortcut': bootDesktop.applyShortcut(bootDesktop.desktopConfig.shortcut); break;
    case 'autostart': {
      const r = bootDesktop.applyAutostart(bootDesktop.desktopConfig.autostart);
      if (!r.ok) return { ok: true, config: { ...bootDesktop.desktopConfig }, warning: `系统未接受自启动设置：${r.reason}` };
      break;
    }
    case 'autoupdate': if (bootDesktop.desktopConfig.autoupdate) bootDesktop.applyAutoUpdate(true); break;
    case 'floating': bootDesktop.applyFloating(bootDesktop.desktopConfig.floating); break;
    case 'notify': if (bootDesktop.desktopConfig.notify) bootDesktop.notifyDesktop('OrchDesk', '系统通知已开启'); break;
  }
  log('INFO', 'desktop', `桌面集成开关变更：${DESKTOP_LABELS[res.key]} → ${bootDesktop.desktopConfig[res.key] ? '开' : '关'}`);
  return {
    ok: true,
    config: { ...bootDesktop.desktopConfig },
    changed: res.changed,
    autostartEffective: bootDesktop.readLoginItemSettings().openAtLogin === true,
  };
});

/** 悬浮窗上下文：渲染层切换会话时推送（主进程不猜「当前会话」）。 */
ipcMain.handle('orchdesk:desktop-floating-context', async (_e, ctx: { title?: string; sessions?: number }) => {
  const safeTitle = String(ctx?.title || '').trim().slice(0, 80);
  const safeSessions = Number.isFinite(ctx?.sessions) ? Math.max(0, Math.trunc(Number(ctx.sessions))) : 0;
  bootDesktop.setFloatingContext({ title: safeTitle, sessions: safeSessions });
  if (bootDesktop.floatingWindow && !bootDesktop.floatingWindow.isDestroyed()) bootDesktop.renderFloatingWindow();
  return { ok: true, context: { ...bootDesktop.floatingContext } };
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
  setSessionCwd(sid, resolved);
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
    const result = bootDesktop.mainWindow ? await dialog.showOpenDialog(bootDesktop.mainWindow, opts) : await dialog.showOpenDialog(opts);
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
    const result = bootDesktop.mainWindow ? await dialog.showSaveDialog(bootDesktop.mainWindow, opts) : await dialog.showSaveDialog(opts);
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
    const result = bootDesktop.mainWindow ? await dialog.showOpenDialog(bootDesktop.mainWindow, openOpts) : await dialog.showOpenDialog(openOpts);
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
    const ok = preloadTerminalPty();
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
    hydrateMarketEnabled();
  } catch (err) {
    console.warn('[orchdesk] 插件市场状态装载失败:', (err as Error).message);
  }

  // MCP 真接入：配置装载（env 密文随目录迁移，跨机器解不开会表现为「连接失败」而非明文泄漏）。
  try {
    const n = loadMcp();
    if (n > 0) log('INFO', 'mcp', `MCP 配置已装载：${n} 个 server（${mcpFilePath()}）`);
  } catch (err) {
    console.warn('[orchdesk] MCP 配置装载失败:', (err as Error).message);
  }

  // PRD FR-4.2：桌面集成开关全量重放（此前 6 项全是设置页空壳，见第十个死挂点）。
  // 必须在 createWindow 之前——全局快捷键/托盘都依赖 mainWindow 存在与否。
  bootDesktop.setDesktopConfig(loadDesktopConfig(dataDir()));
  bootDesktop.applyDesktopConfig();

  bootDesktop.createWindow();
  // 托盘由 applyTray 按配置决定是否创建；此处不再无条件 createTray()。
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) bootDesktop.createWindow();
  });

  // 开机提醒（FR-4.2）：启动完成发一条系统通知，配置关闭时静默跳过。
  if (bootDesktop.desktopConfig.notify) bootDesktop.notifyDesktop('OrchDesk 已启动', '点击托盘图标或按 ' + SHORTCUT_LABEL + ' 唤起主窗');
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  // 注销全局快捷键：不注销会在进程退出后残留加速器（Windows 上表现为快捷键失灵）
  try { globalShortcut.unregisterAll(); } catch { /* 忽略 */ }
  bootDesktop.destroyFloatingWindow();
  // 触发全部插件的逆效应（卸载无残留）
  void stopRuntime();
});
