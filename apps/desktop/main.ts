/// <reference types="electron" />
import { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, safeStorage, shell } from 'electron';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { guanjiClient } from './guanji';
import { hubClient } from './hub';

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

function sessionsFile(): string {
  // 惰性获取：app.getPath 需在 app ready 之后才稳定可用。
  return path.join(app.getPath('userData'), 'orchdesk-sessions.json');
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
}

const MODELS_FILE = () => path.join(app.getPath('userData'), 'models.json');

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
    };
    const hasPlainKey = (raw.providers as Array<Record<string, unknown>> | undefined)?.some(p => 'apiKey' in p);
    if (hasPlainKey) saveModelConfig(cfg);
    return cfg;
  } catch { return { providers: [], defaultProvider: 'ollama', defaultModel: 'qwen3:14b' }; }
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

// ---- 真实模型调用（OpenAI 兼容 + Ollama）----

async function callModel(provider: ModelProvider, model: string, messages: Array<{ role: string; content: string }>): Promise<string> {
  if (provider.type === 'ollama') {
    return callOllama(provider, model, messages);
  }
  return callOpenAICompatible(provider, model, messages);
}

async function callOllama(provider: ModelProvider, model: string, messages: Array<{ role: string; content: string }>): Promise<string> {
  const url = provider.baseUrl.replace(/\/$/, '') + '/api/chat';
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, stream: false }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`Ollama 返回 HTTP ${res.status}: ${await res.text()}`);
  const data = await res.json() as { message?: { content?: string }; error?: string };
  if (data.error) throw new Error(data.error);
  return data.message?.content || '';
}

async function callOpenAICompatible(provider: ModelProvider, model: string, messages: Array<{ role: string; content: string }>): Promise<string> {
  const apiKey = decryptKey(provider.apiKeyEnc);
  if (!apiKey) throw new Error(`提供商「${provider.name}」未配置 API Key，请先在设置页配置`);
  const mode = provider.apiMode || 'chat';
  const base = provider.baseUrl.replace(/\/+$/, '');
  let url: string, body: Record<string, unknown>;

  // 若 baseUrl 已包含完整 API 路径（如 …/v1/chat/completions），直接使用
  if (base.includes('/chat/completions') || base.includes('/responses') || base.includes('/completions')) {
    url = base;
    if (mode === 'responses') {
      body = { model, input: messages.map(m => ({ role: m.role, content: m.content })).filter(m => m.role === 'user').map(m => m.content).join('\n') || messages.at(-1)?.content || '' };
    } else if (mode === 'completions') {
      body = { model, prompt: messages.map(m => m.content).join('\n'), max_tokens: 1024 };
    } else {
      body = { model, messages, stream: false };
    }
  } else {
    // 归一化 baseUrl：去掉尾部 / 和 /v1 路径
    const clean = base.replace(/\/v1\/?$/, '');
    if (mode === 'responses') {
      url = clean + '/v1/responses';
      body = { model, input: messages.map(m => ({ role: m.role, content: m.content })).filter(m => m.role === 'user').map(m => m.content).join('\n') || messages.at(-1)?.content || '' };
    } else if (mode === 'completions') {
      url = clean + '/v1/completions';
      body = { model, prompt: messages.map(m => m.content).join('\n'), max_tokens: 1024 };
    } else {
      url = clean + '/v1/chat/completions';
      body = { model, messages, stream: false };
    }
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`模型 API 返回 HTTP ${res.status}: ${txt.slice(0, 200)}`);
  }
  const data = await res.json() as Record<string, unknown>;
  if ((data as { error?: { message?: string } }).error?.message) throw new Error((data as { error?: { message?: string } }).error!.message!);
  if (mode === 'responses') return ((data as { output_text?: string }).output_text || '');
  if (mode === 'completions') return ((data as { choices?: Array<{ text?: string }> }).choices?.[0]?.text || '');
  return ((data as { choices?: Array<{ message?: { content?: string } }> }).choices?.[0]?.message?.content || '');
}

// ---------------------------------------------------------------------------
// 模型回合（FR-5 真实闭环）
// 当前实现：OpenAI 兼容 API + Ollama 本地模型；配置存储于 userData/models.json，
// API Key 经 safeStorage 加密。
// ---------------------------------------------------------------------------
async function runAgentTurn(sessionId: string, text: string, opts: { models?: string[]; thinkLevel?: string }): Promise<{ text: string; intent: string }> {
  const modelCfg = loadModelConfig();
  if (!modelCfg.providers.length) return { text: '（未配置模型）请先在设置页「模型管理」中添加模型提供商。', intent: 'CONFIRM' };

  // 取第一个已配置提供商；若 opts 指定了模型则优先用
  const provider = modelCfg.providers[0]!;
  const availableModels = provider.models || [];
  const requested = (opts?.models || [])[0];
  // 若请求的模型不在提供商列表中，回退到提供商的第一个模型
  const modelPick = availableModels.includes(requested || '') ? requested : (availableModels[0] || modelCfg.defaultModel);
  const model = modelPick || 'qwen3:14b';

  // 构建消息上下文（从会话历史取最近几条）
  const sessionMsgs = (store[sessionId] as { msgs?: Array<{ role?: string; text?: string }> } | undefined)?.msgs || [];
  const recent = sessionMsgs.slice(-10).filter(m => m.role && m.text).map(m => ({ role: m.role as string, content: m.text as string }));
  recent.push({ role: 'user', content: text });

  try {
    const reply = await callModel(provider, model, recent);

    // 持久化用户消息 + 助手回复到会话
    const s = store[sessionId] as Record<string, unknown> | undefined;
    if (s) {
      const msgs = (s.msgs as Array<Record<string, unknown>>) || [];
      msgs.push({ role: 'user', text, ts: new Date().toISOString() });
      msgs.push({ role: 'assistant', text: reply, model, ts: new Date().toISOString() });
      s.msgs = msgs;
      s.updated = new Date().toISOString();
      saveStore();
    }
    return { text: reply, intent: 'ACT' };
  } catch (err) {
    const msg = (err as Error).message;
    return { text: `（模型调用失败）${msg}\n\n请检查模型配置和网络连接后重试。`, intent: 'CONFIRM' };
  }
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    center: true,
    show: false,
    backgroundColor: '#1E1E1E',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      // 红线（ADR-0002）：渲染进程保持沙箱，绝不开 nodeIntegration。
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  mainWindow.once('ready-to-show', () => mainWindow?.show());

  // P1：加载真实渲染工程（提升自 prototype/orchdesk.html v0.6）。
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
  return { providers: cfg.providers.map(p => ({ id: p.id, name: p.name, type: p.type, baseUrl: p.baseUrl, models: p.models })), defaultProvider: cfg.defaultProvider, defaultModel: cfg.defaultModel };
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
    const userData = app.getPath('userData');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const snapDir = path.join(userData, 'snapshots', stamp);
    fs.mkdirSync(path.dirname(snapDir), { recursive: true });
    const snapshotsDir = path.join(userData, 'snapshots');
    fs.cpSync(userData, snapDir, { recursive: true, filter: (src) => !src.startsWith(snapshotsDir + path.sep) });
    return { ok: true, dir: snapDir };
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
}

/** 更新前必须完成数据快照（PLAN 红线：不要更新后补）。 */
async function checkForUpdates(): Promise<{ snapshot: { ok: boolean; dir?: string }; update?: { available: boolean; version?: string; note?: string }; reason?: string }> {
  const snapshot = snapshotData();
  try {
    // electron-updater 为可选依赖：未安装（尚未发布）时不阻断，仅提示。
    // 用字符串字面量规避编译期模块解析（运行时动态加载）。
    const mod = await import('electron-updater' as string).then((m: any) => m.autoUpdater).catch(() => null);
    if (!mod) {
      return { snapshot, update: { available: false, note: '尚未发布到 GitHub Releases，更新检查待启用（已先完成数据快照）' } };
    }
    const res = await mod.checkForUpdates();
    return {
      snapshot,
      update: {
        available: !!res?.updateInfo,
        version: res?.updateInfo?.version,
        note: res?.updateInfo ? `发现新版本 ${res.updateInfo.version}` : '已是最新',
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
    await shell.openPath(app.getPath('userData'));
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
