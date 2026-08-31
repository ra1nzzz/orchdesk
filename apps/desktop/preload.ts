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

  /** 项目分组：启动时拉取（此前缺失，重启后项目全丢）。 */
  loadProjects: (): Promise<Array<{ id: string; n?: string; sessions?: string[]; archived?: number }>> =>
    ipcRenderer.invoke('orchdesk:load-projects'),

  /** 项目分组：变更后落盘。 */
  persistProjects: (projects: Array<{ id: string; n?: string; sessions?: string[]; archived?: number }>): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('orchdesk:persist-projects', projects),

  /** 工具执行步骤（主进程 runAgentTurn 实时推送；此前无订阅方，步骤条永远为空）。 */
  onToolStep: (cb: (step: { sessionId: string; name: string; ph: 'running' | 'done' | 'error'; result?: string }) => void): (() => void) => {
    const listener = (_e: unknown, step: { sessionId: string; name: string; ph: 'running' | 'done' | 'error'; result?: string }): void => cb(step);
    ipcRenderer.on('orchdesk:tool-step', listener);
    return () => ipcRenderer.removeListener('orchdesk:tool-step', listener);
  },

  /** 插件运行时：真实装载状态（替代渲染层硬编码常量）。 */
  getPluginRuntime: (): Promise<{ ready: boolean; activeCount: number; total: number; plugins: Array<{ name: string; active: boolean; available: boolean; error?: string }> }> =>
    ipcRenderer.invoke('orchdesk:plugin-runtime'),

  /** 插件真实热插拔（FR-3）：启用注册 effect，停用逆回滚。 */
  setPluginEnabled: (name: string, enabled: boolean): Promise<{ ok: boolean; active?: boolean; reason?: string }> =>
    ipcRenderer.invoke('orchdesk:plugin-set-enabled', name, enabled),

  /** 编排目录（multi 插件）：8 专家 + 3 团的真实数据。 */
  getOrchestrationCatalog: (): Promise<{ experts?: unknown[]; teams?: unknown[] } | null> =>
    ipcRenderer.invoke('orchdesk:orchestration-catalog'),

  /** 专家团派发（multi composeTeam）：三层编排，返回 { rootId, nodes } 或 { error }。 */
  composeTeam: (teamId: string, task: string): Promise<{ error?: string; rootId?: string; nodes?: unknown[] }> =>
    ipcRenderer.invoke('orchdesk:compose-team', teamId, task),

  /** TRACE 上报状态：enabled（用户开关，默认开）+ builtin（TOKEN 是否已加密内置）。 */
  traceStatus: (): Promise<{ enabled: boolean; builtin: boolean }> =>
    ipcRenderer.invoke('orchdesk:trace-status'),

  /** TRACE 上报开关（重启生效：config 在插件装载时注入）。 */
  traceSetEnabled: (enabled: boolean): Promise<{ ok: boolean; reason?: string; requiresRestart?: boolean }> =>
    ipcRenderer.invoke('orchdesk:trace-set-enabled', enabled),

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

  // ---- PRD FR-8 沙箱 ----
  /** 沙箱策略快照（模式 + 网络域名白名单）。 */
  getSandbox: (): Promise<{ mode: string; networkAllow: string[] }> =>
    ipcRenderer.invoke('orchdesk:sandbox-get'),

  /** 设置网络请求域名白名单（['*'] = 不限）。 */
  setNetworkAllow: (list: string[]): Promise<{ ok: boolean; reason?: string; networkAllow?: string[] }> =>
    ipcRenderer.invoke('orchdesk:sandbox-set-network-allow', list),

  // ---- PRD FR-4.2 桌面集成（托盘 / 快捷键 / 自启动 / 更新 / 悬浮窗 / 通知） ----
  /** 桌面集成开关快照（含快捷键读法与自启动的**系统实际**状态）。 */
  getDesktop: (): Promise<{
    config: Record<string, boolean>;
    shortcutLabel: string;
    labels: Record<string, string>;
    autostartEffective: boolean;
  }> => ipcRenderer.invoke('orchdesk:desktop-get'),

  /** 切换单个桌面集成开关（返回落盘后的完整配置）。 */
  setDesktop: (
    key: string,
    value: boolean,
  ): Promise<{ ok: boolean; reason?: string; warning?: string; changed?: boolean; config?: Record<string, boolean>; autostartEffective?: boolean }> =>
    ipcRenderer.invoke('orchdesk:desktop-set', key, value),

  /** 悬浮窗上下文：切换会话时推送（主进程不猜「当前会话」）。 */
  setFloatingContext: (ctx: { title?: string; sessions?: number }): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('orchdesk:desktop-floating-context', ctx),

  /** TRACE 用户反馈（PRD FR-7）：每条 Agent 消息底部标记 → 脱敏入遥测队列。 */
  traceFeedback: (
    payload: { intent?: string; feedback?: 'positive' | 'neutral' | 'negative'; sessionKey?: string; messageKey?: string },
  ): Promise<{ ok: boolean; reason?: string; queue?: { pending: number; retry: number; errors: number } }> =>
    ipcRenderer.invoke('orchdesk:trace-feedback', payload),

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

  // ---- T-P5/T-P6 数据快照 + 更新检查 ----
  snapshotData: (): Promise<{ ok: boolean; dir?: string; reason?: string }> =>
    ipcRenderer.invoke('orchdesk:snapshot-data'),
  checkUpdates: (): Promise<{ snapshot: { ok: boolean; dir?: string }; update?: { available: boolean; version?: string; note?: string }; reason?: string }> =>
    ipcRenderer.invoke('orchdesk:check-updates'),
  /** 用系统默认文件管理器打开项目数据目录。 */
  openProjectDir: (): Promise<{ ok: boolean; reason?: string }> =>
    ipcRenderer.invoke('orchdesk:open-project-dir'),

  /** 打开文件夹选择对话框 */
  pickFolder: (): Promise<{ ok: boolean; path?: string; reason?: string }> =>
    ipcRenderer.invoke('orchdesk:pick-folder'),

  /** 打开日志目录（模型调用 / 插件加载诊断留痕）。 */
  openLogDir: (): Promise<{ ok: boolean; file?: string; reason?: string }> =>
    ipcRenderer.invoke('orchdesk:open-log-dir'),

  /** 导出全部业务数据到用户选择的 JSON 备份文件（BUG-013 方案 B）。 */
  exportData: (): Promise<{ ok: boolean; path?: string; reason?: string }> =>
    ipcRenderer.invoke('orchdesk:export-data'),

  /** 从备份 JSON 导入（与启动迁移同一套「只补齐不覆盖」合并策略）。 */
  importData: (): Promise<{ ok: boolean; imported?: Record<string, number>; notes?: string[]; path?: string; reason?: string }> =>
    ipcRenderer.invoke('orchdesk:import-data'),

  // ---- FR-5 模型管理（配置持久化 + 连通性测试） ----
  /** 取模型配置（不含明文 API Key）。 */
  getModelConfig: (): Promise<{ providers: Array<{ id: string; name: string; type: string; baseUrl: string; models: string[] }>; defaultProvider?: string }> =>
    ipcRenderer.invoke('orchdesk:models-get'),
  /** 保存模型配置（API Key 经 safeStorage 加密）。 */
  saveModelConfig: (config: Record<string, unknown>): Promise<{ ok: boolean; reason?: string }> =>
    ipcRenderer.invoke('orchdesk:models-save', config),
  /** 测试模型连通性。 */
  testModel: (providerId: string, model: string): Promise<{ ok: boolean; latencyMs?: number; error?: string }> =>
    ipcRenderer.invoke('orchdesk:models-test', providerId, model),
};

contextBridge.exposeInMainWorld('orchdesk', orchdesk);
