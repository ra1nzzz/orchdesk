/// <reference types="electron" />
import { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage } from 'electron';
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

// ---------------------------------------------------------------------------
// 模型回合 seam（P1-5 真实闭环的接入点）
// 当前为本地占位回复；接真实模型时，在此调用 dsh 的 ctx.agents：
//   const ctx = await getDshCtx();                 // in-process runProfile('orchdesk')
//   const agent = ctx.agents.create(sessionId, { provider, model, cwd });
//   const reply = await agent.followup(createUserMessage({ content: text }));
//   // 订阅 ctx.on('session/event') 拿 assistant/message 与工具事件
// 真实调用需要 API Key（或本地 Ollama baseURL）；无 key 时 dsh 的 followup 会失败，
// 故在此用占位返回，保证「桌面内会话闭环」骨架在任意环境都可演示与验证。
// ---------------------------------------------------------------------------
async function runAgentTurn(_sessionId: string, text: string, _opts: unknown): Promise<{ text: string; intent: string }> {
  if (process.env.ORCHDESK_MODEL_PROVIDER) {
    // TODO(P1-5): 真实模型分支——接 dsh ctx.agents.followup 或 Ollama。
    // 此处保留 seam，避免在缺 key 环境下阻断 UI。
    console.warn('[orchdesk] ORCHDESK_MODEL_PROVIDER 已设置，但真实模型分支尚未实现（P1 占位）。');
  }
  const reply =
    `（本地运行时占位回复）已收到你的消息：「${text}」\n\n` +
    `OrchDesk 的模型回合 seam 已就绪。配置 API Key（或本地 Ollama baseURL）并在 ` +
    `runAgentTurn 中接入 dsh 的 ctx.agents.followup 后，这里会出现真实模型回复，` +
    `且每条消息都会写入 SessionEvent 日志（append-only，可重启回放）。`;
  return { text: reply, intent: 'ACT' };
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    center: true,
    show: false,
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
  return Object.values(store);
});
ipcMain.handle('orchdesk:persist-sessions', async (_e, sessions: unknown[]) => {
  store = {};
  (sessions || []).forEach((s: any) => { if (s && s.id) store[s.id] = s; });
  saveStore();
  return { ok: true };
});
ipcMain.handle('orchdesk:run-agent-turn', async (_e, sessionId: string, text: string, opts: unknown) => {
  return runAgentTurn(sessionId, text, opts);
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
  return { usageRatio: 0.41, dumps: 2, recallHits: 1, domainCounts: { global: 0, project: 1, director: 0, worker: 0 } };
});
ipcMain.handle('orchdesk:prompt-list', () => {
  dshBridgeStub('prompt');
  return [];
});
ipcMain.handle('orchdesk:prompt-merge', () => {
  dshBridgeStub('prompt');
  return { ok: true, conflicts: [] };
});
ipcMain.handle('orchdesk:prompt-save', () => {
  dshBridgeStub('prompt');
  return { ok: true };
});
ipcMain.handle('orchdesk:prompt-delete', () => {
  dshBridgeStub('prompt');
  return { ok: true };
});
ipcMain.handle('orchdesk:comp-withhold', () => {
  dshBridgeStub('compensation');
  return { needsConfirm: false, category: 'other', reason: 'dsh 桥未接入（占位）', warning: '' };
});
ipcMain.handle('orchdesk:comp-compensate', () => {
  dshBridgeStub('compensation');
  return { id: `stub-${Date.now().toString(36)}`, category: 'other', action: 'dsh 桥未接入（占位）', ts: Date.now() };
});
ipcMain.handle('orchdesk:comp-audit', () => {
  dshBridgeStub('compensation');
  return [];
});
ipcMain.handle('orchdesk:evol-create', () => {
  dshBridgeStub('evolution');
  return { ok: false, reason: 'dsh 桥未接入（P1-5 seam）' };
});
ipcMain.handle('orchdesk:evol-list', () => {
  dshBridgeStub('evolution');
  return [];
});
ipcMain.handle('orchdesk:evol-dispose', () => {
  dshBridgeStub('evolution');
  return { ok: false, reason: 'dsh 桥未接入（P1-5 seam）' };
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
