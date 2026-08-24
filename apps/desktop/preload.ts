import { contextBridge, ipcRenderer } from 'electron';

// ============================================================================
// OrchDesk 渲染进程 preload（上下文隔离桥）
// ----------------------------------------------------------------------------
// 红线：不在渲染进程暴露 nodeIntegration；只经 contextBridge 暴露白名单方法。
// API 签名一旦确定，后续 Phase 不得破坏性改动（加方法可以，改签名不行）。
// 渲染进程持有 UI 会话状态；主进程负责「持久化（load/persist）+ 模型回合」。
// ============================================================================

type Session = {
  id: string;
  pid: string;
  title: string;
  expert: string;
  model?: string;
  updated?: string;
  ts?: string;
  archived?: number;
  msgs: Array<Record<string, unknown>>;
};

const orchdesk = {
  /** 启动时拉取持久化会话；空数组代表首次运行（渲染进程回落种子数据）。 */
  loadSessions: (): Promise<Session[]> =>
    ipcRenderer.invoke('orchdesk:load-sessions'),

  /** 任意变更后落盘（主进程写 userData JSON，可重启回放）。 */
  persistSessions: (sessions: Session[]): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('orchdesk:persist-sessions', sessions),

  /** 模型回合 seam：主进程在此接入真实 dsh ctx / Ollama（P1-5）。 */
  runAgentTurn: (
    sessionId: string,
    text: string,
    opts: { models?: string[]; thinkLevel?: string },
  ): Promise<{ text: string; intent: string }> =>
    ipcRenderer.invoke('orchdesk:run-agent-turn', sessionId, text, opts),

  /** 授权模式（T-P3-2）：读取当前生效的 AuthzMode（default/trusted/paranoid）。 */
  getAuthMode: (): Promise<{ mode: string }> =>
    ipcRenderer.invoke('orchdesk:authz-get-mode'),

  /** 授权模式（T-P3-2）：切换模式（经 dsh sandbox/mode + approval/policy 持久化）。 */
  setAuthMode: (mode: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('orchdesk:authz-set-mode', mode),

  /** 授权分级（T-P3-2）：L0-L4 定义，供设置页/插件页展示。 */
  getAuthLevels: (): Promise<Array<{ level: number; label: string; scope: string; requiresApproval: boolean }>> =>
    ipcRenderer.invoke('orchdesk:authz-get-levels'),

  /** 授权审计日志（T-P3-2）：近期 approval/* + sandbox/mode 事件快照。 */
  getAuthAudit: (): Promise<Array<{ kind: string; ts: number; mode?: string; outcome?: string; toolName?: string; reason?: string }>> =>
    ipcRenderer.invoke('orchdesk:authz-get-audit'),

  /** 审批弹窗（T-P3-2 fail-closed）：渲染层订阅主进程转发的 approval/request。 */
  onAuthRequest: (cb: (req: { id: string; toolName: string; reason?: string }) => void): (() => void) => {
    const listener = (_e: unknown, req: { id: string; toolName: string; reason?: string }): void => cb(req);
    ipcRenderer.on('orchdesk:authz-approval-request', listener);
    return () => ipcRenderer.removeListener('orchdesk:authz-approval-request', listener);
  },

  /** 审批弹窗（T-P3-2）：渲染层把用户决定回传主进程（allowed-once/rejected/cancelled）。 */
  submitDecision: (id: string, outcome: string): void => {
    ipcRenderer.send('orchdesk:authz-submit-decision', id, outcome);
  },

  // ---- T-P4-1/2 记忆 + 提示词库（dsh 服务 seam：ctx.memory / ctx.promptLib） ----
  /** 记忆统计（上下文占用 / 转储数 / 召回命中）。 */
  getMemoryStats: (): Promise<{ usageRatio: number; dumps: number; recallHits: number; domainCounts: Record<string, number> }> =>
    ipcRenderer.invoke('orchdesk:memory-stats'),

  /** 提示词库列表。 */
  listPrompts: (): Promise<Array<Record<string, unknown>>> =>
    ipcRenderer.invoke('orchdesk:prompt-list'),

  /** 合并类别提示词（冲突标记）。 */
  mergePrompts: (category: string, body: string): Promise<{ ok: boolean; conflicts?: Array<Record<string, unknown>> }> =>
    ipcRenderer.invoke('orchdesk:prompt-merge', category, body),

  /** 保存单个提示词。 */
  savePrompt: (doc: Record<string, unknown>): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('orchdesk:prompt-save', doc),

  /** 删除单个提示词。 */
  deletePrompt: (id: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('orchdesk:prompt-delete', id),

  // ---- T-P5-1 补偿层（dsh 服务 seam：ctx.compensation） ----
  /** 外发预判（composer「不可撤销」警示条）。 */
  withhold: (text: string): Promise<{ needsConfirm: boolean; category: string; reason: string; warning: string }> =>
    ipcRenderer.invoke('orchdesk:comp-withhold', text),

  /** 记录补偿动作。 */
  compensate: (text: string, note?: string): Promise<{ id: string; category: string; action: string; ts: number }> =>
    ipcRenderer.invoke('orchdesk:comp-compensate', text, note),

  /** 补偿层审计快照。 */
  getCompensationAudit: (): Promise<Array<Record<string, unknown>>> =>
    ipcRenderer.invoke('orchdesk:comp-audit'),

  // ---- T-P5-2 自进化（dsh 服务 seam：ctx.evolution；临时插件仅驻内存） ----
  /** 创建临时插件（静态门控 + CONFIRM，仅驻内存）。 */
  createTempPlugin: (spec: Record<string, unknown>): Promise<{ ok: boolean; reason?: string }> =>
    ipcRenderer.invoke('orchdesk:evol-create', spec),

  /** 当前驻内存临时插件列表。 */
  listTempPlugins: (): Promise<Array<Record<string, unknown>>> =>
    ipcRenderer.invoke('orchdesk:evol-list'),

  /** 卸载临时插件。 */
  disposeTempPlugin: (id: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('orchdesk:evol-dispose', id),

  // ---- T-P6-1 观雅集技能市场（复用 guanji SKILL API 约定；TOKEN 由用户配置） ----
  /** TOKEN 配置状态（不返回明文）。 */
  guanjiTokenStatus: (): Promise<{ configured: boolean }> =>
    ipcRenderer.invoke('orchdesk:guanji-token-status'),

  /** 用户配置观雅集 TOKEN（来自登录后 GET /api/auth/token 的结果）。 */
  guanjiSetToken: (token: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('orchdesk:guanji-set-token', token),

  /** 拉取观雅集真实技能列表（最近上新 + 精品推送合并去重）。 */
  guanjiList: (): Promise<Array<{ slug: string; name: string; description: string; caps: string[]; auth: 0 | 1 }>> =>
    ipcRenderer.invoke('orchdesk:guanji-list'),

  /** 安装技能（主进程先做能力审查；auth=1 需 authorized=true 显式授权后放行）。 */
  guanjiInstall: (skill: { slug: string; name: string; description: string; caps: string[]; auth: 0 | 1 }, authorized = false): Promise<{ ok: boolean; review: string; reason?: string; path?: string }> =>
    ipcRenderer.invoke('orchdesk:guanji-install', skill, authorized),

  /** 发布技能到观雅集（用户登录后）。 */
  guanjiPublish: (input: { slug: string; alias?: string; filePath: string }): Promise<{ ok: boolean; reason?: string }> =>
    ipcRenderer.invoke('orchdesk:guanji-publish', input),

  // ---- T-P6-2 OrchClaw Hub 联调（配对凭据经 safeStorage 加密存储） ----
  /** 当前配对状态。 */
  hubStatus: (): Promise<{ paired: boolean; url?: string; agentName?: string }> =>
    ipcRenderer.invoke('orchdesk:hub-status'),

  /** 配对远程 Agent。 */
  hubPair: (url: string, token: string): Promise<{ ok: boolean; reason?: string; handle?: string; agentName?: string }> =>
    ipcRenderer.invoke('orchdesk:hub-pair', url, token),

  /** 主会话向远程 Agent 发任务。 */
  hubSend: (text: string): Promise<{ ok: boolean; reason?: string; taskId?: string }> =>
    ipcRenderer.invoke('orchdesk:hub-send', text),

  /** 回传远程 Agent 结果。 */
  hubResult: (taskId: string): Promise<{ status: string; result?: string }> =>
    ipcRenderer.invoke('orchdesk:hub-result', taskId),

  // ---- T-P6-3 数据快照 + 更新检查 ----
  /** 更新前自动快照数据目录（PLAN 红线：不要更新后补）。 */
  snapshotData: (): Promise<{ ok: boolean; dir?: string; reason?: string }> =>
    ipcRenderer.invoke('orchdesk:snapshot-data'),

  /** 检查更新（先完成数据快照，再接入 electron-updater）。 */
  checkUpdates: (): Promise<{ snapshot: { ok: boolean; dir?: string }; update?: { available: boolean; version?: string; note?: string }; reason?: string }> =>
    ipcRenderer.invoke('orchdesk:check-updates'),
};

contextBridge.exposeInMainWorld('orchdesk', orchdesk);
