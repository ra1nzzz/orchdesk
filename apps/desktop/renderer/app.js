/* ============================================================================
 * OrchDesk 渲染进程（P1 真实渲染工程）
 * --------------------------------------------------------------------------
 * 渲染进程持有 UI 会话状态（state.sessions / state.projects）；所有需要落盘
 * 或需要真实模型的操作经 window.orchdesk 桥（contextBridge）调用主进程：
 *   - loadSessions()      启动时拉取持久化会话（空则首次运行，用种子数据）
 *   - persistSessions(arr) 任何变更后落盘（主进程写 userData JSON，可重启回放）
 *   - runAgentTurn(...)    模型回合 seam：主进程在此接真实 dsh ctx / Ollama
 * 红线（ADR-0002）：渲染进程绝不 require node / dsh 模块，一律经桥。
 * 若桥不存在（直接用浏览器打开 index.html 预览），自动回落到页内内存存储。
 * ========================================================================== */
(function () {
  'use strict';

  const I = {
    conv: '<path d="M4 5h16v11H9l-5 4z"/>',
    skills: '<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/><path d="M13 7.5h4M7.5 13v4"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9L17 7M7 17l-2.1 2.1"/>',
    chev: '<path d="M9 6l6 6-6 6"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    more: '<circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/>',
    copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
    edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
    fork: '<circle cx="6" cy="6" r="2"/><circle cx="6" cy="18" r="2"/><circle cx="18" cy="18" r="2"/><path d="M6 8v8M18 16V8a4 4 0 0 0-4-4H8"/>',
    folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    folderOpen: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M3 7l3 3h12l-1 8H6l-3-3z"/>',
    archive: '<rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8M10 12h4"/>',
    at: '<circle cx="12" cy="12" r="4"/><path d="M16 12v1.5a2.5 2.5 0 0 0 5 0V12a9 9 0 1 0-3.5 7.1"/>',
    shield: '<path d="M12 2 4 5v6c0 5 3.5 9.5 8 11 4.5-1.5 8-6 8-11V5z"/>',
    shieldOff: '<path d="M5 5l14 14M12 2 4 5v6c0 5 3.5 9.5 8 11 4.5-1.5 8-6 8-11V5z"/>',
    bot: '<rect x="4" y="7" width="16" height="12" rx="3"/><circle cx="9" cy="13" r="1.2"/><circle cx="15" cy="13" r="1.2"/><path d="M12 7V3M9 3h6"/>',
    trash: '<path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1.2 13a2 2 0 0 1-2 1.8H8.2a2 2 0 0 1-2-1.8L5 6"/>',
    warn: '<path d="M10.3 3.86 1.82 18a2 2 0 0 0 1.7 3h16.9a2 2 0 0 0 1.7-3L13.7 3.86a2 2 0 0 0-3.4 0zM12 9v4M12 17h.01"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
    zap: '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>',
    fileText: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/>',
    wrench: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>',
    presentation: '<rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>',
    clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
    clipboard: '<path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/>',
    check: '<polyline points="20 6 9 17 4 12"/>',
    circle: '<circle cx="12" cy="12" r="9"/>',
    refresh: '<polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>',
    code: '<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>',
    // 浏览器（ADR-0011）面板入口
    globe: '<circle cx="12" cy="12" r="9"/><line x1="3" y1="12" x2="21" y2="12"/><path d="M12 3a15 15 0 0 1 0 18a15 15 0 0 1 0-18z"/>',
    // 建议项图标（iconMap 引用，此前缺失 → ic() 渲染空 SVG）
    barChart: '<line x1="12" y1="20" x2="12" y2="10"/><line x1="18" y1="20" x2="18" y2="4"/><line x1="6" y1="20" x2="6" y2="16"/>',
    grid: '<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/>',
    // ---- 本轮 UI 重构新增 ----
    // 终端（状态栏右下角图标；此前只有文字按钮，无图标）
    terminal: '<rect x="2" y="4" width="20" height="16" rx="2"/><polyline points="6 9 9 12 6 15"/><line x1="12" y1="15" x2="17" y2="15"/>',
    // 下拉箭头（思考链展开 / 终端抽屉）
    chevDown: '<polyline points="6 9 12 15 18 9"/>',
    // 关闭叉（浏览器 TAB 单关）
    x: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
    // 图片占位（浏览器页面快照无缩略图时）
    image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9.5" r="1.5"/><polyline points="21 16 16 11 5 20"/>',
    // 双箭头全关（浏览器「全部关闭」）
    xAll: '<polyline points="4 8 8 12 4 16"/><line x1="13" y1="8" x2="20" y2="16"/><line x1="20" y1="8" x2="13" y2="16"/>',
  };
  const ic = (n, s = 20) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${I[n]}</svg>`;
  /** 工具步骤行（live typing 与静态消息两处共用，杜绝双份模板漂移）。
   * 色义：执行中=琥珀脉冲 / 出错=红 / 完成=绿；sm=true 为 typing 紧凑行。 */
  function toolRow(t, sm) {
    const ph = t.ph === 'running' ? 'running' : (t.ph === 'error' ? 'error' : 'done');
    const dot = ph === 'running' ? 'var(--warn)' : (ph === 'error' ? 'var(--danger)' : 'var(--ok)');
    const anim = ph === 'running' ? 'animation:pulse 1.6s infinite' : '';
    const lbl = ph === 'running' ? '执行中' : (ph === 'error' ? '出错' : '完成');
    const trowSt = sm ? 'style="margin-top:2px"' : '';
    const monoSt = sm ? 'style="font-size:11px"' : '';
    const faintSt = sm ? 'style="margin-left:auto;font-size:10.5px"' : 'style="margin-left:auto"';
    return `<div class="trow" ${trowSt}><span class="tdot" style="background:${dot};${anim}"></span><span class="mono" ${monoSt}>${esc(t.n)}</span><span class="faint" ${faintSt}>${lbl}</span></div>`;
  }
  // 专家 / 专家团：**回落到多 Agent 编排插件（multi）提供的真实目录**。
  // 编排插件可用时以 catalog 为准（8 专家 + 3 团），不可用时才用下面的兜底清单。
  const EXPERTS = ['Orchestrator（主会话）', '开发总监', '设计总监', '测试总监', '项目管理总监', '文档总监', '艺术总监', '风险控制总监'];
  const TEAMS = [{ n: '预置 · 全栈开发团', m: '开发总监 + 测试总监 + 文档总监' }, { n: '预置 · 写作团', m: '文档总监 + 艺术总监' }, { n: '自定义 · 我的专家团', m: '自编排（拖拽专家）' }];

  /** 专家列表：优先取编排插件真实目录。 */
  function expertList() {
    const cat = state.orchestrationCatalog;
    if (cat && Array.isArray(cat.experts) && cat.experts.length) {
      return cat.experts.map((e) => e.title || e.name || e.id);
    }
    return EXPERTS;
  }

  /** 团队列表：优先取编排插件真实目录（成员 id 映射为展示名）。 */
  function teamList() {
    const cat = state.orchestrationCatalog;
    if (cat && Array.isArray(cat.teams) && cat.teams.length) {
      const nameOf = (id) => {
        const e = (cat.experts || []).find((x) => x.id === id);
        return e ? (e.title || e.name || e.id) : id;
      };
      return cat.teams.map((t) => ({
        n: t.name || t.id,
        m: Array.isArray(t.members) ? t.members.map(nameOf).join(' + ') : '',
        id: t.id,
      }));
    }
    return TEAMS;
  }

  /** 编排数据是否来自真实插件（否则 UI 标注「未接入」）。 */
  function orchestrationLive() {
    const cat = state.orchestrationCatalog;
    return !!(cat && Array.isArray(cat.experts) && cat.experts.length);
  }
  // ④M-1：授权模式不再硬编码 —— canonical 来自 authz 插件 AUTHZ_MODES，经
  // orchdesk:authz-get-modes IPC 灌入 state.authModes。这里只留「未加载完成」的
  // 兜底展示（与插件同文案，加载后即被真实数据覆盖），杜绝 trusted 文案漂移。
  const FALLBACK_AUTH_MODES = [
    { id: 'default', label: '默认安全', blurb: '工作区可写；L3/L4 操作弹窗确认（ask）。平衡日常使用与安全。' },
    { id: 'trusted', label: '信任模式', blurb: '同默认沙箱，但放宽命令/网络白名单（仍受 SandboxMode 约束）。高危操作仍弹窗。' },
    { id: 'paranoid', label: '偏执模式', blurb: '只读沙箱 + 任何 ask 自动拒绝（never）。最严；不可逆/越界操作一律不开门。' },
  ];
  const authModesForRender = () => (state.authModes.length ? state.authModes : FALLBACK_AUTH_MODES);
  // 模式 id → 显示名（消费 authModesForRender，杜绝散落「默认安全/信任/偏执」手写映射漂移）。
  const authModeLabel = (id) => {
    const m = authModesForRender().find((x) => x.id === id);
    return m ? m.label : '默认安全';
  };
  const PROMPT_CAT_LABELS = { role: '角色行为', safety: '安全边界', format: '输出格式', 'skill-link': '技能联动' };
  const PROMPT_CATS = Object.keys(PROMPT_CAT_LABELS);
  const PLUGINS = [
    { id: 'intent', n: '意图识别', on: 1, d: 'prompt 到达模型前必经 agent/pre-step；本地模型做 F1-F4 初筛，高风险才转人工确认。', repo: '', caps: ['prompt.read', 'intent.classify', 'flow.gate'], cfg: ['风险阈值：0.70', '默认回退：BLOCK'] },
    { id: 'trace', n: 'TRACE', on: 1, d: 'Agent Loop 前 / Loop 结束，记录用户对语用意图的反馈；脱敏后遥测上传。', repo: '', caps: ['event.read', 'pii.mask'], cfg: ['脱敏：开', '反馈时机：Loop 结束后'] },
    { id: 'brain', n: '脑手解耦', on: 1, d: '主会话负责理解、回收、沉淀；SubAgent 执行、反馈、即用即走。', repo: '', caps: ['agent.spawn', 'agent.dispose', 'memory.commit'], cfg: ['每任务并发：1-3'] },
    { id: 'multi', n: '多Agent编排', on: 1, d: '类 WorkBuddy 的专家与专家团；可用预置，也可自编排。', repo: '', caps: ['expert.load', 'team.compose', 'role.bind'], cfg: ['预置专家团：2 个'] },
    { id: 'hub', n: 'OrchClaw Hub', on: 0, d: '配对远程 Agent 后，主会话可向其下发任务并回收结果。', repo: '', caps: ['pair.token', 'agent.remote', 'ws.channel'], cfg: ['配对：安全存储加密'] }
  ];
  const SKILLS_MARKET = [
    { n: 'guanji', d: '观雅集官方客户端', caps: ['skill.fetch', 'skill.install'], auth: 0 },
    { n: 'consolidate-project-knowledge-base', d: '项目知识库治理', caps: ['fs.read', 'fs.write', 'doc.review'], auth: 1 },
    { n: 'aihot', d: 'AI 资讯日报', caps: ['web.fetch', 'cron.schedule'], auth: 0 },
  ];
  const PLUGIN_MARKET = [
    { n: 'Git 集成', d: '仓库操作 / PR / Issue', caps: ['git.read', 'git.write'], auth: 1 },
    { n: 'PDF 工具箱', d: '读取/合并/拆分/OCR', caps: ['pdf.read', 'pdf.write'], auth: 0 },
    { n: '浏览器自动化', d: 'Playwright 驱动', caps: ['browser.navigate', 'browser.screenshot'], auth: 1 },
    { n: '邮件助手', d: 'SMTP/IMAP 收发', caps: ['mail.send', 'mail.read'], auth: 1 },
    { n: '数据可视化', d: 'Chart.js 图表生成', caps: ['chart.render'], auth: 0 }
  ];
  // 连接器目录已移至后端注册表（PRD FR-3，apps/desktop/connector-registry.ts）。
  // 此前的静态数组带 on:1 —— GitHub 被硬编码成「已连」，是纯假状态，已删。

  // 模型池：仅来自真实配置（设置页添加的提供商）；无配置 = 空池，UI 显示"选择模型"
  let MODELS = [];

  /* ---------- 模型选择：持久化 + 默认策略 ---------- */
  const MODEL_SELECTION_KEY = 'orchdesk.modelSelection';
  function saveModelSelection(models) {
    try { localStorage.setItem(MODEL_SELECTION_KEY, JSON.stringify(models || [])); } catch { /* 隐私模式等忽略 */ }
  }
  function loadModelSelection() {
    try {
      const v = localStorage.getItem(MODEL_SELECTION_KEY);
      const arr = v ? JSON.parse(v) : null;
      return Array.isArray(arr) ? arr : null;
    } catch { return null; }
  }

  /**
   * 默认选择策略（providers 非空时调用）：
   * 1. 用户上次在对话框确认的选择优先（跨会话复用，localStorage 持久化）
   * 2. 仅一种有效模型 → 默认启用它
   * 3. 本地 + API → 本地勾选（意图识别）+ API（主运行）
   * 4. 多个 API → 设置页指定的默认模型 + 本地（若有）
   */
  function autoSelectModels(providers, defaultProviderId, defaultModelName) {
    const pool = dynamicModels;
    if (!pool.length) { state.selectedModels = []; return; }
    const has = (n) => pool.some(m => m.n === n);

    // 本地模型判定：提供商 type=ollama，或名称含 本地/Ollama
    const ollamaNames = new Set((providers || []).filter(p => p.type === 'ollama').map(p => p.name));
    const isLocal = (m) => ollamaNames.has(String(m.p).split(' · ')[0]) || /本地|Ollama/i.test(m.p);
    const localModels = pool.filter(isLocal);
    const apiModels = pool.filter(m => !isLocal(m));

    // 1) 用户持久化的选择优先（至少保留 1 个且全部仍有效）
    const saved = loadModelSelection();
    if (saved && saved.length > 0 && saved.every(has)) {
      state.selectedModels = saved;
      return;
    }

    if (apiModels.length === 0) {
      // 只有本地模型（0 或多个）：全不勾或勾第一个
      state.selectedModels = pool.length ? [pool[0].n] : [];
    } else if (apiModels.length === 1) {
      // 单个 API：本地（若有）作为意图识别 + API 主运行
      state.selectedModels = localModels.length ? [apiModels[0].n, localModels[0].n] : [apiModels[0].n];
    } else {
      // 多个 API：设置页指定的默认模型优先，其次默认提供商下的模型，再否则第一个 API
      const dm = (defaultModelName && has(defaultModelName) ? pool.find(m => m.n === defaultModelName && !isLocal(m)) : null)
        || (defaultProviderId ? apiModels.find(m => String(m.p).startsWith(defaultProviderId)) : null)
        || apiModels[0];
      state.selectedModels = localModels.length ? [dm.n, localModels[0].n] : [dm.n];
    }
    saveModelSelection(state.selectedModels);
  }

  function getModelPool() { return dynamicModels.length ? dynamicModels : MODELS; }

  let dynamicModels = [];

  /* ---------- FR-6 分叉与回放（纯逻辑，与验证套件共用同一份实现） ----------
   * session-fork.js 由 index.html 在 app.js 之前加载；缺失时 FORK 为 null，
   * 分叉点选择与回放视图降级为不可用并如实提示（不静默退化成「全继承」）。 */
  const FORK = (typeof window !== 'undefined' && window.OrchDeskFork) ? window.OrchDeskFork : null;

  /* ---------- 桥接（主进程 contextBridge；无桥接时显示"未连接"） ---------- */
  const bridge = (function () {
    const real = (typeof window !== 'undefined' && window.orchdesk) ? window.orchdesk : null;
    if (real) return real;
    // 无桥接：返回空壳，UI 显示"未连接"状态
    return {
      loadSessions: () => Promise.resolve([]),
      persistSessions: (arr) => Promise.resolve({ ok: false, reason: '未连接主进程' }),
      runAgentTurn: (sessionId, text, opts) => Promise.resolve({ text: '未连接主进程运行时，无法调用模型。请在设置中配置模型提供商。', intent: 'CONFIRM' }),
      // 授权
      getAuthMode: () => Promise.resolve({ mode: 'default' }),
      setAuthMode: () => Promise.resolve({ ok: false }),
      getAuthLevels: () => Promise.resolve([]),
      getAuthAudit: () => Promise.resolve([]),
      getAuthModes: () => Promise.resolve({ modes: [], grantTools: [] }),
      onAuthRequest: () => () => {},
      submitDecision: () => {},
      // 授权白名单（PRD FR-9）
      listGrants: () => Promise.resolve([]),
      addGrant: () => Promise.resolve({ ok: false, reason: '主进程未接入' }),
      revokeGrant: () => Promise.resolve({ ok: false }),
      revokeAllGrants: () => Promise.resolve({ ok: false, revoked: 0 }),
      // 提示词库
      listPrompts: () => Promise.resolve([]),
      mergePrompts: () => Promise.resolve({ sections: [], conflicts: [] }),
      savePrompt: () => Promise.resolve({ ok: false }),
      deletePrompt: () => Promise.resolve({ ok: false }),
      // 记忆
      getMemoryStats: () => Promise.resolve(null),
      // TRACE 用户反馈（PRD FR-7）
      traceFeedback: () => Promise.resolve({ ok: false, reason: '主进程未接入' }),
      // 沙箱（PRD FR-8）
      getSandbox: () => Promise.resolve({ mode: 'workspace-write', networkAllow: ['*'] }),
      setNetworkAllow: (list) => Promise.resolve({ ok: false, reason: '主进程未接入', networkAllow: list }),
      // PRD FR-8：沙箱日志检索（无桥时返回 null → loaded 保持 false，UI 标注未接入
      // 而不是假装「空日志」—— 这两种状态的处置完全不同）
      getSandboxLog: () => Promise.resolve(null),
      clearSandboxLog: () => Promise.resolve({ ok: false, cleared: 0 }),
      // PRD FR-4.2：数据目录内容清单（无桥时 ok=false，UI 不显示假体积）
      getDataDirInventory: () => Promise.resolve({ ok: false, dir: '', items: [], totalSize: 0, totalFiles: 0, totalSizeText: '', errors: [] }),
      // 桌面集成（PRD FR-4.2）：无桥时 config 为 null → 开关降级为不可点并标注
      getDesktop: () => Promise.resolve({ config: null, shortcutLabel: 'Ctrl+Shift+Space', labels: {}, autostartEffective: false }),
      setDesktop: () => Promise.resolve({ ok: false, reason: '主进程未接入' }),
      setFloatingContext: () => Promise.resolve({ ok: false }),
      // 补偿层
      withhold: (text) => Promise.resolve({ needsConfirm: false, category: 'other', reason: '', warning: '' }),
      // FR-6 事件流（ADR-0009）：无桥 → null，回放回退消息数组并标注「事件流未接入」
      getSessionEvents: () => Promise.resolve(null),
      appendForkEvent: () => Promise.resolve({ ok: false, reason: '主进程未接入' }),
      // FR-5 用量追踪：无桥 → null，UI 标注「未接入」而非假 0
      getUsage: () => Promise.resolve(null),
      clearUsage: () => Promise.resolve({ ok: false, reason: '主进程未接入' }),
      compensate: (text, note) => Promise.resolve({ id: 'cmp-' + Date.now().toString(36), ts: Date.now(), text: (text || '').slice(0, 80), note: note || '', action: '记录操作以便审计追溯' }),
      getCompensationAudit: () => Promise.resolve([]),
      createTempPlugin: (spec) => Promise.resolve({ ok: false, reason: '主进程未接入（P1-5 seam）' }),
      listTempPlugins: () => Promise.resolve([]),
      disposeTempPlugin: (id) => Promise.resolve(false),
      guanjiTokenStatus: () => Promise.resolve({ configured: false }),
      guanjiSetToken: () => Promise.resolve({ ok: false }),
      guanjiList: () => Promise.resolve(SKILLS_MARKET.map((s) => ({ slug: s.n, name: s.n, description: s.d, caps: s.caps, auth: s.auth }))),
      guanjiInstall: (skill) => skill && skill.auth ? Promise.resolve({ ok: false, review: 'needs-auth', reason: '需配置观雅集 TOKEN' }) : Promise.resolve({ ok: true, review: 'allowed' }),
      guanjiPublish: () => Promise.resolve({ ok: false, reason: '需配置观雅集 TOKEN' }),
      // 本地已安装技能：无桥 → ok:false（UI 标注「未接入」），不能用空数组冒充「已扫描但没装」
      listInstalledSkills: () => Promise.resolve({ ok: false, items: [], reason: '主进程未接入' }),
      uninstallSkill: () => Promise.resolve({ ok: false, reason: '主进程未接入' }),
      hubStatus: () => Promise.resolve({ paired: false }),
      hubPair: () => Promise.resolve({ ok: false, reason: '未配对' }),
      hubSend: () => Promise.resolve({ ok: false, reason: '未配对' }),
      hubResult: () => Promise.resolve({ status: 'error', result: '未配对' }),
      snapshotData: () => Promise.resolve({ ok: false, reason: '未接入' }),
      checkUpdates: () => Promise.resolve({ snapshot: { ok: false }, update: { available: false, note: '未接入' } }),
      exportData: () => Promise.resolve({ ok: false, reason: '未接入' }),
      importData: () => Promise.resolve({ ok: false, reason: '未接入' }),
      openLogDir: () => Promise.resolve({ ok: false, reason: '未接入' }),
      // 浏览器（ADR-0011）：无桥时返回 open:false —— 面板据此显示「未接入」，
      // 不能用「空白页 / 0 张截图」冒充「浏览器已就绪只是没开」。
      getBrowserStatus: () => Promise.resolve({ open: false }),
      setBrowserVisible: () => Promise.resolve({ ok: false }),
      closeBrowser: () => Promise.resolve({ ok: false, closed: false }),
      openBrowserShotDir: () => Promise.resolve({ ok: false, reason: '未接入' }),
      onBrowserState: () => () => {},
      // 终端（P2-10）：无桥 → null，面板显示「未接入」而不是「0 个会话」
      terminalCreate: () => Promise.resolve({ ok: false, reason: '主进程未接入' }),
      terminalWrite: () => Promise.resolve({ ok: false }),
      terminalResize: () => Promise.resolve({ ok: false }),
      terminalKill: () => Promise.resolve({ ok: false }),
      terminalStatus: () => Promise.resolve(null),
      onTerminalData: () => () => {},
      onTerminalExit: () => () => {},
      // 文件（P2-11）：无桥 → bridgeMissing 标记。不能用 `typeof fn !== 'function'`
      // 判「未接入」——stub 本身也是函数，那样永远显示成「空目录」。
      fileTree: () => Promise.resolve({ ok: false, reason: '主进程未接入', bridgeMissing: true }),
      fileRead: () => Promise.resolve({ ok: false, reason: '主进程未接入', bridgeMissing: true }),
      fileWrite: () => Promise.resolve({ ok: false, reason: '主进程未接入' }),
    };
  })();

  /* ---------- PRD FR-8 沙箱日志：判定结果与类型的中文名 ---------- */
  const SL_DECISION_LABELS = { all: '全部结果', allowed: '放行', denied: '拒绝', error: '出错' };
  // browser（ADR-0011）：内置浏览器的导航与页面内操作
  const SL_KIND_LABELS = { all: '全部类型', path: '路径', command: '命令', network: '网络', approval: '授权', outbound: '外发', browser: '浏览器', config: '配置' };

  /* ---------- 状态 ---------- */
  const state = {
    page: 'session', theme: 'dark', sel: null, ctxOpen: 1, ctxTab: 'todo', wz: 0, wzExpert: 0,
    selProjForComposer: null, projDropdownOpen: false, composerMoreOpen: false,
    newConvMode: true,
    feedback: new Set(), authMode: 'default',
    // 思考链展开态（本轮 UI 重构）：key = `${sid}|${msg.t}`，存已展开「思考中」详情的消息。
    thinkExpanded: new Set(),
    authLevels: [], authAudit: [],
    // ④M-1：授权模式卡 / 白名单工具下拉数据化（canonical = authz 插件 AUTHZ_MODES / GRANT_TOOLS）
    authModes: [], grantTools: [],
    // 授权白名单（PRD FR-9）：会话 / 永久规则，来自 authz 插件真实服务
    grants: [],
    promptDocs: [], promptConflicts: [],
    compAudit: [], tempPlugins: [],
    guanjiSkills: [], guanjiTokenSet: false, installedSkills: [], installedSkillsLoaded: false, askInputCb: null,
    hubStatus: { paired: false }, hubUrl: '', hubTaskText: '', hubResultText: '',
    memoryStats: null,
    pExpanded: new Set(),
    plugSideExpanded: new Set(['builtin', 'market', 'skills', 'experts', 'connectors']),
    selectedModels: [], thinkLevel: 'standard', modelProviders: [], mpEditing: null, defaultProvider: undefined,
    maxToolIterations: 200, projects: [], sessions: {},
    // 实时工具步骤：sessionId → [{ n, ph, result }]，由主进程 orchdesk:tool-step 推送
    toolSteps: {},
    // 插件运行时真实状态（替代 PLUGINS 常量的硬编码 on 字段）
    pluginRuntime: null,
    // 编排目录（multi 插件真实数据；null = 未接入，UI 回落兜底清单并标注）
    orchestrationCatalog: null,
    // 沙箱策略（PRD FR-8）：模式 + 网络域名白名单（null = 未拉取，UI 回落默认）
    sandbox: { mode: 'workspace-write', networkAllow: ['*'] },
    // 最近一次专家团派发结果（composeTeam 返回的 { rootId, nodes }）
    delegationLast: null,
    // TRACE 上报开关（默认开；bridge.traceStatus 拉取后覆盖）
    traceEnabled: true,
    traceBuiltin: false,
    // 桌面集成（PRD FR-4.2）：6 个开关此前全是 data-action="todo" 空壳。
    // null = 桥未接入（浏览器预览），UI 降级为不可点并标注。
    desktop: null,
    // 回放视图（PRD FR-6）：存放被回放的会话 id；非 null 时主区渲染只读时间线。
    replayFor: null,
    // 沙箱日志（PRD FR-8 可检索）：loaded=false 时 UI 标注「未接入」，
    // 与「接进了但没记录」区分开 —— 这两种状态的处置完全不同。
    sandboxLog: {
      entries: [], stats: { total: 0, allowed: 0, denied: 0, error: 0, byTool: [] },
      total: 0, max: 500, keyword: '', decision: 'all', kind: 'all', loaded: false,
    },
    // 数据目录内容清单（PRD FR-4.2）：真实扫描结果。ok=false = 未接入/扫描失败，
    // UI 显示「未接入」而不是沿用写死的「~ 24 MB」。
    dataDirInventory: { ok: false, dir: '', items: [], totalSize: 0, totalFiles: 0, totalSizeText: '', errors: [] },
    // 分层记忆（PRD FR-10）：四域可查 + 晋升。loaded=false = 桥不可用，
    // 与「接进了但域是空的」区分开 —— worker 域空有两种完全不同的成因
    // （还没跑过 SubAgent vs 桥断了），UI 必须说清楚是哪一种。
    memory: { domain: 'worker', items: [], stats: null, loaded: false, busy: false },
    // 晋升审计（PRD FR-10「须显式操作并写审计」）：成功与失败都记。
    memoryPromotions: {
      entries: [], stats: { total: 0, promoted: 0, rejected: 0, byEdge: [] },
      total: 0, max: 200, ok: 'all', loaded: false,
    },
    // 记忆摘要方式（FR-10）：llm = 模型摘要，extractive = 抽取式兜底。
    // 必须显式展示 —— 否则「自动转储其实一直在兜底」这种降级无从发现。
    memorySummarize: { mode: 'extractive', provider: '', model: '', seam: false, loaded: false },
    // FR-5 用量追踪：真实记账（只统计网关上报过 usage 的回合）。loaded=false = 未接入。
    usage: {
      loaded: false,
      total: { promptTokens: 0, completionTokens: 0, totalTokens: 0, turns: 0 },
      byModel: [], bySession: [],
    },
    // FR-6 回放数据源（ADR-0009）：事件流时间线。sid 不匹配当前回放会话 = 未加载。
    sessionEvents: { sid: null, data: null, loaded: false },
    // 浏览器（ADR-0011）：内置 CDP 浏览器窗口。loaded=false = 桥未接入；
    // open=false = 窗口没开（面板显示「未打开」，不显示空白页或假地址）。
    // Agent 默认在后台隐藏窗口操作网页，这个面板是用户唯一的观察与制动入口。
    browser: { loaded: false, open: false, url: '', title: '', visible: false, lastShot: null, lastError: '', shotsDir: '',
      // 页面快照 TAB（本轮 UI 重构）：底层是单个隐藏 CDP 窗口，同一时刻只有一个活跃页面，
      // 但 Agent 会先后访问多个 URL —— 每次 navigate 登记一张卡片（标题/URL/缩略图），
      // 侧栏里就是可单关/全关的 TAB 列表。绝不用「多个页面同时存在」的假象冒充多标签。
      pages: [], activePageId: null },
    // 浏览器面板是否打开（状态推送时据此决定是否重绘）
    browserPanelOpen: false,
    // 浏览器侧栏显隐（多 TAB 容器）。Agent 首次调用浏览器时自动置 true，
    // 同时默认收起任务监控侧栏——两个侧栏同时展开会把主区挤没。
    browserSideOpen: false,
    // 终端（P2-10）：ptyAvailable=false = 管道模式降级（必须显式展示，不冒充 PTY）。
    // loaded=false = 桥未接入；sessions=[] = 没有打开的终端（两者不是一回事）。
    terminal: { loaded: false, ptyAvailable: false, via: 'pipe', sessions: [], activeId: null },
    terminalPanelOpen: false,
    // 终端抽屉全屏档位（需求3）：全屏时抽屉占满除标题栏/状态栏外的高度，
    // 主区（flex:1）自动收缩——不是盖住主区。
    termFull: false,
    // 文件（P2-11）：root='' = 尚未选择目录。children 是目录懒加载缓存。
    filePanelOpen: false,
    // 右栏「文件」TAB（本轮 UI 重构）：与「产物」不同——产物是本会话 Agent 生成的内容，
    // 文件是当前工作目录的全部文件。root 自动跟随会话所绑定项目的本地目录。
    fileTab: { root: '', inited: false, loading: false, expanded: new Set(), children: new Map(), error: '' },
    filePanel: { loaded: false, bridgeMissing: false, root: '', truncated: false, expanded: new Set(), children: new Map(), preview: null, previewPath: '', previewLoading: false, shikiReady: false,
      // P3 编辑/diff：view = preview | edit | diff；diffRows/diffTooLarge 是最近一次计算结果
      view: 'preview', editBuf: '', editBase: '', eol: 'lf', dirty: false, saving: false, discardArmed: false,
      diffRows: null, diffTooLarge: false, diffLineDelta: 0, diffStat: '', saveError: '' },
    // 连接器（PRD FR-3）：真实后端注册表（凭证加密存储 + 保存即探测）。
    // loaded=false 时侧栏显示「未接入」，不能拿空数组冒充「都没配置」。
    connectors: { items: [], stats: { total: 0, configured: 0, tested: 0, ok: 0 }, loaded: false, expanded: null },
    connAudit: { entries: [], stats: { total: 0, saves: 0, clears: 0, tests: 0, fails: 0 }, total: 0, max: 200, loaded: false },
    // 本地插件市场（PRD FR-3）：dataDir()/plugins 下的第三方插件。
    market: { items: [], dir: '', count: 0, loaded: false, busy: null },
    // MCP（真接入）：真实 server 配置 + 连接状态 + 工具清单。
    // loaded=false = 主进程桥未接入；servers=[] = 已接入但没配置（两者不是一回事）。
    mcp: { servers: [], stats: { total: 0, configured: 0, connected: 0, tools: 0 }, loaded: false },
    mcpExpanded: null,
    // 插件页搜索（前端过滤；对内置插件卡片按名称/描述/能力/标识做不区分大小写子串匹配）
    plugSearch: '',
  };

  const $ = (s) => document.querySelector(s);
  const PAGES = [
    { id: 'session', n: '会话', icon: 'conv' },
    { id: 'plugins', n: '插件', icon: 'skills' },
    { id: 'settings', n: '设置', icon: 'settings' }
  ];
  const nowTime = () => new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });

  // 导入期间挂起 persist：persist-sessions 是「渲染层状态整体重写」，若在
  // 主进程导入落盘与渲染层重拉之间触发，会把导入数据整体冲掉（审阅阻断项）。
  let importSuspend = false;
  /** 沙箱日志检索防抖句柄（PRD FR-8）。 */
  let sblogTimer = 0;

  function persist() { if (importSuspend) return; persistSessions(); persistProjects(); }

  function persistSessions() { bridge.persistSessions(Object.values(state.sessions)).catch(() => {}); }

  /**
   * 项目分组落盘（BUG：此前只持久化 sessions，重启后项目全丢、会话退化为「任务」组）。
   * 用 try/catch 兜底：桥不可用时降级为不落盘，不影响会话本身。
   */
  let projectsPersistTimer = null;
  function persistProjects() {
    if (typeof bridge.persistProjects !== 'function') return;
    if (projectsPersistTimer) clearTimeout(projectsPersistTimer);
    projectsPersistTimer = setTimeout(() => {
      projectsPersistTimer = null;
      bridge.persistProjects(state.projects).catch((err) => {
        console.warn('[persist] 项目分组落盘失败:', err && err.message);
      });
    }, 250);
  }

  /**
   * 插件卡片状态徽章：优先取运行时真实状态（orchdesk:plugin-runtime），
   * 未接入运行时时回落常量声明并标注「未接入」，不伪造「已启用」。
   */
  function pluginBadge(id) {
    const rt = state.pluginRuntime;
    if (rt && rt.ready && Array.isArray(rt.plugins)) {
      const live = rt.plugins.find((x) => x.name === id);
      if (live) {
        if (live.active) return '<span class="badge ok">已启用</span>';
        if (!live.available) return `<span class="badge">未接入</span>`;
        return `<span class="badge warn" title="${(live.error || '').replace(/"/g, '')}">已停用</span>`;
      }
      // 运行时不认识这个插件（如 hub 走独立实现）→ 回落常量
    }
    const p = PLUGINS.find((x) => x.id === id);
    if (!p) return '';
    if (p.on) return '<span class="badge ok">已启用</span>';
    return p.deferred ? '<span class="badge">延后 · 需联调</span>' : '<span class="badge">已关闭</span>';
  }

  /** 插件开关的初始状态：以运行时为准 */
  function pluginSwitchedOn(id) {
    const rt = state.pluginRuntime;
    if (rt && rt.ready && Array.isArray(rt.plugins)) {
      const live = rt.plugins.find((x) => x.name === id);
      if (live) return live.active === true;
    }
    const p = PLUGINS.find((x) => x.id === id);
    return !!(p && p.on);
  }

  /** 深拷贝会话（分叉用）。structuredClone 不可用时回落到 JSON 往返。 */
  function deepClone(v) {
    if (typeof structuredClone === 'function') {
      try { return structuredClone(v); } catch { /* 含不可克隆值时回落 */ }
    }
    return JSON.parse(JSON.stringify(v));
  }

  /* ---------- 渲染：导航 ---------- */
  function renderRail() {
    $('#rail').innerHTML = PAGES.map((p) => `<button class="navbtn ${state.page === p.id ? 'active' : ''}" data-action="nav" data-id="${p.id}" title="${p.n}">${ic(p.icon)}<span class="nl">${p.n}</span></button>`).join('') +
      `<div class="sp"></div><button class="navbtn" data-action="toggle-theme" title="切换主题">${ic('sun')}<span class="nl">主题</span></button>`;
  }

  /* ---------- 渲染：消息（外部/用户可控内容统一转义，防 XSS） ---------- */
  // 转义表提到闭包外：每次调用 new 一个字面量对象，2MB 文本实测 43ms。
  const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  function esc(v) {
    return String(v ?? '').replace(/[&<>"']/g, (c) => ESC_MAP[c]);
  }

  /* ---------- PRD FR-4.2 桌面集成 ---------- */
  /** 自启动描述如实反映「系统实际状态」：写了但系统没接受 → 明确提示，不假装已生效。 */
  function desktopAutostartDesc() {
    const d = state.desktop;
    if (!d) return '开机时启动 OrchDesk';
    if (d.config.autostart && d.autostartEffective === false) return '开机时启动 · 系统未接受该设置';
    return '开机时启动 OrchDesk';
  }

  /** 悬浮窗内容由渲染层推送（主进程不猜「当前会话」）。未开启悬浮窗时不发 IPC。 */
  /* ---------- PRD FR-8 沙箱日志 ---------- */
  /** 当前检索条件（从 state 直接组装，避免 UI 与请求各存一份）。 */
  function sandboxLogQuery() {
    return { keyword: state.sandboxLog.keyword, decision: state.sandboxLog.decision, kind: state.sandboxLog.kind, limit: 100 };
  }

  /** 合并主进程返回。r 为 null / 非对象 → 保持 loaded=false（UI 标注未接入）。 */
  function applySandboxLog(r) {
    if (!r || typeof r !== 'object' || !Array.isArray(r.entries)) return;
    state.sandboxLog = {
      entries: r.entries,
      stats: r.stats || { total: 0, allowed: 0, denied: 0, error: 0, byTool: [] },
      total: Number(r.total) || r.entries.length,
      max: Number(r.max) || state.sandboxLog.max,
      keyword: state.sandboxLog.keyword,
      decision: state.sandboxLog.decision,
      kind: state.sandboxLog.kind,
      loaded: true,
    };
  }

  /* ---------- PRD FR-10 分层记忆与晋升 ---------- */
  // 四域与晋升方向。worker 的临时结论只能逐层往上走：worker → director → project → global。
  // global 是终点，没有再上一层的去处（跨项目长期记忆，写进去就是最终形态）。
  const MEM_DOMAIN_LABELS = { global: '全局', project: '项目', director: '总监', worker: '临时' };
  const MEM_DOMAIN_DESC = {
    global: '跨项目长期事实（写入即最终形态，无上层）',
    project: '当前项目沉淀（来自 director 晋升）',
    director: '总监域（Worker 结论经 Director 过滤后落此）',
    worker: 'SubAgent 临时结果（即用即走，出域须过 Director 过滤）',
  };
  /** 晋升的下一层。null = 已在顶层。 */
  const MEM_NEXT_DOMAIN = { worker: 'director', director: 'project', project: 'global', global: null };

  const MEM_REASON_LABELS = {
    'memory-service-unavailable': '记忆服务未加载',
    'bad-domain': '域名参数非法',
    'bad-id': '条目 id 非法',
    'entry-not-found': '条目不存在（可能已被晋升走）',
    'same-domain': '源域与目标域相同',
    'brain-filter-unavailable': 'Director 过滤器不可用（fail-closed，默认拒绝）',
    'director-filter-pending': 'Director 过滤回调未注入（fail-closed，默认拒绝）',
    'director-filter-timeout': 'Director 过滤超时（fail-closed，按拒绝处理）',
  };

  /** 把插件返回的英文 reason 翻成中文；未登记的按前缀归类后原样带出。 */
  function memReasonText(reason) {
    const r = String(reason || '');
    if (MEM_REASON_LABELS[r]) return MEM_REASON_LABELS[r];
    if (r.startsWith('director-rejected:')) return `Director 驳回（${r.slice('director-rejected:'.length)}）`;
    if (r.startsWith('promoted:')) return `已晋升 ${r.slice('promoted:'.length).replace('->', ' → ')}`;
    if (r.startsWith('error:')) return `执行异常：${r.slice('error:'.length)}`;
    return r;
  }

  /** 重拉当前域条目 + 四域统计。桥不可用时保持 loaded=false。 */
  function refreshMemoryDomain() {
    if (typeof bridge.listMemoryDomain !== 'function') {
      state.memory = { ...state.memory, items: [], stats: null, loaded: false };
      if (state.page === 'settings') render();
      return;
    }
    bridge.listMemoryDomain(state.memory.domain).then((r) => {
      state.memory.items = Array.isArray(r) ? r : [];
      // null = 服务不可用（主进程侧域名非法 / memory 插件未加载都会回 null）。
      // 必须和「接进了但域是空的」区分开：前者要报「未接入」，后者才说「暂无条目」。
      // 把 null 当空数组会让「记忆服务根本没起来」看起来像「还没跑过 SubAgent」。
      state.memory.loaded = Array.isArray(r);
      if (state.page === 'settings') render();
    }).catch(() => {
      state.memory.loaded = false;
      if (state.page === 'settings') render();
    });
    refreshMemoryPromotions();
  }

  /** 重拉当前摘要方式（LLM / 抽取式兜底）。桥不可用时保持 loaded=false。 */
  function refreshMemorySummarize() {
    if (typeof bridge.getMemorySummarizeStatus !== 'function') {
      state.memorySummarize = { ...state.memorySummarize, loaded: false };
      if (state.page === 'settings') render();
      return;
    }
    bridge.getMemorySummarizeStatus().then((r) => {
      if (!r || typeof r !== 'object') return;
      state.memorySummarize = {
        mode: r.mode === 'llm' ? 'llm' : 'extractive',
        provider: String(r.provider || ''),
        model: String(r.model || ''),
        seam: !!r.seam,
        loaded: true,
      };
      if (state.page === 'settings') render();
    }).catch(() => {
      state.memorySummarize = { ...state.memorySummarize, loaded: false };
      if (state.page === 'settings') render();
    });
  }

  function refreshMemoryPromotions() {
    if (typeof bridge.getMemoryPromotions !== 'function') return;
    bridge.getMemoryPromotions({ ok: state.memoryPromotions.ok, limit: 60 }).then((r) => {
      if (!r || typeof r !== 'object' || !Array.isArray(r.entries)) return;
      state.memoryPromotions = {
        entries: r.entries,
        stats: r.stats || { total: 0, promoted: 0, rejected: 0, byEdge: [] },
        total: Number(r.total) || r.entries.length,
        max: Number(r.max) || state.memoryPromotions.max,
        ok: state.memoryPromotions.ok,
        loaded: true,
      };
      if (state.page === 'settings') render();
    }).catch(() => {});
  }

  /* ---------- 连接器（PRD FR-3） ---------- */
  /** 重拉连接器目录 + 状态。桥不可用时保持 loaded=false，UI 显「未接入」。 */
  function refreshConnectors() {
    if (typeof bridge.getConnectors !== 'function') {
      state.connectors = { ...state.connectors, loaded: false };
      if (state.page === 'plugins') render();
      return;
    }
    bridge.getConnectors().then((r) => {
      if (!r || typeof r !== 'object' || !Array.isArray(r.items)) return;
      state.connectors = {
        items: r.items,
        stats: r.stats || { total: 0, configured: 0, tested: 0, ok: 0 },
        loaded: true,
        expanded: state.connectors.expanded,
      };
      if (state.page === 'plugins') render();
    }).catch(() => {
      state.connectors = { ...state.connectors, loaded: false };
      if (state.page === 'plugins') render();
    });
    refreshConnectorAudit();
  }

  /* ---------- 本地已安装技能 ---------- */
  /**
   * 重拉本地技能清单（主进程真实扫描 数据目录/skills/*.skill）。
   * 此前 installedSkills 只在安装时往内存数组里 push，重启即清零 —— 磁盘上有包
   * 却显示 0 个。合并时保留内存中的启用/停用开关（该开关暂未持久化，默认启用）。
   * ok=false（扫描失败）与 ok=true + 空数组（真没装）分开存，UI 分别标注。
   */
  function refreshInstalledSkills() {
    if (typeof bridge.listInstalledSkills !== 'function') {
      state.installedSkillsLoaded = false;
      return Promise.resolve();
    }
    return bridge.listInstalledSkills().then((r) => {
      if (!r || typeof r !== 'object') return;
      state.installedSkillsLoaded = r.ok === true;
      if (r.ok !== true || !Array.isArray(r.items)) return;
      state.installedSkills = r.items.map((it) => {
        const prev = state.installedSkills.find((x) => x.slug === it.slug);
        return {
          slug: String(it.slug),
          bytes: Number(it.bytes) || 0,
          installedAt: Number(it.installedAt) || 0,
          // 启用状态仅本次运行有效：未见过的按启用计，见过的沿用用户选择。
          enabled: prev ? prev.enabled !== false : true,
        };
      });
    }).catch(() => { state.installedSkillsLoaded = false; });
  }

  function refreshConnectorAudit() {
    if (typeof bridge.getConnectorAudit !== 'function') return;
    bridge.getConnectorAudit({ limit: 30 }).then((r) => {
      if (!r || typeof r !== 'object' || !Array.isArray(r.entries)) return;
      state.connAudit = {
        entries: r.entries,
        stats: r.stats || { total: 0, saves: 0, clears: 0, tests: 0, fails: 0 },
        total: Number(r.total) || r.entries.length,
        max: Number(r.max) || state.connAudit.max,
        loaded: true,
      };
      if (state.page === 'plugins') render();
    }).catch(() => {});
  }

  /* ---------- MCP（真接入） ---------- */
  /** 重拉 MCP 列表 + 连接状态。桥不可用保持 loaded=false，UI 显「未接入」。 */
  function refreshMcp() {
    if (typeof bridge.mcpList !== 'function') {
      state.mcp.loaded = false;
      return Promise.resolve();
    }
    return bridge.mcpList().then((r) => {
      if (!r || typeof r !== 'object') return;
      state.mcp = {
        servers: Array.isArray(r.servers) ? r.servers : [],
        stats: r.stats || { total: 0, configured: 0, connected: 0, tools: 0 },
        loaded: r.ok === true,
      };
      if (state.page === 'plugins') render();
    }).catch(() => { state.mcp.loaded = false; });
  }

  /** 连接器状态徽标。manual（无自动探测）与 http 的「未验证」语义不同，不能共用一个词。 */
  function connBadge(c) {
    const st = c.state || {};
    if (!st.configured) return '<span class="ib badge">未配置</span>';
    if (c.manual) return st.lastTestOk === true ? '<span class="ib badge ok">已验证</span>' : '<span class="ib badge warn">已保存 · 不可自动验证</span>';
    if (st.lastTestOk === true) return '<span class="ib badge ok">已连接</span>';
    if (st.lastTestOk === false) return '<span class="ib badge warn">连通失败</span>';
    return '<span class="ib badge warn">已配置 · 未验证</span>';
  }

  /* ---------- 本地插件市场（PRD FR-3） ---------- */
  function refreshMarket() {
    if (typeof bridge.getMarketPlugins !== 'function') {
      state.market = { ...state.market, loaded: false };
      if (state.page === 'plugins') render();
      return;
    }
    bridge.getMarketPlugins().then((r) => {
      if (!r || typeof r !== 'object' || !Array.isArray(r.items)) return;
      state.market = { items: r.items, dir: String(r.dir || ''), count: Number(r.count) || 0, loaded: true, busy: state.market.busy };
      if (state.page === 'plugins') render();
    }).catch(() => {
      state.market = { ...state.market, loaded: false };
      if (state.page === 'plugins') render();
    });
  }

  /** 市场插件状态徽标：装载完成 ≠ 激活（依赖未满足时必须可区分）。 */
  function marketBadge(m) {
    if (!m.manifestOk) return '<span class="ib badge warn">manifest 非法</span>';
    if (!m.hasEntry) return '<span class="ib badge warn">缺 index.js</span>';
    if (m.active) return '<span class="ib badge ok">已启用</span>';
    if (m.enabled) return '<span class="ib badge warn">已启用 · 未激活</span>';
    return '<span class="ib badge">未启用</span>';
  }

  /* ---------- FR-5 用量追踪 ---------- */
  function refreshUsage() {
    if (typeof bridge.getUsage !== 'function') {
      state.usage = { ...state.usage, loaded: false };
      if (state.page === 'settings') render();
      return;
    }
    bridge.getUsage().then((r) => {
      if (!r || typeof r !== 'object') return;
      // 桥在但 IPC 出错 ≠ 未接入——错误态必须显式标注（审阅裁决：把异常显示成「未接入」同样违反「状态不许撒谎」）
      if (r.ok === false) {
        state.usage = { ...state.usage, loaded: false, error: String(r.reason || '读取失败') };
        if (state.page === 'settings') render();
        return;
      }
      if (!r.total) return;
      state.usage = { loaded: true, error: null, total: r.total,
        byModel: Array.isArray(r.byModel) ? r.byModel : [],
        bySession: Array.isArray(r.bySession) ? r.bySession : [] };
      if (state.page === 'settings') render();
    }).catch((err) => {
      state.usage = { ...state.usage, loaded: false, error: (err && err.message) ? String(err.message) : '桥接调用异常' };
      if (state.page === 'settings') render();
    });
  }

  /** token 数量的人类可读形态（12.3k / 4.56M）。 */
  function fmtTokens(n) {
    const v = Number(n) || 0;
    if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M';
    if (v >= 1e3) return (v / 1e3).toFixed(1) + 'k';
    return String(v);
  }

  /** FR-5 用量卡片：真实记账（只统计网关上报过 usage 的回合）。「未接入」≠「0」≠「读取失败」。 */
  function renderUsageCard() {
    const u = state.usage;
    if (!u.loaded) {
      if (u.error) {
        return `<div style="margin-top:10px;padding:8px 12px;background:var(--bg-inset);border-radius:8px">
          <div class="row" style="justify-content:space-between"><b style="font-size:12px">用量追踪（FR-5）</b><span class="badge warn">读取失败</span></div>
          <div class="faint" style="font-size:11.5px;margin-top:4px">主进程用量读取失败：${esc(u.error)}（重新打开设置页可重试）。</div>
        </div>`;
      }
      return `<div style="margin-top:10px;padding:8px 12px;background:var(--bg-inset);border-radius:8px">
        <div class="row" style="justify-content:space-between"><b style="font-size:12px">用量追踪（FR-5）</b><span class="badge">未接入</span></div>
        <div class="faint" style="font-size:11.5px;margin-top:4px">主进程未接入用量桥接，无法显示真实记账。</div>
      </div>`;
    }
    const rows = (u.byModel || []).map((m) => `<tr>
      <td class="mono" style="font-size:11.5px">${esc(m.model)}</td>
      <td style="text-align:right" class="mono">${fmtTokens(m.promptTokens)}</td>
      <td style="text-align:right" class="mono">${fmtTokens(m.completionTokens)}</td>
      <td style="text-align:right" class="mono"><b>${fmtTokens(m.totalTokens)}</b></td>
      <td style="text-align:right" class="faint">${m.turns} 回合</td>
    </tr>`).join('');
    return `<div style="margin-top:10px;padding:8px 12px;background:var(--bg-inset);border-radius:8px">
      <div class="row" style="justify-content:space-between;margin-bottom:6px">
        <b style="font-size:12px">用量追踪（FR-5）</b>
        <span class="row" style="gap:8px">
          <span class="faint" style="font-size:11px">合计 ↑${fmtTokens(u.total.promptTokens)} · ↓${fmtTokens(u.total.completionTokens)} · 总 ${fmtTokens(u.total.totalTokens)} · ${u.total.turns} 回合</span>
          <button class="btn sm ghost" data-action="usage-refresh">刷新</button>
          <button class="btn sm ghost" data-action="usage-clear">清空</button>
        </span>
      </div>
      ${(u.total.turns ? `<table style="width:100%">
        <tr><th style="text-align:left">模型</th><th style="text-align:right">输入 tokens</th><th style="text-align:right">输出 tokens</th><th style="text-align:right">合计</th><th style="text-align:right">回合</th></tr>
        ${rows}
      </table>` : '<div class="faint" style="font-size:11.5px">尚无用量记录 —— 网关未上报 usage 的回合不记账（「没上报」≠「0 token」）。</div>')}
    </div>`;
  }

  /* ---------- FR-6 事件流回放数据源（ADR-0009） ---------- */
  function refreshSessionEvents(sid) {
    if (typeof bridge.getSessionEvents !== 'function') {
      state.sessionEvents = { sid: sid, data: null, loaded: false };
      render();
      return;
    }
    bridge.getSessionEvents(sid).then((r) => {
      // 异步竞态防线：回来时用户可能已切到另一个会话的回放
      if (state.replayFor !== sid) return;
      state.sessionEvents = { sid: sid, data: (r && typeof r === 'object') ? r : null, loaded: true };
      render();
    }).catch(() => {
      if (state.replayFor !== sid) return;
      state.sessionEvents = { sid: sid, data: null, loaded: false };
      render();
    });
  }

  /* ---------- PRD FR-4.2 数据目录内容清单 ---------- */
  /**
   * 重拉数据目录清单。清单只在启动时取一次，导入数据 / 导出快照之后体积会变，
   * 所以给用户一个手动刷新入口 —— 否则 UI 上的数字会一直停在启动那一刻。
   */
  function refreshDataDirInventory() {
    if (typeof bridge.getDataDirInventory !== 'function') {
      state.dataDirInventory = { ok: false, dir: '', items: [], totalSize: 0, totalFiles: 0, totalSizeText: '', errors: [] };
      if (state.page === 'settings') render();
      return;
    }
    bridge.getDataDirInventory().then((r) => {
      state.dataDirInventory = (r && typeof r === 'object')
        ? r
        : { ok: false, dir: '', items: [], totalSize: 0, totalFiles: 0, totalSizeText: '', errors: [] };
      if (state.page === 'settings') render();
    }).catch(() => {});
  }

  /** 重拉日志并只重绘设置区（不整体 render，避免打断输入框光标）。 */
  function refreshSandboxLog() {
    if (typeof bridge.getSandboxLog !== 'function') return;
    bridge.getSandboxLog(sandboxLogQuery()).then((r) => {
      applySandboxLog(r);
      if (state.page === 'settings') render();
    }).catch(() => {});
  }

  function pushFloatingContext() {
    const d = state.desktop;
    if (!d || !d.config || !d.config.floating) return;
    if (typeof bridge.setFloatingContext !== 'function') return;
    const cur = state.sessions[state.sel];
    const sessions = Object.values(state.sessions).filter((s) => s && s.msgs && s.msgs.length).length;
    bridge.setFloatingContext({ title: (cur && cur.title) || '', sessions }).catch(() => {});
  }

  /**
   * 单个桌面集成开关。state.desktop 为 null（桥未接入 / 浏览器预览）时降级为
   * 不可点 + 标注「未接入」，避免又出现「UI 可点但不生效」的死挂点。
   */
  function desktopItem(key, name, desc, mono) {
    const d = state.desktop;
    const on = !!(d && d.config && d.config[key]);
    const disabled = !d;
    return `<div class="desktop-item"${disabled ? ' title="主进程未接入，当前为浏览器预览"' : ''}>
      <div><div class="di-name">${esc(name)}</div><div class="di-desc${mono ? ' mono' : ''}" data-desktop-desc="${esc(key)}">${esc(desc)}</div></div>
      <div class="switch ${on ? 'on' : ''}${disabled ? ' disabled' : ''}" data-action="desktop-toggle" data-dk="${esc(key)}" role="switch" aria-checked="${on}" aria-label="${esc(name)}"></div>
    </div>`;
  }
  function renderMsg(m, sid) {
    const isU = (m.r || m.role) === 'user';
    const intentBadge = m.intent && m.intent !== 'ACT'
      ? (m.intent === 'CONFIRM' ? `<span class="badge warn">意图 · 待确认</span>` : `<span class="badge danger">意图 · 已拦截</span>`)
      : '';
    const tools = (m.tools && m.tools.length) ? `<details class="tools"><summary>${ic('chev', 14)} ${m.steps} 步 · ${m.tools.length} 个动作</summary>${m.tools.map((t) => toolRow(t)).join('')}</details>` : '';
    const sub = m.sub ? `<div class="subagent"><span class="badge ${m.sub.state === 'running' ? 'warn' : 'info'}">SubAgent</span><span class="mono">${esc(m.sub.name)}</span><span class="phases faint">${m.sub.state === 'running' ? '执行中 · 即用即走' : '已回收并销毁'}</span></div>` : '';
    // FR-5：单回合 token 徽标（网关没上报 usage 的回合没有该字段，不显示假 0）
    const tok = (m.tok && Number.isFinite(m.tok.p) && Number.isFinite(m.tok.c))
      ? `<span class="faint mono" style="font-size:10.5px;margin-left:6px">↑${fmtTokens(m.tok.p)} ↓${fmtTokens(m.tok.c)}</span>` : '';
    const fb = (m.feedback && state.feedback.has(sid + '|' + m.t)) ? `<div class="feedback" style="color:var(--ok)">已记录反馈 · 已脱敏遥测</div>`
      : (m.feedback ? `<div class="feedback"><span>这条回答对你有帮助吗？</span><button data-action="trace" data-fb="positive" data-t="${m.t}">有帮助</button><button data-action="trace" data-fb="negative" data-t="${m.t}">需改进</button><span class="faint">反馈将用于改善回复质量</span></div>` : '');
    const raw = m.x || m.text || '';
    let txt;
    if (m.typing) {
      // BUG（全盘死挂点扫描）：typing 期间实时读 state.toolSteps[sid]（onToolStep 订阅
      // 写入、此前零读取）。主进程每步推送都会触发 render()，用户能看到工具正在跑，
      // 而非永远只显示「思考中…」直到整回合结束。
      const liveSteps = (sid && Array.isArray(state.toolSteps[sid]) && state.toolSteps[sid].length)
        ? state.toolSteps[sid]
        : null;
      if (!liveSteps) {
        txt = '<span class="faint">思考中…</span>';
      } else {
        // 本轮 UI 重构：思考链默认折叠（只显示最近一步，不让工具流刷屏），
        // 右侧箭头可展开/收起完整明细。key 用 sid|t 唯一定位这条 typing 消息。
        const key = `${sid}|${m.t}`;
        const open = state.thinkExpanded.has(key);
        txt = `<div class="think-head"><span class="faint">思考中 · 正在执行 ${liveSteps.length} 个工具…</span>`
          + `<button class="think-toggle${open ? ' open' : ''}" data-action="think-toggle" data-k="${esc(key)}"`
          + ` title="${open ? '收起' : '展开'}思考链详情" aria-expanded="${open}">${ic('chevDown', 13)}</button></div>`
          + (open
            ? `<div class="think-detail">${liveSteps.map((st) => toolRow(st, true)).join('')}</div>`
            : toolRow(liveSteps[liveSteps.length - 1], true));
      }
    } else if (isU) {
      txt = esc(raw);
    } else {
      // Agent 回复：检测是否整条是纯代码块 → 否则 Markdown 渲染
      const trimmed = raw.trim();
      const fullCode = trimmed.match(/^```(\w*)\n([\s\S]*)\n```$/);
      if (fullCode) {
        txt = `<pre><code>${esc(fullCode[2].trim())}</code></pre>`;
      } else {
        txt = renderMD(raw);
      }
    }
    return `<div class="msg ${isU ? 'user' : 'agent'}${m.typing ? ' typing' : ''}">
      <div class="avatar">${isU ? '我' : 'AI'}</div>
      <div class="body"><div class="meta"><b>${isU ? '你' : 'OrchDesk'}</b><span>${m.t}</span>${intentBadge}${tok}</div>
      <div class="md-body">${txt}</div>${sub}${tools}${fb}</div></div>`;
  }

  /* ---------- 需求1：语义化的大任务步骤（待办数据源） ---------- */
  // 旧实现把 m.tools 的工具名（file_read / shell_command…）直接当待办条目，于是侧栏
  // 里清一色是命令执行。真正有用的待办是 Agent 对「用户这个请求」做的任务分拆
  // （调研可行性 / 多子代理审阅 / 头脑风暴 / UI 重构 / 提交推送 …）。
  // 用户裁决「两者结合」，故两级来源：
  //   ① 结构化 plan 块：```orch-plan / ```plan 围栏 或 <plan>…</plan>，支持 - [x] 完成标记
  //   ② 回退：Agent 正文里的 markdown 列表（checkbox 任务清单优先，其次「计划/步骤」小节下的列表）
  // 工具调用不再是待办，降为折叠的「执行明细」——那是手段，不是任务本身。
  function parseStepLine(line) {
    let s = (line || '').trim();
    if (!s) return null;
    let done = false;
    let m = s.match(/^[-*+]\s*\[([ xX])\]\s*(.+)$/);
    if (!m) m = s.match(/^\d+[.)]\s*\[([ xX])\]\s*(.+)$/);
    if (m) { done = m[1].toLowerCase() === 'x'; s = m[2].trim(); }
    else {
      const p = s.match(/^(?:[-*+]\s+|\d+[.)]\s+)(.+)$/);
      if (!p) return null;   // 不是列表行 → 不是步骤
      s = p[1].trim();
    }
    // 行内状态标记（模型常用 emoji 而不是 checkbox）
    if (/^(?:✅|☑|✔)/.test(s) || /（已完成）|\(done\)/i.test(s)) done = true;
    s = s.replace(/^(?:✅|☑|✔|⏳|🔄|▶)\s*/, '').trim();
    if (!s || s.length > 120) return null;   // 过长的是正文而非步骤标题
    return { text: s, done };
  }

  function extractPlanSteps(msgs) {
    const isAgent = (m) => { const r = m.r || m.role; return r === 'agent' || r === 'assistant'; };
    const steps = [];
    // ① 结构化 plan 块
    (msgs || []).forEach((m) => {
      if (!isAgent(m)) return;
      const raw = m.x || m.text || '';
      const blocks = [];
      const fenceRe = /```(?:orch-plan|plan)\s*\n([\s\S]*?)```/gi;
      const tagRe = /<plan>([\s\S]*?)<\/plan>/gi;
      let mt;
      while ((mt = fenceRe.exec(raw))) blocks.push(mt[1]);
      while ((mt = tagRe.exec(raw))) blocks.push(mt[1]);
      blocks.forEach((b) => b.split(/\r?\n/).forEach((ln) => {
        const st = parseStepLine(ln);
        if (st) steps.push(st);
      }));
    });
    if (steps.length) return { steps, source: 'plan' };

    // ② 回退：正文 markdown 列表（先剔除代码块，避免把代码注释/数组当步骤）
    (msgs || []).forEach((m) => {
      if (!isAgent(m)) return;
      const raw = m.x || m.text || '';
      const lines = raw.split(/```/).filter((_, i) => i % 2 === 0).join('\n').split(/\r?\n/);
      let inPlanSection = false;
      lines.forEach((ln) => {
        if (/^\s{0,3}#{1,6}\s+/.test(ln) || /^[^`]{0,40}[：:]\s*$/.test(ln)) {
          inPlanSection = /(计划|步骤|安排|任务|方案|路线|待办|plan|step|todo|checklist)/i.test(ln);
          return;
        }
        const isCheckbox = /^\s*[-*+]\s*\[[ xX]\]/.test(ln);
        const st = parseStepLine(ln);
        if (st && (isCheckbox || inPlanSection)) steps.push(st);
      });
    });
    return { steps, source: steps.length ? 'list' : 'none' };
  }

  /* ---------- 渲染：侧栏（ZCode 风格：分组/项目切换 + 文件夹图标） ---------- */
  function renderSideSession() {
    const active = state.projects.filter(p => !p.archived);
    const archived = state.projects.filter(p => p.archived);

    const renderProject = (p) => {
      const expanded = state.pExpanded.has(p.id);
      return `<div class="proj">
        <div class="proj-head" data-action="proj-toggle" data-id="${p.id}">
          <span class="pf ${expanded ? 'open' : ''}">${ic('chev', 12)}</span>
          ${p.path ? '<span class="pf-open" style="color:var(--fg-faint);font-size:12px" title="有本地文件夹">' + ic('folderOpen', 14) + '</span>' : '<span class="pf-open" style="color:var(--fg-faint);font-size:12px" title="无文件夹绑定">' + ic('folder', 14) + '</span>'}
          <span class="pn">${esc(p.n)}</span>
          <span class="pm" style="display:flex;gap:1px;align-items:center">
            <button class="opbtn" data-action="proj-menu" data-id="${p.id}" title="项目操作">···</button>
          </span>
        </div>
        ${expanded ? `<div class="proj-list">${p.sessions.map((sid) => {
          const s = state.sessions[sid]; if (!s) return '';
          return `<div class="sess ${state.sel === sid ? 'active' : ''}" data-action="sel" data-id="${sid}">
            <span class="sn" title="${esc(s.title)} ${esc(s.expert)}">${esc(s.title)}</span>
            ${s.updated !== '刚刚' ? `<span class="st">${esc(s.updated)}</span>` : ''}
            <button class="opbtn" data-action="sess-menu" data-id="${sid}" title="会话操作">···</button>
          </div>`;
        }).join('')}</div>` : ''}
      </div>`;
    };

    const activeBlocks = active.map(renderProject).join('');

    // 归档 - 折叠
    const archBlocks = archived.map(renderProject).join('');
    const archExpanded = state.pExpanded.has('__archived__');
    const archToggle = archBlocks ? `<div class="proj-head" data-action="proj-toggle" data-id="__archived__" style="opacity:0.6">
      <span class="pf ${archExpanded ? 'open' : ''}">${ic('chev', 12)}</span>
      <span class="pn" style="color:var(--fg-dim);text-transform:none;font-weight:500;letter-spacing:0;font-size:12px">已归档</span>
    </div>${archExpanded ? `<div class="proj-list">${archBlocks}</div>` : ''}` : '';

    // 任务模式会话（不属于任何项目的独立会话）
    const allProjectIds = new Set(state.projects.map(p => p.id));
    const taskSessions = Object.values(state.sessions).filter(s => s.pid === '__task__' || !allProjectIds.has(s.pid));
    const taskExpanded = state.pExpanded.has('__task__');
    const taskBlock = taskSessions.length ? `<div class="proj">
      <div class="proj-head" data-action="proj-toggle" data-id="__task__">
        <span class="pf ${taskExpanded ? 'open' : ''}">${ic('chev', 12)}</span>
        <span class="pn" style="color:var(--fg-faint);text-transform:none;font-weight:500;letter-spacing:0;font-size:12px">${ic('zap', 14)} 任务</span>
        <span class="pc">${taskSessions.length}</span>
      </div>
      ${taskExpanded ? `<div class="proj-list">${taskSessions.map((s) => {
        return `<div class="sess ${state.sel === s.id ? 'active' : ''}" data-action="sel" data-id="${s.id}">
          <span class="sn" title="${esc(s.title)} ${esc(s.expert)}">${esc(s.title)}</span>
          ${s.updated !== '刚刚' ? `<span class="st">${esc(s.updated)}</span>` : ''}
          <button class="opbtn" data-action="sess-menu" data-id="${s.id}" title="会话操作">···</button>
        </div>`;
      }).join('')}</div>` : ''}
    </div>` : '';

    return `<div class="proj-seg">
      <span class="seg-label">项目 / 任务</span>
      <div class="seg-tabs">
        <span class="seg-tab active">项目</span>
      </div>
    </div>
    <div style="display:align-items:center;gap:4px;padding:4px 10px 8px">
      <span style="font-size:12px;font-weight:600;color:var(--fg)"></span>
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" style="color:var(--fg-faint);cursor:pointer;margin-left:auto" data-action="newconv" title="新建会话"><path d="M12 5v14M5 12h14"/></svg>
    </div>` + activeBlocks + taskBlock + archToggle + `<div class="fab-wrap"><button class="fab" data-action="newconv" title="新建会话">${ic('plus', 22)}</button></div>`;
  }

  function getGreeting() {
    const h = new Date().getHours();
    let g;
    if (h < 6) g = '夜深了，注意休息';
    else if (h < 9) g = '早上好';
    else if (h < 12) g = '上午好';
    else if (h < 14) g = '中午好';
    else if (h < 18) g = '下午好';
    else if (h < 20) g = '傍晚好';
    else if (h < 22) g = '晚上好';
    else g = '夜深了，注意休息';
    return g + '! 一起来做点什么呢？';
  }

  /* 智能推荐：基于最近 7 天对话主题信号 + 技能使用频率 + 空闲检测 */
  function getSmartRecommendations() {
    const sessions = Object.values(state.sessions || {});
    const now = Date.now();
    const week = 7 * 24 * 3600_000;

    if (!sessions.length) {
      // 首次使用 → 新手引导
      return [
        { label: '创建项目', icon: 'folder', action: 'home-create-proj' },
        { label: '闲时任务', icon: 'clock', action: 'quick-idle' },
        { label: '浏览技能', icon: 'grid', action: 'quick-skills' },
        { label: '项目分析', icon: 'search', action: 'quick-analyze' },
      ];
    }

    // 最近 7 天用户消息主题信号
    const recent = sessions
      .filter(s => s.ts > now - week)
      .flatMap(s => (s.msgs || []).filter(m => m.role === 'user').map(m => (m.text || '')));

    const match = (re) => recent.some(m => re.test(m));

    let ordered = [];
    if (match(/报错|bug|修复|debug|error|exception/i))              ordered.push('报错修复');
    if (match(/文档|报告|周报|总结|markdown|readme/i))               ordered.push('文档报告');
    if (match(/重构|refactor|优化|升级|架构/i))                       ordered.push('项目重构');
    if (match(/数据|分析|统计|报表|dashboard/i))                       ordered.push('数据分析');
    if (match(/PPT|幻灯片|演示|presentation|slides/i))               ordered.push('PPT 制作');

    // 高频技能替换
    const skillFreq = {};
    sessions.forEach(s => (s.msgs || []).forEach(m => {
      (m.tools || []).forEach(t => { skillFreq[t.n] = (skillFreq[t.n] || 0) + 1; });
      if (m.sub) { const n = m.sub.name || 'agent'; skillFreq[n] = (skillFreq[n] || 0) + 1; }
    }));
    const topSkill = Object.entries(skillFreq).sort((a, b) => b[1] - a[1])[0];
    if (topSkill && topSkill[1] >= 2 && ordered.length >= 3) {
      ordered[2] = topSkill[0];
    }

    // 空闲检测（7 天无新会话 → 加入闲时任务）
    const hasRecent = sessions.some(s => s.ts > now - week);
    if (!hasRecent && !ordered.includes('闲时任务')) ordered.push('闲时任务');

    // 兜底填充
    const pool = ['报错修复', '文档报告', 'PPT 制作', '闲时任务'];
    pool.forEach(k => { if (!ordered.includes(k)) ordered.push(k); });

    const iconMap = {
      '报错修复': 'wrench', '文档报告': 'fileText', '项目重构': 'code',
      '数据分析': 'barChart', 'PPT 制作': 'presentation', '闲时任务': 'clock',
      '创建项目': 'folder', '浏览技能': 'grid', '项目分析': 'search',
    };
    const actionMap = {
      '报错修复': 'quick-debug', '文档报告': 'quick-weekly', 'PPT 制作': 'quick-ppt',
      '项目重构': 'quick-refactor', '数据分析': 'quick-data', '闲时任务': 'quick-idle',
      '创建项目': 'home-create-proj', '浏览技能': 'quick-skills', '项目分析': 'quick-analyze',
    };

    return ordered.slice(0, 4).map(label => ({
      label,
      icon: iconMap[label] || 'zap',
      action: actionMap[label] || 'todo',
    }));
  }

  function thinkLabel(l) { return ({ off: '关闭', standard: '标准', deep: '深度', max: '最大' })[l] || '标准'; }
  function renderComposer(s) {
    const mpLabel = state.selectedModels.length > 1 ? state.selectedModels.length + ' 个模型' : (state.selectedModels[0] || '选择模型');
    const thinkIdx = ({ off: 0, standard: 1, deep: 2, max: 3 })[state.thinkLevel] || 1;
    // 当前选中项目
    const activeProjects = state.projects.filter(p => !p.archived);
    const curProj = state.selProjForComposer ? activeProjects.find(p => p.id === state.selProjForComposer) : null;
    const projName = curProj ? curProj.n : '选择项目（或进入任务模式）';
    const projSelector = `<div style="position:relative">
      <div class="proj-select ${state.projDropdownOpen ? 'open' : ''}" data-action="proj-select-toggle" title="选择项目">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>
        <span class="ps-name">${esc(projName)}</span>
        <svg class="ps-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>
      </div>
      <div class="proj-dropdown ${state.projDropdownOpen ? 'open' : ''}" id="projDropdown">
        <div class="pd-label">项目</div>
        ${activeProjects.length ? activeProjects.map(p => `<div class="pd-item ${curProj && curProj.id === p.id ? 'active' : ''}" data-action="composer-proj-pick" data-pid="${p.id}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>
          <div><div>${esc(p.n)}</div>${p.d ? `<div class="pd-meta">${esc(p.d)}</div>` : ''}</div>
          ${curProj && curProj.id === p.id ? '<span class="badge ok" style="margin-left:auto;font-size:10px">当前</span>' : ''}
        </div>`).join('') : '<div class="pd-item" style="color:var(--fg-faint);cursor:default">暂无项目</div>'}
        <div class="pd-sep"></div>
        <div class="pd-item ${!curProj ? 'active' : ''}" data-action="composer-proj-task" title="不关联项目，直接对话">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="3"/><path d="M9 12l2 2 4-4"/></svg>
          <div><div>任务模式</div><div class="pd-meta">不关联项目，直接对话</div></div>
        </div>
      </div>
    </div>`;
    return `<div class="composer"><div class="box">
      ${projSelector}
      <textarea id="composer" placeholder="向 ${s.expert} 发消息…（先经意图识别插件初筛）"></textarea>
      <div id="outboundWarn" class="outbound-warn" hidden></div>
      <div class="bar">
        <div class="composer-more">
          <button class="t-btn" data-action="composer-more-toggle" data-tip="更多选项">${ic('more')}</button>
          <div class="composer-more-dropdown ${state.composerMoreOpen ? 'open' : ''}" id="composerMore">
            <div class="composer-more-item" data-action="skill-add">
              <span class="cm-icon">${ic('plus', 16)}</span>
              <span class="cm-label">加载技能</span>
            </div>
            <div class="composer-more-item" data-action="expert-add">
              <span class="cm-icon">${ic('at', 16)}</span>
              <span class="cm-label">引用专家或专家团</span>
            </div>
            <div class="composer-more-item" data-action="auth-open">
              <span class="cm-icon">${ic('shield', 16)}</span>
              <span class="cm-label">授权模式</span>
              <span class="cm-val">${authModeLabel(state.authMode)}</span>
            </div>
            <div class="composer-more-sep"></div>
            <div class="composer-more-item think-item">
              <div class="think-row"><span class="cm-label">思维深度</span><span class="tl">${thinkLabel(state.thinkLevel)}</span></div>
              <input type="range" min="0" max="3" step="1" value="${thinkIdx}" data-action="think-slider">
            </div>
            <div class="composer-more-item" style="cursor:default">
              <span class="cm-icon"><span class="dot" style="background:var(--ok);width:7px;height:7px;border-radius:50%"></span></span>
              <span class="cm-label">意图识别</span>
              <span class="cm-val">本地模型</span>
            </div>
          </div>
        </div>
        <div class="right">
          <button class="c-mp ${state.selectedModels.length > 1 ? 'multi' : ''}" data-action="model-pick"><span class="md"></span><span class="mn">${mpLabel}</span>${ic('chev', 12)}</button>
          <button class="btn sm primary" data-action="send">发送</button>
        </div>
      </div>
    </div></div>`;
  }

  /* ---------- 渲染：会话主区（ZCode 风格：新对话/欢迎页 + 快捷入口） ---------- */
  function renderHomeScreen() {
    const activeProjects = state.projects.filter(p => !p.archived);
    const curProj = state.selProjForComposer && state.selProjForComposer !== '__task__' ? activeProjects.find(p => p.id === state.selProjForComposer) : null;
    const projLabel = curProj ? curProj.n : '选择项目（或进入任务模式）';
    
    // 项目选择下拉
    const projSelector = `<div style="position:relative">
      <div class="proj-select ${state.projDropdownOpen ? 'open' : ''}" data-action="proj-select-toggle" title="选择项目">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>
        <span class="ps-name">${esc(projLabel)}</span>
        <svg class="ps-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>
      </div>
      <div class="proj-dropdown ${state.projDropdownOpen ? 'open' : ''}" id="projDropdown">
        <div class="pd-label">项目</div>
        ${activeProjects.length ? activeProjects.map(p => `<div class="pd-item ${curProj && curProj.id === p.id ? 'active' : ''}" data-action="composer-proj-pick" data-pid="${p.id}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>
          <div><div>${esc(p.n)}</div>${p.d ? `<div class="pd-meta">${esc(p.d)}</div>` : ''}</div>
          ${curProj && curProj.id === p.id ? '<span class="badge ok" style="margin-left:auto;font-size:10px">当前</span>' : ''}
        </div>`).join('') : '<div class="pd-item" style="color:var(--fg-faint);cursor:default">暂无项目</div>'}
        <div class="pd-sep"></div>
        <div class="pd-item" data-action="home-create-proj" title="创建新项目">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>
          <div><div>创建项目</div><div class="pd-meta">新建项目并绑定本地文件夹</div></div>
        </div>
        <div class="pd-item ${!curProj ? 'active' : ''}" data-action="composer-proj-task" title="不关联项目，直接对话">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="3"/><path d="M9 12l2 2 4-4"/></svg>
          <div><div>任务模式</div><div class="pd-meta">不关联项目，直接对话</div></div>
        </div>
      </div>
    </div>`;

    // 智能推荐快捷操作（基于对话历史主题 + 技能使用频率 + 空闲检测）
    const recs = getSmartRecommendations();
    const recHtml = recs.map(q =>
      `<button class="quick-action-btn" data-action="${q.action}" title="${q.label}">
        <span class="qa-icon">${ic(q.icon, 16)}</span><span>${q.label}</span>
      </button>`
    ).join('');

    return `<div class="home-screen">
      <div class="home-greeting">${esc(getGreeting())}</div>
      <div class="home-input-wrap">
        <div class="composer"><div class="box">
          ${projSelector}
          <textarea id="homeComposer" placeholder="向 OrchDesk 提问…" rows="1"></textarea>
          <div id="outboundWarn" class="outbound-warn" hidden></div>
          <div class="bar">
            <div class="composer-more">
              <button class="t-btn" data-action="composer-more-toggle" data-tip="更多选项">${ic('more')}</button>
              <div class="composer-more-dropdown ${state.composerMoreOpen ? 'open' : ''}" id="composerMore">
                <div class="composer-more-item" data-action="skill-add">
                  <span class="cm-icon">${ic('plus', 16)}</span>
                  <span class="cm-label">加载技能</span>
                </div>
                <div class="composer-more-item" data-action="expert-add">
                  <span class="cm-icon">${ic('at', 16)}</span>
                  <span class="cm-label">引用专家或专家团</span>
                </div>
                <div class="composer-more-item think-item">
                  <div class="think-row"><span class="cm-label">思维深度</span><span class="tl">${thinkLabel(state.thinkLevel)}</span></div>
                  <input type="range" min="0" max="3" step="1" value="${({off:0,standard:1,deep:2,max:3}[state.thinkLevel]||1)}" data-action="think-slider">
                </div>
              </div>
            </div>
            <div class="right">
              <button class="c-mp ${state.selectedModels.length > 1 ? 'multi' : ''}" data-action="model-pick"><span class="md"></span><span class="mn">${state.selectedModels.length > 1 ? state.selectedModels.length + ' 个模型' : (state.selectedModels[0] || '选择模型')}</span>${ic('chev', 12)}</button>
              <button class="btn sm primary" data-action="home-send">发送</button>
            </div>
          </div>
        </div></div>
        <div class="home-quick-actions">
          ${recHtml}
        </div>
      </div>
    </div>`;
  }

  /* ---------- FR-6 分叉点节点标记 ---------- */
  function renderForkNode(fork, atTail) {
    const when = new Date(fork.at).toLocaleString('zh-CN');
    return `<div class="fork-node">
      <span class="fn-line"></span>
      <span class="fn-badge">${ic('fork', 13)} 分叉点</span>
      <span class="fn-meta">继承自「${esc(fork.fromTitle || fork.from)}」第 ${fork.atIndex} 条消息之后 · ${esc(when)}${atTail ? ' · 其后为本分支独立写入' : ''}</span>
    </div>`;
  }

  /* ---------- FR-6 回放视图（只读时间线） ----------
   * 数据源优先级（ADR-0009）：append-only 事件流 > 消息数组回退。
   * 两种来源必须显式标注 —— 「事件流重建」与「历史会话回退」是不同的保证等级，
   * 混用不分会让「模型可见必入日志」变成一句没人能验证的话。 */
  function replaySourceNote() {
    const ev = state.sessionEvents;
    if (ev.loaded && ev.data && ev.data.source === 'event-log') return 'append-only 事件流重建（ADR-0009）';
    if (ev.loaded && ev.data && ev.data.source === 'legacy') return '历史会话：事件流无记录或不完整，从消息数组重建';
    return '从消息数组重建（事件流未接入）';
  }
  function renderReplay(s) {
    const ev = state.sessionEvents;
    const events = (ev.loaded && ev.sid === s.id && ev.data && ev.data.source === 'event-log')
      ? (ev.data.timeline || [])
      : (FORK ? FORK.buildReplayTimeline(s) : []);
    const badgeOf = (kind) => ({
      'fork-origin': 'info', user: 'info', agent: 'ok', tool: 'warn', subagent: 'info', feedback: 'ok',
    }[kind] || 'info');
    const labelOf = (kind) => (FORK.REPLAY_KIND_LABELS[kind] || kind);
    return `<div style="flex:1;overflow-y:auto" id="msgScroll">
      <div style="max-width:760px;margin:0 auto;padding:18px 16px 10px">
        <div class="row" style="justify-content:space-between;margin-bottom:10px">
          <div class="row"><b style="font-size:16px">回放 · ${esc(s.title)}</b><span class="badge info">只读</span></div>
          <div class="row" style="gap:8px">
            <span class="faint">${events.length} 个事件</span>
            <button class="btn sm" data-action="replay-close" data-sid="${esc(s.id)}">返回会话</button>
          </div>
        </div>
        <div class="faint" style="margin-bottom:10px">回放自 ${esc(replaySourceNote())}，仅用于追溯，<b>不可编辑、不可继续对话</b>。</div>
        ${events.length ? `<div class="replay">${events.map((ev) => `<div class="rp-item rp-${esc(ev.kind)}">
          <span class="rp-dot"></span>
          <div class="rp-main">
            <div class="row rp-head">
              <span class="rp-seq mono">#${ev.seq}</span>
              <span class="badge ${badgeOf(ev.kind)}">${esc(labelOf(ev.kind))}</span>
              <span class="rp-label">${esc(ev.label)}</span>
              ${ev.status === 'running' ? '<span class="badge warn">进行中</span>' : ''}
              <span class="faint rp-ts">${esc(ev.ts)}</span>
            </div>
            <div class="rp-detail">${ev.detail ? esc(ev.detail) : '<span class="faint">（无摘要）</span>'}</div>
          </div>
        </div>`).join('')}</div>` : '<div class="ctx-empty">该会话还没有可回放的事件</div>'}
      </div></div>`;
  }

  const VIEWS = {};
  VIEWS.session = {
    side() { return renderSideSession(); },
    main() {
      // 新对话模式 → 主页（优先级最高）
      if (state.newConvMode) {
        state.newConvMode = false;
        return renderHomeScreen();
      }
      // 无选中会话 → 主页
      if (!state.sel || !state.sessions[state.sel]) {
        return renderHomeScreen();
      }
      const s = state.sessions[state.sel];
      // 回放视图（FR-6 只读）：优先于普通消息流，且不挂 composer。
      if (state.replayFor === s.id) return renderReplay(s);

      // 血缘提示 + 消息流中的分叉点节点标记（FR-6）
      const fork = FORK ? FORK.normalizeFork(s.fork) : null;
      const msgs = s.msgs || [];
      const atTail = !!fork && fork.atIndex >= msgs.length;
      const msgHtml = msgs
        .map((m, i) => (fork && i === fork.atIndex ? renderForkNode(fork, atTail) : '') + renderMsg(m, s.id))
        .join('') + (atTail ? renderForkNode(fork, true) : '');

      return `<div style="flex:1;overflow-y:auto" id="msgScroll">
        <div style="max-width:760px;margin:0 auto;padding:18px 16px 10px">
          <div class="row" style="justify-content:space-between;margin-bottom:4px">
            <div class="row"><b style="font-size:16px">${esc(s.title)}</b>
              <span class="badge info">${esc(s.expert)}</span></div>
            <div class="row" style="gap:4px">
              ${FORK ? `<button class="btn sm ghost" data-action="fork" data-sid="${esc(s.id)}" title="从此会话创建分支（可选分叉点）">${ic('fork', 13)} 分叉</button>` : ''}
              ${FORK ? `<button class="btn sm ghost" data-action="replay-open" data-sid="${esc(s.id)}" title="只读回放本会话">${ic('clock', 13)} 回放</button>` : ''}
              <button class="iconbtn" data-action="toggle-ctx" title="切换右侧面板" style="transform:rotate(${state.ctxOpen ? 0 : 180}deg);transition:.15s">${ic('chev', 14)}</button></div>
          </div>
          ${fork ? `<div class="fork-origin">${ic('fork', 13)} 分支自 <span class="mono">#${esc(fork.from)}</span>${fork.fromTitle ? `「${esc(fork.fromTitle)}」` : ''} · 继承前 ${fork.atIndex} 条 · ${esc(new Date(fork.at).toLocaleString('zh-CN'))}</div>` : ''}
          <div id="confirmZone"></div>
          ${msgHtml}
        </div></div>
      ${renderComposer(s)}`;
    },
    ctx() {
      const s = state.sel && state.sessions[state.sel] ? state.sessions[state.sel] : null;
      const tabId = state.ctxTab || 'todo';
      const tabs = [
        { id: 'todo', label: '待办', badge: '' },
        { id: 'products', label: '产物', badge: '' },
        // 需求3：文件从标题栏按钮 + 全屏面板，改为右栏 TAB。
        // 与「产物」不同源：产物是本会话 Agent 生成的内容，文件是工作目录的全部文件。
        { id: 'files', label: '文件', badge: '' },
        // 「能力」= 插件 + 技能 + MCP（原「技能与MCP」名不副实：里面列的是插件）
        { id: 'caps', label: '能力', badge: '' },
      ];
      const tabsHTML = tabs.map(t => `<button class="ctx-tab ${tabId === t.id ? 'active' : ''}" data-action="ctx-tab" data-id="${t.id}">${t.label}</button>`).join('');

      if (!s) {
        return `<div class="ctx-header">
            <div class="ctx-title">${ic('clipboard', 16)} 任务监控</div>
            <div class="ctx-subtitle">DSH 插件 · 已启用</div>
          </div>
          <div class="ctx-tabs">${tabsHTML}</div>
          <div class="ctx-body">
            <div class="ctx-empty"><div class="empty-icon">${ic('clipboard', 28)}</div>选择会话后查看任务跟踪<br><span style="font-size:10px">发送消息后 Agent 步骤、产物、技能将在此显示</span></div>
          </div>
          <div id="previewRoot"></div>`;
      }

      const msgs = s.msgs || [];
      // ---- 需求1：语义化的大任务步骤 ----
      // 主列表来自 Agent 对请求的任务分拆（结构化 plan 块 → markdown 列表回退），
      // 工具调用降为下面的「执行明细」——file_read / shell_command 是手段不是任务。
      const plan = extractPlanSteps(msgs);
      const steps = plan.steps.map((p) => ({ text: p.text, status: p.done ? 'done' : 'pending', time: '' }));
      // 完成度只用显式标记（[x] / ✅）判定，不拿工具数去猜进度；
      // 唯一例外：Agent 正在跑（typing 中）时把第一条未完成的标为进行中。
      const runningNow = msgs.some((m) => m.typing);
      if (runningNow) {
        const first = steps.find((st) => st.status !== 'done');
        if (first) first.status = 'running';
      }
      const doneSteps = steps.filter(st => st.status === 'done').length;
      const runningSteps = steps.filter(st => st.status === 'running').length;
      // ---- 执行明细（工具调用 / SubAgent）：折叠在待办下方，不占主列表 ----
      const toolActions = [];
      msgs.forEach((m) => {
        if (m.tools && m.tools.length) {
          m.tools.forEach((t) => {
            toolActions.push({ text: t.n, status: t.ph === 'done' ? 'done' : t.ph === 'running' ? 'running' : 'pending', time: m.t || '' });
          });
        }
        if (m.sub) {
          toolActions.push({ text: 'SubAgent: ' + (m.sub.name || ''), status: m.sub.state === 'disposed' ? 'done' : 'running', time: m.t || '' });
        }
      });

      // ---- 提取产物 ----
      const products = [];
      const codeBlockRe = /```(\w+)?\n([\s\S]*?)```/g;
      msgs.forEach((m, i) => {
        if ((m.r === 'agent' || m.role === 'assistant') && (m.x || m.text)) {
          const content = m.x || m.text || '';
          let match;
          while ((match = codeBlockRe.exec(content)) !== null) {
            const lang = match[1] || 'text';
            const code = match[2].trim();
            const extMap = { python:'py', javascript:'js', typescript:'ts', html:'html', css:'css', json:'json', markdown:'md', bash:'sh', shell:'sh', rust:'rs', go:'go' };
            const ext = extMap[lang.toLowerCase()] || lang;
            const type = ext === 'md' ? 'md' : ['py','js','ts','html','css','json','sh','rs','go'].includes(ext) ? 'code' : 'md';
            products.push({ id: 'p' + i + '_' + products.length, name: (lang || 'text') + '_output' + (ext !== 'text' ? '.' + ext : ''), lang, content: code, size: code.length, type });
          }
        }
      });

      // ---- 能力（插件 / 技能 / MCP）----
      // 旧代码从 Agent 消息里正则抓 {skill:xxx} 当「已用技能」，再 unshift 四个内置
      // 插件名当「插件」——两处都不是真数据源：
      //   · {skill:xxx} 是**提示词模板**的引用语法（prompt 插件消费），Agent 回复里
      //     根本不会原样出现，解析结果恒为空（死挂点）；
      //   · 内置插件名写死成常量数组，与运行时真实装载无关。
      // 改为：插件取 pluginRuntime 真实装载，技能取本地磁盘真实扫描。

      // 插件运行时真实装载（「插件」分组用）。
      const rt = state.pluginRuntime;
      const rtReady = !!(rt && rt.ready);
      const rtOf = (n) => (rt && Array.isArray(rt.plugins) ? rt.plugins.find((x) => x.name === n) : null);

      // ---- Tab 内容 ----
      let bodyHTML = '';
      if (tabId === 'todo') {
        const stepRow = (st, mini) => {
          const dot = st.status === 'done' ? ic('check', mini ? 11 : 12) : st.status === 'running' ? ic('refresh', mini ? 11 : 12) : ic('circle', mini ? 11 : 12);
          return '<div class="ctx-step' + (mini ? ' mini' : '') + '"><span class="step-dot ' + st.status + '">' + dot + '</span>'
            + '<span class="step-text">' + esc(st.text) + '</span>'
            + (mini ? '<span class="step-time">' + esc(st.time) + '</span>' : '') + '</div>';
        };
        if (steps.length === 0) {
          // 没有语义步骤时，至少把执行明细摆出来（旧版就是从这里取的），并说明待办的语义来源
          bodyHTML = toolActions.length
            ? '<div class="ctx-empty" style="padding-top:14px"><div class="empty-icon">' + ic('clipboard', 24) + '</div>'
              + '尚未识别到任务分拆<br><span style="font-size:10px">让 Agent 先输出计划清单（markdown 列表或 ```orch-plan 块）即可在此跟踪</span></div>'
              + '<div class="ctx-section"><div class="ctx-section-title">执行明细 · ' + toolActions.length + ' 个动作</div>' + toolActions.map((st) => stepRow(st, true)).join('') + '</div>'
            : '<div class="ctx-empty"><div class="empty-icon">' + ic('check', 28) + '</div>暂无任务步骤<br><span style="font-size:10px">发送消息后将跟踪 Agent 的任务分拆与操作</span></div>';
        } else {
          const srcLabel = plan.source === 'plan' ? '任务分拆' : '任务分拆（解析自回复列表）';
          bodyHTML = '<div class="ctx-section"><div class="ctx-section-title">' + srcLabel
            + ' · ' + doneSteps + '/' + steps.length + '</div>'
            + steps.map((st) => stepRow(st, false)).join('') + '</div>';
          if (toolActions.length) {
            bodyHTML += '<details class="ctx-fold"><summary>' + ic('chev', 12) + ' 执行明细 · ' + toolActions.length + ' 个动作</summary>'
              + toolActions.map((st) => stepRow(st, true)).join('') + '</details>';
          }
        }
      } else if (tabId === 'products') {
        if (products.length === 0) {
          bodyHTML = '<div class="ctx-empty"><div class="empty-icon">' + ic('fileText', 28) + '</div>暂无产物<br><span style="font-size:10px">Agent 生成代码时将在此显示</span></div>';
        } else {
          bodyHTML = '<div class="ctx-section"><div class="ctx-section-title">会话产物 (' + products.length + ')</div>' + products.map(p => {
            const iconCls = p.type === 'md' ? 'md' : p.type === 'code' ? 'code' : 'img';
            const iconChar = p.type === 'md' ? ic('fileText', 16) : ic('code', 16);
            return '<div class="ctx-product" data-action="preview-product" data-pid="' + p.id + '" data-content="' + esc(p.content).replace(/"/g, '&quot;') + '" data-name="' + esc(p.name) + '" data-lang="' + esc(p.lang || '') + '"><span class="prod-icon ' + iconCls + '">' + iconChar + '</span><span class="prod-name">' + esc(p.name) + '</span><span class="prod-size">' + (p.size > 1024 ? (p.size/1024).toFixed(1) + 'KB' : p.size + 'B') + '</span></div>';
          }).join('') + '</div>';
        }
      } else if (tabId === 'files') {
        // 需求3：工作目录的全部文件（不是会话产物）。首次进入时按项目目录自动装载。
        if (!state.fileTab.inited) ensureFileTabRoot();
        bodyHTML = '<div class="ctx-section">' + fileTabBodyHTML() + '</div>';
      } else if (tabId === 'caps') {
        // 「能力」= 使用中的插件 + 技能 + MCP 三类（原「技能与MCP」只列了后两类，
        // 且「插件」一项取的是写死的常量数组，与运行时无关）。
        // ① 插件：pluginRuntime 真实装载；运行时未接入时回落声明清单并标注「未接入」，
        //    不用空列表冒充「没有插件」（「未接入」≠「为空」是本项目踩过三次的坑）。
        const rtList = rtReady && Array.isArray(rt.plugins) && rt.plugins.length ? rt.plugins : null;
        const declaredList = rtList ? null : PLUGINS.map((p) => ({ name: p.id }));
        const plugRows = (rtList || declaredList || []).map((p) => {
          const name = String(p.name);
          const rec = rtList ? p : null;
          const active = rtReady && !!rec && rec.active === true;
          // 停用逆回滚（主进程 setPluginEnabled）会把 error 置为「已停用（逆回滚完成）」——
          // 若见 error 就标「异常」，主动停用的插件会被误标；按前缀区分停用与真异常。
          const broken = !!rec && !!rec.error && !/^已停用/.test(rec.error);
          const label = !rtReady ? '未接入'
            : (rec ? (active ? '已启用' : (broken ? '异常' : '已停用')) : '未接入');
          const title = rec && rec.error ? esc(rec.error) : '';
          return '<div class="ctx-skill"><span class="sk-icon builtin">' + esc(name[0].toUpperCase()) + '</span>'
            + '<span class="sk-name">' + esc(name) + '</span>'
            + '<span class="sk-status ' + (active ? 'on' : 'idle') + '"' + (title ? ' title="' + title + '"' : '') + '>' + esc(label) + '</span></div>';
        }).join('');
        const plugActive = rtList ? rtList.filter((p) => p.active === true).length : 0;
        bodyHTML = '<div class="ctx-section"><div class="ctx-section-title">插件'
          + (rtList ? ' · 使用中 ' + plugActive + '/' + rtList.length : ' · 运行时未接入')
          + '</div>'
          + (rtList ? '' : '<div class="faint" style="font-size:10px;padding:2px 0 6px">插件运行时未接入 · 以下为声明清单，非实时装载状态</div>')
          + plugRows + '</div>';
        // ② 技能：本地磁盘真实扫描（数据目录/skills/*.skill）。
        //    未接入（扫描失败）与「已扫描但没装」分别标注，不混为一谈。
        const skills = state.installedSkills || [];
        const skRows = skills.map((sk) => {
          const on = sk.enabled !== false;
          const size = sk.bytes ? (sk.bytes > 1024 ? (sk.bytes / 1024).toFixed(1) + 'KB' : sk.bytes + 'B') : '';
          return '<div class="ctx-skill"><span class="sk-icon skill">' + esc(String(sk.slug)[0].toUpperCase()) + '</span>'
            + '<span class="sk-name mono">' + esc(sk.slug) + '</span>'
            + (size ? '<span class="sk-meta">' + size + '</span>' : '')
            + '<span class="sk-status ' + (on ? 'on' : 'idle') + '">' + (on ? '已启用' : '已停用') + '</span></div>';
        }).join('');
        bodyHTML += '<div class="ctx-section"><div class="ctx-section-title">技能'
          // 未接入时不显示「0/0」——那是把「没读到」说成了「读到了 0 个」。
          + (state.installedSkillsLoaded
            ? ' · 使用中 ' + skills.filter((sk) => sk.enabled !== false).length + '/' + skills.length
            : ' · 未接入')
          + '</div>'
          + (state.installedSkillsLoaded
            ? (skills.length ? skRows : '<div class="faint" style="font-size:10px;padding:2px 0 6px">暂无已安装技能 · 插件页 → 技能市场（观雅集）可安装</div>')
            : '<div class="faint" style="font-size:10px;padding:2px 0 6px">技能目录未接入（主进程桥不可用）· 非「没有技能」</div>')
          + '</div>';
        // ③ MCP 连接（真接入）：真实 server 配置 + 连接状态 + 工具清单。
        //    此前这里写死 4 个「filesystem/intent/memory/orchestration」并拿插件装载状态
        //    冒充连接态（全仓无真实 MCP 实现）——已换成 mcp-client.ts 的真实数据。
        const mcps = state.mcp.servers || [];
        const mcpLoaded = state.mcp.loaded;
        const mcpStats = state.mcp.stats || { total: 0, configured: 0, connected: 0, tools: 0 };
        const mcpRows = mcps.map((m) => {
          const connected = m.lastConnectOk === true;
          const label = connected
            ? '已连接'
            : (m.enabled === false ? '已停用' : (m.lastConnectOk === false ? '连接失败' : '待连接'));
          const toolN = Array.isArray(m.tools) ? m.tools.length : 0;
          const toolTitle = connected ? (toolN ? ` · ${toolN} 个工具` : ' · 无工具') : '';
          const msg = m.lastMessage ? esc(m.lastMessage) : '';
          return '<div class="ctx-mcp"><span class="mcp-dot ' + (connected ? 'connected' : 'disconnected') + '"></span>'
            + '<span style="flex:1">' + esc(m.name || m.id) + '</span>'
            + '<span style="font-size:10px;color:var(--fg-dim)">' + esc(label) + toolTitle + '</span></div>'
            + (msg ? '<div class="faint" style="font-size:10px;padding:0 0 4px 26px">' + msg + '</div>' : '');
        }).join('');
        bodyHTML += '<div class="ctx-section"><div class="ctx-section-title">MCP 连接'
          + (mcpLoaded ? ' · ' + mcpStats.connected + '/' + mcpStats.total : ' · 未接入')
          + '</div>'
          + (!mcpLoaded
            ? '<div class="faint" style="font-size:10px;padding:2px 0 6px">MCP 桥未接入（主进程不可用）· 非「没有配置」</div>'
            : (mcps.length
              ? mcpRows
              : '<div class="faint" style="font-size:10px;padding:2px 0 6px">暂无 MCP server · 插件页 → MCP 可添加（命令/参数/env）</div>'))
          + '</div>';
      }

      return '<div class="ctx-header"><div class="ctx-title">' + ic('clipboard', 16) + ' 任务监控</div><div class="ctx-subtitle">' + esc(s.title) + ' · ' + esc(s.expert) + '</div></div><div class="ctx-tabs">' + tabsHTML + '</div><div class="ctx-body">' + bodyHTML + '</div><div id="previewRoot"></div>';
    }
  };

  /* ---------- 渲染：插件视图 ---------- */
  VIEWS.plugins = {
    side() {
      const sec = (key, title, count, html) => {
        const expanded = state.plugSideExpanded.has(key);
        return `<div class="ssec">
          <div class="ss-h" data-action="pside-toggle" data-id="${key}">
            <span class="ss-c ${expanded ? 'open' : ''}">${ic('chev', 12)}</span>
            <span class="ss-t">${title}</span>
            <span class="ss-n">${count}</span>
          </div>
          ${expanded ? `<div class="ss-l">${html}</div>` : ''}
        </div>`;
      };
      const builtIn = PLUGINS.map((p) => `<div class="ss-i ${p.on ? 'on' : ''}" data-action="plug-nav" data-id="${p.id}">
        <span class="id"></span><span class="in">${p.n}</span>
        ${p.on ? '<span class="ib badge ok">启</span>' : p.deferred ? '<span class="ib badge">延后</span>' : '<span class="ib badge">关</span>'}</div>`).join('');
      // 插件市场：本地目录已接真实注册表（FR-3）；远程源（观雅集/Hub）未接入，诚实标注。
      // 此前整栏标「规划中」，本地目录接入后必须区分两种状态。
      const market = (state.market.loaded
        ? state.market.items.map((m) => `<div class="ss-i ${m.active ? 'on' : ''}" data-action="market-local-nav" data-id="${esc(m.dir)}"><span class="id"></span><span class="in">${esc(m.manifest && m.manifest.name || m.dir)}</span>${marketBadge(m)}</div>`).join('')
        : '') +
        PLUGIN_MARKET.map((p) => `<div class="ss-i"><span class="id"></span><span class="in">${esc(p.n)}</span><span class="ib badge">远程未接入</span></div>`).join('');
      const skills = SKILLS_MARKET.map((s) => `<div class="ss-i"><span class="id"></span><span class="in mono" style="font-size:11.5px">${esc(s.n)}</span>${s.auth ? '<span class="ib badge warn">授权</span>' : '<span class="ib badge ok">可装</span>'}</div>`).join('');
      const experts = [...expertList().map((e) => `<div class="ss-i"><span class="id"></span><span class="in">${e}</span><span class="ib badge info">专家</span></div>`),
        ...teamList().map((t) => `<div class="ss-i"><span class="id"></span><span class="in">${esc(t.n)}</span><button class="btn sm ghost" data-action="team-compose" data-tid="${esc(t.id || '')}" data-tn="${esc(t.n)}">派发任务</button><span class="ib badge ceo">团</span></div>`)].join('');
      // 委派树结果（composeTeam 返回后渲染；CEO→Director→Worker 三层）。
      // ②半接线修复后 composeTeam 会把 task 真实喂给各 Director 经 agentRunner 执行，
      // 节点携带 task/result/note —— 必须在树里可见，否则又落入「执行了却存而不显」。
      const delRow = (n) => {
        const line = `<div class="ss-i"><span class="id"></span><span class="in">${esc(String(n.label || n.id))}</span><span class="ib badge ${String(n.layer) === 'ceo' ? 'ceo' : 'info'}">${esc(String(n.layer || ''))}</span><span class="ib badge ${String(n.status) === 'done' ? 'ok' : 'warn'}">${esc(String(n.status || ''))}</span></div>`;
        const cut = (s) => (s.length > 140 ? s.slice(0, 140) + '…' : s);
        const bits = [];
        const t = n.task; if (typeof t === 'string' && t) bits.push(`任务：${esc(cut(t))}`);
        const st = String(n.status || '');
        if (st === 'failed') bits.push(typeof n.note === 'string' && n.note ? `原因：${esc(cut(n.note))}` : '原因：执行失败');
        else if (st === 'done') { const r = n.result; if (typeof r === 'string' && r) bits.push(`产出：${esc(cut(r))}`); }
        if (st === 'running' || st === 'pending') bits.push(st === 'running' ? '执行中…' : '待执行');
        return line + (bits.length ? `<div class="del-note">${bits.join('<br>')}</div>` : '');
      };
      const deleg = (state.delegationLast?.nodes || []).map(delRow).join('');
      const expertsHtml = experts + (deleg ? sec('delegation', '最近一次委派树', (state.delegationLast?.nodes || []).length, deleg) : '');
      // 连接器侧栏：真实后端状态。桥不可用（loaded=false）显「未接入」，
      // 与「已接入但都没配置」必须区分 —— 把 null 当空数组是本项目踩过三次的坑。
      const connItems = state.connectors.loaded
        ? state.connectors.items.map((c) => `<div class="ss-i ${c.state && c.state.lastTestOk === true ? 'on' : ''}" data-action="conn-cfg" data-id="${esc(c.id)}"><span class="id"></span><span class="in">${esc(c.name)}</span>${connBadge(c)}</div>`).join('')
        : '<div class="ss-i"><span class="id"></span><span class="in">连接器注册表</span><span class="ib badge">未接入</span></div>';
      const connCount = state.connectors.loaded ? state.connectors.stats.total : 0;
      return sec('builtin', '内置插件', PLUGINS.length, builtIn) +
        sec('market', '插件市场', (state.market.loaded ? state.market.items.length : 0) + PLUGIN_MARKET.length, market) +
        sec('skills', '技能市场', SKILLS_MARKET.length, skills) +
        sec('experts', '专家·专家团', expertList().length + teamList().length, expertsHtml) +
        sec('connectors', '连接器', connCount, connItems);
    },
    main() {
      // 插件页搜索（2026-09-06）：顶部搜索条即时过滤内置插件卡片。
      // 全部卡片仍一次渲染（避免重渲染丢输入焦点），由 plugSearchFilter() 在
      // 运行时切换每张卡 .hidden；匹配文本（名称/描述/能力/标识/仓库）预先拼进
      // data-search 小写。不触后端，纯即时前端过滤。
      return `<div class="main-inner"><h1 class="pg">插件</h1><div class="pg-sub">一切皆插件——能力以插件形式挂载；启用 = 注册 effect，停用 = 注册回滚（无残留）。</div>
        <div class="plug-search-bar">
          <input type="search" class="inp" id="plugSearch" placeholder="搜索内置插件（名称 / 能力 / 描述）…"
            value="${esc(state.plugSearch)}" aria-label="搜索内置插件">
          <span class="faint" id="plugSearchCount" style="font-size:11px"></span>
        </div>
        ${PLUGINS.map((p) => `<div class="plug" data-pid="${p.id}" data-search="${esc([p.n, p.d, (p.caps || []).join(' '), p.id, p.repo || ''].join(' ').toLowerCase())}">
          <div class="ph">
            <div style="min-width:0;flex:1">
              <div class="ptitle">${p.n}
                ${pluginBadge(p.id)}
                ${p.model ? `<span class="badge info">${p.model}</span>` : ''}</div>
              <div class="pdesc">${p.d}</div>
              <div class="pmeta">${p.repo ? `<span class="mono">${p.repo}</span>·` : ''}<span class="faint">能力声明</span></div>
              <div class="pcaps">${p.caps.map((c, i) => `<span class="badge cap ${i === 0 ? '' : (c.includes('write') || c.includes('dispose') || c.includes('commit') ? 'warn' : '')}">${c}</span>`).join('')}</div>
            </div>
            <div class="pactions">
              <!-- 内联 onclick 里的 toast 在 IIFE 作用域外，点击必抛 ReferenceError；
                   切换逻辑统一交给下面委托的 case 'plug-toggle'（真实热插拔）。 -->
              <div class="switch ${pluginSwitchedOn(p.id) ? 'on' : ''}" data-action="plug-toggle" data-id="${p.id}" title="${pluginSwitchedOn(p.id) ? '点击停用' : '点击启用'}"></div>
              <button class="btn sm" data-action="plug-cfg" data-id="${p.id}">配置</button>
            </div>
          </div>
          <div class="pbody" data-cfg="${p.id}">
            ${p.cfg.map((c) => `<div class="row" style="padding:3px 0"><span class="faint" style="width:180px">${c}</span></div>`).join('')}
            <div class="row" style="margin-top:6px"><button class="btn sm">查看审计日志</button><button class="btn sm ghost" data-action="plug-unload">卸载并回滚</button></div>
          </div>
        </div>`).join('')}
        <div class="faint" id="plugSearchEmpty" style="padding:14px;display:none">没有匹配的内置插件</div>
        <div class="sec-title" style="margin-top:18px">连接器（PRD FR-3）</div>
        <div class="card" style="padding:12px">
          <div class="faint" style="margin-bottom:8px">第三方服务接入：凭证仅本地<b>加密</b>保存（密钥存系统安全存储），保存即自动探测一次连通性。${state.connectors.loaded ? `共 ${state.connectors.stats.total} 个 · 已配置 ${state.connectors.stats.configured} · 连通 ${state.connectors.stats.ok}` : ''}</div>
          ${!state.connectors.loaded
    ? '<div class="faint">连接器注册表未接入（主进程桥不可用）</div>'
    : state.connectors.items.map((c) => {
      const st = c.state || {};
      const open = state.connectors.expanded === c.id;
      const lastMsg = st.lastTestAt
        ? `<span class="faint" style="font-size:11px">最近探测：${st.lastTestOk === true ? '<span style="color:var(--ok)">✓</span>' : st.lastTestOk === false ? '✗' : '·'} ${esc(st.lastTestMessage || '')}</span>`
        : (c.manual && st.configured ? `<span class="faint" style="font-size:11px">${esc(c.manualHint || '已保存凭证（无自动探测）')}</span>` : '');
      const formRows = c.fields.map((f) => {
        const val = (c.values && c.values[f.key]) || '';
        const inputType = f.type === 'secret' ? 'password' : 'text';
        return `<div class="mb-row"><label>${esc(f.label)}${f.required ? '' : ' <span class="faint">（选填）</span>'}</label><input class="inp" type="${inputType}" id="connf-${esc(c.id)}-${esc(f.key)}" placeholder="${esc(f.placeholder || '')}" value="${esc(val)}">${f.hint ? `<div class="faint" style="font-size:10.5px;margin-top:2px">${esc(f.hint)}</div>` : ''}</div>`;
      }).join('');
      return `<div class="plug" data-cid="${esc(c.id)}" ${open ? '' : ''}>
            <div class="ph">
              <div style="min-width:0;flex:1">
                <div class="ptitle">${esc(c.name)} ${connBadge(c)} ${c.caps.map((cap) => `<span class="badge cap">${esc(cap)}</span>`).join('')}</div>
                <div class="pdesc">${esc(c.desc)}</div>
                <div class="pmeta">${lastMsg}</div>
              </div>
              <div class="pactions">
                ${c.manual ? '' : `<button class="btn sm" data-action="conn-test" data-id="${esc(c.id)}" ${st.configured ? '' : 'disabled'}>测试</button>`}
                <button class="btn sm" data-action="conn-cfg" data-id="${esc(c.id)}">${open ? '收起' : '配置'}</button>
              </div>
            </div>
            ${open ? `<div class="pbody" style="display:block">
              ${formRows}
              <div class="row" style="margin-top:8px;align-items:center">
                <button class="btn sm primary" data-action="conn-save" data-id="${esc(c.id)}">保存${c.manual ? '' : '并测试'}</button>
                <button class="btn sm ghost" data-action="conn-clear" data-id="${esc(c.id)}" ${st.configured ? '' : 'disabled'}>清除凭证</button>
                <span class="faint" style="font-size:11px;margin-left:auto;cursor:pointer" data-action="open-external" data-url="${esc(c.docsUrl)}">凭证获取文档 ↗</span>
              </div>
              ${c.manual ? `<div class="faint" style="font-size:11px;margin-top:6px">${esc(c.manualReason || '')}</div>` : ''}
            </div>` : ''}
          </div>`;
    }).join('')}
          ${state.connAudit.entries.length ? `<div class="sec-title" style="margin-top:12px;font-size:12px">审计（保存/清除/探测，${state.connAudit.total} 条 · 上限 ${state.connAudit.max}）</div>
          <div style="max-height:180px;overflow:auto">
            ${state.connAudit.entries.map((e) => `<div class="row" style="padding:3px 0;border-top:1px solid var(--border)"><span class="mono" style="font-size:11px;width:86px">${esc(e.id)}</span><span class="badge ${e.action === 'test' ? 'ok' : e.action === 'test-fail' ? 'warn' : ''}" style="margin:0 6px">${esc(e.action)}</span><span style="flex:1;font-size:11.5px">${esc(e.message)}</span><span class="faint mono" style="font-size:10.5px">${new Date(e.ts).toLocaleString()}</span></div>`).join('')}
          </div>
          <div class="row" style="margin-top:6px"><button class="btn sm ghost" data-action="conn-audit-clear">清空审计</button></div>` : ''}
        </div>
        <div class="sec-title" style="margin-top:18px">MCP（Model Context Protocol）</div>
        <div class="card" style="padding:12px">
          <div class="faint" style="margin-bottom:8px">接入 MCP server（stdio）：命令 + 参数 + 环境变量（env 密钥<b>加密</b>落盘）。保存即握手探测一次，拿到真实工具清单。${state.mcp.loaded ? `共 ${state.mcp.stats.total} 个 · 已连接 ${state.mcp.stats.connected} · 工具 ${state.mcp.stats.tools}` : ''}</div>
          ${!state.mcp.loaded
    ? '<div class="faint">MCP 桥未接入（主进程不可用）</div>'
    : state.mcp.servers.map((m) => {
      const connected = m.lastConnectOk === true;
      const open = state.mcpExpanded === m.id;
      const tools = Array.isArray(m.tools) ? m.tools : [];
      return `<div class="plug" data-mcpid="${esc(m.id)}">
            <div class="ph">
              <div style="min-width:0;flex:1">
                <div class="ptitle">${esc(m.name || m.id)} ${connected ? '<span class="ib badge ok">已连接</span>' : (m.enabled === false ? '<span class="ib badge">已停用</span>' : (m.lastConnectOk === false ? '<span class="ib badge warn">连接失败</span>' : '<span class="ib badge warn">待连接</span>'))}</div>
                <div class="pdesc mono" style="font-size:11px">${esc(m.command || '')}${(Array.isArray(m.args) && m.args.length) ? ' ' + m.args.map((a) => esc(a)).join(' ') : ''}</div>
                <div class="pmeta">${connected && tools.length ? tools.map((t) => `<span class="badge cap">${esc(t)}</span>`).join('') : `<span class="faint" style="font-size:11px">${esc(m.lastMessage || '尚未连接')}</span>`}</div>
              </div>
              <div class="pactions">
                <button class="btn sm" data-action="mcp-probe" data-id="${esc(m.id)}" ${m.enabled === false ? 'disabled' : ''}>探测</button>
                <button class="btn sm" data-action="mcp-toggle" data-id="${esc(m.id)}">${m.enabled === false ? '启用' : '停用'}</button>
                <button class="btn sm ghost" data-action="mcp-del" data-id="${esc(m.id)}">删除</button>
              </div>
            </div>
          </div>`;
    }).join('')}
          <div class="row" style="margin-top:10px"><button class="btn sm primary" data-action="mcp-add">+ 添加 MCP server</button></div>
        </div>
        <div class="sec-title" style="margin-top:18px">本地插件市场（PRD FR-3）</div>
        <div class="card" style="padding:12px">
          <div class="faint" style="margin-bottom:8px">第三方插件放 <b>插件目录</b>（manifest.json + index.js）后出现在这里。扫描不执行代码；<b>启用 = 显式授权装载</b>，与内置插件同一套真热插拔（停用 = 逆回滚无残留）。远程市场需签名与来源校验，未接入。</div>
          <div class="row" style="margin-bottom:10px">
            <button class="btn sm" data-action="market-open-dir">打开插件目录</button>
            <button class="btn sm ghost" data-action="market-refresh">重新扫描</button>
            ${state.market.loaded ? `<span class="faint" style="font-size:11px;margin-left:auto">${state.market.items.length} 个目录 · ${state.market.count} 个已启用</span>` : ''}
          </div>
          ${!state.market.loaded
    ? '<div class="faint">本地插件市场未接入（主进程桥不可用）</div>'
    : state.market.items.length === 0
      ? `<div class="faint">插件目录为空：把含 manifest.json + index.js 的插件目录放进 ${esc(state.market.dir)} 后点「重新扫描」</div>`
      : state.market.items.map((m) => {
        const name = m.manifest && m.manifest.name ? m.manifest.name : m.dir;
        const desc = m.manifest && m.manifest.description ? m.manifest.description : '';
        const ver = m.manifest && m.manifest.version ? m.manifest.version : '';
        const caps = m.manifest && Array.isArray(m.manifest.caps) ? m.manifest.caps : [];
        const inj = m.manifest && Array.isArray(m.manifest.inject) ? m.manifest.inject : [];
        return `<div class="plug" data-mid="${esc(m.dir)}">
              <div class="ph">
                <div style="min-width:0;flex:1">
                  <div class="ptitle">${esc(name)} ${marketBadge(m)} ${ver ? `<span class="badge info mono">v${esc(ver)}</span>` : ''}</div>
                  ${desc ? `<div class="pdesc">${esc(desc)}</div>` : ''}
                  <div class="pmeta">
                    ${caps.map((cap) => `<span class="badge cap">${esc(cap)}</span>`).join('')}
                    ${inj.length ? `<span class="faint" style="font-size:11px;margin-left:6px">注入：${inj.map((s) => esc(s)).join('、')}</span>` : ''}
                    ${m.error ? `<div class="faint" style="font-size:11px;color:var(--warn, #b7791f)">${esc(m.error)}</div>` : ''}
                  </div>
                </div>
                <div class="pactions">
                  <div class="switch ${m.enabled ? 'on' : ''}" data-action="market-local-toggle" data-id="${esc(m.dir)}" title="${m.manifestOk && m.hasEntry ? (m.enabled ? '点击停用' : '点击启用（显式授权装载）') : 'manifest 非法或缺 index.js，不可启用'}"></div>
                </div>
              </div>
            </div>`;
      }).join('')}
        </div>
        <div class="sec-title muted" style="margin-top:18px">临时插件（自进化 · 仅驻内存 · 重启即失）</div>
        <div class="card temp-plug-card">
          <div class="faint" style="margin-bottom:8px">Agent 运行时自建的临时插件；信任级 = Shell，须沙箱内运行，不持久化。加载前经静态分析 + CONFIRM（fail-closed）。</div>
          ${state.tempPlugins.length ? state.tempPlugins.map((p) => `<div class="tp-item"><span class="mono">${p.name}</span><span class="badge warn">shell</span><span class="faint">仅驻内存</span><button class="btn sm ghost" data-action="tp-dispose" data-id="${p.id}">卸载</button></div>`).join('') : '<div class="faint">暂无临时插件（创建后在此列出，重启即失）</div>'}
          <div class="row" style="margin-top:8px"><button class="btn sm" data-action="tp-new">+ 新建临时插件</button></div>
        </div>
        <div class="sec-title" style="margin-top:18px">技能市场（观雅集）</div>
        <div class="card models-card" style="padding:12px">
          ${state.guanjiTokenSet
            ? '<div class="row" style="margin-bottom:8px"><span class="badge ok">已配置 TOKEN</span><button class="btn sm ghost" data-action="guanji-token" style="margin-left:8px">更换 TOKEN</button></div>'
            : '<div class="row" style="margin-bottom:8px"><span class="badge warn">未配置 TOKEN</span><button class="btn sm primary" data-action="guanji-token" style="margin-left:8px">配置观雅集 TOKEN</button></div>'}
          <div class="row" style="margin-bottom:6px;gap:8px">
            <input type="search" class="inp" id="skillSearch" placeholder="搜索技能（slug / 名称 / 描述 / 能力）…" style="max-width:340px" aria-label="搜索技能">
            <span class="faint" id="skillSearchCount" style="font-size:11px"></span>
          </div>
          <table style="width:100%">
            <tr><th style="width:32%">技能</th><th>能力</th><th style="width:80px;text-align:right">操作</th></tr>
            ${(state.guanjiSkills.length ? state.guanjiSkills : SKILLS_MARKET.map((s) => ({ slug: s.n, name: s.n, description: s.d, caps: s.caps, auth: s.auth }))).map((s) => `<tr data-skill-search="${esc([s.slug, s.name, s.description || '', (s.caps || []).join(' ')].join(' ').toLowerCase())}">
              <td><div class="mono" style="font-size:11.5px">${esc(s.slug)}</div><div class="faint" style="font-size:11px;margin-top:2px">${esc(s.description || '')}</div></td>
              <td>${s.caps.map((c) => `<span class="badge cap" style="margin:2px 4px 2px 0">${esc(c)}</span>`).join('')}${s.auth ? '<span class="badge warn">需授权</span>' : ''}</td>
              <td style="text-align:right"><button class="btn sm primary" data-action="guanji-install" data-slug="${esc(s.slug)}">安装</button></td>
            </tr>`).join('')}
          </table>
          <div class="row" style="margin-top:10px"><button class="btn sm" data-action="guanji-publish">发布技能到观雅集</button></div>
          ${state.installedSkills.length ? `<div class="sec-title" style="margin-top:14px;font-size:12px">已安装（${state.installedSkills.length}）</div>
          <div class="installed-skills">` + state.installedSkills.map((s) => {
            const on = s.enabled !== false;
            const size = s.bytes ? (s.bytes > 1024 ? (s.bytes / 1024).toFixed(1) + 'KB' : s.bytes + 'B') : '';
            return `<div class="is-row">
              <span class="is-name mono">${esc(s.slug)}</span>
              <span class="badge ${on ? 'ok' : ''}">${on ? '已启用' : '已停用'}</span>
              ${size ? `<span class="faint mono" style="font-size:10.5px">${size}</span>` : ''}
              <span style="flex:1"></span>
              <button class="btn sm" data-action="skill-toggle" data-n="${esc(s.slug)}">${on ? '停用' : '启用'}</button>
              <button class="btn sm ghost danger-text" data-action="skill-uninstall" data-n="${esc(s.slug)}">卸载</button>
            </div>`;
          }).join('') + `</div>` : ''}
        </div></div>`;
    },
    ctx() {
      return `<div class="sec-title">能力审查</div>
        <div class="faint" style="margin-bottom:8px">插件加载前经 inject 静态声明审查；<b>红色能力</b>需用户主动授权。</div>
        <div class="card" style="padding:10px">
          <div style="font-size:11.5px;font-weight:600;margin-bottom:6px">L0-L4 分级</div>
          <div class="levels">
            ${state.authLevels.length
              ? state.authLevels.map((l) => `<div class="lv"><span class="lv-n">L${l.level}</span><span class="lv-l">${esc(l.label)}</span><span class="faint">${esc(l.scope)}</span>${l.requiresApproval ? '<span class="badge warn">需授权</span>' : ''}</div>`).join('')
              : '<div class="faint">分级定义加载中…</div>'}
          </div>
        </div>
        <div class="sec-title">当前激活</div>
        <div class="faint" style="font-size:12px">意图识别 · TRACE · 脑-手解耦 · 多Agent编排 · 补偿层 · 自进化</div>
        <div class="sec-title">OrchClaw Hub 联调</div>
        <div class="card" style="padding:10px">
          <div class="faint" style="margin-bottom:8px">配对远程 Agent（凭据经系统安全存储加密）；主会话可向其下发任务并回收结果。端到端需可达远程 Hub。</div>
          ${state.hubStatus.paired
            ? `<div class="row" style="margin-bottom:8px"><span class="badge ok">已配对${state.hubStatus.agentName ? ' · ' + esc(state.hubStatus.agentName) : ''}</span><button class="btn sm ghost" data-action="hub-unpair" style="margin-left:8px">解除配对</button></div>`
            : `<div class="mb-row"><label>Hub URL</label><input class="inp" id="hubUrl" placeholder="https://hub.example.com" value="${esc(state.hubUrl || '')}"></div>`
               + `<div class="mb-row"><label>配对凭据</label><input class="inp" id="hubToken" type="password" placeholder="远程 Agent 配对 Token"></div>`
               + `<button class="btn sm primary" data-action="hub-pair">配对</button>`}
          <div class="mb-row" style="margin-top:8px"><label>向远程下发任务</label><textarea id="hubTask" class="inp" rows="2" placeholder="任务描述…">${esc(state.hubTaskText || '')}</textarea></div>
          <button class="btn sm" data-action="hub-send">发送任务</button>
          ${state.hubResultText ? `<div class="faint" style="margin-top:8px;white-space:pre-wrap">${esc(state.hubResultText)}</div>` : ''}
        </div>`;
    }
  };

  /* ---------- 渲染：设置视图 ---------- */
  VIEWS.settings = {
    side() {
      return `<div class="sec-title">设置</div>
        <div class="settings-nav">
        ${[{ id: 'model', n: '模型', icon: 'bot' }, { id: 'cred', n: '凭据', icon: 'shield' }, { id: 'sandbox', n: '沙箱与授权', icon: 'shield' }, { id: 'prompt', n: '系统提示词', icon: 'at' }, { id: 'desktop', n: '桌面集成', icon: 'settings' }, { id: 'data', n: '数据目录', icon: 'folder' }, { id: 'about', n: '关于', icon: 'at' }]
          .map((s) => `<div class="node settings-nav-item" data-action="settings-nav" data-id="${s.id}"><span class="sni-icon">${ic(s.icon, 14)}</span><span class="sni-label">${s.n}</span></div>`).join('')}
        </div>`;
    },
    main() {
      // BUG（全盘死挂点扫描）：statbar 硬编码「%APPDATA%/OrchDesk」「dsh 99f6f02」——
      // 渲染层拿不到真实数据目录与运行时版本，宁可显示真实状态也不伪造。
      const ddOk = state.dataDirInventory && state.dataDirInventory.ok && state.dataDirInventory.dir;
      const ddShort = ddOk ? String(state.dataDirInventory.dir).replace(/\\/g, '/').split('/').filter(Boolean).slice(-2).join('/') : '';
      const rtOk = state.pluginRuntime && state.pluginRuntime.ready;
      return `<div class="main-inner"><h1 class="pg">设置</h1><div class="pg-sub">模型、沙箱、授权、桌面集成等能力均以插件形式挂载，在此统一管理。</div>
        <div class="statbar">
          <div class="stat"><div class="sk">授权模式</div><div class="sv"><span class="dot" style="background:var(--ok)"></span>${authModeLabel(state.authMode)}</div></div>
          <div class="stat"><div class="sk">沙箱</div><div class="sv"><span class="badge ok" style="font-weight:600">Windows ACL</span></div></div>
          <div class="stat"><div class="sk">数据目录</div><div class="sv" style="font-size:12px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:150px" title="${esc(ddOk ? state.dataDirInventory.dir : '')}">${ddOk ? '…/' + esc(ddShort) : '本地（未扫描）'}</div></div>
          <div class="stat"><div class="sk">运行时</div><div class="sv" style="font-size:12px;font-weight:500">${rtOk ? `插件运行时就绪 · ${state.pluginRuntime.activeCount}/${state.pluginRuntime.total}` : '插件运行时未启动'}</div></div>
        </div>
        <div class="sec-title" id="settings-section-model"><span class="ico">${ic('bot', 14)}</span>模型管理</div>
        <div class="card" id="model-mgmt-card">
          <div class="faint" style="margin-bottom:14px">添加模型提供商后，会话中发送消息将调用真实模型 API（OpenAI 兼容或 Ollama 本地）。API Key 经系统安全存储加密。</div>
          <div id="model-providers-list"></div>
          <div id="default-model-pick-wrap" style="${state.modelProviders.length ? '' : 'display:none'}">
            <div style="margin-top:10px;padding:8px 12px;background:var(--bg-inset);border-radius:8px;display:flex;align-items:center;gap:8px">
              <span class="faint" style="font-size:11.5px;white-space:nowrap">默认模型</span>
              <select id="default-model-pick" class="mp-inp" style="flex:1;font-size:12px">
                ${(state.modelProviders || []).flatMap(p => (p.models || []).map(m => ({ n: m, pn: p.name, pt: p.type }))).map(m =>
                  `<option value="${esc(m.n)}" ${state.defaultModel === m.n ? 'selected' : ''}>${esc(m.pn)} (${m.pt === 'ollama' ? '本地' : 'API'}) · ${esc(m.n)}</option>`
                ).join('')}
              </select>
            </div>
          </div>
          <div style="margin-top:10px;padding:8px 12px;background:var(--bg-inset);border-radius:8px;display:flex;align-items:center;gap:8px">
            <span class="faint" style="font-size:11.5px;white-space:nowrap;flex:none">Agent 迭代</span>
            <input type="range" id="max-iter-pick" min="1" max="500" step="1" value="${state.maxToolIterations || 200}" style="flex:1">
            <span id="max-iter-val" class="mono" style="font-size:11px;color:var(--fg-dim);min-width:32px;text-align:right">${state.maxToolIterations || 200}</span>
          </div>
          ${renderUsageCard()}
          <div style="margin-top:14px;padding-top:14px;border-top:1px solid var(--border)">
            <b style="font-size:12.5px;margin-bottom:10px;display:block">${state.mpEditing ? '编辑提供商' : '添加提供商'}</b>
            <div class="mp-form">
              <div class="mp-row">
                <label class="mp-label">类型</label>
                <select id="mp-type" class="mp-inp" style="max-width:180px">
                  <option value="ollama">Ollama 本地</option>
                  <option value="openai-compatible">OpenAI 兼容</option>
                </select>
              </div>
              <div class="mp-row">
                <label class="mp-label">名称</label>
                <input type="text" id="mp-name" placeholder="如 OpenAI、DeepSeek" class="mp-inp">
              </div>
              <div class="mp-row">
                <label class="mp-label">Base URL</label>
                <div class="mp-url-wrap">
                  <input type="text" id="mp-url" placeholder="localhost:11434" class="mp-inp mp-url-inp">
                  <label class="mp-url-check"><input type="checkbox" id="mp-fullurl" checked> 完整 URL（含 http://）</label>
                </div>
              </div>
              <div class="mp-row" id="mp-mode-row" style="display:none">
                <label class="mp-label">API 协议</label>
                <select id="mp-mode" class="mp-inp" style="max-width:200px">
                  <option value="chat">/v1/chat/completions（标准对话）</option>
                  <option value="responses">/v1/responses（ Responses API）</option>
                  <option value="completions">/v1/completions（文本补全）</option>
                </select>
                <span class="faint" style="font-size:11px;margin-left:8px">选择 API 端点协议</span>
              </div>
              <div class="mp-row">
                <label class="mp-label">API Key</label>
                <input type="password" id="mp-key" placeholder="sk-...（可选，Ollama 可留空）" class="mp-inp">
              </div>
              <div class="mp-row">
                <label class="mp-label">模型</label>
                <input type="text" id="mp-models" placeholder="gpt-4o, claude-3-5-sonnet（逗号分隔）" class="mp-inp">
                <span class="faint" style="font-size:11px;margin-left:8px">逗号分隔多个模型名称</span>
              </div>
              <div class="mp-row" style="margin-top:4px">
                <label class="mp-label"></label>
                <div style="display:flex;gap:8px">
                  <button class="btn sm primary" data-action="model-add-provider">${state.mpEditing ? '保存' : '添加'}</button>
                  ${state.mpEditing ? '<button class="btn sm" data-action="model-cancel-edit">取消</button>' : ''}
                </div>
              </div>
            </div>
          </div>
        </div>
        <div class="sec-title" id="settings-section-sandbox"><span class="ico">${ic('shield', 14)}</span>沙箱与授权</div>
        <div class="card">
          <div class="row" style="margin-bottom:10px">
            <span class="badge ok">沙箱 Windows ACL</span><span class="badge info">L0-L4 分级</span><span class="faint">fail-closed</span>
          </div>
          <div class="faint" style="margin-bottom:8px">授权模式（三模式映射到 dsh 沙箱 + 审批策略，切换经 session 事件持久化，重启可回放）</div>
          <div class="auth-modes">
            ${authModesForRender().map((m) => `<div class="am ${state.authMode === m.id ? 'sel' : ''}" data-action="auth-mode-pick" data-id="${m.id}">
              <div class="am-h"><b>${m.label}</b>${state.authMode === m.id ? '<span class="badge ok">当前</span>' : ''}</div>
              <div class="faint" style="font-size:11.5px;margin-top:4px">${m.blurb}</div>
            </div>`).join('')}
          </div>
          <div class="sec-title" style="margin:16px 0 8px">网络域名白名单（PRD FR-8）</div>
          <div class="faint" style="margin-bottom:6px">一行一个域名（如 <span class="mono">github.com</span>），<span class="mono">*</span> 表示不限；非白名单域名的抓取经补偿层二次确认（fail-closed）。</div>
          <textarea class="inp mono" id="net-allow" rows="3" style="width:100%;font-size:11.5px">${esc((state.sandbox.networkAllow || ['*']).join('\n'))}</textarea>
          <div class="row" style="margin-top:8px"><button class="btn sm primary" data-action="sandbox-save-net">保存白名单</button><span class="faint" id="net-allow-tip"></span></div>
          <div class="sec-title" style="margin:16px 0 8px">L0-L4 分级</div>
          <div class="levels">
            ${state.authLevels.length ? state.authLevels.map((l) => `<div class="lv"><span class="lv-n">L${l.level}</span><span class="lv-l">${l.label}</span><span class="faint">${l.scope}</span>${l.requiresApproval ? '<span class="badge warn">需授权</span>' : ''}</div>`).join('') : '<div class="faint">分级定义加载中…</div>'}
          </div>
          <div class="sec-title" style="margin:16px 0 8px">授权白名单（PRD FR-9 · 可查看可撤销）</div>
          <div class="faint" style="margin-bottom:6px">粒度分「会话 / 永久」，规则 = 操作类型 + 目标模式（仅 <span class="mono">*</span> 通配，整串匹配）。命中即放行并计入审计；<b>偏执模式下白名单不生效</b>（切到偏执 = 全锁）。</div>
          <div class="grant-add">
            <select id="grant-tool" class="inp" style="width:150px">
              ${(state.grantTools.length ? state.grantTools : ['*', 'file_write', 'shell_command', 'web_fetch']).map((t) => `<option value="${t}">${t === '*' ? '任意操作' : t}</option>`).join('')}
            </select>
            <input type="text" id="grant-pattern" class="inp mono" placeholder="目标模式，如 D:/Code/OrchDesk/* 或 *" style="flex:1;font-size:11.5px">
            <select id="grant-scope" class="inp" style="width:110px"><option value="permanent">永久</option><option value="session">本会话</option></select>
            <button class="btn sm primary" data-action="grant-add">+ 添加</button>
          </div>
          <div class="grant-list">
            ${state.grants.length ? state.grants.map((g) => `<div class="gr-item">
              <span class="badge ${g.scope === 'permanent' ? 'warn' : 'info'}">${g.scope === 'permanent' ? '永久' : '会话'}</span>
              <span class="mono">${esc(g.tool === '*' ? '任意操作' : g.tool)}</span>
              <span class="mono faint" style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(g.pattern)}">${esc(g.pattern)}</span>
              <span class="faint">${g.hits} 次</span>
              <button class="opbtn" data-action="grant-revoke" data-id="${esc(g.id)}" title="撤销">${ic('trash', 13)}</button>
            </div>`).join('') : '<div class="faint">暂无白名单（审批弹窗点「会话内允许 / 永久允许」即写入，也可上方手动添加）</div>'}
          </div>
          <div class="row" style="margin-top:8px">
            <button class="btn sm" data-action="grant-revoke-all" ${state.grants.length ? '' : 'disabled'}>全部撤销</button>
            <span class="faint">撤销立即生效，全部动作入审计日志</span>
          </div>
          <div class="sec-title" style="margin:16px 0 8px">审计日志（近期）</div>
          <div class="audit-log">
            ${state.authAudit.length ? state.authAudit.slice().reverse().slice(0, 12).map((e) => `<div class="al"><span class="mono" style="font-size:10.5px">${new Date(e.ts).toLocaleTimeString('zh-CN')}</span><span class="badge ${e.kind === 'approval-decided' ? (e.outcome === 'allowed-once' ? 'ok' : 'danger') : 'info'}">${e.kind}</span>${e.toolName ? `<span class="mono faint">${e.toolName}</span>` : ''}${e.outcome ? `<span class="faint">${e.outcome}</span>` : ''}${e.mode ? `<span class="faint">mode=${e.mode}</span>` : ''}</div>`).join('') : '<div class="faint">暂无审计事件（L3/L4 操作与模式切换会记录于此）</div>'}
          </div>
          <div class="sec-title" style="margin:16px 0 8px">补偿层审计（边界外操作）</div>
          <div class="audit-log">
            ${state.compAudit.length ? state.compAudit.slice().reverse().slice(0, 12).map((e) => `<div class="al"><span class="mono" style="font-size:10.5px">${new Date(e.ts).toLocaleTimeString('zh-CN')}</span><span class="badge warn">补偿</span><span class="mono faint">${(e.text || '').replace(/</g, '&lt;')}</span>${e.note ? `<span class="faint">${e.note}</span>` : ''}</div>`).join('') : '<div class="faint">暂无补偿动作记录（外发/不可逆操作后在此提供「补偿动作」）</div>'}
          </div>
          <div class="row" style="margin-top:8px"><button class="btn sm" data-action="comp-record">+ 记录补偿动作</button><span class="faint">不保证完全撤销，仅尽力补偿</span></div>
          <div class="sec-title" style="margin:16px 0 8px">沙箱日志（PRD FR-8 · 可检索）</div>
          <div class="faint" style="margin-bottom:6px">记录每一次沙箱判定：路径 / 命令 / 域名白名单、授权门、外发预判，以及执行成败。环形缓冲保留最近 ${state.sandboxLog.max} 条，随数据目录迁移。</div>
          <div class="sblog-bar">
            <input type="text" id="sblog-kw" class="inp mono" placeholder="检索：路径 / 命令 / 域名 / 会话 ID" style="flex:1;font-size:11.5px" value="${esc(state.sandboxLog.keyword)}">
            <select id="sblog-decision" class="inp" style="width:96px">
              ${['all', 'denied', 'allowed', 'error'].map((d) => `<option value="${d}"${state.sandboxLog.decision === d ? ' selected' : ''}>${SL_DECISION_LABELS[d]}</option>`).join('')}
            </select>
            <select id="sblog-kind" class="inp" style="width:110px">
              ${['all', 'path', 'command', 'network', 'approval', 'outbound', 'config'].map((k) => `<option value="${k}"${state.sandboxLog.kind === k ? ' selected' : ''}>${SL_KIND_LABELS[k]}</option>`).join('')}
            </select>
            <button class="btn sm" data-action="sblog-clear" ${state.sandboxLog.total ? '' : 'disabled'}>清空</button>
          </div>
          <div class="sblog-stats sl-stats">
            <span class="badge info">共 ${state.sandboxLog.total} 条</span>
            <span class="badge ok">放行 ${state.sandboxLog.stats.allowed}</span>
            <span class="badge danger">拒绝 ${state.sandboxLog.stats.denied}</span>
            ${state.sandboxLog.stats.error ? `<span class="badge warn">出错 ${state.sandboxLog.stats.error}</span>` : ''}
            ${state.sandboxLog.stats.byTool.map((t) => `<span class="faint mono">${esc(t.tool)} ×${t.count}</span>`).join('')}
          </div>
          <div class="audit-log sblog sl-log">
            ${state.sandboxLog.entries.length ? state.sandboxLog.entries.map((e) => `<div class="al">
              <span class="mono" style="font-size:10.5px">${new Date(e.ts).toLocaleString('zh-CN')}</span>
              <span class="badge ${e.decision === 'allowed' ? 'ok' : (e.decision === 'denied' ? 'danger' : 'warn')}">${SL_DECISION_LABELS[e.decision] || e.decision}</span>
              <span class="badge info">${SL_KIND_LABELS[e.kind] || e.kind}</span>
              <span class="mono faint">${esc(e.tool)}</span>
              <span class="mono" style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(e.target)}">${esc(e.target)}</span>
              ${e.reason ? `<span class="faint" style="max-width:32%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(e.reason)}">${esc(e.reason)}</span>` : ''}
            </div>`).join('') : `<div class="faint">${state.sandboxLog.loaded ? '暂无匹配记录（Agent 执行文件 / 命令 / 网络操作时写入）' : '沙箱日志未接入（主进程桥不可用）'}</div>`}
          </div>
        </div>
        <div class="sec-title" id="settings-section-prompt"><span class="ico">${ic('at', 14)}</span>系统提示词库</div>
        <div class="card">
          <div class="faint" style="margin-bottom:8px">提示词与技能解耦；分类（角色行为 / 安全边界 / 输出格式 / 技能联动）；支持 <span class="mono">{'{skill:xxx}'}</span> 引用；按 Agent 绑定 + 优先级合并（冲突显式标记）。</div>
          <div class="row" style="margin-bottom:8px"><button class="btn sm primary" data-action="prompt-new">+ 新建提示词</button><span class="faint">共 ${state.promptDocs.length} 条</span></div>
          <div class="prompt-list">
            ${state.promptDocs.length ? state.promptDocs.map((d) => `<div class="pl-item" data-action="prompt-edit" data-id="${d.id}">
              <div class="pl-h"><b>${d.title}</b><span class="badge info">${PROMPT_CAT_LABELS[d.category] || d.category}</span>${d.agents.length ? `<span class="faint">· ${d.agents.join(',')}</span>` : '<span class="faint">· 全局</span>'}</div>
              <div class="mono faint" style="font-size:11px;margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${d.body.replace(/</g, '&lt;').slice(0, 80)}</div>
            </div>`).join('') : '<div class="faint">暂无提示词（新建后在此列出，可按 Agent 绑定与合并）</div>'}
          </div>
          ${state.promptConflicts.length ? `<div class="warn-list" style="margin-top:8px"><div class="badge warn">合并冲突 ${state.promptConflicts.length} 处（已显式标记，未静默覆盖）</div>${state.promptConflicts.slice(0, 4).map((c) => `<div style="font-size:11px;margin-top:4px">· ${PROMPT_CAT_LABELS[c.category] || c.category}：${c.docA} ↔ ${c.docB}</div>`).join('')}</div>` : ''}
        </div>
        <div class="sec-title" id="settings-section-desktop"><span class="ico">${ic('settings', 14)}</span>桌面集成</div>
        <div class="desktop-grid">
          ${desktopItem('tray', '系统托盘', '关闭窗口后继续运行')}
          ${desktopItem('shortcut', '全局快捷键', state.desktop && state.desktop.shortcutLabel ? state.desktop.shortcutLabel : 'Ctrl+Shift+Space', true)}
          ${desktopItem('autostart', '登录自启动', desktopAutostartDesc())}
          ${desktopItem('autoupdate', '自动更新', '新版本静默下载（退出时安装）')}
          ${desktopItem('floating', '悬浮窗', '桌面常驻小窗，点击唤起主窗')}
          ${desktopItem('notify', '开机提醒', '关键事件系统通知')}
          <div class="desktop-item"><div><div class="di-name">TRACE 遥测</div><div class="di-desc" id="trace-desc">脱敏遥测上报至 OrchDesk 公开仓库（仅白名单字段，不含任何消息内容）</div></div><div class="switch ${state.traceEnabled ? 'on' : ''}" id="trace-switch" data-action="trace-toggle"></div></div>
        </div>
        <div class="sec-title" id="settings-section-memory"><span class="ico">${ic('archive', 14)}</span>分层记忆（PRD FR-10）</div>
        <div class="card">
          <div class="faint" style="margin-bottom:8px">四域物理隔离，各落独立文件。Worker 出域（→ 总监 / 项目 / 全局）一律经 Director 过滤，<b>fail-closed</b>：过滤器缺失、超时、抛错都按拒绝处理。</div>
          <div class="row" style="gap:6px;margin-bottom:8px;align-items:center">
            <span class="faint" style="font-size:11.5px">转储摘要</span>
            ${!state.memorySummarize.loaded
    // 桥断了就**不要**沿用上一秒的状态：那会把「已断开」显示成「正在用某模型」，
    // 与记忆列表同类的毛病（陈旧状态冒充现状）。loaded=false 一律报未接入。
    ? '<span class="badge warn">摘要状态未接入</span><span class="faint" style="font-size:11px">主进程桥不可用</span>'
    : state.memorySummarize.mode === 'llm'
      ? `<span class="badge ok">模型摘要</span><span class="faint mono" style="font-size:11px">${esc(state.memorySummarize.provider || '模型')} / ${esc(state.memorySummarize.model)}</span>`
      : '<span class="badge warn">抽取式兜底</span><span class="faint" style="font-size:11px">未配置模型：自动转储只保留首尾各 3 条原文</span>'}
          </div>
          <div class="row" style="margin-bottom:6px;gap:6px">
            ${['worker', 'director', 'project', 'global'].map((d) => {
    const n = state.memory.stats && typeof state.memory.stats[d] === 'number' ? state.memory.stats[d] : null;
    return `<span class="seg-tab ${state.memory.domain === d ? 'active' : ''}" data-action="mem-domain" data-domain="${d}" title="${esc(MEM_DOMAIN_DESC[d])}">${MEM_DOMAIN_LABELS[d]}${n === null ? '' : ` ${n}`}</span>`;
  }).join('')}
            <button class="btn sm" style="margin-left:auto" data-action="mem-refresh" ${state.memory.busy ? 'disabled' : ''}>刷新</button>
          </div>
          <div class="faint" style="margin-bottom:8px;font-size:11.5px">${esc(MEM_DOMAIN_DESC[state.memory.domain])}</div>
          ${state.memory.domain === 'worker' ? `<div class="row" style="margin-bottom:8px"><button class="btn sm primary" data-action="mem-promote-worker" ${(state.memory.busy || !state.memory.items.length) ? 'disabled' : ''}>批量晋升本域（逐条过 Director 过滤）</button><span class="faint" style="font-size:11px">一次最多 20 条，按时间正序</span></div>` : ''}
          <div class="mem-list">
            ${state.memory.items.length ? state.memory.items.slice().sort((a, b) => Number(b.createdAt) - Number(a.createdAt)).map((e) => {
    const to = MEM_NEXT_DOMAIN[state.memory.domain];
    return `<div class="mem-item">
                <div class="mi-text" title="${esc(e.text)}">${esc(String(e.text || '').slice(0, 160))}</div>
                <div class="mi-meta">
                  <span class="mono faint">${esc(e.origin || '—')}</span>
                  ${e.agent ? `<span class="faint">${esc(e.agent)}</span>` : ''}
                  <span class="faint mono" style="margin-left:auto">${e.createdAt ? new Date(e.createdAt).toLocaleString('zh-CN') : ''}</span>
                </div>
                ${to ? `<button class="btn sm" data-action="mem-promote" data-id="${esc(e.id)}" data-from="${esc(state.memory.domain)}" data-to="${to}" ${state.memory.busy ? 'disabled' : ''}>晋升 → ${MEM_DOMAIN_LABELS[to]}</button>` : '<span class="faint" style="font-size:11px">已在顶层</span>'}
              </div>`;
  }).join('') : `<div class="faint">${state.memory.loaded ? (state.memory.domain === 'worker' ? '本域暂无条目（SubAgent 执行完被回收时，其结论会落到这里）' : '本域暂无条目（由下层晋升而来）') : '记忆服务未接入（主进程桥不可用）'}</div>`}
          </div>
          <div class="sec-title" style="margin:16px 0 8px">晋升审计</div>
          <div class="sblog-bar">
            <select id="mp-ok" class="inp" style="width:120px">
              ${[['all', '全部'], ['true', '已晋升'], ['false', '被拦下']].map(([v, t]) => `<option value="${v}"${state.memoryPromotions.ok === v ? ' selected' : ''}>${t}</option>`).join('')}
            </select>
            <button class="btn sm" data-action="mp-clear" ${state.memoryPromotions.total ? '' : 'disabled'}>清空</button>
          </div>
          <div class="sblog-stats mp-stats">
            <span class="badge info">共 ${state.memoryPromotions.total} 条</span>
            <span class="badge ok">已晋升 ${state.memoryPromotions.stats.promoted}</span>
            <span class="badge danger">被拦下 ${state.memoryPromotions.stats.rejected}</span>
            ${state.memoryPromotions.stats.byEdge.map((x) => `<span class="faint mono">${esc(x.edge)} ×${x.count}</span>`).join('')}
          </div>
          <div class="audit-log sblog mp-log">
            ${state.memoryPromotions.entries.length ? state.memoryPromotions.entries.map((e) => `<div class="al">
              <span class="mono" style="font-size:10.5px">${new Date(e.ts).toLocaleString('zh-CN')}</span>
              <span class="badge ${e.ok ? 'ok' : 'danger'}">${e.ok ? '已晋升' : '被拦下'}</span>
              <span class="mono faint">${esc(e.from)} → ${esc(e.to)}</span>
              <span class="badge info">${e.actor === 'auto' ? '自动' : '手动'}</span>
              <span class="mono" style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(e.preview)}">${esc(e.preview) || '<span class="faint">（无预览）</span>'}</span>
              <span class="faint" style="max-width:30%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(memReasonText(e.reason))}">${esc(memReasonText(e.reason))}</span>
            </div>`).join('') : `<div class="faint">${state.memoryPromotions.loaded ? '暂无晋升记录（在此点「晋升」后写入）' : '晋升审计未接入（主进程桥不可用）'}</div>`}
          </div>
        </div>
        <div class="sec-title" id="settings-section-data"><span class="ico">${ic('folder', 14)}</span>数据目录</div>
        <div class="card">
          <div class="row"><span class="mono">${esc(state.dataDirInventory.dir || '%APPDATA%/OrchDesk')}</span><span class="faint">· 本地优先，数据不出本机</span></div>
          ${state.dataDirInventory.ok
    ? `<div class="faint" style="margin-top:6px;font-size:11.5px">共 ${esc(state.dataDirInventory.totalSizeText)} · ${state.dataDirInventory.totalFiles} 个文件${state.dataDirInventory.errors.length ? ` · <span class="badge warn">${state.dataDirInventory.errors.length} 项扫描失败</span>` : ''}</div>
             <div class="dir-inv">${state.dataDirInventory.items.map((i) => `<div class="di-row">
               <span class="mono" style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(i.name)}">${ic(i.kind === 'dir' ? 'folder' : 'fileText', 12)} ${esc(i.name === '.' ? '（全部）' : i.name)}</span>
               ${i.kind === 'dir' ? `<span class="faint">${i.files} 个文件</span>` : ''}
               <span class="faint mono">${esc(i.sizeText || '')}</span>
             </div>`).join('') || '<div class="faint">目录为空（首次运行尚未产生数据）</div>'}</div>`
    : '<div class="faint" style="margin-top:6px;font-size:11.5px">内容清单未接入（主进程桥不可用）</div>'}
          <div class="row" style="margin-top:8px"><button class="btn sm" data-action="open-project-dir">打开目录</button><button class="btn sm" data-action="open-log-dir">打开日志</button><button class="btn sm" data-action="dir-inv-refresh">刷新清单</button><button class="btn sm" data-action="snapshot-data">导出快照</button><button class="btn sm primary" data-action="check-updates">检查更新（先快照）</button></div>
          <div class="row" style="margin-top:6px"><button class="btn sm" data-action="export-data">导出数据</button><button class="btn sm" data-action="import-data">导入数据</button><span class="faint" style="font-size:11px">跨设备迁移 · 只补齐不覆盖</span></div>
        </div>
        <div class="sec-title" id="settings-section-about"><span class="ico">${ic('at', 14)}</span>关于</div>
        <div class="card">
          <div class="row" style="justify-content:space-between"><span>OrchDesk 桌面壳</span><b>P6</b></div>
          <div class="faint" style="margin-top:4px">会话优先的本地 Agent 工作台</div>
          <div class="faint" style="margin-top:8px;font-size:11.5px">底座 deepseek-harness（Cordis）· 基线 99f6f02</div>
        </div>
        <div style="margin-top:14px"><button class="btn" data-action="wz-open">重新打开入门向导</button></div></div>`;
    },
    ctx() {
      return `<div class="sec-title">凭据</div>
        <div class="faint">API Key 以 AES-256-GCM 加密存储；界面只显示掩码。</div>
        <div class="sec-title">一切皆插件</div>
        <div class="faint">模型、提示词、沙箱、授权、记忆等均为插件；关闭即卸载并回滚其注册（可逆效应），无残留。</div>
        <div class="sec-title">快捷操作</div>
        <div class="card" style="padding:10px">
          <div class="row" style="padding:4px 0"><span>备份整个数据目录</span>
            <span class="faint mono" style="margin-left:auto">${state.dataDirInventory.ok ? esc(state.dataDirInventory.totalSizeText) : '未接入'}</span>
            <button class="btn sm" data-action="export-data">导出</button></div>
          <div class="row" style="padding:4px 0"><span>打开数据目录</span>
            <span class="faint mono" style="margin-left:auto">${state.dataDirInventory.ok ? state.dataDirInventory.totalFiles + ' 个文件' : ''}</span>
            <button class="btn sm" data-action="open-project-dir">打开</button></div>
          <div class="row" style="padding:4px 0"><span>打开日志目录</span><button class="btn sm" style="margin-left:auto" data-action="open-log-dir">打开</button></div>
        </div>`;
    }
  };

  /* ---------- 向导 ---------- */
  const WZ = [
    { t: '欢迎使用 OrchDesk', h: `<div style="font-size:18px;font-weight:700;margin-bottom:8px">本地优先的 Agent 工作台</div>
      <div class="mut" style="margin-bottom:14px">打开就是会话。像 DSH 一样，你只需和一个 Agent 对话；脑-手解耦、多Agent编排、意图识别在后台安静运行，需要时再进「插件」或「设置」。</div>
      <div style="border:1px solid var(--border);border-radius:8px;padding:10px 12px;display:flex;gap:10px;align-items:center"><span class="badge ok">就绪</span><div><b>deepseek-harness 运行时</b><div class="faint mono">基线 99f6f02 · 本地运行</div></div></div>` },
    { t: '选择默认专家', h: `<div style="margin-bottom:10px" class="mut">你想先和谁对话？（之后可随时切换，或用专家团）</div>
      ${expertList().map((e, i) => `<div class="expert-opt ${state.wzExpert === i ? 'sel' : ''}" data-action="wz-expert" data-i="${i}"><div class="avatar" style="background:${i === 0 ? 'var(--ceo)' : 'var(--director)'}">${e[0]}</div><div><b>${e}</b><div class="faint">${i === 0 ? '主会话：理解/拆解/回收/沉淀' : '领域专家'}</div></div></div>`).join('')}` }
  ];
  function renderWizard() {
    $('#wzBody').innerHTML = WZ[state.wz].h;
    $('#wzNext').textContent = state.wz === 0 ? '下一步' : '进入会话';
  }

  /* ---------- 引擎 ---------- */
  function updateProtocolRow() {
    const t = $('#mp-type')?.value;
    const row = $('#mp-mode-row');
    if (row) row.style.display = t === 'openai-compatible' ? '' : 'none';
  }
  function renderModelProviders() {
    const el = $('#model-providers-list');
    if (!el) return;
    const providers = state.modelProviders || [];
    if (!providers.length) {
      el.innerHTML = '<div class="faint prov-empty">尚未配置模型提供商，请使用下方表单添加。<br>添加后可在对话中调用真实模型 API（OpenAI 兼容或 Ollama 本地），API Key 经系统安全存储加密。</div>';
      return;
    }
    const modeLabel = { chat: 'Chat', responses: 'Responses', completions: 'Completions', ollama: 'Ollama' };
    el.innerHTML = providers.map(p => `<div class="prov-row" data-id="${p.id}">
      <div class="prov-info">
        <div class="prov-name"><b>${esc(p.name)}</b><span class="badge info">${p.type === 'ollama' ? 'Ollama 本地' : 'OpenAI 兼容 · ' + (modeLabel[p.apiMode] || 'Chat')}</span></div>
        <div class="prov-detail"><span class="mono faint">${esc(p.baseUrl)}</span><span class="faint">·</span><span class="faint">${(p.models || []).join(', ')}</span></div>
      </div>
      <div class="prov-actions"><button class="btn sm ghost" data-action="model-test" data-id="${esc(p.id)}" data-n="${esc((p.models || [])[0] || p.name)}">测试</button><button class="btn sm" data-action="model-edit-provider" data-id="${p.id}">编辑</button><button class="btn sm danger" data-action="model-del-provider" data-id="${p.id}">删除</button></div>
    </div>`).join('');
    refreshDefaultModelPicker();
  }

  function refreshDefaultModelPicker() {
    const wrap = $('#default-model-pick-wrap');
    if (!wrap) return;
    const allModels = (state.modelProviders || []).flatMap(p => (p.models || []).map(m => ({ n: m, pn: p.name, pt: p.type })));
    const pick = wrap.querySelector('select');
    if (!pick) return;
    pick.innerHTML = allModels.map(m =>
      `<option value="${esc(m.n)}" ${state.defaultModel === m.n ? 'selected' : ''}>${esc(m.pn)} (${m.pt === 'ollama' ? '本地' : 'API'}) · ${esc(m.n)}</option>`
    ).join('');
    wrap.style.display = allModels.length ? '' : 'none';
  }

  function render() {
    try {
      renderRail();
      const v = VIEWS[state.page];
      if (!v) {
        $('#main').innerHTML = '<div style="color:red;padding:40px">未知页面：' + esc(state.page) + '</div>';
        return;
      }
      $('#side').innerHTML = v.side();
      $('#main').innerHTML = v.main();
      $('#context').innerHTML = v.ctx();
      $('#appGrid').classList.toggle('has-ctx', state.ctxOpen);
      $('#winTitle').textContent = (PAGES.find((x) => x.id === state.page)?.n || '会话') + ' — 本地 Agent 工作台';
      // P1 键盘可达（/harden）：渲染后给所有非原生可交互的 [data-action] 补
      // role/tabindex —— 项目惯用 div+data-action，靠逐个补必漏（焦点样式有了，
      // 但没有 tabindex 焦点根本到不了）。委托层一次性收敛，新元素自动继承。
      hardenActions($('#main')); hardenActions($('#side')); hardenActions($('#context'));
      if (state.page === 'plugins') { plugSearchFilter(); skillSearchFilter(); }
      if (state.page === 'settings') renderModelProviders();
      if (state.page === 'settings' && state.settingsSection) {
        const target = $('#settings-section-' + state.settingsSection);
        if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        document.querySelectorAll('[data-action="settings-nav"]').forEach(el => {
          // 用 class 而非 inline background（2026-09-06）：active 高亮走 .settings-nav-item.active
          el.classList.toggle('active', el.dataset.id === state.settingsSection);
        });
      } else if (state.page === 'settings') {
        // 首次进入设置页未选分区：高亮第一项（模型）
        document.querySelectorAll('[data-action="settings-nav"]').forEach(el => {
          el.classList.toggle('active', el.dataset.id === 'model');
        });
      }
      const sc = $('#msgScroll'); if (sc) sc.scrollTop = sc.scrollHeight;
    } catch (err) {
      console.error('[render] ERROR:', err);
      $('#main').innerHTML = '<div style="color:#EF4444;padding:40px;font-family:monospace"><b>渲染错误</b><pre>' + (err && err.stack || err) + '</pre></div>';
    }
  }

  /* ---------- P1 键盘可达（/harden，2026-09-06） ----------
   * 在委托层为 div[data-action] 统一补无障碍属性，取代「逐个补」——
   * 逐个补会在每次新增交互元素时漏一个（此前全项目 tabindex=0 即是证据）。
   * 只处理没有原生交互语义的标签（div/span/li），button/input/select 本身可聚焦。
   * 键盘触发（Enter/Space）由 body 级 keydown 委托统一接管（见 init 末尾）。 */
  /* ---------- 技能市场搜索过滤（2026-09-06）----------
   * 与插件搜索同套路：运行时不触发 render（保输入焦点），按 #skillSearch 词
   * 切换表格行可见性并更新命中计数。词来自 <input>，不做 DOM 重建。 */
  function skillSearchFilter() {
    const inp = $('#skillSearch');
    if (!inp) return;
    const q = inp.value.trim().toLowerCase();
    const rows = document.querySelectorAll('tr[data-skill-search]');
    let shown = 0;
    rows.forEach((r) => {
      const hit = !q || (r.dataset.skillSearch || '').includes(q);
      r.style.display = hit ? '' : 'none';
      if (hit) shown++;
    });
    const cnt = $('#skillSearchCount');
    if (cnt) cnt.textContent = q ? `命中 ${shown}/${rows.length}` : '';
  }

  function hardenActions(root) {
    if (!root) return;
    root.querySelectorAll('[data-action]').forEach((el) => {
      const tag = el.tagName;
      if (tag === 'BUTTON' || tag === 'INPUT' || tag === 'SELECT' || tag === 'A' || tag === 'TEXTAREA') return;
      if (el.hasAttribute('role')) return;   // 已显式给过 role（如 .switch 的 role="switch"）不覆盖
      if (el.closest('[role="menu"]')) return; // 菜单项键盘由方向键/Enter 处理，不强制 tab
      el.setAttribute('role', 'button');
      if (el.hasAttribute('tabindex')) return; // 已显式给过（编辑器输入等）不抢
      el.tabIndex = 0;
    });
  }

  /* ---------- 插件页搜索过滤（2026-09-06） ----------
   * 在运行时按 #plugSearch 词隐藏/显示内置插件卡片，并更新命中计数。
   * 不清空 #plugSearch（input 里的词是用户正在输入的焦点所在），只改卡片可见性，
   * 所以不触发 render()，不丢焦点。空词 = 全部显示。 */
  function plugSearchFilter() {
    const inp = $('#plugSearch');
    if (!inp) return;
    const q = inp.value.trim().toLowerCase();
    state.plugSearch = inp.value; // 供「切走再切回」保留词（render 会回填 value）
    const cards = document.querySelectorAll('.plug[data-pid]');
    let shown = 0;
    cards.forEach((c) => {
      const hit = !q || (c.dataset.search || '').includes(q);
      c.style.display = hit ? '' : 'none';
      if (hit) shown++;
    });
    const cnt = $('#plugSearchCount');
    if (cnt) cnt.textContent = q ? `命中 ${shown}/${cards.length}` : '';
    const empty = $('#plugSearchEmpty');
    if (empty) empty.style.display = (q && shown === 0) ? 'block' : 'none';
  }

  function updateTraceUi() {
    const sw = $('#trace-switch');
    if (sw) sw.classList.toggle('on', state.traceEnabled);
    const desc = $('#trace-desc');
    if (desc) desc.textContent = state.traceBuiltin
      ? (state.traceEnabled
        ? '脱敏遥测上报至 OrchDesk 公开仓库（仅白名单字段，不含任何消息内容）'
        : '已关闭（重启后完全生效）——遥测仅本地缓冲，不上传')
      : '未内置上报凭据（开发模式）——遥测仅本地缓冲，不上传';
  }

  function toast(msg, type = '') {
    const t = document.createElement('div'); t.className = 'toast ' + type; t.textContent = msg;
    $('#toastRoot').appendChild(t); setTimeout(() => t.remove(), 3200);
  }

  /* ---------- Markdown 渲染器（基于 marked.js） ---------- */
  function renderMD(md) {
    if (!md) return '';
    try {
      const raw = typeof marked !== 'undefined' ? marked.parse(md, { gfm: true, breaks: false }) : esc(md);
      // marked 输出可能含 HTML 标签，仅对非代码部分转义
      // 简单策略：对 < 标签做白名单过滤（只保留 marked 生成的 HTML 标签）
      return raw.replace(/<(?!\/?(pre|code|h[1-6]|ul|ol|li|p|br|strong|b|em|i|a|blockquote|table|thead|tbody|tr|td|th|sup|sub|hr|del|s|strike)\b)[^>]*>/gi, '&lt;$0').replace(/&lt;\/(pre|code|h[1-6]|ul|ol|li|p|strong|b|em|i|a|blockquote|table|thead|tbody|tr|td|th|sup|sub|del|s|strike)>/, '</$1>');
    } catch {
      return esc(md);
    }
  }

  function openProductPreview(name, content, lang) {
    const body = document.createElement('div');
    body.className = 'ctx-preview-overlay';
    body.innerHTML = `<div class="ctx-preview-card">
      <div class="ctx-preview-head">
        <span class="ph-title">${esc(name)}${lang ? ' <span class="faint" style="font-weight:400;font-size:11px">' + esc(lang) + '</span>' : ''}</span>
        <button class="ctx-preview-close" data-action="preview-close">✕</button>
      </div>
      <div class="ctx-preview-body">${renderMD(content)}</div>
    </div>`;
    document.body.appendChild(body);
    body.addEventListener('click', (e) => {
      if (e.target.closest('[data-action="preview-close"]') || e.target === body) body.remove();
    });
  }
  function openModal(html) { $('#modalRoot').innerHTML = `<div class="overlay" data-action="modal-bg"><div class="modal">${html}</div></div>`; }
  function closeModal() { $('#modalRoot').innerHTML = ''; }

  function openMenu(anchor, items) {
    $('#menuRoot').innerHTML = '';
    const r = anchor.getBoundingClientRect();
    const pop = document.createElement('div');
    pop.className = 'pop';
    pop.style.top = (r.bottom + 4) + 'px';
    pop.style.left = (r.right - 180) + 'px';
    pop.innerHTML = items.map((it) => `<div class="mi ${it.danger ? 'danger' : ''}" data-action="menu-item" data-id="${it.id || ''}">${it.svg ? `<span>${it.svg}</span>` : ''}<span>${it.label}</span></div>`).join('');
    $('#menuRoot').appendChild(pop);
    setTimeout(() => {
      document.addEventListener('click', function close(ev) {
        if (!ev.target.closest('.pop')) { $('#menuRoot').innerHTML = ''; document.removeEventListener('click', close); }
      }, { once: true });
    }, 0);
  }

  /* ---------- 会话工作区（BUG-023）：项目绑定目录 → 会话默认 cwd ---------- */
  // 主进程 sessionCwds 是进程内 Map（重启即失），所以「创建会话 / 打开会话 /
  // 重选项目 / 分叉」每次都要重放一次；无绑定或任务模式跳过（不误设）。
  // 失败必须可见（toast），不许静默——静默会让工作区悄悄回落 user home，
  // Agent 又在 C:\Users\my 里找 git 仓库，正是本 BUG 的形态。
  function projectPathOf(sid) {
    const s = state.sessions[sid];
    if (!s || !s.pid || s.pid === '__task__') return '';
    const p = state.projects.find((x) => x.id === s.pid);
    return p ? String(p.path || '').trim() : '';
  }

  async function applySessionCwd(sid) {
    const dir = projectPathOf(sid);
    if (!dir) return;
    try {
      const r = await bridge.setSessionCwd(sid, dir);
      if (!r || r.ok !== true) toast(`项目工作区未生效：${(r && r.reason) || '未知原因'}`, 'warn');
    } catch {
      toast('项目工作区未设置（桥不可用）', 'warn');
    }
  }

  function createSessionInProject(pid) {
    const id = 's' + Date.now().toString(36);
    const p = state.projects.find((x) => x.id === pid);
    const s = { id, pid, title: '新会话', expert: expertList()[state.wzExpert] || expertList()[0], model: state.selectedModels[0] || '—', updated: '刚刚', ts: nowTime(), msgs: [] };
    state.sessions[id] = s;
    if (p && !p.sessions.includes(id)) p.sessions.push(id);
    state.pExpanded.add(pid);
    state.sel = id;
    state.selProjForComposer = pid;
    state.projDropdownOpen = false;
    persist(); render();
    applySessionCwd(id);
    const pName = p ? p.n : pid;
    toast(`已新建会话 → ${pName}`, 'ok');
  }

  /* ---------- 会话操作（真实落盘，经桥） ---------- */
  function findProjectOf(sid) { return state.projects.find((p) => p.sessions.includes(sid)); }
  function touch(s) { s.updated = '刚刚'; }

  function doNewConv() {
    state.newConvMode = true;
    state.sel = null;
    render();
  }

  async function doSend() {
    const c = $('#composer'); if (!c) return;
    const text = c.value.trim();
    if (!text) { toast('输入为空', 'warn'); return; }
    if (state.selectedModels.length === 0) {
      // 配置可能在「设置 → 模型」刚更新过，或上一次 getModelConfig 请求失败，
      // 发送前再自动选择一次；仍为空才拦截（并给出可达的路径，而非死胡同）。
      autoSelectModels(state.modelProviders, state.defaultProvider, state.defaultModel);
      if (state.selectedModels.length === 0) {
        toast('未检测到可用模型 · 已跳转到「设置 → 模型管理」', 'warn');
        state.page = 'settings'; state.settingsSection = 'model'; render();
        return;
      }
    }
    const s = state.sessions[state.sel]; if (!s) return;
    const t = nowTime();
    s.msgs.push({ r: 'user', t, x: text }); touch(s);
    const typingIdx = s.msgs.push({ r: 'agent', t, x: '', typing: true }) - 1;
    // BUG（全盘死挂点扫描）：toolSteps 此前「有写入（onToolStep 订阅）无读取」=存而不显。
    // 新回合开始时清空本会话轨迹；回合中 renderMsg 的 typing 分支实时读它；回合结束把
    // runAgentTurn 返回的 tools/steps 静态写入该条 agent 消息（renderMsg 的「N 步 · M 个
    // 动作」展示形态随即生效）。
    state.toolSteps[s.id] = [];
    render();
    try {
      const res = await bridge.runAgentTurn(s.id, text, { models: state.selectedModels, thinkLevel: state.thinkLevel });
      const tsteps = (res && Array.isArray(res.tools) && res.tools.length) ? res.tools : undefined;
      s.msgs[typingIdx] = {
        r: 'agent', t: nowTime(), x: res.text, intent: res.intent || 'ACT', feedback: 1,
        tools: tsteps,
        steps: tsteps ? tsteps.length : (Number(res && res.steps) || undefined),
      };
      touch(s); persist(); render();
      // typing 消息已被静态消息替换（tools 已随消息落库展示），live 轨迹不再需要
      delete state.toolSteps[s.id];
      toast(`已入会话日志 · ${state.selectedModels.length} 模型 · 思维 ${thinkLabel(state.thinkLevel)}`, 'ok');
    } catch (err) {
      s.msgs[typingIdx] = { r: 'agent', t: nowTime(), x: '（模型回合失败：' + (err && err.message ? err.message : err) + '）' };
      delete state.toolSteps[s.id];
      render();
      toast('模型回合失败', 'danger');
    }
  }

  async function doRename(sid, title) {
    const s = state.sessions[sid]; if (!s) return;
    s.title = title || s.title; touch(s); persist(); render();
    toast(`已重命名为「${s.title}」`, 'ok');
  }

  /**
   * 会话分叉（PRD FR-6）。
   * @param sid     源会话
   * @param name    分支名
   * @param atIndex 分叉点：继承前 atIndex 条消息（缺省 = 全部继承）。
   *                旧实现恒深拷贝全部消息，没有真正的「分叉点」概念。
   */
  async function doFork(sid, name, atIndex) {
    const src = state.sessions[sid];
    if (!src) return;
    if (!FORK) { toast('分叉模块未加载（session-fork.js 缺失）', 'err'); return; }
    const srcMsgs = Array.isArray(src.msgs) ? src.msgs : [];
    const id = 's' + Date.now().toString(36);
    const s = deepClone(src);
    const pid = src.pid && src.pid !== '__task__' ? src.pid : (state.projects.find((p) => !p.archived) || {}).id || '__task__';
    // 分叉点：由 FORK.makeForkLineage 夹到 [0, srcMsgs.length]，消息切片用同一个
    // idx，保证「血缘记录的分叉点」与「实际继承的条数」永远一致。
    const idx = FORK.makeForkLineage(src, Number(atIndex)).atIndex;
    s.id = id;
    s.title = name || ('分支-' + (src.title || sid));
    s.pid = pid;
    s.updated = '刚刚';
    // 血缘：from + 分叉点 + 源标题快照（源被删后仍可读）
    s.fork = FORK.makeForkLineage(src, idx);
    delete s.forkedFrom; delete s.forkedAt;
    // 只继承分叉点之前的消息。必须从 s.msgs（deepClone 产物）里切，不能从
    // src.msgs 切 —— 后者元素仍是源会话的对象引用，分支与源会共享消息对象。
    s.msgs = FORK.forkMessages(s.msgs, idx);
    state.sessions[id] = s;
    const proj = state.projects.find((p) => p.id === pid);
    if (proj && !proj.sessions.includes(id)) proj.sessions.unshift(id);
    state.sel = id; state.replayFor = null; persist(); render();
    applySessionCwd(id);
    // FR-6（ADR-0009）：分叉落事件——子日志只写一条 fork-origin 血缘，不拷贝父事件。
    // 写失败不回滚分叉（sessions.json 仍是运行态事实源），只如实提示。
    bridge.appendForkEvent({ newId: id, from: sid, fromTitle: src.title || sid, atIndex: idx, at: (s.fork && s.fork.at) || Date.now() })
      .then((r) => { if (!r || r.ok !== true) toast('事件流未记录分叉血缘' + (r && r.reason ? '：' + r.reason : ''), 'warn'); })
      .catch(() => toast('事件流未接入，分叉血缘未记录', 'warn'));
    toast(idx >= srcMsgs.length
      ? '已创建分支（继承全部消息，独立写入）'
      : `已从第 ${idx} 条消息处分叉（继承前 ${idx} 条）`, 'ok');
  }

  async function doDeleteSession(sid) {
    const from = findProjectOf(sid);
    if (from) from.sessions = from.sessions.filter((x) => x !== sid);
    delete state.sessions[sid];
    if (state.sel === sid) {
      state.sel = Object.keys(state.sessions)[0] || null;
    }
    persist(); render();
    toast(`会话 #${sid} 已删除`, 'warn');
  }

  async function doArchiveSession(sid) {
    const s = state.sessions[sid]; if (!s) return;
    const from = findProjectOf(sid);
    if (from) from.sessions = from.sessions.filter((x) => x !== sid);
    const arc = state.projects.find((p) => p.archived === 1) || state.projects.find((p) => p.id === 'p3');
    if (arc && !arc.sessions.includes(sid)) arc.sessions.unshift(sid);
    s.pid = arc ? arc.id : s.pid; s.archived = 1;
    if (state.sel === sid) state.sel = state.projects[0].sessions[0] || sid;
    persist(); render();
    toast(`会话「${s.title}」已归档`, 'warn');
  }

  async function doArchiveProject(pid) {
    const p = state.projects.find((x) => x.id === pid); if (!p) return;
    // 将所有归档会话统一归入"已归档"虚拟容器
    let arch = state.projects.find((x) => x.id === '__archived__');
    if (!arch) {
      arch = { id: '__archived__', n: '已归档', d: '', open: 0, archived: 1, sessions: [] };
      state.projects.push(arch);
    }
    // 将项目内所有会话移入归档容器
    p.sessions.forEach((sid) => {
      if (!arch.sessions.includes(sid)) arch.sessions.push(sid);
      const s = state.sessions[sid]; if (s) { s.pid = arch.id; s.archived = 1; }
    });
    p.sessions = [];
    p.archived = 1; p.open = 0;
    state.pExpanded.delete(pid);
    state.pExpanded.add('__archived__');
    persist(); render();
    toast(`项目「${p.n}」已归档`, 'warn');
  }

  /* ---------- 授权模式选择（T-P3-2） ---------- */
  // 从更严模式切到更松模式需二次确认（防 L4 风险）。
  const MODE_RANK = { paranoid: 0, default: 1, trusted: 2 };
  function confirmSwitchAuth(target) {
    const targetSpec = authModesForRender().find((m) => m.id === target);
    const loosening = (MODE_RANK[target] ?? 1) > (MODE_RANK[state.authMode] ?? 1);
    const danger = target === 'trusted' || target === 'default' ? '' : '';
    openModal(`<div class="mh ${loosening ? 'danger' : ''}">${ic('shield', 18)}<b>切换授权模式到「${targetSpec ? targetSpec.label : target}」？</b></div>
      <div class="mb">
        <div>${targetSpec ? targetSpec.blurb : ''}</div>
        ${loosening ? `<div class="warn-list" style="margin-top:10px">
          <div>· 从「偏执/默认」切到更松模式会放宽沙箱约束</div>
          <div>· L3/L4 操作（网络/Shell）仍会弹窗确认（fail-closed）</div>
          <div>· 切换经 session 事件持久化，重启后保持</div>
        </div>` : ''}
      </div>
      <div class="mf">
        <button class="btn ghost" data-action="modal-cancel">取消</button>
        <button class="btn ${loosening ? 'danger' : 'primary'}" data-action="auth-do-switch" data-id="${target}">确认切换</button>
      </div>`);
  }
  function openAuthPicker() {
    openModal(`<div class="mh">${ic('shield', 18)}<b>选择授权模式</b></div>
      <div class="mb">
        <div class="faint" style="margin-bottom:10px">三模式映射到 dsh 沙箱（read-only / workspace-write）与审批策略（ask / never）。</div>
        ${authModesForRender().map((m) => `<div class="row" style="padding:9px 10px;border:1px solid ${state.authMode === m.id ? 'var(--accent)' : 'var(--border)'};border-radius:8px;margin-bottom:7px;cursor:pointer" data-action="auth-mode-pick" data-id="${m.id}">
          <div style="flex:1"><b>${m.label}</b>${state.authMode === m.id ? ' <span class="badge ok">当前</span>' : ''}<div class="faint" style="font-size:11px;margin-top:3px">${m.blurb}</div></div>
          ${state.authMode === m.id ? '' : '<button class="btn sm">选择</button>'}
        </div>`).join('')}
      </div>
      <div class="mf"><button class="btn ghost" data-action="modal-cancel">关闭</button></div>`);
  }

  /* ---------- 浏览器面板（ADR-0011：内置 CDP 浏览器） ---------- */
  // Agent 默认在**后台隐藏窗口**里操作网页（保留登录态、不打断用户），若没有面板
  // 就成了黑箱：用户既不知道它打开了哪个页面，也没法叫停。面板承担三件事：
  // 看现状（标题/地址/最近截图）、调出或收回窗口、一键关闭。
  function applyBrowserState(st) {
    if (!st || typeof st !== 'object') return;
    const prev = state.browser;
    state.browser = {
      loaded: true,
      open: !!st.open,
      url: st.url || '',
      title: st.title || '',
      visible: !!st.visible,
      lastShot: st.lastShot || null,
      lastError: st.lastError || '',
      shotsDir: st.shotsDir || prev.shotsDir || '',
      pages: Array.isArray(st.pages) ? st.pages.slice() : (prev.pages || []),
      activePageId: st.pages && st.pages.find((p) => p.active) ? st.pages.find((p) => p.active).id : (prev.activePageId || null),
    };
    // 需求3：Agent 一调用浏览器就自动展开侧栏（并顶替任务监控），用户不必去找开关。
    // 只在「从未打开 → 打开」这个跃迁上自动展开，避免用户手动收起后被每次状态推送弹回来。
    if (state.browser.open && !prev.open) state.browserSideOpen = true;
    // 浏览器关了（窗口收起/全关）→ 侧栏也跟着收起，任务监控自动回来
    if (!state.browser.open && prev.open) state.browserSideOpen = false;
    renderStatusBarActions();
    renderBrowserSide();
  }

  /**
   * 浏览器侧栏（需求3）：与任务监控共用第 4 列，展开时顶替任务监控。
   * 内容 = 页面快照 TAB 列表（底层是单隐藏 CDP 窗口，同一时刻只有一个活跃页面，
   * 卡片表达的是「Agent 先后访问过哪些页面」，不是多标签浏览器）。
   */
  function renderBrowserSide() {
    const host = $('#browserSide');
    if (!host) return;
    const app = $('#appGrid');
    if (app) app.classList.toggle('browser-mode', !!state.browserSideOpen);
    if (!state.browserSideOpen) { host.innerHTML = ''; return; }
    const b = state.browser;
    const pages = b.pages || [];
    const closeBtn = '<button class="bw-side-x" data-action="bw-side-close" title="收起侧栏（回到任务监控）">' + ic('x', 13) + '</button>';
    if (!b.loaded) {
      host.innerHTML = `<div class="bw-head">${ic('globe', 14)}<b>浏览器</b>${closeBtn}</div>`
        + '<div class="bw-empty">未接入主进程，浏览器状态不可用。</div>';
      return;
    }
    if (!pages.length) {
      host.innerHTML = `<div class="bw-head">${ic('globe', 14)}<b>浏览器</b>${closeBtn}</div>`
        + '<div class="bw-empty">浏览器未打开。<br><span style="font-size:10.5px">让 Agent 访问网页时会自动打开并在此登记页面</span></div>';
      return;
    }
    const tabsHTML = pages.map((p) => {
      const host2 = (() => { try { return new URL(p.url).hostname; } catch { return p.url; } })();
      return `<div class="bw-tab${p.active ? ' active' : ''}" data-action="bw-tab-focus" data-id="${esc(p.id)}" title="${esc(p.url)}">
        ${p.shot ? `<img class="bw-tab-shot" src="${esc(p.shot)}" alt="">` : `<div class="bw-tab-shot ph">${ic('image', 18)}</div>`}
        <div class="bw-tab-meta">
          <div class="bw-tab-title">${esc(p.title || host2 || '(无标题)')}</div>
          <div class="bw-tab-url">${esc(host2)}</div>
        </div>
        <button class="bw-tab-x" data-action="bw-tab-close" data-id="${esc(p.id)}" title="关闭这个页面">${ic('x', 12)}</button>
      </div>`;
    }).join('');
    host.innerHTML = `<div class="bw-head">${ic('globe', 14)}<b>浏览器</b>`
      + `<span class="badge${b.visible ? ' ok' : ''}">${b.visible ? '窗口已显示' : '后台运行'}</span>`
      + `<button class="btn sm ghost" data-action="${b.visible ? 'browser-hide' : 'browser-show'}">${b.visible ? '收回' : '显示'}</button>`
      + `<button class="btn sm ghost" data-action="bw-tab-clear" title="关闭全部页面">${ic('xAll', 12)}</button>`
      + closeBtn + `</div>`
      + `<div class="bw-tabs">${tabsHTML}</div>`
      + `<div class="bw-foot faint">单窗口模型：同一时刻只有一个活跃页面，卡片是 Agent 访问过的页面快照。点击卡片＝显示该页。</div>`;
  }

  /**
   * 状态栏右下角图标区：浏览器 / 终端。
   * 标题栏的三个文字按钮（浏览器/终端/文件）已下移：文件进右栏 TAB，
   * 浏览器与终端改为这里的图标——未激活灰、激活点亮，点击切换开关。
   * 只在首次建 DOM，之后仅改 class/title，避免频繁重绘丢焦点。
   */
  function renderStatusBarActions() {
    const host = $('#sbActions');
    if (!host) return;
    const b = state.browser;
    const t = state.terminal;
    if (host.childElementCount !== 2) {
      host.innerHTML = `<button class="sb-icon" data-action="browser-panel" id="browserBtn"></button>`
        + `<button class="sb-icon" data-action="terminal-panel" id="terminalBtn"></button>`;
    }
    const bBtn = $('#browserBtn');
    const tBtn = $('#terminalBtn');
    if (bBtn) {
      const on = !!b.open;
      bBtn.innerHTML = ic('globe', 15);
      bBtn.classList.toggle('on', on);
      bBtn.classList.toggle('unavailable', !b.loaded);
      bBtn.title = !b.loaded ? '内置浏览器（未接入主进程）'
        : on ? `内置浏览器：${b.title || b.url || '已打开'}${b.visible ? '' : '（后台运行）'} · 点击${state.browserSideOpen ? '收起' : '展开'}侧栏`
          : '内置浏览器（未打开）· Agent 访问网页时自动显示';
    }
    if (tBtn) {
      const on = !!state.terminalPanelOpen;
      tBtn.innerHTML = ic('terminal', 15);
      tBtn.classList.toggle('on', on);
      tBtn.classList.toggle('unavailable', !(t && t.loaded));
      tBtn.title = !(t && t.loaded) ? '终端（未接入主进程）'
        : `${on ? '收起' : '展开'}终端${t.ptyAvailable ? '' : '（node-pty 不可用，管道模式降级）'}`;
    }
  }

  /** 兼容旧调用点：浏览器状态变化后刷新状态栏图标。 */
  function renderBrowserBadge() { renderStatusBarActions(); }

  function loadBrowserStatus() {
    if (typeof bridge.getBrowserStatus !== 'function') return Promise.resolve();
    return bridge.getBrowserStatus()
      .then((st) => { applyBrowserState(st); })
      .catch((err) => { console.warn('[browser] 状态拉取失败:', err && err.message); });
  }

  function browserPanelHTML() {
    const b = state.browser;
    if (!b.loaded) {
      return `<div class="mh">${ic('globe', 18)}<b>内置浏览器</b></div>
        <div class="mb"><div class="faint">未接入主进程，浏览器状态不可用。</div></div>
        <div class="mf"><button class="btn ghost" data-action="modal-cancel">关闭</button></div>`;
    }
    const shot = b.lastShot;
    const stateText = b.open ? (b.visible ? '已显示' : '后台运行') : '未打开';
    return `<div class="mh">${ic('globe', 18)}<b>内置浏览器</b><span class="bw-dot ${b.open ? 'on' : ''}"></span><span class="faint" style="font-size:11px">${stateText}</span></div>
      <div class="mb">
        ${b.open
    ? `<div class="bw-row"><span class="bw-k">标题</span><span class="bw-v">${esc(b.title || '(无)')}</span></div>
           <div class="bw-row"><span class="bw-k">地址</span><span class="bw-v bw-url">${esc(b.url || '(无)')}</span></div>`
    : `<div class="faint" style="padding:6px 0">浏览器未打开。让 Agent 访问网页时它会自动打开（也可直接说「打开 xxx 网站」）。</div>`}
        ${shot ? `<div class="bw-shot">
          <div class="bw-k" style="margin-bottom:6px">最近截图</div>
          ${shot.dataUrl ? `<img class="bw-img" src="${esc(shot.dataUrl)}" alt="页面截图">` : '<div class="faint">（本次截图无预览缩略图）</div>'}
          ${shot.path ? `<div class="bw-path" title="${esc(shot.path)}">${esc(shot.path)}</div>` : ''}
        </div>` : ''}
        ${b.lastError ? `<div class="bw-err">最近错误：${esc(b.lastError)}</div>` : ''}
        <div class="faint" style="font-size:11px;margin-top:10px">点击 / 输入 / 执行脚本会改变页面状态，需经授权确认；每次操作都记入沙箱日志。</div>
      </div>
      <div class="mf">
        <button class="btn ghost" data-action="browser-shot-dir">截图目录</button>
        <span class="row" style="margin-left:auto">
          ${b.open ? (b.visible
    ? '<button class="btn sm" data-action="browser-hide">收回后台</button>'
    : '<button class="btn sm" data-action="browser-show">显示窗口</button>') : ''}
          <button class="btn sm ghost" data-action="browser-close" ${b.open ? '' : 'disabled'}>关闭浏览器</button>
          <button class="btn ghost" data-action="modal-cancel">关闭</button>
        </span>
      </div>`;
  }

  function openBrowserPanel() {
    state.browserPanelOpen = true;
    openModal(browserPanelHTML());
  }

  /** 面板打开时状态变化 → 重绘（用户在看面板，内容必须跟着实时变）。 */
  function rerenderBrowserPanelIfOpen() {
    if (state.browserPanelOpen && $('#modalRoot .bw-dot, #modalRoot .bw-shot, #modalRoot .mb')) {
      openModal(browserPanelHTML());
    }
  }

  async function browserAct(fn, okMsg) {
    try {
      const r = await fn();
      if (r && r.ok === false) { toast(r.reason || '操作失败', 'err'); return; }
      if (r && r.state) applyBrowserState(r.state);
      else await loadBrowserStatus();
      if (okMsg) toast(okMsg, 'ok');
    } catch (err) {
      toast(`浏览器操作失败：${(err && err.message) || err}`, 'err');
    }
    rerenderBrowserPanelIfOpen();
  }

  /* ---------- 终端面板（P2-10：node-pty 正路 + 管道模式显式降级） ---------- */
  // 终端是「用户亲手操作」的入口，与浏览器面板（观察 Agent）相反。
  // xterm 实例与滚动位置不能随状态推送重绘 —— 所以走全屏覆盖层 +
  // 「骨架只建一次，头部与可见性单独更新」，不走 modal 体系。
  const termHandles = new Map(); // id -> { cont, term, fit, pre }

  function xtermAvailable() { return typeof window !== 'undefined' && window.Terminal; }
  function fitAvailable() { return typeof window !== 'undefined' && window.FitAddon && window.FitAddon.FitAddon; }

  function ensureTermSkeleton() {
    const root = $('#terminalRoot');
    if (root.dataset.ready) return;
    root.innerHTML = '<div class="fp-head" id="termHead"></div><div class="term-body" id="termBody"></div>';
    root.dataset.ready = '1';
  }

  function openTerminalPanel() {
    state.terminalPanelOpen = true;
    $('#terminalRoot').classList.remove('hidden');
    ensureTermSkeleton();
    refreshTerminal();
    renderStatusBarActions();   // 右下角终端图标点亮
  }

  function closeTerminalPanel() {
    state.terminalPanelOpen = false;
    state.termFull = false;
    const root = $('#terminalRoot');
    root.classList.add('hidden');
    root.classList.remove('full');
    renderStatusBarActions();
  }

  /** 抽屉全屏 / 还原（需求3）：全屏时主区自动收缩，不遮挡任何内容。 */
  function toggleTermFull() {
    state.termFull = !state.termFull;
    $('#terminalRoot').classList.toggle('full', state.termFull);
    renderTerminalPanel();
    // 高度变了，xterm 必须重新 fit，否则内容被裁或留白
    for (const [, h] of termHandles) { if (h.fit) { try { h.fit.fit(); } catch { /* 隐藏中 */ } } }
  }

  function terminalShortcutLabel() {
    return state.terminal.ptyAvailable ? 'PTY' : '管道模式';
  }

  async function refreshTerminal() {
    if (typeof bridge.terminalStatus !== 'function') {
      state.terminal.loaded = false;
      renderTerminalPanel();
      return;
    }
    try {
      const st = await bridge.terminalStatus();
      if (!st || typeof st !== 'object') {
        state.terminal.loaded = false;
      } else {
        state.terminal.loaded = true;
        state.terminal.ptyAvailable = !!st.ptyAvailable;
        state.terminal.via = st.via || 'pipe';
        const ids = new Set((st.sessions || []).map((s) => s.id));
        for (const id of [...termHandles.keys()]) if (!ids.has(id)) disposeTerm(id);
        (st.sessions || []).forEach((s) => { if (!termHandles.has(s.id)) attachTerm(s); });
        state.terminal.sessions = st.sessions || [];
        if (!state.terminal.activeId || !ids.has(state.terminal.activeId)) {
          state.terminal.activeId = state.terminal.sessions.length
            ? state.terminal.sessions[state.terminal.sessions.length - 1].id
            : null;
        }
      }
    } catch (err) {
      state.terminal.loaded = false;
    }
    renderTerminalPanel();
  }

  function attachTerm(s) {
    const body = $('#termBody');
    if (!body) return;
    const cont = document.createElement('div');
    cont.className = 'term-container';
    cont.dataset.tid = s.id;
    body.appendChild(cont);
    const rec = { cont, term: null, fit: null, pre: null };
    termHandles.set(s.id, rec);
    if (xtermAvailable()) {
      const term = new window.Terminal({
        cursorBlink: true, fontSize: 12, scrollback: 5000,
        fontFamily: 'Consolas, "Courier New", monospace',
        theme: { background: '#161622', foreground: '#e6e6f0', cursor: '#a78bfa' },
      });
      rec.term = term;
      if (fitAvailable()) {
        rec.fit = new window.FitAddon.FitAddon();
        term.loadAddon(rec.fit);
      }
      term.open(cont);
      if (rec.fit) { try { rec.fit.fit(); } catch { /* 尺寸为 0 时静默（面板还藏着） */ } }
      term.onResize(({ cols, rows }) => { bridge.terminalResize(s.id, cols, rows); });
      term.onData((d) => { bridge.terminalWrite(s.id, d); });
      if (s.replay) term.write(s.replay);
    } else {
      // 降级（可见）：xterm 缺失 → 只读回放 + 逐行输入，不冒充完整交互终端
      cont.innerHTML = '<div class="term-degrade">xterm 未加载：已降级为逐行输入模式（输出照常显示，方向键/交互式程序不可用）</div>'
        + '<pre class="term-pre"></pre>'
        + '<div class="term-fb-row"><span class="term-fb-ps">$</span><input type="text" class="term-fb-input" placeholder="输入命令后回车发送"></div>';
      rec.pre = cont.querySelector('.term-pre');
      if (s.replay) rec.pre.textContent = s.replay;
      const inp = cont.querySelector('.term-fb-input');
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && inp.value) {
          bridge.terminalWrite(s.id, inp.value + '\r');
          inp.value = '';
        }
      });
    }
  }

  function disposeTerm(id) {
    const h = termHandles.get(id);
    if (!h) return;
    if (h.term) { try { h.term.dispose(); } catch { /* 已销毁 */ } }
    h.cont.remove();
    termHandles.delete(id);
  }

  function showTermEmpty(text) {
    const body = $('#termBody');
    if (!body) return;
    let empty = body.querySelector('.term-empty');
    if (!text) { if (empty) empty.remove(); return; }
    if (!empty) {
      empty = document.createElement('div');
      empty.className = 'term-empty';
      body.appendChild(empty);
    }
    empty.innerHTML = text;
  }

  function renderTerminalPanel() {
    if (!$('#terminalRoot').dataset.ready) return;
    const t = state.terminal;
    const head = $('#termHead');
    const closeBtn = '<button class="btn ghost sm" data-action="term-close">关闭</button>';
    // 需求3：抽屉全屏档位。全屏时上方主区（flex:1）自动收缩，不是盖住它。
    const fullBtn = `<button class="btn ghost sm" data-action="term-full" title="${state.termFull ? '还原高度' : '展开到全屏（上方空间自动收缩）'}">${state.termFull ? '还原' : '全屏'}</button>`;
    if (!t.loaded) {
      head.innerHTML = `<b>终端</b><span class="faint">未接入主进程</span><span style="margin-left:auto"></span>${fullBtn}${closeBtn}`;
      showTermEmpty('<div class="faint">主进程未接入终端服务（桥不可用）。</div>');
      return;
    }
    const tabs = t.sessions.map((s) => {
      const name = (s.shell || 'shell').split(/[\\/]/).pop();
      return `<button class="term-tab${s.id === t.activeId ? ' on' : ''}" data-action="term-tab" data-id="${s.id}" title="${esc(s.cwd)}（PID ${s.pid} · ${s.via === 'pty' ? 'PTY' : '管道'}）">${esc(name)}${s.exited ? '（已退出）' : ''}<span class="term-tab-x" data-action="term-tab-close" data-id="${s.id}" title="结束该会话">×</span></button>`;
    }).join('');
    head.innerHTML = `<b>终端</b>
      <span class="badge${t.ptyAvailable ? '' : ' warn'}" title="${t.ptyAvailable ? 'node-pty 已加载（真 PTY）' : 'node-pty 不可用：已降级为管道模式（交互式程序受限）'}">${terminalShortcutLabel()}</span>
      <span class="row" style="margin-left:10px">${tabs}</span>
      <button class="btn sm ghost" data-action="term-new" ${t.sessions.length >= 6 ? 'disabled title="已达会话上限（6）"' : ''}>+ 新建</button>
      <span style="margin-left:auto"></span>${fullBtn}${closeBtn}`;
    if (!t.sessions.length) {
      showTermEmpty('<div class="faint">没有打开的终端。点「+ 新建」开一个。</div>');
      return;
    }
    showTermEmpty('');
    for (const [id, h] of termHandles) h.cont.classList.toggle('hidden', id !== t.activeId);
    const active = termHandles.get(t.activeId);
    if (active) {
      if (active.fit) { try { active.fit.fit(); } catch { /* 隐藏中 */ } }
      if (active.term) active.term.focus();
    }
  }

  async function newTerminalSession() {
    // BUG-023：当前会话所属项目绑定了目录时，终端落在项目目录里（否则落到主进程 cwd）。
    // 目录不存在时主进程会自行回落，不用这里兜底。
    const projPath = projectPathOf(state.sel);
    const r = await bridge.terminalCreate(projPath ? { cwd: projPath } : {});
    if (!r || r.ok === false) {
      toast(`创建终端失败：${(r && r.reason) || '未接入'}`, 'err');
      return;
    }
    await refreshTerminal();
    if (r.session && r.session.via === 'pipe') {
      toast('node-pty 不可用，已降级为管道模式（交互式程序受限）', 'warn');
    }
  }

  /* ---------- 文件面板（P2-11：只读浏览 + shiki 高亮，编辑后置） ---------- */
  const FILE_SHIKI_LANGS = ['typescript', 'javascript', 'json', 'markdown', 'css', 'html', 'python', 'bash', 'yaml', 'go', 'rust', 'sql'];
  // 语法高亮体积门槛（实测基准见 renderFileView 注释）：200KB ≈ 高亮耗时 ~1s。
  const FILE_SHIKI_MAX_CHARS = 200 * 1024;
  const FILE_SHIKI_MAX_LINES = 3000;

  function ensureFileSkeleton() {
    const root = $('#fileRoot');
    if (root.dataset.ready) return;
    root.innerHTML = '<div class="fp-head" id="fileHead"></div>'
      + '<div class="file-body"><div class="file-tree" id="fileTree"></div><div class="file-view" id="fileView"></div></div>';
    root.dataset.ready = '1';
  }

  function openFilePanel() {
    state.filePanelOpen = true;
    $('#fileRoot').classList.remove('hidden');
    ensureFileSkeleton();
    // BUG-023：会话所属项目绑定了目录时，文件面板缺省根 = 项目目录（不再空白待选）。
    if (!state.filePanel.root) {
      const projPath = projectPathOf(state.sel);
      if (projPath) {
        state.filePanel.root = projPath;
        loadFileDir(projPath);
      }
    }
    renderFilePanel();
  }

  function closeFilePanel() {
    state.filePanelOpen = false;
    $('#fileRoot').classList.add('hidden');
  }

  async function pickFileRoot() {
    const r = await bridge.pickFolder();
    if (r && r.ok && r.path) {
      state.filePanel.root = r.path;
      state.filePanel.expanded = new Set();
      state.filePanel.children = new Map();
      state.filePanel.preview = null;
      state.filePanel.previewPath = '';
      await loadFileDir(r.path);
    } else if (r && r.ok === false) {
      toast(`选择目录失败：${(r && r.reason) || '未接入'}`, 'err');
    }
  }

  async function loadFileDir(dir) {
    const r = await bridge.fileTree(dir);
    if (r && r.bridgeMissing) {
      // 「未接入」与「接了但为空」必须分开：桥不存在时不能显示成「空目录」。
      state.filePanel.bridgeMissing = true;
      renderFilePanel();
      return;
    }
    if (!r || r.ok === false) {
      toast(`读取目录失败：${(r && r.reason) || '未接入'}`, 'err');
      state.filePanel.expanded.delete(dir);
      renderFilePanel();
      return;
    }
    state.filePanel.loaded = true;
    state.filePanel.children.set(dir, { entries: r.entries || [], truncated: !!r.truncated });
    if (!state.filePanel.root) state.filePanel.root = dir;
    renderFilePanel();
  }

  function fileEntryHTML(e, depth) {
    const pad = `padding-left:${8 + depth * 16}px`;
    if (e.kind === 'dir') {
      const open = state.filePanel.expanded.has(e.path);
      return `<div class="file-row dir${open ? ' open' : ''}" style="${pad}" data-action="file-toggle" data-path="${esc(e.path)}"><span class="file-caret">${open ? '▾' : '▸'}</span>${ic(open ? 'folderOpen' : 'folder', 14)}${esc(e.name)}</div>`;
    }
    const active = state.filePanel.previewPath === e.path ? ' active' : '';
    const ico = e.binary ? ic('fileText', 14) : ic(e.ext === 'md' ? 'fileText' : 'code', 14);
    return `<div class="file-row file${active}" style="${pad}" data-action="file-open" data-path="${esc(e.path)}" data-name="${esc(e.name)}"><span class="file-caret"></span>${ico}${esc(e.name)}<span class="file-size">${esc(e.sizeLabel || '')}</span></div>`;
  }

  /* ---------- 需求3：右栏「文件」TAB ----------
     与全屏文件面板（state.filePanel，含预览/编辑/diff）分开维护自己的根与展开态：
     TAB 的根自动跟随当前会话所绑定项目的本地目录（用户裁决），全屏面板仍可自选目录。 */
  function fileTabTreeHTML(dir, depth) {
    const ft = state.fileTab;
    const cached = ft.children.get(dir);
    if (!cached) return '';
    let html = (cached.entries || []).map((e) => {
      const full = e.path || (dir.replace(/[\\/]+$/, '') + '/' + e.name);
      e.path = full;
      const isDir = e.kind === 'dir';
      const open = ft.expanded.has(full);
      let out = `<div class="ftab-row${isDir ? ' dir' : ''}" data-action="${isDir ? 'ftab-toggle' : 'ftab-open'}" data-p="${esc(full)}" title="${esc(full)}" style="padding-left:${6 + depth * 13}px">`
        + `<span class="ftab-ico">${isDir ? ic(open ? 'folderOpen' : 'folder', 13) : ic(e.ext === 'md' ? 'fileText' : 'code', 13)}</span>`
        + `<span class="ftab-name">${esc(e.name)}</span></div>`;
      if (isDir && open) out += fileTabTreeHTML(full, depth + 1);
      return out;
    }).join('');
    if (cached.truncated) html += `<div class="ftab-row faint" style="padding-left:${6 + depth * 13}px">（条目超上限，已截断）</div>`;
    return html;
  }

  function fileTabBodyHTML() {
    const ft = state.fileTab;
    // 侧栏太窄放不下预览/编辑/diff，也放不下完整的目录选择流程：
    // 三个分支**都要**有进全屏面板的入口 —— 目录读不到时用户恰恰最需要它。
    const fullBtn = `<button class="btn sm ghost" data-action="file-panel" title="在全屏面板中打开（可预览 / 编辑 / diff / 选目录）">${ic('plus', 12)}</button>`;
    if (ft.error) {
      return `<div class="ctx-empty"><div class="empty-icon">${ic('warn', 24)}</div>目录读取失败<br><span style="font-size:10px">${esc(ft.error)}</span></div>`
        + `<div class="ftab-acts">${fullBtn}<button class="btn sm ghost" data-action="ftab-pick">选择目录</button></div>`;
    }
    if (!ft.root) {
      // 没有绑定目录时不冒充「空目录」：明确区分「未绑定」与「绑定了但空」
      return `<div class="ctx-empty"><div class="empty-icon">${ic('folder', 24)}</div>当前会话的项目未绑定本地目录<br>`
        + `<span style="font-size:10px">绑定后自动显示该目录的文件，也可手动选择</span></div>`
        + `<div class="ftab-acts"><button class="btn sm ghost" data-action="ftab-pick">选择目录</button>${fullBtn}</div>`;
    }
    const base = ft.root.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || ft.root;
    return `<div class="ftab-head" title="${esc(ft.root)}">${ic('folderOpen', 13)}<span class="ftab-root">${esc(base)}</span>`
      + `<button class="btn sm ghost" data-action="ftab-refresh" title="刷新">${ic('refresh', 12)}</button>`
      + `<button class="btn sm ghost" data-action="ftab-pick" title="更换目录">${ic('folder', 12)}</button>`
      + fullBtn + `</div>`
      + `<div class="ftab-tree">${fileTabTreeHTML(ft.root, 0) || '<div class="faint" style="padding:8px">（空目录）</div>'}</div>`
      + `<div class="ftab-tip faint">点击文件在全屏面板中预览</div>`;
  }

  /** 首次进入文件 TAB 时按项目目录自动装载（用户裁决：自动跟随项目目录）。 */
  async function ensureFileTabRoot() {
    const ft = state.fileTab;
    if (ft.inited || ft.loading) return;
    const dir = projectPathOf(state.sel) || '';
    if (!dir) { ft.inited = true; return; }
    ft.loading = true;
    try {
      const r = await bridge.fileTree(dir);
      if (r && r.bridgeMissing) { ft.error = '主进程未接入文件服务'; }
      else if (!r || r.ok === false) { ft.error = (r && r.reason) || '目录读取失败'; }
      else { ft.root = dir; ft.children.set(dir, { entries: r.entries || [], truncated: !!r.truncated }); ft.error = ''; }
    } catch (e) { ft.error = (e && e.message) || '目录读取失败'; }
    ft.loading = false;
    ft.inited = true;
    render();
  }

  async function fileTabLoadDir(dir) {
    const ft = state.fileTab;
    const r = await bridge.fileTree(dir);
    if (!r || r.ok === false) { toast(`读取目录失败：${(r && r.reason) || '未接入'}`, 'err'); ft.expanded.delete(dir); return; }
    ft.children.set(dir, { entries: r.entries || [], truncated: !!r.truncated });
  }

  function renderTreeLevel(dir, depth) {
    const cached = state.filePanel.children.get(dir);
    if (!cached) return '';
    let html = (cached.entries || []).map((e) => {
      // entries 上补 path/sizeLabel（宿主排序返回的是纯条目）
      const full = e.path || (dir.replace(/[\\/]+$/, '') + '/' + e.name);
      e.path = full;
      // sizeLabel 由宿主用 humanSize 给出（唯一真源），渲染层不再自己换算。
      let out = fileEntryHTML(e, depth);
      if (e.kind === 'dir' && state.filePanel.expanded.has(full)) {
        out += renderTreeLevel(full, depth + 1);
      }
      return out;
    }).join('');
    if (cached.truncated) html += `<div class="file-row faint" style="padding-left:${8 + depth * 16}px">（条目超上限，已截断）</div>`;
    return html;
  }

  function renderFilePanel() {
    if (!$('#fileRoot').dataset.ready) return;
    const fp = state.filePanel;
    const head = $('#fileHead');
    const closeBtn = '<button class="btn ghost sm" data-action="file-close">关闭</button>';
    // 「未接入」不能用 `typeof bridge.fileTree !== 'function'` 判——桥兜底 stub
    // 也是函数，那样永远命中不了。真实信号是宿主返回的 bridgeMissing 标记。
    if (fp.bridgeMissing) {
      head.innerHTML = `<b>文件</b><span class="faint">未接入主进程</span><span style="margin-left:auto"></span>${closeBtn}`;
      $('#fileTree').innerHTML = '<div class="faint" style="padding:10px">主进程未接入文件服务。</div>';
      $('#fileView').innerHTML = '';
      return;
    }
    head.innerHTML = `<b>文件</b>
      <span class="file-root" title="${esc(fp.root)}">${esc(fp.root || '（未选择目录）')}</span>
      <span class="row" style="margin-left:8px">
        <button class="btn sm ghost" data-action="file-pick">${fp.root ? '更换目录' : '选择目录'}</button>
        ${fp.root ? `<button class="btn sm ghost" data-action="file-refresh">刷新</button>` : ''}
      </span>
      <span style="margin-left:auto"></span>${closeBtn}`;
    if (!fp.root) {
      $('#fileTree').innerHTML = '<div class="faint" style="padding:10px">选择一个目录开始浏览（只读；编辑与 diff 后续按需加入）。</div>';
      $('#fileView').innerHTML = '';
      return;
    }
    $('#fileTree').innerHTML = renderTreeLevel(fp.root, 0) || '<div class="faint" style="padding:10px">（空目录）</div>';
    if (!fp.preview && !fp.previewLoading) {
      $('#fileView').innerHTML = '<div class="faint" style="padding:14px">左侧点选文件预览（只读）。</div>';
    }
  }

  async function openFilePreview(path, name) {
    const fp = state.filePanel;
    fp.previewPath = path;
    fp.previewLoading = true;
    // 换文件 = 重置编辑态（编辑另一个文件前不保留上一个文件的缓冲）
    fp.view = 'preview'; fp.editBuf = ''; fp.editBase = ''; fp.dirty = false; fp.saving = false; fp.discardArmed = false;
    fp.diffRows = null; fp.diffTooLarge = false; fp.diffLineDelta = 0; fp.saveError = '';
    const view = $('#fileView');
    if (view) view.innerHTML = `<div class="faint" style="padding:14px">读取中…</div>`;
    const r = await bridge.fileRead(path);
    fp.previewLoading = false;
    if (!r || r.ok === false) {
      fp.preview = null;
      if (view && fp.previewPath === path) {
        view.innerHTML = `<div class="file-view-head">${esc(path)}</div><div class="faint" style="padding:14px">读取失败：${esc((r && r.reason) || '未接入')}</div>`;
      }
      return;
    }
    if (view && fp.previewPath !== path) return; // 用户已点开别的文件
    fp.preview = r;
    renderFileView();
  }

  /** 文件不可编辑的原因（显式降级：不说「能编辑」也不说「坏了」，说清为什么不能）。 */
  function fileEditBlockReason(r) {
    if (r.binary) return '二进制文件';
    if (r.truncated) return '文件超过 2MB 读取上限（只读了前段，保存会截断文件）';
    if (r.encodingSuspicious) return '内容不是有效 UTF-8（保存会产生乱码）';
    return '';
  }

  /** 编辑缓冲的「将要写盘」形态：textarea 产物是纯 LF，CRLF 文件按原风格还原。 */
  function fileEditWillSave() {
    const fp = state.filePanel;
    return window.OrchDeskFileEdit
      ? window.OrchDeskFileEdit.applyEol(fp.editBuf, fp.eol)
      : fp.editBuf;
  }

  function fileViewToolbar(r) {
    const fp = state.filePanel;
    const editable = !!r.editable && typeof bridge.fileWrite === 'function' && !!(window.OrchDeskFileEdit && window.OrchDeskFileEdit.computeDiff);
    const reason = fileEditBlockReason(r);
    const btns = [];
    if (fp.view === 'edit') {
      btns.push(`<button class="btn sm ${fp.diffRows ? 'ghost' : 'ghost'}" data-action="file-edit-diff">${fp.view === 'diff' ? '退出对比' : '对比变更'}</button>`);
      btns.push(`<button class="btn sm primary" data-action="file-edit-save"${fp.saving ? ' disabled' : ''}>${fp.saving ? '保存中…' : '保存'}</button>`);
      btns.push(`<button class="btn sm ghost" data-action="file-edit-cancel">${fp.discardArmed ? '确认丢弃？' : (fp.dirty ? '放弃修改' : '取消编辑')}</button>`);
    } else if (editable) {
      btns.push('<button class="btn sm ghost" data-action="file-edit">编辑</button>');
    }
    return `<span class="row" style="margin-left:auto">
      ${!editable && reason ? `<span class="faint" title="该文件不可编辑">不可编辑：${esc(reason)}</span>` : ''}
      ${fp.dirty ? '<span class="badge warn">未保存</span>' : ''}
      ${btns.join('')}
    </span>`;
  }

  function renderFileView() {
    const fp = state.filePanel;
    const view = $('#fileView');
    const r = fp.preview;
    if (!view || !r) return;
    const renderPath = fp.previewPath;
    const meta = `<div class="file-view-head"><span>${esc(fp.previewPath)}</span>
      <span class="faint">${esc(r.sizeLabel || '')}${r.truncated ? ' · 已截断（只读前 2MB）' : ''}</span>
      ${fileViewToolbar(r)}</div>`;
    if (r.binary) {
      view.innerHTML = meta + `<div class="faint" style="padding:14px">二进制文件（${esc(r.sizeLabel || '')}），不提供内容预览。</div>`;
      return;
    }
    if (fp.view === 'edit') {
      view.innerHTML = meta
        + (fp.saveError ? `<div class="file-edit-error">${esc(fp.saveError)} <button class="btn sm ghost" data-action="file-edit-reload">重新加载</button></div>` : '')
        + `<textarea id="fileEditBuf" class="file-edit-area" spellcheck="false">${esc(fp.editBuf)}</textarea>`;
      return;
    }
    if (fp.view === 'diff') {
      view.innerHTML = meta + renderFileDiffBody();
      return;
    }
    // shiki 高亮：可用 + 语言受支持 + 体积在阈值内才走；否则纯文本 <pre>（不猜语言）。
    // 体积门槛不是保守：codeToHtml 是同步阻塞渲染线程，实测 64KB=753ms、
    // 256KB=1.34s、1MB=5.1s、**2MB=10.5s**，且 HTML 膨胀约 6.8 倍（2MB 文本
    // 产出约 35 万个 span）。超过阈值一律回落 <pre> 并显式说明「为什么没高亮」。
    const lang = r.lang;
    const tooBigForShiki = r.content.length > FILE_SHIKI_MAX_CHARS
      || r.content.split('\n').length > FILE_SHIKI_MAX_LINES;
    if (tooBigForShiki) {
      view.innerHTML = meta
        + `<div class="faint" style="padding:8px 14px">文件过大（${esc(r.sizeLabel || '')}），已跳过语法高亮以保证界面响应；编辑与保存不受影响。</div>`
        + `<pre class="file-pre">${esc(r.content)}</pre>`;
      return;
    }
    const useShiki = typeof window !== 'undefined' && window.ShikiLite
      && lang && window.ShikiLite.supportedLang(lang) && lang !== 'plaintext';
    if (useShiki) {
      window.ShikiLite.createHighlighter({ langs: FILE_SHIKI_LANGS, theme: document.documentElement.dataset.theme === 'light' ? 'github-light' : 'github-dark' })
        .then((h) => {
          if (fp.previewPath !== renderPath || fp.view !== 'preview' || fp.preview !== r) return;
          view.innerHTML = meta + `<div class="file-code">${h.codeToHtml(r.content, { lang })}</div>`;
        })
        .catch((err) => {
          console.warn('[file] shiki 高亮失败，回落纯文本:', err && err.message);
          if (fp.view === 'preview') view.innerHTML = meta + `<pre class="file-pre">${esc(r.content)}</pre>`;
        });
      return;
    }
    view.innerHTML = meta + `<pre class="file-pre">${esc(r.content)}</pre>`;
  }

  function renderFileDiffBody() {
    const fp = state.filePanel;
    const fe = window.OrchDeskFileEdit;
    if (!fe) return '<div class="faint" style="padding:14px">对比组件未接入（file-edit.js 未加载）。</div>';
    if (fp.diffTooLarge) {
      return `<div class="faint" style="padding:14px">变更过大（行数变化 ${fp.diffLineDelta > 0 ? '+' : ''}${fp.diffLineDelta}），不提供逐行对比；保存仍可用。</div>`;
    }
    const rows = fp.diffRows || [];
    if (!rows.length) return '<div class="faint" style="padding:14px">无变更（与磁盘一致）。</div>';
    const groups = fe.groupHunks(rows);
    const html = groups.map((g) => {
      const body = g.map((row) => {
        const cls = row.t === 'add' ? 'add' : row.t === 'del' ? 'del' : 'ctx';
        return `<div class="fd-row ${cls}"><span class="fd-no">${row.an || ''}</span><span class="fd-no">${row.bn || ''}</span><span class="fd-t">${esc(row.s) || '&nbsp;'}</span></div>`;
      }).join('');
      return `<div class="fd-hunk">${body}</div>`;
    }).join('');
    const stat = fp.diffStat || '';
    return `<div class="fd-stat">${esc(stat)}</div><div class="file-diff">${html}</div>`;
  }

  function startFileEdit() {
    const fp = state.filePanel;
    const r = fp.preview;
    if (!r || r.binary || r.truncated || r.encodingSuspicious) return;
    const fe = window.OrchDeskFileEdit;
    fp.eol = fe ? fe.detectEol(r.content) : 'lf';
    fp.editBuf = r.content; // textarea 赋值后浏览器会把 CRLF 规范化为 LF（写盘时按 fp.eol 还原）
    // 缓存 dirty 比较基线（textarea 内容就是 LF 形态，与 editBuf 同形）
    fp.editBase = fe ? fe.applyEol(r.content, 'lf') : r.content;
    fp.dirty = false;
    fp.view = 'edit';
    fp.discardArmed = false;
    fp.saveError = '';
    fp.diffRows = null; fp.diffTooLarge = false;
    renderFileView();
    const ta = $('#fileEditBuf');
    if (ta) ta.focus();
  }

  function computeFileDiff() {
    const fp = state.filePanel;
    const fe = window.OrchDeskFileEdit;
    if (!fe || !fp.preview) return;
    const will = fileEditWillSave();
    const d = fe.computeDiff(fp.preview.content, will);
    if (d.ok) {
      fp.diffRows = d.rows;
      fp.diffTooLarge = false;
      fp.diffStat = `+${d.stats.adds} / -${d.stats.dels}`;
    } else {
      fp.diffRows = null;
      fp.diffTooLarge = true;
      fp.diffLineDelta = d.lineDelta;
      fp.diffStat = '';
    }
  }

  async function saveFileEdit() {
    const fp = state.filePanel;
    const r = fp.preview;
    if (!r || fp.saving) return;
    if (typeof bridge.fileWrite !== 'function') { toast('保存失败：主进程未接入', 'err'); return; }
    fp.saving = true;
    fp.saveError = '';
    renderFileView();
    const will = fileEditWillSave();
    const res = await bridge.fileWrite(r.path || fp.previewPath, will, r.mtimeMs);
    fp.saving = false;
    if (res && res.ok) {
      // 预览基线更新为刚写盘的内容（后续 diff/编辑以新基线为准）
      fp.preview.content = will;
      fp.preview.mtimeMs = res.mtimeMs;
      fp.preview.size = res.size;
      fp.preview.sizeLabel = res.sizeLabel;
      fp.dirty = false;
      fp.view = 'preview';
      fp.editBuf = '';
      // 基线轮转：连续编辑时以「刚写盘的内容」为新的比较基准，否则下一轮
      // 编辑会被自己上一次的保存误判成 dirty。
      fp.editBase = window.OrchDeskFileEdit
        ? window.OrchDeskFileEdit.applyEol(will, 'lf')
        : will;
      toast(`已保存（${res.sizeLabel || ''}）`, 'ok');
    } else {
      fp.saveError = (res && res.reason) || '保存失败';
      if (res && res.code === 'modified-externally') {
        // 外部修改拒绝：编辑态保留缓冲（改动不丢），由用户决定重新加载或另作处理
        fp.view = 'edit';
      }
    }
    renderFileView();
  }

  function cancelFileEdit() {
    const fp = state.filePanel;
    if (fp.dirty && !fp.discardArmed) {
      // 两段式确认：第一次点只 arm（不弹窗打断），3.5s 内再点才真的丢弃
      fp.discardArmed = true;
      renderFileView();
      setTimeout(() => { if (fp.discardArmed) { fp.discardArmed = false; if (fp.view === 'edit') renderFileView(); } }, 3500);
      return;
    }
    fp.view = 'preview';
    fp.editBuf = '';
    fp.dirty = false;
    fp.discardArmed = false;
    fp.saveError = '';
    fp.diffRows = null; fp.diffTooLarge = false;
    renderFileView();
  }

  function toggleFileDiff() {
    const fp = state.filePanel;
    if (fp.view === 'diff') { fp.view = 'edit'; renderFileView(); return; }
    computeFileDiff();
    fp.view = 'diff';
    renderFileView();
  }

  async function reloadFilePreview() {
    const fp = state.filePanel;
    const p = fp.previewPath;
    if (p) await openFilePreview(p);
  }


  /* ---------- 通用输入弹窗（Electron 不支持 window.prompt，统一走 modal） ---------- */
  function askInput(opts) {
    openModal(`<div class="mh">${ic('at', 18)}<b>${esc(opts.title)}</b></div>
      <div class="mb">
        ${opts.label ? `<div class="faint" style="margin-bottom:8px">${esc(opts.label)}</div>` : ''}
        <div class="mb-row"><input id="askInput" class="inp" type="${opts.secret ? 'password' : 'text'}" placeholder="${esc(opts.placeholder || '')}" style="width:100%" autofocus></div>
      </div>
      <div class="mf"><button class="btn ghost" data-action="modal-cancel">取消</button>
        <button class="btn primary" data-action="ask-input-ok">${esc(opts.okText || '确定')}</button></div>`);
    state.askInputCb = opts.onOk;
  }

  /** 观雅集技能安装（authorized=true 表示用户已在弹窗中显式授权高危能力）。 */
  async function doInstallGuanjiSkill(skill, authorized) {
    try {
      const r = await bridge.guanjiInstall(skill, authorized);
      if (r && r.ok) {
        // 不再手动 push 一条内存记录：以磁盘真实扫描为准（含体积/落盘时间），
        // 否则装完 UI 显示的是只有 slug 的假条目，且重启后来源不一致。
        await refreshInstalledSkills();
        toast(`已从观雅集安装「${skill.slug}」（能力审查：${r.review}）`, 'ok');
      } else if (r && r.review === 'needs-auth') {
        toast(`「${skill.slug}」需授权：请先在弹窗中确认高危能力`, 'danger');
      } else {
        toast(`安装失败：${(r && r.reason) || '未知错误'}`, 'danger');
      }
    } catch {
      toast('安装请求异常', 'danger');
    }
    closeModal();
    render();
  }

  /* ---------- 系统提示词编辑器（T-P4-3） ---------- */
  function openPromptEditor(doc) {
    const isEdit = !!doc;
    const title = isEdit ? doc.title : '';
    const category = isEdit ? doc.category : 'role';
    const body = isEdit ? doc.body : '';
    const agents = isEdit ? (doc.agents || []).join(', ') : '';
    openModal(`<div class="mh">${ic('at', 18)}<b>${isEdit ? '编辑提示词' : '新建提示词'}</b></div>
      <div class="mb">
        <div class="faint" style="margin-bottom:8px">提示词与技能解耦；可在正文中使用 <span class="mono">{'{skill:xxx}'}</span> 引用技能（运行时展开）。</div>
        <div class="mb-row"><label>标题</label><input id="pmTitle" class="inp" value="${title.replace(/"/g, '&quot;')}" placeholder="如：默认角色设定"></div>
        <div class="mb-row"><label>分类</label><select id="pmCat" class="inp">
          ${PROMPT_CATS.map((c) => `<option value="${c}" ${c === category ? 'selected' : ''}>${PROMPT_CAT_LABELS[c]}</option>`).join('')}
        </select></div>
        <div class="mb-row"><label>正文</label><textarea id="pmBody" class="inp" rows="5" placeholder="提示词内容…支持 {skill:xxx} 引用">${body.replace(/</g, '&lt;')}</textarea></div>
        <div class="mb-row"><label>绑定 Agent</label><input id="pmAgents" class="inp" value="${agents}" placeholder="留空=全局默认；多个用逗号分隔"></div>
      </div>
      <div class="mf">
        ${isEdit ? `<button class="btn danger" data-action="prompt-delete" data-id="${doc.id}">删除</button>` : ''}
        <button class="btn ghost" data-action="modal-cancel">取消</button>
        <button class="btn primary" data-action="prompt-save" data-id="${isEdit ? doc.id : ''}">保存</button>
      </div>`);
  }

  async function doSavePrompt(id) {
    const title = ($('#pmTitle')?.value || '').trim();
    const category = $('#pmCat')?.value || 'role';
    const body = ($('#pmBody')?.value || '').trim();
    const agents = ($('#pmAgents')?.value || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (!title) { toast('请填写标题', 'warn'); return; }
    const patch = { title, category, body, agents, priority: 100 };
    try {
      const res = await bridge.savePrompt(id || '', patch);
      if (res && res.ok) {
        closeModal();
        await refreshPrompts();
        toast(isEdit(id) ? '提示词已更新' : '提示词已创建', 'ok');
      } else {
        toast('提示词未持久化（运行时未接入？仅在占位环境）', 'warn');
        // 占位环境：本地乐观更新，保证 UI 可演示。
        const local = { id: id || ('pl-' + Date.now()), title, category, body, agents, priority: 100, updatedAt: Date.now() };
        if (id) { const i = state.promptDocs.findIndex((d) => d.id === id); if (i >= 0) state.promptDocs[i] = local; }
        else state.promptDocs.unshift(local);
        closeModal(); render(); toast(isEdit(id) ? '提示词已更新（本地）' : '提示词已创建（本地）', 'ok');
      }
    } catch {
      toast('保存失败（运行时未接入）', 'warn');
    }
  }
  function isEdit(id) { return !!id; }

  async function doDeletePrompt(id) {
    try {
      const res = await bridge.deletePrompt(id);
      if (res && res.ok) { closeModal(); await refreshPrompts(); toast('提示词已删除', 'ok'); return; }
    } catch { /* 占位环境乐观删除 */ }
    state.promptDocs = state.promptDocs.filter((d) => d.id !== id);
    closeModal(); render(); toast('提示词已删除（本地）', 'ok');
  }

  async function refreshPrompts() {
    try {
      const list = await bridge.listPrompts();
      if (Array.isArray(list)) state.promptDocs = list;
      const merged = await bridge.mergePrompts('main');
      if (merged && Array.isArray(merged.conflicts)) state.promptConflicts = merged.conflicts;
    } catch { /* 占位环境保留本地数据 */ }
  }
  async function doSwitchAuth(target) {
    state.authMode = target; // 乐观更新；真实持久化经桥。
    render();
    try {
      const res = await bridge.setAuthMode(target);
      if (!res || res.ok === false) toast('授权模式切换未持久化（运行时未接入？）', 'warn');
      else toast(`已切换为「${authModeLabel(target)}」`, target === 'paranoid' ? 'ok' : 'warn');
    } catch {
      toast('授权模式切换失败（运行时未接入）', 'warn');
    }
  }

  /* ---------- 审批弹窗（T-P3-2 fail-closed） ---------- */
  // 主进程经 authz 插件转发 dsh approval/request → 渲染层弹窗 → 用户决定 → submitDecision。
  function showApprovalModal(req) {
    // PRD FR-9 授权粒度：单次 / 会话 / 永久。后两者需要「具体目标」才能建白名单规则
    // （拿不到目标就只能建 '*' 规则，等于对该工具全放行 —— 不提供这个选项）。
    const target = String(req.target || '').trim();
    const canRemember = !!target && !!req.toolName;
    const remember = canRemember
      ? `<div class="row" style="margin-top:10px">
           <button class="btn sm" data-action="approval-grant" data-id="${req.id}" data-scope="session" data-tool="${esc(req.toolName)}" data-target="${esc(target)}">会话内允许</button>
           <button class="btn sm" data-action="approval-grant" data-id="${req.id}" data-scope="permanent" data-tool="${esc(req.toolName)}" data-target="${esc(target)}">永久允许</button>
           <span class="faint">目标 <span class="mono">${esc(target.length > 48 ? target.slice(0, 48) + '…' : target)}</span></span>
         </div>`
      : `<div class="faint" style="margin-top:8px;font-size:11.5px">该请求未携带具体目标，只能单次允许（白名单需「操作类型 + 目标」两项齐全）。</div>`;
    openModal(`<div class="mh danger">${ic('warn', 18)}<b>授权确认（L3/L4 操作）</b></div>
      <div class="mb">
        <div>Agent 请求执行 <b>${esc(req.toolName || '受限操作')}</b>${req.reason ? `：<span class="faint">${esc(req.reason)}</span>` : ''}。</div>
        <div class="warn-list" style="margin-top:10px">
          <div>· 该操作属于 L3/L4 级别，需你显式授权</div>
          <div>· 超时或关闭将视为 <b>拒绝（fail-closed）</b>，操作不会执行</div>
          <div>· 「会话 / 永久允许」写入授权白名单，可在设置页查看与撤销</div>
        </div>
        ${remember}
      </div>
      <div class="mf">
        <button class="btn ghost" data-action="approval-deny" data-id="${req.id}">拒绝</button>
        <button class="btn danger" data-action="approval-allow" data-id="${req.id}">允许本次</button>
      </div>`);
  }

  /** 分叉点选项文案：说明「继承到第几条之后」。 */
  function forkOptionLabel(i, msgs) {
    const n = msgs.length;
    if (i >= n) return `全部 · 继承 ${n} 条`;
    if (i <= 0) return '空起点 · 不继承任何消息';
    const m = msgs[i - 1] || {};
    const who = (m.r || m.role) === 'user' ? '你' : 'Agent';
    const txt = String(m.x || m.text || '').replace(/\s+/g, ' ').trim().slice(0, 40);
    return `第 ${i} 条（${who}：${txt || '（空消息）'}）之后`;
  }

  function confirmNewBranch(sid) {
    const s = state.sessions[sid];
    const msgs = (s && Array.isArray(s.msgs)) ? s.msgs : [];
    const n = msgs.length;
    // 没有分叉模块 or 没有消息 → 不给分叉点选择，只做「全继承」（或空起点）。
    const pickable = !!(FORK && n > 0);
    openModal(`<div class="mh">${ic('fork', 18)}<b>从此会话创建分支</b></div>
      <div class="mb">
        <div>分支继承 <span class="mono">#${sid}</span> 在<b>分叉点之前</b>的消息，之后写入独立会话，<b>互不污染</b>。</div>
        <div class="warn-list"><div>· 可在分叉点独立探索</div><div>· 主干不受影响</div><div>· 可随时合并或丢弃分支</div></div>
        <div style="margin-top:10px">分支名：<input type="text" id="fork-name" value="分支-${sid}-1" style="margin-top:4px"></div>
        ${pickable ? `<div style="margin-top:12px">
          <div class="row" style="justify-content:space-between">
            <span class="cm-label">分叉点</span><span class="tl mono" id="fork-at-label">${esc(forkOptionLabel(n, msgs))}</span>
          </div>
          <input type="range" id="fork-at" min="0" max="${n}" step="1" value="${n}" data-action="fork-slider" data-sid="${esc(sid)}" style="width:100%">
          <div class="faint" style="font-size:11px;margin-top:2px">拖动选择从哪一条之后分出；默认继承全部 ${n} 条</div>
        </div>` : `<div class="faint" style="margin-top:10px">${FORK ? '当前会话还没有消息，分支将从空起点开始。' : '分叉模块未加载，无法选择分叉点。'}</div>`}
      </div>
      <div class="mf">
        <button class="btn ghost" data-action="modal-cancel">取消</button>
        <button class="btn primary" data-action="branch-confirm" data-sid="${esc(sid)}"${FORK ? '' : ' disabled'}>创建分支</button>
      </div>`);
  }

  function confirmRename(sid) {
    const s = state.sessions[sid];
    openModal(`<div class="mh">${ic('edit', 18)}<b>重命名会话</b></div>
      <div class="mb">
        <div>新名称：<input type="text" value="${s ? s.title : ''}" style="margin-top:6px"></div>
        <div class="faint" style="margin-top:8px">会话 ID 保持 <span class="mono">#${sid}</span> 不变。</div>
      </div>
      <div class="mf">
        <button class="btn ghost" data-action="modal-cancel">取消</button>
        <button class="btn primary" data-action="rename-confirm" data-id="${sid}">保存</button>
      </div>`);
  }

  function confirmArchiveProject(pid) {
    const p = state.projects.find((x) => x.id === pid);
    openModal(`<div class="mh danger">${ic('archive', 18)}<b>归档项目「${p ? p.n : ''}」？</b></div>
      <div class="mb">
        <div>归档后将折叠到「已归档」分组，<b>不可在前台直接打开</b>。所有会话日志和事件仍保留在数据目录，可随时还原。</div>
        <div class="warn-list"><div>· 项目内 <b>${p ? p.sessions.length : 0}</b> 个会话一并归档</div><div>· 插件与配置保留</div><div>· 归档后可在「已归档」组中点击还原</div></div>
      </div>
      <div class="mf">
        <button class="btn ghost" data-action="modal-cancel">取消</button>
        <button class="btn danger" data-action="archive-confirm" data-id="${pid}">确认归档</button>
      </div>`);
  }

  function openSkillPicker() {
    const skills = PLUGINS.concat(SKILLS_MARKET);
    openModal(`<div class="mh">${ic('plus', 18)}<b>加载技能到当前会话</b></div>
      <div class="mb">
        <div class="faint" style="margin-bottom:8px">技能加载后将注册为本次会话的 effect，离开会话即卸载。</div>
        ${skills.map((p) => `<div class="row" style="padding:7px 8px;border:1px solid var(--border);border-radius:7px;margin-bottom:6px"><div style="flex:1"><b>${p.n || p.d}</b><div class="faint" style="font-size:11px">${p.d || ''}</div></div><button class="btn sm primary" data-action="skill-attach" data-n="${p.n || p.d}">加载</button></div>`).join('')}
      </div>
      <div class="mf"><button class="btn ghost" data-action="modal-cancel">关闭</button></div>`);
  }

  function openExpertPicker() {
    openModal(`<div class="mh">${ic('at', 18)}<b>引用专家或专家团</b></div>
      <div class="mb">
        <div class="faint" style="margin-bottom:8px">@ 引用后，专家将以 <b>SubAgent</b> 形式参与本次回复，不替换主会话。</div>
        <div class="sec-title" style="margin:6px 0">专家</div>
        ${expertList().map((e) => `<div class="row" style="padding:6px 8px;border:1px solid var(--border);border-radius:7px;margin-bottom:5px"><div style="flex:1"><b>${esc(e)}</b></div><button class="btn sm" data-action="expert-attach" data-n="${esc(e)}">@ 引用</button></div>`).join('')}
        <div class="sec-title" style="margin:10px 0 6px">专家团</div>
        ${teamList().map((t) => `<div class="row" style="padding:6px 8px;border:1px solid var(--border);border-radius:7px;margin-bottom:5px"><div style="flex:1"><b>${esc(t.n)}</b><div class="faint" style="font-size:11px">${esc(t.m || '')}</div></div><button class="btn sm primary" data-action="expert-attach" data-n="${esc(t.n)}">引用团</button></div>`).join('')}
      </div>
      <div class="mf"><button class="btn ghost" data-action="modal-cancel">关闭</button></div>`);
  }

  function openModelPicker() {
    const pool = getModelPool();
    if (!pool.length) {
      openModal(`<div class="mh">${ic('bot', 18)}<b>选择模型</b></div>
        <div class="mb">
          <div class="faint">尚未配置任何模型提供商。请到 <b>设置 → 模型管理</b> 添加提供商（OpenAI 兼容 API 或 Ollama 本地）。</div>
        </div>
        <div class="mf"><button class="btn ghost" data-action="modal-cancel">关闭</button></div>`);
      return;
    }
    const poolNames = new Set(pool.map(m => m.n));
    // 同步：清理已不在当前模型池中的残留选中项
    const prevLen = state.selectedModels.length;
    state.selectedModels = state.selectedModels.filter(n => poolNames.has(n));
    if (state.selectedModels.length !== prevLen) {
      console.log('[model] cleaned stale selection:', prevLen, '->', state.selectedModels.length);
    }
    const groups = {};
    pool.forEach((m) => { const p = m.p.split(' · ')[0]; if (!groups[p]) groups[p] = []; groups[p].push(m); });
    const html = Object.entries(groups).map(([provider, models]) => {
      const allSel = models.every((m) => state.selectedModels.includes(m.n));
      return `<div class="mg-grp">
        <div class="mg-h">${esc(provider)}<span class="mg-all" data-action="mg-toggle-all" data-p="${esc(provider)}">${allSel ? '取消全选' : '全选'}</span></div>
        ${models.map((m) => { const sel = state.selectedModels.includes(m.n);
          const isDefault = state.defaultModel === m.n;
          return `<div class="m-opt ${sel ? 'sel' : ''}" data-action="model-toggle" data-n="${esc(m.n)}">
            <div class="mo-cb"></div>
            <div class="mo-info"><div class="mo-name">${esc(m.n)}${isDefault ? ' <span class="badge ok">默认</span>' : ''}</div><div class="mo-meta">${esc(m.p)}</div></div>
            <div class="mo-state">${m.state === '已测' || m.state === '已就绪' ? '<span class="badge ok">' + m.state + '</span>' : '<span class="badge">' + m.state + '</span>'}</div>
          </div>`; }).join('')}
      </div>`;
    }).join('');
    openModal(`<div class="mh">${ic('bot', 18)}<b>选择模型</b></div>
      <div class="mb">
        <div class="faint" style="margin-bottom:10px">第一个选中 = 主运行模型；本地模型勾选后作为意图识别。此选择会保存，新会话自动复用。默认模型可在 设置→模型管理 中指定。</div>
        ${html}
      </div>
      <div class="mf">
        <button class="btn ghost" data-action="model-clear">清空</button>
        <button class="btn primary" data-action="model-confirm">确认（${state.selectedModels.length} 个）</button>
      </div>`);
  }

  /* ---------- 交互 ---------- */
  // 点击空白处关闭项目下拉
  document.body.addEventListener('click', (e) => {
    if ((state.projDropdownOpen && !e.target.closest('.proj-select') && !e.target.closest('.proj-dropdown')) ||
        (state.composerMoreOpen && !e.target.closest('.composer-more'))) {
      state.projDropdownOpen = false;
      state.composerMoreOpen = false;
      const dd = document.querySelector('.proj-dropdown');
      if (dd) dd.classList.remove('open');
      const ps = document.querySelector('.proj-select');
      if (ps) ps.classList.remove('open');
      const cm = document.querySelector('.composer-more-dropdown');
      if (cm) cm.classList.remove('open');
    }
  });
  /* composer Enter-to-send（homeComposer + 会话内 #composer） */
  document.body.addEventListener('input', (e) => {
    if (e.target && e.target.id === 'plugSearch') plugSearchFilter();
    else if (e.target && e.target.id === 'skillSearch') skillSearchFilter();
  });
  document.body.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      // 终端 / 文件面板：ESC 收起。但焦点在终端内部（xterm 的输入区 / 降级输入框）
      // 时不收 —— vim/less 等交互程序也用 ESC，不能被面板快捷键抢走。
      const inTerm = e.target && e.target.closest && e.target.closest('#terminalRoot .term-container');
      if (state.terminalPanelOpen && !inTerm) { closeTerminalPanel(); return; }
      if (state.filePanelOpen) { closeFilePanel(); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey && (e.target.id === 'homeComposer' || e.target.id === 'composer')) {
      e.preventDefault();
      const sendBtn = e.target.closest('.home-textarea-wrap')?.querySelector('[data-action="home-send"]')
        || document.querySelector('[data-action="home-send"], [data-action="send"]');
      if (sendBtn) sendBtn.click();
    }
    // P1 键盘可达（/harden）：委托层统一把 Enter/Space 映射到 [data-action] 的 click。
    // 只对「被 hardenActions 补了 tabindex 的 div 交互元素」生效，不抢原生控件的默认键
    //（如文本输入的回车、按钮的 Space、下拉的箭头）。textarea 需要 shift+Enter 时不拦。
    if ((e.key === 'Enter' || e.key === ' ') && e.target && e.target.closest) {
      const actEl = e.target.closest('[data-action][tabindex]:not(button):not(input):not(select):not(a):not(textarea)');
      if (actEl) {
        e.preventDefault();
        actEl.click();
      }
    }
  });
  document.body.addEventListener('click', async (e) => {
    const el = e.target.closest('[data-action]'); if (!el) return;
    const a = el.dataset.action, id = el.dataset.id;
    switch (a) {
      case 'nav': {
        state.page = id;
        // 进入设置页时重拉记忆域与沙箱日志：SubAgent 执行完会随时往 worker 域落结论，
        // 只靠启动时拉一次，用户看到的就是「空的」，会误判成功能没生效。
        if (id === 'settings') { refreshMemoryDomain(); refreshMemorySummarize(); refreshSandboxLog(); refreshUsage(); }
        if (id === 'plugins') { refreshConnectors(); refreshMarket(); }
        render();
        break;
      }
      case 'settings-nav': state.settingsSection = id; render(); break;
      case 'toggle-theme': { state.theme = state.theme === 'light' ? 'dark' : 'light'; document.documentElement.dataset.theme = state.theme; break; }
      case 'toggle-ctx': state.ctxOpen = !state.ctxOpen; render(); break;
      case 'ctx-tab': state.ctxTab = el.dataset.id; render(); break;
      // 思考链展开/收起（本轮 UI 重构）：只切这份消息的展开态，工具明细随之显示或收起。
      case 'think-toggle': {
        const k = el.dataset.k;
        if (!k) break;
        if (state.thinkExpanded.has(k)) state.thinkExpanded.delete(k); else state.thinkExpanded.add(k);
        render();
        break;
      }
      // ---- 需求3：右栏「文件」TAB ----
      case 'ftab-toggle': {
        const p = el.dataset.p;
        if (!p) break;
        const ft = state.fileTab;
        if (ft.expanded.has(p)) { ft.expanded.delete(p); render(); }
        else {
          ft.expanded.add(p);
          if (ft.children.has(p)) render();
          else fileTabLoadDir(p).then(() => render()).catch(() => render());
        }
        break;
      }
      case 'ftab-open': {
        // 侧栏只做浏览（很窄），点文件交给全屏面板预览——复用既有预览/编辑/diff 链路
        const p = el.dataset.p;
        if (!p) break;
        openFilePanel();
        openFilePreview(p, p.split(/[\\/]/).pop());
        break;
      }
      case 'ftab-pick': {
        const r = await bridge.pickFolder();
        if (r && r.ok && r.path) {
          const ft = state.fileTab;
          ft.root = r.path; ft.expanded = new Set(); ft.children = new Map(); ft.error = ''; ft.inited = true;
          await fileTabLoadDir(r.path);
        } else if (r && r.ok === false) {
          toast(`选择目录失败：${(r && r.reason) || '未接入'}`, 'err');
        }
        render();
        break;
      }
      case 'ftab-refresh': {
        const ft = state.fileTab;
        if (!ft.root) break;
        ft.children = new Map();
        await fileTabLoadDir(ft.root);
        render();
        break;
      }
      case 'preview-product': {
        const content = el.dataset.content;
        const name = el.dataset.name;
        const lang = el.dataset.lang;
        if (content) openProductPreview(name, content, lang);
        break;
      }
      case 'proj-select-toggle': { state.projDropdownOpen = !state.projDropdownOpen; const dd = $('#projDropdown'); if (dd) dd.classList.toggle('open', state.projDropdownOpen); break; }
      case 'composer-proj-pick': {
        const pid = el.dataset.pid;
        state.selProjForComposer = pid;
        state.projDropdownOpen = false;
        // 若当前会话不在该项目下，跳转到该项目下的第一个会话或创建新会话
        const curS = state.sessions[state.sel];
        if (!curS || curS.pid !== pid) {
          const p = state.projects.find(x => x.id === pid);
          const existing = p ? p.sessions.find(sid => state.sessions[sid]) : null;
          if (existing) { state.sel = existing; }
          else if (p) { createSessionInProject(pid); }
        }
        // BUG-023：重选项目（含重选同一个）后，会话工作区必须跟着项目绑定目录走。
        if (state.sel && state.sessions[state.sel] && state.sessions[state.sel].pid === pid) {
          applySessionCwd(state.sel);
        }
        render();
        break;
      }
      case 'composer-proj-task': {
        state.selProjForComposer = '__task__';
        state.projDropdownOpen = false;
        closeModal();
        const id = 's' + Date.now().toString(36);
        const s = { id, pid: '__task__', title: '任务', expert: expertList()[state.wzExpert] || expertList()[0], model: state.selectedModels[0] || '—', updated: '刚刚', ts: nowTime(), msgs: [] };
        state.sessions[id] = s;
        state.sel = id;
        state.pExpanded.add('__task__');
        persist(); render();
        toast('已进入任务模式（无项目）', 'ok');
        break;
      }
      case 'welcome-new-proj': doNewConv(); break;
      case 'welcome-task': {
        const id = 's' + Date.now().toString(36);
        const s = { id, pid: '__task__', title: '任务', expert: expertList()[state.wzExpert] || expertList()[0], model: state.selectedModels[0] || '—', updated: '刚刚', ts: nowTime(), msgs: [] };
        state.sessions[id] = s; state.sel = id;
        persist(); render(); toast('已进入任务模式（无项目）', 'ok');
        break;
      }

      /* 会话 */
      // 切换会话即退出回放视图（回放只对被点开的那个会话有效）
      // BUG-023：打开会话时重放工作区（幂等）——覆盖「重启后主进程 Map 已空」的场景。
      case 'sel': state.sel = id; state.replayFor = null; applySessionCwd(id); pushFloatingContext(); render(); break;
      case 'newconv': doNewConv(); break;
      case 'home-send': {
        const homeInp = $('#homeComposer');
        const text = homeInp?.value?.trim();
        if (!text) { toast('输入为空', 'warn'); break; }
        homeInp.value = '';
        if (!state.selProjForComposer || state.selProjForComposer === '__task__') {
          const id = 's' + Date.now().toString(36);
          const s = { id, pid: '__task__', title: text.slice(0, 20), expert: expertList()[state.wzExpert] || expertList()[0], model: state.selectedModels[0] || '—', updated: '刚刚', ts: nowTime(), msgs: [] };
          state.sessions[id] = s;
          state.sel = id;
          state.selProjForComposer = '__task__';
          state.pExpanded.add('__task__');
          persist(); render();
        } else {
          const pid = state.selProjForComposer;
          const sid = 's' + Date.now().toString(36);
          const p = state.projects.find(x => x.id === pid);
          const s = { id: sid, pid, title: text.slice(0, 20), expert: expertList()[state.wzExpert] || expertList()[0], model: state.selectedModels[0] || '—', updated: '刚刚', ts: nowTime(), msgs: [] };
          state.sessions[sid] = s;
          if (p && !p.sessions.includes(sid)) p.sessions.push(sid);
          state.pExpanded.add(pid);
          state.sel = sid;
          persist(); render();
          applySessionCwd(sid);
        }
        const c = $('#composer');
        if (c) {
          c.value = text;
          c.dispatchEvent(new Event('input', { bubbles: true }));
          doSend();
        } else {
          toast('发送失败：未找到输入框', 'warn');
        }
        break;
      }
      case 'quick-weekly': case 'quick-debug': case 'quick-ppt': case 'quick-idle':
      case 'quick-refactor': case 'quick-data': case 'quick-skills': case 'quick-analyze': {
        const labels = {
          'quick-weekly': '周报总结', 'quick-debug': '报错修复', 'quick-ppt': 'PPT 制作',
          'quick-idle': '闲时任务', 'quick-refactor': '项目重构', 'quick-data': '数据分析',
          'quick-skills': '浏览技能', 'quick-analyze': '项目分析',
        };
        const prompts = {
          'quick-weekly': '请帮我写一份周报总结，包含本周完成的工作、遇到的问题和下周计划。',
          'quick-debug': '请帮我诊断并修复以下代码问题：',
          'quick-ppt': '请帮我制作 PPT，主题是：',
          'quick-idle': '请帮我处理以下闲时任务：',
          'quick-refactor': '请帮我分析并重构以下代码：',
          'quick-data': '请帮我分析以下数据并给出洞察：',
          'quick-skills': '请帮我推荐适合当前项目的技能：',
          'quick-analyze': '请帮我分析当前项目的结构和代码质量：',
        };
        const text = prompts[a] || '';
        const inp = $('#homeComposer');
        if (inp) { inp.value = text; inp.dispatchEvent(new Event('input', { bubbles: true })); }
        const sendBtn = document.querySelector('[data-action="home-send"]');
        if (sendBtn) sendBtn.click();
        toast(`已加载「${labels[a] || a}」模板`, 'ok');
        break;
      }
      case 'home-create-proj': {
        openModal(`<div class="mh">${ic('folder', 18)}<b>创建项目</b></div>
          <div class="mb">
            <div class="mb-row"><label>项目名称</label><input id="newProjName" class="inp" placeholder="如：React 重构" style="width:100%"></div>
            <div class="mb-row"><label>本地文件夹</label>
              <div style="display:flex;gap:8px;align-items:center">
                <input id="newProjPath" class="inp" placeholder="选择或输入本地文件夹路径" style="flex:1" readonly>
                <button class="btn sm" data-action="pick-folder">浏览</button>
              </div>
              <div class="faint" style="font-size:11px;margin-top:4px">绑定后可通过「打开项目目录」快速访问</div>
            </div>
          </div>
          <div class="mf"><button class="btn ghost" data-action="modal-cancel">取消</button><button class="btn primary" data-action="do-create-proj-home">创建</button></div>`);
        break;
      }
      case 'pick-folder': {
        const pathInput = $('#newProjPath');
        try {
          const r = await bridge.pickFolder();
          if (r && r.ok && r.path && pathInput) pathInput.value = r.path;
        } catch {
          const selected = prompt('请输入本地文件夹路径：');
          if (selected && pathInput) pathInput.value = selected;
        }
        break;
      }
      case 'do-create-proj-home': {
        const name = ($('#newProjName')?.value || '').trim();
        const path = ($('#newProjPath')?.value || '').trim();
        if (!name) { toast('请输入项目名称', 'warn'); break; }
        const id = 'p' + Date.now().toString(36);
        const p = { id, n: name, d: '', open: 1, archived: 0, sessions: [], path: path || '' };
        state.projects.push(p);
        state.selProjForComposer = id;
        persist();
        closeModal();
        // Create initial session
        createSessionInProject(id);
        toast(`项目「${name}」已创建`, 'ok');
        break;
      }
      case 'proj-toggle': { if (state.pExpanded.has(id)) state.pExpanded.delete(id); else state.pExpanded.add(id); render(); break; }
      case 'proj-menu': e.stopPropagation(); openMenu(el, [
        { id: 'open', label: '打开项目目录', svg: ic('folder', 14) },
        { sep: 1, label: '归档项目', svg: ic('archive', 14), danger: 1, id: 'archive' }]);
        document.querySelector('.pop [data-id="open"]').onclick = async () => {
          $('#menuRoot').innerHTML = '';
          // BUG-022：必须把项目绑定的文件夹传给主进程。旧代码无参调用，主进程恒开数据目录，
          // 于是「打开项目目录」弹出的永远是 C 盘 OrchDesk 数据目录。
          const proj = state.projects.find((x) => x.id === id);
          const bound = proj && String(proj.path || '').trim();
          if (!bound) {
            toast('该项目未绑定本地文件夹（新建项目时选择本地文件夹后可用）', 'warn');
            return;
          }
          const r = await bridge.openProjectDir(bound);
          toast(
            r && r.ok
              ? `已打开项目目录：${(r && r.path) || bound}`
              : `打开失败：${(r && r.reason) || '未知错误'}`,
            r && r.ok ? 'ok' : 'danger',
          );
        };
        document.querySelector('.pop [data-id="archive"]').onclick = () => { $('#menuRoot').innerHTML = ''; confirmArchiveProject(id); };
        break;
      case 'sess-menu': e.stopPropagation(); openMenu(el, [
        { id: 'copy', label: '复制会话 ID', svg: ic('copy', 14) },
        { id: 'rename', label: '重命名', svg: ic('edit', 14) },
        { sep: 1, id: 'fork', label: '创建分支', svg: ic('fork', 14) },
        { sep: 1, id: 'archive', label: '归档', svg: ic('archive', 14), danger: 1 },
        { sep: 1, id: 'delete', label: '删除', svg: ic('trash', 14), danger: 1 }]);
        const pop = document.querySelector('.pop');
        pop.querySelector('[data-id="copy"]').onclick = () => { navigator.clipboard && navigator.clipboard.writeText(id).catch(() => {}); toast(`已复制 #${id}`, 'ok'); $('#menuRoot').innerHTML = ''; };
        pop.querySelector('[data-id="rename"]').onclick = () => { $('#menuRoot').innerHTML = ''; confirmRename(id); };
        pop.querySelector('[data-id="fork"]').onclick = () => { $('#menuRoot').innerHTML = ''; confirmNewBranch(id); };
        pop.querySelector('[data-id="archive"]').onclick = () => { $('#menuRoot').innerHTML = ''; doArchiveSession(id); };
        pop.querySelector('[data-id="delete"]').onclick = async () => { $('#menuRoot').innerHTML = ''; await doDeleteSession(id); };
        break;
      // 会话标题栏「分叉」（data-sid 优先；无则当前会话）
      case 'fork': confirmNewBranch(el.dataset.sid || state.sel); break;
      /* 创建分支（FR-6）：分叉点来自滑块，缺省 = 全继承 */
      case 'branch-confirm': {
        const inp = $('#modalRoot input[type=text]');
        const nm = inp ? inp.value : '';
        const at = $('#modalRoot #fork-at');
        const sid = el.dataset.sid || state.sel;
        closeModal();
        doFork(sid, nm, at ? at.value : undefined);
        break;
      }
      case 'replay-open': { state.replayFor = el.dataset.sid || state.sel; state.sessionEvents = { sid: null, data: null, loaded: false }; render(); refreshSessionEvents(state.replayFor); break; }
      case 'replay-close': { state.replayFor = null; render(); break; }
      case 'rename-confirm': { const inp = $('#modalRoot input[type=text]'); const sid = el.dataset.id; if (inp && sid) doRename(sid, inp.value); closeModal(); break; }

      /* composer */
      case 'send': doSend(); break;
      case 'skill-add': openSkillPicker(); break;
      case 'expert-add': openExpertPicker(); break;
      case 'skill-attach': toast(`已加载技能「${el.dataset.n}」（注册为 effect，离开会话即卸载）`, 'ok'); closeModal(); break;
      case 'expert-attach': toast(`已 @引用「${el.dataset.n}」参与本次回复（SubAgent）`, 'ok'); closeModal(); break;
      case 'auth-open': openAuthPicker(); break;
      case 'auth-mode-pick': {
        const target = el.dataset.id;
        if (target === state.authMode) { closeModal(); break; }
        // 从更严切到更松需二次确认（T-P3-2 防 L4 风险）。
        const loosening = (MODE_RANK[target] ?? 1) > (MODE_RANK[state.authMode] ?? 1);
        if (loosening) { confirmSwitchAuth(target); }
        else { doSwitchAuth(target); }
        break;
      }
      case 'auth-do-switch': { const target = el.dataset.id; closeModal(); doSwitchAuth(target); break; }
      case 'sim-highrisk': { const z = $('#confirmZone'); z.innerHTML = `<div class="confirm-banner"><span class="badge warn">意图 · 待确认</span> 该请求含「删除文件」高风险动作，本地模型判定需人工确认。
        <div class="row" style="margin-top:8px"><button class="btn sm primary" data-action="confirm-yes">确认执行</button><button class="btn sm" data-action="confirm-no">拒绝</button></div></div>`; z.scrollIntoView(); break; }
      case 'approval-allow': { const id = el.dataset.id; closeModal(); bridge.submitDecision(id, 'allowed-once'); toast('已允许本次操作（allowed-once）', 'ok'); break; }
      /* 授权白名单（PRD FR-9）：会话 / 永久粒度 —— 先建规则再放行，规则失败则拒绝 */
      case 'approval-grant': {
        const id = el.dataset.id;
        const scope = el.dataset.scope === 'permanent' ? 'permanent' : 'session';
        const tool = el.dataset.tool || '';
        const target = el.dataset.target || '';
        closeModal();
        bridge.addGrant({
          tool,
          pattern: target,
          scope,
          ...(scope === 'session' ? { sessionId: state.sel || '' } : {}),
          note: '审批弹窗授权',
        }).then((r) => {
          if (!r || !r.ok) {
            bridge.submitDecision(id, 'rejected');
            toast(`白名单写入失败，已拒绝：${(r && r.reason) || '未知原因'}`, 'err');
            return;
          }
          state.grants = Array.isArray(r.grants) ? r.grants : state.grants;
          bridge.submitDecision(id, 'allowed-once');
          toast(scope === 'permanent' ? '已永久允许（可在设置页撤销）' : '本会话内不再询问', 'ok');
        }).catch((e) => {
          bridge.submitDecision(id, 'rejected');
          toast('白名单写入失败，已拒绝: ' + ((e && e.message) || e), 'err');
        });
        break;
      }
      case 'approval-deny': { const id = el.dataset.id; closeModal(); bridge.submitDecision(id, 'rejected'); toast('已拒绝该操作', 'danger'); break; }
      case 'confirm-yes': case 'confirm-no': { const z = $('#confirmZone'); z.innerHTML = ''; toast(a === 'confirm-yes' ? '已确认 · 入审计日志' : '已拒绝 · 入审计日志', a === 'confirm-yes' ? 'ok' : 'danger'); break; }

      /* 补偿层（T-P5-1） */
      /* 沙箱日志（PRD FR-8 可检索）：检索条件变更由 input/change 监听驱动，
         这里只处理「清空」这个破坏性动作。 */
      /* 数据目录清单（PRD FR-4.2）：导入/导出之后体积会变，手动重扫。 */
      case 'dir-inv-refresh': {
        refreshDataDirInventory();
        toast('正在重新扫描数据目录…', 'ok');
        break;
      }

      /* 分层记忆晋升（PRD FR-10，第十四个死挂点）：
         插件的 promote() 一直存在但零调用方，这里补的是调用链。 */
      case 'mem-domain': {
        state.memory.domain = el.dataset.domain || 'worker';
        refreshMemoryDomain();
        break;
      }
      case 'mem-refresh': {
        refreshMemoryDomain();
        break;
      }
      case 'mem-promote': {
        const id = el.dataset.id || '';
        const from = el.dataset.from || state.memory.domain;
        const to = el.dataset.to || '';
        if (!id || !to) { toast('晋升参数缺失', 'warn'); break; }
        if (typeof bridge.promoteMemory !== 'function') { toast('晋升未接入（主进程桥不可用）', 'warn'); break; }
        state.memory.busy = true; render();
        bridge.promoteMemory({ id, from, to }).then((r) => {
          state.memory.busy = false;
          const ok = !!(r && r.ok);
          // 被 Director 驳回不是错误：那是过滤在正常工作。用 warn 而不是 err，
          // 否则用户会以为功能坏了，实际是「这条结论没被放行」。
          toast(memReasonText(r && r.reason), ok ? 'ok' : 'warn');
          refreshMemoryDomain();
        }).catch((err) => {
          state.memory.busy = false;
          toast(`晋升失败：${(err && err.message) || err}`, 'err');
          render();
        });
        break;
      }
      case 'mem-promote-worker': {
        if (typeof bridge.promoteWorkerDomain !== 'function') { toast('批量晋升未接入（主进程桥不可用）', 'warn'); break; }
        state.memory.busy = true; render();
        bridge.promoteWorkerDomain('director').then((r) => {
          state.memory.busy = false;
          if (!r || !r.ok) { toast(`批量晋升失败：${(r && r.reason) || '未知原因'}`, 'warn'); render(); return; }
          // 全部被拒不是失败 —— Director 就是干这个的。只报事实，不报情绪。
          toast(`已处理 ${r.attempted} 条：晋升 ${r.promoted} · 驳回 ${r.rejected}${r.remaining ? ` · 还剩 ${r.remaining} 条，可再点一次` : ''}`, r.promoted ? 'ok' : 'warn');
          refreshMemoryDomain();
        }).catch((err) => {
          state.memory.busy = false;
          toast(`批量晋升异常：${(err && err.message) || err}`, 'err');
          render();
        });
        break;
      }
      case 'mp-clear': {
        if (!state.memoryPromotions.total) break;
        bridge.clearMemoryPromotions().then((r) => {
          if (!r || !r.ok) { toast('清空失败（主进程未接入）', 'warn'); return; }
          state.memoryPromotions = {
            entries: [], stats: { total: 0, promoted: 0, rejected: 0, byEdge: [] },
            total: 0, max: state.memoryPromotions.max, ok: state.memoryPromotions.ok, loaded: true,
          };
          render();
          toast(`已清空晋升审计（${r.cleared} 条）`, 'ok');
        }).catch(() => toast('清空失败', 'err'));
        break;
      }
      case 'sblog-clear': {
        if (!state.sandboxLog.total) break;
        bridge.clearSandboxLog().then((r) => {
          if (!r || !r.ok) { toast('清空失败（主进程未接入）', 'warn'); return; }
          state.sandboxLog.entries = [];
          state.sandboxLog.total = 0;
          state.sandboxLog.stats = { total: 0, allowed: 0, denied: 0, error: 0, byTool: [] };
          render();
          toast(`已清空沙箱日志（${r.cleared} 条）`, 'ok');
        }).catch(() => toast('清空失败', 'err'));
        break;
      }
      case 'sandbox-save-net': {
        const ta = document.getElementById('net-allow');
        const list = String((ta && ta.value) || '').split('\n').map((s) => s.trim()).filter(Boolean);
        const tip = document.getElementById('net-allow-tip');
        bridge.setNetworkAllow(list.length ? list : ['*']).then((r) => {
          if (r && r.ok) {
            state.sandbox.networkAllow = r.networkAllow || ['*'];
            if (tip) tip.textContent = `已保存（${state.sandbox.networkAllow.join('、')}）`;
            toast('沙箱：网络域名白名单已更新', 'ok');
          } else {
            if (tip) tip.textContent = `保存失败：${(r && r.reason) || '未知原因'}`;
            toast('沙箱白名单保存失败', 'warn');
          }
        }).catch(() => { if (tip) tip.textContent = '保存失败（主进程未接入）'; });
        break;
      }
      case 'comp-record': {
        openModal(`<div class="mh">${ic('warn', 18)}<b>记录补偿动作</b></div>
          <div class="mb">
            <div class="faint" style="margin-bottom:8px">补偿层无形式化保证，仅做尽力补偿。描述已发生的边界外/不可逆操作：</div>
            <textarea id="compText" class="inp" rows="3" placeholder="如：已删除 /tmp/secret.txt"></textarea>
          </div>
          <div class="mf"><button class="btn ghost" data-action="modal-cancel">取消</button><button class="btn primary" data-action="comp-do">记录</button></div>`);
        break;
      }
      case 'comp-do': {
        const t = ($('#compText')?.value || '').trim();
        if (!t) { toast('请描述操作', 'warn'); break; }
        try {
          const rec = await bridge.compensate(t);
          state.compAudit.unshift(rec);
          closeModal(); render(); toast('补偿动作已记录并入审计', 'ok');
        } catch { toast('记录失败（运行时未接入）', 'warn'); }
        break;
      }

      /* 自进化临时插件（T-P5-2） */
      case 'tp-new': {
        openModal(`<div class="mh">${ic('skills', 18)}<b>新建临时插件（自进化）</b></div>
          <div class="mb">
            <div class="faint" style="margin-bottom:8px">信任级 = Shell，须沙箱内运行；仅驻内存，重启即失。加载前经静态分析 + CONFIRM。</div>
            <div class="mb-row"><label>名称</label><input id="tpName" class="inp" placeholder="如：summarizer"></div>
            <div class="mb-row"><label>代码</label><textarea id="tpCode" class="inp" rows="4" placeholder="export function run(t){ return t; }"></textarea></div>
          </div>
          <!-- 内联 onclick 里的 toast/bridge/state 都在 IIFE 作用域外，点击必 ReferenceError；
               逻辑已由下方委托的 case 'tp-create' 承担。 -->
          <div class="mf"><button class="btn ghost" data-action="modal-cancel">取消</button><button class="btn primary" data-action="tp-create">创建（CONFIRM）</button></div>`);
        break;
      }
      case 'tp-create': {
        const name = ($('#tpName')?.value || '').trim();
        const code = ($('#tpCode')?.value || '').trim();
        if (!name || !code) { toast('请填写名称与代码', 'warn'); break; }
        try {
          const r = await bridge.createTempPlugin({ name, code });
          if (r && r.ok) { state.tempPlugins.unshift(r.plugin); closeModal(); render(); toast(`已创建临时插件「${name}」（仅驻内存）`, 'ok'); }
          else { toast('创建被拒：' + ((r && r.reason) || '静态门控未通过'), 'danger'); }
        } catch { toast('创建失败（运行时未接入）', 'warn'); }
        break;
      }
      case 'tp-dispose': {
        try {
          const ok = await bridge.disposeTempPlugin(id);
          if (ok) state.tempPlugins = state.tempPlugins.filter((p) => p.id !== id);
          render(); toast('临时插件已卸载', 'warn');
        } catch { toast('卸载失败（运行时未接入）', 'warn'); }
        break;
      }
      case 'trace': {
        // key 必须与 renderMsg 的读取口径一致（sid|m.t）；此前硬编码 's1' 导致反馈永远显示不出来。
        const sid = state.sel || '';
        const key = sid + '|' + (el.dataset.t || '');
        const feedback = el.dataset.fb === 'negative' ? 'negative' : 'positive';
        if (state.feedback.has(key)) state.feedback.delete(key);
        else state.feedback.add(key);
        // 反馈落盘，重启后仍在（此前仅存于内存 Set）
        const s = state.sessions[sid];
        if (s) { s.feedback = [...state.feedback].filter((k) => k.startsWith(sid + '|')); persist(); }
        render();
        // 真实遥测落点（第八死挂点修复）：经 IPC → trace 插件 recordFeedback（source='user'）。
        // 此前按钮只改本地 Set，反馈从未进入遥测队列。
        const msg = (s && s.msgs || []).find((m) => m.t === el.dataset.t);
        bridge.traceFeedback({
          intent: (msg && msg.intent) || 'unknown',
          feedback,
          sessionKey: sid,
          messageKey: el.dataset.t || '',
        }).then((r) => {
          if (r && r.ok) toast(`TRACE：反馈已记录（待发 ${(r.queue && r.queue.pending) || 0} 条，脱敏后批量上送）`, 'ok');
          else if (r && r.reason) toast(`TRACE 反馈未能入队：${r.reason}`, 'warn');
        }).catch(() => {});
        break;
      }

      /* 模型选择 + 思维等级 */
      case 'composer-more-toggle': { state.composerMoreOpen = !state.composerMoreOpen; const cm = document.querySelector('.composer-more-dropdown'); if (cm) cm.classList.toggle('open', state.composerMoreOpen); break; }
      case 'model-pick': openModelPicker(); break;
      case 'model-toggle': {
        const n = el.dataset.n; const idx = state.selectedModels.indexOf(n);
        if (idx >= 0) { state.selectedModels.splice(idx, 1); el.classList.remove('sel'); }
        else { state.selectedModels.push(n); el.classList.add('sel'); }
        const btn = document.querySelector('[data-action="model-confirm"]'); if (btn) btn.textContent = `确认（${state.selectedModels.length} 个）`;
        document.querySelectorAll('.mg-all').forEach((sp) => { const p = sp.dataset.p; const grp = getModelPool().filter((m) => m.p.split(' · ')[0] === p); const allSel = grp.every((m) => state.selectedModels.includes(m.n)); sp.textContent = allSel ? '取消全选' : '全选'; });
        break;
      }
      case 'mg-toggle-all': {
        const p = el.dataset.p; const grp = getModelPool().filter((m) => m.p.split(' · ')[0] === p);
        const allSel = grp.every((m) => state.selectedModels.includes(m.n));
        if (allSel) grp.forEach((m) => { const i = state.selectedModels.indexOf(m.n); if (i >= 0) state.selectedModels.splice(i, 1); });
        else grp.forEach((m) => { if (!state.selectedModels.includes(m.n)) state.selectedModels.push(m.n); });
        openModelPicker(); break;
      }
      case 'model-confirm': {
        const selectedNames = [...state.selectedModels];
        // 持久化到 localStorage（跨会话复用）
        if (selectedNames.length === 0) {
          try { localStorage.removeItem(MODEL_SELECTION_KEY); } catch { /* ignore */ }
          autoSelectModels(state.modelProviders, state.defaultProvider, state.defaultModel);
          toast('未选择模型，已回退默认策略', 'warn');
        } else {
          saveModelSelection(selectedNames);
        }
        // 持久化到当前选中会话
        const curS = state.sessions[state.sel];
        if (curS && selectedNames.length) curS.model = selectedNames[0];
        if (curS) curS.models = selectedNames;
        closeModal(); render(); break;
      }
      case 'model-clear': state.selectedModels = []; openModelPicker(); break;

      /* 插件 */
      case 'pside-toggle': { if (state.plugSideExpanded.has(id)) state.plugSideExpanded.delete(id); else state.plugSideExpanded.add(id); render(); break; }
      case 'plug-toggle': {
        // 真实热插拔（FR-3）：此前只切 CSS class + toast，插件从未真正加载/卸载。
        const wantOn = !el.classList.contains('on');
        el.style.pointerEvents = 'none'; el.style.opacity = '0.6';
        try {
          const r = await bridge.setPluginEnabled(id, wantOn);
          if (r && r.ok) {
            // 以运行时返回的真实状态为准，不乐观更新
            const on = r.active === true;
            el.classList.toggle('on', on);
            state.pluginRuntime = await bridge.getPluginRuntime().catch(() => state.pluginRuntime);
            toast(on ? `已启用 ${id}（注册为 effect）` : `已停用 ${id}（注册已回滚，无残留）`, on ? 'ok' : 'warn');
          } else {
            toast(`切换失败：${(r && r.reason) || '未知错误'}`, 'danger');
          }
        } catch (err) {
          toast(`切换异常：${(err && err.message) || err}`, 'danger');
        } finally {
          el.style.pointerEvents = ''; el.style.opacity = '';
          render();
        }
        break;
      }
      case 'plug-cfg': { const card = el.closest('.plug'); if (card) card.classList.toggle('open'); break; }
      case 'plug-nav': { const card = document.querySelector(`.plug[data-pid="${id}"]`); if (card) { card.classList.add('open'); card.scrollIntoView({ behavior: 'smooth', block: 'start' }); } break; }
      case 'plug-unload': toast('已卸载并回滚注册（无残留）', 'warn'); break;
      case 'market': toast(`「${el.dataset.n}」请到 设置-技能市场（观雅集）完成安装与能力审查`, 'warn'); break;
      case 'market-auth': toast(`「${el.dataset.n}」需授权：请在 设置-技能市场 安装时于确认弹窗中授权高危能力`, 'warn'); break;

      /* 连接器（PRD FR-3） */
      case 'conn-cfg':
        state.connectors.expanded = state.connectors.expanded === id ? null : id;
        if (state.page === 'plugins') render();
        break;
      case 'conn-test': {
        el.textContent = '测试中…'; el.disabled = true;
        bridge.connectorTest(id).then((r) => {
          if (!r || r.ok === false && r.reason) { toast(String(r && r.reason || '探测失败'), 'err'); }
          else toast(r.message || (r.ok ? '连通性正常' : '探测失败'), r.ok ? 'ok' : 'warn');
          refreshConnectors();
        }).catch((err) => { toast(`探测失败：${err && err.message || err}`, 'err'); refreshConnectors(); });
        break;
      }
      case 'conn-save': {
        const inputs = document.querySelectorAll(`[id^="connf-${id}-"]`);
        const creds = {};
        inputs.forEach((inp) => { creds[inp.id.replace(`connf-${id}-`, '')] = inp.value; });
        el.textContent = '保存中…'; el.disabled = true;
        bridge.connectorSave(id, creds).then((r) => {
          if (!r || r.ok === false) { toast(String(r && r.reason || '保存失败'), 'err'); }
          else if (r.configured === false) toast('凭证已保存（必填字段不完整）', 'warn');
          else if (r.probe) toast(r.probe.manual ? String(r.probe.message || '已保存') : (r.probe.ok ? `已保存 · ${r.probe.message}` : `已保存 · ${r.probe.message}`), r.probe.manual || r.probe.ok ? 'ok' : 'warn');
          else toast('凭证已保存', 'ok');
          refreshConnectors();
        }).catch((err) => { toast(`保存失败：${err && err.message || err}`, 'err'); refreshConnectors(); });
        break;
      }
      case 'conn-clear': {
        bridge.connectorClear(id).then((r) => {
          toast(r && r.ok ? '凭证已清除' : String(r && r.reason || '清除失败'), r && r.ok ? 'ok' : 'err');
          refreshConnectors();
        }).catch((err) => toast(`清除失败：${err && err.message || err}`, 'err'));
        break;
      }
      case 'conn-audit-clear':
        bridge.clearConnectorAudit().then((r) => {
          toast(r && r.ok ? `已清空 ${r.cleared} 条审计` : '清空失败', r && r.ok ? 'ok' : 'err');
          refreshConnectorAudit();
        }).catch(() => {});
        break;
      case 'open-external':
        if (typeof bridge.openExternal === 'function') {
          bridge.openExternal(el.dataset.url || '').then((r) => {
            if (!r || !r.ok) toast(String(r && r.reason || '无法打开链接'), 'err');
          }).catch(() => {});
        } else toast('外部链接打开未接入', 'warn');
        break;

      /* 本地插件市场（PRD FR-3） */
      case 'market-refresh': refreshMarket(); break;

      /* FR-5 用量追踪 */
      case 'usage-refresh': refreshUsage(); break;
      case 'usage-clear':
        bridge.clearUsage().then((r) => {
          toast(r && r.ok ? '用量记账已清空' : String(r && r.reason || '清空失败'), r && r.ok ? 'ok' : 'err');
          refreshUsage();
        }).catch(() => {});
        break;
      case 'market-open-dir':
        if (typeof bridge.openMarketDir !== 'function') { toast('未接入', 'warn'); break; }
        bridge.openMarketDir().then((r) => {
          if (!r || !r.ok) toast(String(r && r.reason || '无法打开插件目录'), 'err');
          else toast('已在系统文件管理器打开插件目录', 'ok');
        }).catch((err) => toast(`打开失败：${err && err.message || err}`, 'err'));
        break;
      case 'market-local-toggle': {
        const item = state.market.items.find((x) => x.dir === id);
        const next = !(item && item.enabled);
        if (item) state.market.busy = id;
        if (typeof bridge.setMarketPluginEnabled !== 'function') { toast('未接入', 'warn'); break; }
        bridge.setMarketPluginEnabled(id, next).then((r) => {
          if (!r || r.ok === false) {
            toast(String(r && r.reason || '操作失败'), 'err');
          } else if (r.state && r.state.active) {
            toast(`已启用并装载：${r.state.manifest && r.state.manifest.name || id}`, 'ok');
          } else if (r.state && r.state.enabled) {
            toast('装载完成但未激活（注入的依赖未满足）', 'warn');
          } else {
            toast('已停用（逆回滚完成，无残留）', 'ok');
          }
          refreshMarket();
        }).catch((err) => toast(`操作失败：${err && err.message || err}`, 'err'));
        break;
      }
      case 'market-local-nav': break;

      /* T-P6-1 观雅集技能市场 */
      case 'guanji-token': {
        askInput({
          title: '配置观雅集 TOKEN',
          label: '粘贴观雅集持久化 TOKEN（来自 https://skill.ytaiv.com/api/auth/token，登录后获取）。TOKEN 将经系统安全存储加密保存，绝不硬编码。',
          placeholder: '粘贴 TOKEN…',
          secret: true,
          okText: '保存',
          onOk: async (t) => {
            if (!t || !t.trim()) { toast('TOKEN 为空', 'warn'); return; }
            const r = await bridge.guanjiSetToken(t.trim());
            state.guanjiTokenSet = !!(r && r.ok);
            if (state.guanjiTokenSet) { try { state.guanjiSkills = await bridge.guanjiList(); } catch { /* 回落静态样本 */ } }
            toast(state.guanjiTokenSet ? '观雅集 TOKEN 已配置' : `TOKEN 配置失败：${(r && r.reason) || '未知错误'}`, state.guanjiTokenSet ? 'ok' : 'danger');
            render();
          },
        });
        break;
      }
      case 'guanji-install': {
        const slug = el.dataset.slug;
        const list = state.guanjiSkills.length ? state.guanjiSkills : SKILLS_MARKET.map((s) => ({ slug: s.n, name: s.n, description: s.d, caps: s.caps, auth: s.auth }));
        const skill = list.find((x) => x.slug === slug);
        if (!skill) break;
        if (skill.auth === 1) {
          // 高危技能：先弹显式授权确认（列出声明的 L3/L4 高危能力），确认后 authorized=true 安装。
          openModal(`<div class="mh">${ic('shield', 18)}<b>授权安装「${esc(skill.name || slug)}」</b></div>
            <div class="mb">
              <div class="faint" style="margin-bottom:8px">该技能声明了 L3/L4 高危能力，安装后即获得这些权限（L3/L4 强制授权，不可凭 TOKEN 绕过）。请确认：</div>
              <div>${skill.caps.map((c) => `<span class="badge warn" style="margin:2px 4px 2px 0">${esc(c)}</span>`).join('')}</div>
            </div>
            <div class="mf"><button class="btn ghost" data-action="modal-cancel">取消</button>
              <button class="btn danger" data-action="guanji-install-auth" data-slug="${esc(slug)}">授权并安装</button></div>`);
        } else {
          await doInstallGuanjiSkill(skill, false);
        }
        break;
      }
      case 'guanji-install-auth': {
        const slug = el.dataset.slug;
        const list = state.guanjiSkills.length ? state.guanjiSkills : SKILLS_MARKET.map((s) => ({ slug: s.n, name: s.n, description: s.d, caps: s.caps, auth: s.auth }));
        const skill = list.find((x) => x.slug === slug);
        if (!skill) break;
        await doInstallGuanjiSkill(skill, true);
        break;
      }
      case 'guanji-publish': {
        askInput({
          title: '发布技能到观雅集',
          label: '输入技能 slug（与 .skill 包根 SKILL.md 的 name 一致）。发布需已配置 TOKEN；.skill 包经 Electron 文件对话框选择后上传。',
          placeholder: '技能 slug…',
          okText: '发布',
          onOk: async (slug) => {
            if (!slug || !slug.trim()) { toast('slug 为空', 'warn'); return; }
            const r = await bridge.guanjiPublish({ slug: slug.trim(), filePath: '' });
            toast(r && r.ok ? `已发布「${slug.trim()}」到观雅集` : `发布失败：${(r && r.reason) || '需配置 TOKEN 与有效 .skill 文件'}`, r && r.ok ? 'ok' : 'danger');
            render();
          },
        });
        break;
      }
      case 'skill-toggle': { const s = state.installedSkills.find((x) => x.slug === el.dataset.n); if (s) { s.enabled = !s.enabled; render(); } break; }
      case 'skill-uninstall': {
        // 真删磁盘包。此前只从渲染层数组移除，文件还在 —— 下次启动又冒出来。
        const slug = el.dataset.n;
        try {
          const r = typeof bridge.uninstallSkill === 'function'
            ? await bridge.uninstallSkill(slug)
            : { ok: false, reason: '主进程未接入' };
          if (r && r.ok) {
            state.installedSkills = state.installedSkills.filter((x) => x.slug !== slug);
            toast(`已卸载「${slug}」`, 'warn');
          } else {
            toast(`卸载失败：${(r && r.reason) || '未知错误'}`, 'danger');
          }
        } catch (err) {
          toast(`卸载异常：${(err && err.message) || err}`, 'danger');
        }
        render();
        break;
      }

      /* MCP（真接入） */
      case 'mcp-add': {
        openModal(`<div class="mh">${ic('zap', 18)}<b>添加 MCP server</b></div>
          <div class="mb">
            <div class="faint" style="margin-bottom:8px">stdio 传输：填写启动命令与参数。env 值（如 API 密钥）将<b>加密</b>落盘。保存即握手探测一次。</div>
            <div class="mb-row"><label>ID（唯一）</label><input id="mcpId" class="inp" placeholder="如 filesystem / github"></div>
            <div class="mb-row"><label>显示名</label><input id="mcpName" class="inp" placeholder="可留空，默认用 ID"></div>
            <div class="mb-row"><label>命令</label><input id="mcpCmd" class="inp" placeholder="npx / uvx / node / 绝对路径"></div>
            <div class="mb-row"><label>参数（空格分隔）</label><input id="mcpArgs" class="inp" placeholder="-y @modelcontextprotocol/server-filesystem /path"></div>
            <div class="mb-row"><label>环境变量（KEY=VALUE，一行一个，选填）</label><textarea id="mcpEnv" class="inp" rows="3" placeholder="GITHUB_TOKEN=ghp_xxx"></textarea></div>
          </div>
          <div class="mf"><button class="btn ghost" data-action="modal-cancel">取消</button>
            <button class="btn primary" data-action="mcp-save">保存并探测</button></div>`);
        break;
      }
      case 'mcp-save': {
        const id = ($('#mcpId') && $('#mcpId').value || '').trim();
        const name = ($('#mcpName') && $('#mcpName').value || '').trim();
        const command = ($('#mcpCmd') && $('#mcpCmd').value || '').trim();
        const argsRaw = ($('#mcpArgs') && $('#mcpArgs').value || '').trim();
        const envRaw = ($('#mcpEnv') && $('#mcpEnv').value || '').trim();
        if (!id || !command) { toast('ID 与命令必填', 'warn'); break; }
        const args = argsRaw ? argsRaw.split(/\s+/).filter(Boolean) : [];
        const env = {};
        if (envRaw) {
          for (const line of envRaw.split('\n')) {
            const eq = line.indexOf('=');
            if (eq <= 0) continue;
            env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
          }
        }
        try {
          const r = typeof bridge.mcpSave === 'function'
            ? await bridge.mcpSave({ id, name, command, args, env: Object.keys(env).length ? env : undefined, enabled: true })
            : { ok: false, reason: '主进程未接入' };
          if (r && r.ok) {
            const probe = r.probe;
            toast(probe && probe.connected
              ? `已保存并连接「${id}」· ${(probe.tools || []).length} 个工具`
              : (probe ? `已保存但连接失败：${probe.reason || '未知'}` : '已保存（未启用连接）'),
              probe && probe.connected ? 'ok' : 'warn');
          } else {
            toast(`保存失败：${(r && r.reason) || '未知错误'}`, 'danger');
          }
        } catch (err) {
          toast(`保存异常：${(err && err.message) || err}`, 'danger');
        }
        closeModal();
        await refreshMcp();
        render();
        break;
      }
      case 'mcp-probe': {
        const id = el.dataset.id;
        el.textContent = '探测中…'; el.disabled = true;
        try {
          const r = typeof bridge.mcpProbe === 'function'
            ? await bridge.mcpProbe(id)
            : { ok: false, reason: '主进程未接入' };
          const probe = r && r.probe;
          toast(probe && probe.connected
            ? `已连接「${id}」· ${(probe.tools || []).length} 个工具`
            : `连接失败：${(probe && probe.reason) || (r && r.reason) || '未知'}`, probe && probe.connected ? 'ok' : 'warn');
        } catch (err) {
          toast(`探测异常：${(err && err.message) || err}`, 'danger');
        }
        await refreshMcp();
        render();
        break;
      }
      case 'mcp-toggle': {
        const id = el.dataset.id;
        const cur = state.mcp.servers.find((x) => x.id === id);
        const want = !(cur && cur.enabled !== false);
        try {
          const r = typeof bridge.mcpSetEnabled === 'function'
            ? await bridge.mcpSetEnabled(id, want)
            : { ok: false, reason: '主进程未接入' };
          if (!r || !r.ok) toast(`切换失败：${(r && r.reason) || '未知错误'}`, 'danger');
        } catch (err) {
          toast(`切换异常：${(err && err.message) || err}`, 'danger');
        }
        await refreshMcp();
        render();
        break;
      }
      case 'mcp-del': {
        const id = el.dataset.id;
        try {
          const r = typeof bridge.mcpDelete === 'function'
            ? await bridge.mcpDelete(id)
            : { ok: false, reason: '主进程未接入' };
          toast(r && r.ok ? `已删除「${id}」` : `删除失败：${(r && r.reason) || '未知错误'}`, r && r.ok ? 'warn' : 'danger');
        } catch (err) {
          toast(`删除异常：${(err && err.message) || err}`, 'danger');
        }
        await refreshMcp();
        render();
        break;
      }

      /* T-P6-2 OrchClaw Hub 联调 */
      case 'hub-pair': {
        const url = (($('#hubUrl') && $('#hubUrl').value) || '').trim();
        const token = (($('#hubToken') && $('#hubToken').value) || '').trim();
        if (!url || !token) { toast('请填写 Hub URL 与配对凭据', 'danger'); break; }
        const r = await bridge.hubPair(url, token);
        if (r && r.ok) { state.hubStatus = { paired: true, url, agentName: r.agentName }; state.hubUrl = url; toast(`已配对远程 Agent${r.agentName ? '：' + r.agentName : ''}`, 'ok'); }
        else { toast(`配对失败：${(r && r.reason) || '未知错误'}`, 'danger'); }
        render();
        break;
      }
      case 'hub-send': {
        const text = (($('#hubTask') && $('#hubTask').value) || '').trim();
        if (!text) { toast('请填写任务内容', 'danger'); break; }
        state.hubTaskText = text;
        const r = await bridge.hubSend(text);
        if (r && r.ok && r.taskId) {
          toast('任务已下发，正在回收结果…', 'ok');
          const res = await bridge.hubResult(r.taskId);
          state.hubResultText = (res && res.result) ? res.result : `状态：${(res && res.status) || 'unknown'}`;
        } else { state.hubResultText = `发送失败：${(r && r.reason) || '未配对'}`; }
        render();
        break;
      }
      case 'hub-unpair': { state.hubStatus = { paired: false }; state.hubResultText = ''; toast('已解除配对', 'warn'); render(); break; }

      /* 设置 */
      case 'model-test': {
        // 此前用 800ms setTimeout 伪造「连通正常」，而真正的 bridge.testModel 从未被调用 —— 假成功。
        // 改为真实连通性测试：主进程发一次真实请求并计时。
        const pid = el.dataset.id || '';
        const model = el.dataset.n || '';
        el.disabled = true; el.textContent = '测试中…';
        try {
          const r = await bridge.testModel(pid, model);
          if (r && r.ok) toast(`${model} 连通正常（${r.latencyMs != null ? r.latencyMs + 'ms' : '已响应'}）`, 'ok');
          else toast(`${model} 连通失败：${(r && r.error) || '未知错误'}`, 'danger');
        } catch (err) {
          toast(`测试异常：${(err && err.message) || err}`, 'danger');
        } finally {
          el.disabled = false; el.textContent = '测试';
        }
        break;
      }
      case 'model-edit-provider': {
        const p = (state.modelProviders || []).find(x => x.id === el.dataset.id);
        if (!p) break;
        state.mpEditing = { id: p.id };
        render();
        $('#mp-type').value = p.type || 'ollama';
        $('#mp-name').value = p.name;
        $('#mp-url').value = p.baseUrl;
        $('#mp-fullurl').checked = true;
        $('#mp-mode').value = p.apiMode || 'chat';
        $('#mp-key').value = '';
        $('#mp-models').value = (p.models || []).join(', ');
        updateProtocolRow();
        $('#mp-name').focus();
        break;
      }
      case 'model-del-provider': {
        state.modelProviders = (state.modelProviders || []).filter(x => x.id !== el.dataset.id);
        const r = await bridge.saveModelConfig({ providers: state.modelProviders, defaultProvider: state.defaultProvider });
        if (r && r.ok) {
          try { const mc = await bridge.getModelConfig(); if (mc && mc.providers) dynamicModels = mc.providers.flatMap(p => p.models.map(n => ({ n, p: p.name + ' · ' + p.type, k: '(本地)', state: '已配' }))); } catch { dynamicModels = []; }
          toast('提供商已删除', 'warn'); renderModelProviders();
        } else { toast('删除失败', 'danger'); }
        break;
      }
      case 'model-cancel-edit': { state.mpEditing = null; render(); break; }
      case 'model-add-provider': {
        const type = $('#mp-type')?.value || 'ollama';
        const name = $('#mp-name')?.value?.trim();
        let url = $('#mp-url')?.value?.trim();
        const full = ($('#mp-fullurl')?.checked);
        const key = $('#mp-key')?.value?.trim();
        const modelsStr = $('#mp-models')?.value?.trim();
        const apiMode = type === 'openai-compatible' ? ($('#mp-mode')?.value || 'chat') : 'ollama';
        if (!name || !url) { toast('请填写名称和 Base URL', 'warn'); break; }
        if (!full) {
          const proto = url.startsWith('http://') ? 'http://' : url.startsWith('https://') ? 'https://' : 'http://';
          url = proto + url;
        }
        const models = modelsStr ? modelsStr.split(',').map(s => s.trim()).filter(Boolean) : ['default'];
        const isEdit = !!state.mpEditing;
        const providers = [...(state.modelProviders || [])];
        if (isEdit) {
          const idx = providers.findIndex(p => p.id === state.mpEditing.id);
          const provider = { id: state.mpEditing.id, name, type, apiMode, baseUrl: url, models, apiKey: key };
          if (idx >= 0) providers[idx] = provider;
          else providers.push(provider);
          state.mpEditing = null;
        } else {
          const id = name.toLowerCase().replace(/[^a-z0-9]/g, '-');
          providers.push({ id, name, type, apiMode, baseUrl: url, models, apiKey: key });
        }
        const r2 = await bridge.saveModelConfig({ providers, defaultProvider: type === 'ollama' ? providers[providers.length - 1]?.id : (state.defaultProvider || providers[0]?.id) });
        if (r2 && r2.ok) {
          state.modelProviders = providers;
          try { const mc2 = await bridge.getModelConfig(); if (mc2 && mc2.providers) dynamicModels = mc2.providers.flatMap(p => p.models.map(n => ({ n, p: p.name + ' · ' + p.type, k: key ? 'sk-••••••••' : '(本地)', state: '已配' }))); } catch { dynamicModels = []; }
          toast(isEdit ? `提供商「${name}」已更新` : `提供商「${name}」已添加`, 'ok');
          if (!isEdit) { $('#mp-name').value = ''; $('#mp-url').value = ''; $('#mp-key').value = ''; $('#mp-models').value = ''; }
          renderModelProviders();
        } else { toast(`保存失败：${(r2 && r2.reason) || ''}`, 'danger'); }
        break;
      }
      // 兜底：UI 里不该再出现未接线动作。此前这里弹「该操作在真实版本中打开
      // 对应面板」——可这就是真实版本，那句话等于用假承诺把死挂点糊过去。
      // 现在未接线动作会在控制台报警，并在界面上如实说「未接线」。
      case 'todo':
        console.warn('[orchdesk] 未接线的动作被点击：', el.dataset.action, el.outerHTML.slice(0, 120));
        toast('该动作尚未接线（已记录到控制台）', 'warn');
        break;
      default:
        // 动作名拼错 / 新增动作忘了写分支 —— 别静默吞掉。
        console.warn('[orchdesk] 未知的 data-action：', a);
        break;

      /* T-P6-3 数据快照 + 更新检查 */
      case 'open-project-dir': {
        // 设置页语义 = 打开数据目录，故意不传项目路径（项目目录走项目的 `··` 菜单）。
        const r = await bridge.openProjectDir();
        toast(r && r.ok ? `已打开数据目录：${(r && r.path) || ''}` : `打开失败：${(r && r.reason) || '未知错误'}`, r && r.ok ? 'ok' : 'danger');
        break;
      }
      /* 日志目录（模型调用 / 插件加载诊断留痕） */
      case 'open-log-dir': {
        const r = await bridge.openLogDir();
        toast(r && r.ok ? `已打开日志目录\n当前日志: ${r.file || ''}` : `打开失败：${(r && r.reason) || '未知错误'}`, r && r.ok ? 'ok' : 'danger');
        break;
      }
      case 'snapshot-data': { const r = await bridge.snapshotData(); toast(r && r.ok ? `数据快照已生成：${r.dir}` : `快照失败：${(r && r.reason) || ''}`, r && r.ok ? 'ok' : 'danger'); break; }
      /* BUG-013 方案 B：数据导出 / 导入 */
      case 'export-data': {
        const r = await bridge.exportData();
        toast(r && r.ok ? `数据已导出：${r.path}` : (r && r.reason === 'cancelled' ? '已取消导出' : `导出失败：${(r && r.reason) || ''}`), r && r.ok ? 'ok' : (r && r.reason === 'cancelled' ? 'ok' : 'danger'));
        break;
      }
      case 'import-data': {
        importSuspend = true;
        try {
          const r = await bridge.importData();
          if (r && r.ok) {
            const parts = [];
            const im = r.imported || {};
            if (im.sessions) parts.push(`会话 ×${im.sessions}`);
            if (im.projects) parts.push(`项目 ×${im.projects}`);
            if (im.providers) parts.push(`模型提供商 ×${im.providers}`);
            if (im.guanji) parts.push('观雅集 TOKEN');
            if (im.hub) parts.push('Hub 凭据');
            const notes = (r.notes || []).join('\n');
            const summary = parts.length ? parts.join(' · ') : '本地数据已包含备份内容，无新增';
            toast(`导入完成：${summary}${notes ? '\n' + notes : ''}`, 'ok');
            // 重新拉取会话与项目分组（主进程已重载内存态；sessions 是按 id 的 map，需归一化）
            try {
              const [sess, projs] = await Promise.all([bridge.loadSessions(), bridge.loadProjects()]);
              if (Array.isArray(sess) && sess.length) {
                state.sessions = {};
                sess.forEach((s) => { state.sessions[s.id] = s; });
                if (!state.sessions[state.sel]) state.sel = sess[0].id;
              }
              if (Array.isArray(projs) && projs.length) state.projects = projs;
              render();
            } catch { /* 渲染层自行降级：下次启动生效 */ }
          } else {
            toast(r && r.reason === 'cancelled' ? '已取消导入' : `导入失败：${(r && r.reason) || ''}`, r && r.reason === 'cancelled' ? 'ok' : 'danger');
          }
        } finally {
          importSuspend = false; // 任何异常路径都必须恢复落盘，否则后续变更永不持久化
        }
        break;
      }
      case 'check-updates': {
        toast('正在先快照数据目录，然后检查更新…', 'ok');
        const r = await bridge.checkUpdates();
        const snap = (r && r.snapshot && r.snapshot.ok) ? `数据快照：${r.snapshot.dir}` : '数据快照失败';
        const upd = (r && r.update) ? (r.update.available ? `发现新版本 ${r.update.version}` : (r.update.note || '已是最新')) : (r && r.reason || '更新检查暂不可用');
        toast(`${snap}\n${upd}`, (r && r.update && r.update.available) ? 'ok' : 'warn');
        break;
      }

      /* 系统提示词（T-P4-3） */
      case 'prompt-new': openPromptEditor(null); break;
      case 'prompt-edit': { const d = state.promptDocs.find((x) => x.id === id); openPromptEditor(d || null); break; }
      case 'prompt-save': doSavePrompt(id); break;
      case 'prompt-delete': doDeletePrompt(id); break;

      /* modal */
      case 'modal-bg': if (e.target === el) { state.askInputCb = null; state.browserPanelOpen = false; closeModal(); } break;
      case 'modal-cancel': state.askInputCb = null; state.browserPanelOpen = false; closeModal(); break;

      /* 浏览器面板（ADR-0011）+ 侧栏（需求3） */
      case 'browser-panel': {
        // 右下角图标：浏览器已打开 → 切换侧栏；未打开 → 打开详情弹窗（里面说明了触发方式）
        if (state.browser.open) {
          state.browserSideOpen = !state.browserSideOpen;
          renderBrowserSide();
          renderStatusBarActions();
        } else {
          openBrowserPanel();
        }
        break;
      }
      case 'bw-side-close': {
        state.browserSideOpen = false;
        renderBrowserSide();
        renderStatusBarActions();
        break;
      }
      case 'bw-tab-close': {
        const id = el.dataset.id;
        if (!id) break;
        const r = await bridge.closeBrowserPage(id);
        if (r && r.state) applyBrowserState(r.state);
        break;
      }
      case 'bw-tab-clear': {
        const r = await bridge.clearBrowserPages();
        if (r && r.state) applyBrowserState(r.state);
        toast('已关闭全部页面', 'ok');
        break;
      }
      case 'bw-tab-focus': {
        // 单窗口模型：切到历史页面 = 把窗口导航过去（用户亲手操作，不过授权门）
        const id = el.dataset.id;
        const p = (state.browser.pages || []).find((x) => x.id === id);
        if (!p) break;
        const r = await bridge.browserGoto(p.url);
        if (r && r.state) applyBrowserState(r.state);
        if (r && r.ok === false) toast(`切换失败：${r.reason || ''}`, 'err');
        break;
      }
      case 'browser-show': browserAct(() => bridge.setBrowserVisible(true)); break;
      case 'browser-hide': browserAct(() => bridge.setBrowserVisible(false)); break;
      case 'browser-close': browserAct(() => bridge.closeBrowser(), '浏览器已关闭'); break;

      /* 终端面板（P2-10）+ 底部抽屉（需求3） */
      case 'terminal-panel': {
        // 右下角图标：展开 / 收起抽屉
        if (state.terminalPanelOpen) closeTerminalPanel(); else openTerminalPanel();
        break;
      }
      case 'term-full': toggleTermFull(); break;
      case 'term-close': closeTerminalPanel(); break;
      case 'term-new': newTerminalSession(); break;
      case 'term-tab': {
        if (state.terminal.activeId !== id) {
          state.terminal.activeId = id;
          renderTerminalPanel();
        }
        break;
      }
      case 'term-tab-close': {
        bridge.terminalKill(id).then(() => refreshTerminal());
        break;
      }

      /* 文件面板（P2-11） */
      case 'file-panel': openFilePanel(); break;
      case 'file-close': closeFilePanel(); break;
      case 'file-pick': pickFileRoot(); break;
      case 'file-refresh': {
        state.filePanel.children.delete(state.filePanel.root);
        state.filePanel.expanded = new Set([state.filePanel.root]);
        loadFileDir(state.filePanel.root);
        break;
      }
      case 'file-toggle': {
        const path = el.dataset.path;
        if (state.filePanel.expanded.has(path)) {
          state.filePanel.expanded.delete(path);
          renderFilePanel();
        } else {
          state.filePanel.expanded.add(path);
          if (state.filePanel.children.has(path)) renderFilePanel();
          else loadFileDir(path);
        }
        break;
      }
      case 'file-open': openFilePreview(el.dataset.path, el.dataset.name); break;
      // P3 编辑/diff
      case 'file-edit': startFileEdit(); break;
      case 'file-edit-diff': toggleFileDiff(); break;
      case 'file-edit-save': saveFileEdit(); break;
      case 'file-edit-cancel': cancelFileEdit(); break;
      case 'file-edit-reload': reloadFilePreview(); break;
      case 'browser-shot-dir': {
        bridge.openBrowserShotDir().then((r) => {
          if (!r || r.ok === false) toast(`打开截图目录失败：${(r && r.reason) || '未接入'}`, 'err');
          else toast('已打开截图目录', 'ok');
        }).catch((err) => toast(`打开截图目录失败：${(err && err.message) || err}`, 'err'));
        break;
      }
      case 'ask-input-ok': {
        const cb = state.askInputCb;
        state.askInputCb = null;
        const v = ($('#askInput') && $('#askInput').value) || '';
        closeModal();
        if (typeof cb === 'function') cb(v);
        break;
      }
      case 'archive-confirm': doArchiveProject(id); closeModal(); break;

      /* 向导 */
      case 'wz-next': if (state.wz === 0) { state.wz = 1; renderWizard(); } else { $('#wizard').classList.add('hidden'); state.page = 'session'; render(); toast(`已进入会话 · 默认专家：${expertList()[state.wzExpert] || expertList()[0]}`, 'ok'); } break;
      case 'wz-skip': $('#wizard').classList.add('hidden'); state.page = 'session'; render(); break;
      case 'wz-open': state.wz = 0; renderWizard(); $('#wizard').classList.remove('hidden'); break;
      case 'wz-expert': state.wzExpert = +el.dataset.i; renderWizard(); break;
      /* 专家团派发（multi composeTeam，第五个死挂点修复：目录可看 → 任务可派） */
      /* TRACE 上报开关（TOKEN 加密内置，用户仅可开关；默认开） */
      case 'trace-toggle': {
        const cur = state.traceEnabled !== false;
        bridge.traceSetEnabled(!cur).then((r) => {
          if (!r || !r.ok) { toast((r && r.reason) || '切换失败', 'err'); return; }
          state.traceEnabled = !cur;
          updateTraceUi();
          toast(r.requiresRestart ? '已保存 · 重启 OrchDesk 后生效' : '已保存', 'ok');
        }).catch((e) => toast('切换失败: ' + ((e && e.message) || e), 'err'));
        break;
      }
      /* 授权白名单（PRD FR-9）：添加 / 撤销 / 全部撤销 */
      case 'grant-add': {
        const tool = ($('#grant-tool') && $('#grant-tool').value) || '*';
        const pattern = (($('#grant-pattern') && $('#grant-pattern').value) || '').trim();
        const scope = ($('#grant-scope') && $('#grant-scope').value) === 'session' ? 'session' : 'permanent';
        if (!pattern) { toast('请填写目标模式（不限目标填 *）', 'warn'); break; }
        bridge.addGrant({
          tool, pattern, scope,
          ...(scope === 'session' ? { sessionId: state.sel || '' } : {}),
          note: '设置页手动添加',
        }).then((r) => {
          if (!r || !r.ok) { toast((r && r.reason) || '添加失败', 'err'); return; }
          state.grants = Array.isArray(r.grants) ? r.grants : state.grants;
          const p = $('#grant-pattern'); if (p) p.value = '';
          render(); toast('已加入白名单', 'ok');
        }).catch((e) => toast('添加失败: ' + ((e && e.message) || e), 'err'));
        break;
      }
      case 'grant-revoke': {
        bridge.revokeGrant(el.dataset.id).then((r) => {
          if (!r || !r.ok) { toast('撤销失败', 'err'); return; }
          state.grants = Array.isArray(r.grants) ? r.grants : state.grants;
          render(); toast('已撤销该白名单规则', 'ok');
        }).catch((e) => toast('撤销失败: ' + ((e && e.message) || e), 'err'));
        break;
      }
      case 'grant-revoke-all': {
        bridge.revokeAllGrants().then((r) => {
          if (!r || !r.ok) { toast('撤销失败', 'err'); return; }
          state.grants = Array.isArray(r.grants) ? r.grants : [];
          render(); toast(`已撤销全部 ${r.revoked || 0} 条白名单`, 'ok');
        }).catch((e) => toast('撤销失败: ' + ((e && e.message) || e), 'err'));
        break;
      }
      /* 桌面集成开关（PRD FR-4.2）：此前 6 项全是 data-action="todo" 空壳 */
      case 'desktop-toggle': {
        const key = el.dataset.dk;
        if (!state.desktop || !state.desktop.config || !(key in state.desktop.config)) break;
        const next = !state.desktop.config[key];
        const label = (state.desktop.labels && state.desktop.labels[key]) || key;
        // 乐观更新：先响应用户点击，失败再回滚（设置项切换的即时反馈要求）
        state.desktop.config[key] = next;
        el.classList.toggle('on', next);
        el.setAttribute('aria-checked', String(next));
        bridge.setDesktop(key, next).then((r) => {
          if (!r || !r.ok) {
            state.desktop.config[key] = !next;
            el.classList.toggle('on', !next);
            el.setAttribute('aria-checked', String(!next));
            toast((r && r.reason) || '切换失败', 'err');
            return;
          }
          if (r.config) state.desktop.config = r.config;
          if (typeof r.autostartEffective === 'boolean') state.desktop.autostartEffective = r.autostartEffective;
          const descEl = document.querySelector(`[data-desktop-desc="${key}"]`);
          if (descEl && key === 'autostart') descEl.textContent = desktopAutostartDesc();
          // 悬浮窗刚开启时先推一次上下文，否则小窗显示「未选择会话」直到下次切会话
          if (key === 'floating' && next) pushFloatingContext();
          toast(r.warning ? r.warning : `${label}已${next ? '开启' : '关闭'}`, r.warning ? 'err' : 'ok');
        }).catch((e) => {
          state.desktop.config[key] = !next;
          el.classList.toggle('on', !next);
          toast('切换失败: ' + ((e && e.message) || e), 'err');
        });
        break;
      }
      case 'team-compose': {
        const tid = el.dataset.tid;
        const tn = el.dataset.tn || '专家团';
        // BUG（全盘死挂点扫描）：原代码 askInput({...}).then(...)——askInput 不返回
        // Promise（onOk 回调式），对 undefined 调 .then 必抛 TypeError，专家团「派发
        // 任务」按钮一点就崩，composeTeam 从不被调用（UI 显示成功实为永不可达）。
        askInput({
          title: `派发任务 · ${tn}`,
          label: 'CEO（主会话）将拆解任务并派给 Director→Worker，经真实模型执行，耗时可能较长。',
          placeholder: '描述要派发的任务…',
          onOk: (task) => {
            task = String(task || '').trim();
            if (!task) return;
            toast('编排中：CEO 拆解 → Director → Worker…', 'info');
            bridge.composeTeam(tid, task).then((r) => {
              if (r && r.error) { toast(r.error, 'err'); return; }
              state.delegationLast = r;
              render();
              toast(`编排完成 · ${r.rootId || ''}`, 'ok');
            }).catch((e) => toast('编排失败: ' + ((e && e.message) || e), 'err'));
          },
        });
        break;
      }
    }
  });

  let outboundTimer = null;
  async function updateOutboundWarn(text) {
    const el = $('#outboundWarn'); if (!el) return;
    clearTimeout(outboundTimer);
    outboundTimer = setTimeout(async () => {
      try {
        const w = await Promise.resolve(bridge.withhold(text || ''));
        if (w && w.needsConfirm) { el.hidden = false; el.textContent = w.warning || '⚠ 此操作不可撤销：发送前需二次确认'; }
        else { el.hidden = true; el.textContent = ''; }
      } catch { el.hidden = true; }
    }, 300);
  }

  document.body.addEventListener('input', (e) => {
    if (e.target.id === 'composer') { updateOutboundWarn(e.target.value); return; }
    // 文件编辑缓冲（P3）：只更新 dirty 徽标，不重渲染（textarea 重渲染会丢焦点/光标）
    if (e.target.id === 'fileEditBuf') {
      const fp = state.filePanel;
      const was = fp.dirty;
      fp.editBuf = e.target.value;
      // 基线在 startFileEdit 里算一次并缓存：每敲一键都对 2MB 文本做
      // applyEol + 读 2MB textarea 值，是纯粹的浪费（实测每次 1.1ms）。
      fp.dirty = fp.editBuf !== fp.editBase;
      if (was !== fp.dirty) {
        const badge = document.querySelector('#fileView .badge.warn');
        if (badge) badge.remove();
        if (fp.dirty) {
          const bar = document.querySelector('#fileView .file-view-head .row');
          if (bar) bar.insertAdjacentHTML('afterbegin', '<span class="badge warn">未保存</span>');
        }
      }
      return;
    }
    // 沙箱日志检索：条件变化即重拉。防抖 350ms —— 每敲一个字都发一次 IPC 会
    // 把输入变成卡顿源（日志体量可能上百条）。
    if (e.target.id === 'sblog-kw') {
      state.sandboxLog.keyword = e.target.value || '';
      clearTimeout(sblogTimer);
      sblogTimer = setTimeout(refreshSandboxLog, 350);
      return;
    }
    if (e.target.dataset.action === 'fork-slider') {
      const sid = e.target.dataset.sid;
      const s = sid && state.sessions[sid];
      const msgs = (s && Array.isArray(s.msgs)) ? s.msgs : [];
      const v = Math.max(0, Math.min(msgs.length, parseInt(e.target.value, 10) || 0));
      const lab = document.getElementById('fork-at-label');
      // 不写 state：分叉点只在点「创建分支」的那一刻读取，拖动中不落任何数据。
      if (lab) lab.textContent = forkOptionLabel(v, msgs);
    }
    if (e.target.dataset.action === 'think-slider') {
      const levels = ['off', 'standard', 'deep', 'max'];
      const labels = ['关闭', '标准', '深度', '最大'];
      const v = Math.max(0, Math.min(3, parseInt(e.target.value, 10) || 0));
      state.thinkLevel = levels[v];
      const tl = e.target.parentElement.querySelector('.tl');
      if (tl) tl.textContent = labels[v];
    }
  });
  document.body.addEventListener('change', (e) => {
    if (e.target.id === 'sblog-decision') {
      state.sandboxLog.decision = e.target.value || 'all';
      refreshSandboxLog();
      return;
    }
    if (e.target.id === 'sblog-kind') {
      state.sandboxLog.kind = e.target.value || 'all';
      refreshSandboxLog();
      return;
    }
    // 晋升审计过滤（PRD FR-10）。<select> 的 value 一定是字符串，故主进程侧
    // 的 ok 参数同时吃布尔与 'true'/'false'（只认布尔会让过滤静默失效）。
    if (e.target.id === 'mp-ok') {
      state.memoryPromotions.ok = e.target.value || 'all';
      refreshMemoryPromotions();
      return;
    }
    if (e.target.id === 'mp-type') updateProtocolRow();
    if (e.target.id === 'default-model-pick' && e.target.value !== state.defaultModel) {
      state.defaultModel = e.target.value;
      autoSelectModels(state.modelProviders, state.defaultProvider, state.defaultModel);
      render();
      bridge.saveModelConfig({ providers: state.modelProviders, defaultProvider: state.defaultProvider, defaultModel: state.defaultModel }).catch(() => {});
    }
    if (e.target.id === 'max-iter-pick') {
      state.maxToolIterations = Math.max(1, Math.min(500, parseInt(e.target.value) || 200));
      const valEl = $('#max-iter-val');
      if (valEl) valEl.textContent = state.maxToolIterations;
      bridge.saveModelConfig({ providers: state.modelProviders, defaultProvider: state.defaultProvider, defaultModel: state.defaultModel, maxToolIterations: state.maxToolIterations }).catch(() => {});
    }
  });

  /* ---------- 启动 ---------- */
  async function init() {
    console.log('[init] starting...', 'sessions:', Object.keys(state.sessions).length, 'projects:', state.projects.length);

    // 立即渲染空壳（用户先看到界面，不等数据）
    render();

    // TRACE 上报状态（开关默认开；builtin = TOKEN 是否已加密内置）——fire-and-forget
    if (typeof bridge.traceStatus === 'function') {
      bridge.traceStatus().then((ts) => {
        state.traceEnabled = ts.enabled !== false;
        state.traceBuiltin = !!ts.builtin;
        updateTraceUi();
      }).catch(() => undefined);
    }

    // 第零步：加载项目分组（此前只加载会话 → 重启后项目全丢、会话退化为「任务」组）
    try {
      if (typeof bridge.loadProjects === 'function') {
        const remoteProjects = await bridge.loadProjects();
        if (Array.isArray(remoteProjects) && remoteProjects.length) {
          state.projects = remoteProjects.map((p) => ({ ...p, sessions: Array.isArray(p.sessions) ? p.sessions : [] }));
        }
      }
    } catch (err) { console.warn('[init] 项目分组加载失败:', err); }

    // 第一步：加载会话（决定走 wizard 还是主界面）
    try {
      const remote = await bridge.loadSessions();
      console.log('[init] loaded sessions:', remote.length);
      if (remote && remote.length) {
        state.sessions = {};
        remote.forEach((s) => { state.sessions[s.id] = s; });
        // 项目分组优先用落盘的成员关系，缺失时按 pid 重建（兼容旧数据）
        const known = new Set();
        state.projects.forEach((p) => { p.sessions.forEach((id) => known.add(id)); });
        state.projects.forEach((p) => {
          const owned = remote.filter((s) => s.pid === p.id).map((s) => s.id);
          p.sessions = p.sessions.filter((id) => state.sessions[id]);
          owned.forEach((id) => { if (!p.sessions.includes(id)) p.sessions.push(id); });
        });
        // 恢复 TRACE 反馈（此前反馈只存内存，刷新即丢）
        Object.values(state.sessions).forEach((s) => {
          if (Array.isArray(s.feedback)) s.feedback.forEach((k) => state.feedback.add(k));
        });
        if (!state.sessions[state.sel]) state.sel = remote[0].id;
      }
      console.log('[init] state.sel:', state.sel, 'total sessions:', Object.keys(state.sessions).length);
    } catch (err) { console.error('[init] error:', err); }

    // 订阅浏览器状态（ADR-0011）：Agent 在后台操作网页时，面板与标题栏状态点实时跟随。
    // 没有这个订阅，用户点开面板看到的永远是启动那一刻的快照。
    try {
      if (typeof bridge.onBrowserState === 'function') {
        bridge.onBrowserState((st) => {
          applyBrowserState(st);
          rerenderBrowserPanelIfOpen();
        });
      }
    } catch (err) { console.warn('[init] 浏览器状态订阅失败:', err); }

    // 订阅终端输出/退出（P2-10）：xterm 实例常驻，数据到达直接 write。
    try {
      if (typeof bridge.onTerminalData === 'function') {
        bridge.onTerminalData((ev) => {
          const h = termHandles.get(ev.id);
          if (!h) return; // 面板还没开：回放缓冲在主进程，重开 Tab 能补看
          if (h.term) h.term.write(ev.data);
          else if (h.pre) {
            // 降级 <pre> 路径：缓存到数组再 join。`textContent +=` 每次都要
            // 读出整个字符串再写回（O(n) 读 + O(n) 写），长会话会越敲越卡。
            h.lines = h.lines || [];
            h.lines.push(ev.data);
            let s = h.lines.join('');
            if (s.length > 400000) {
              s = s.slice(-200000);
              h.lines = [s];
            }
            h.pre.textContent = s;
            h.cont.scrollTop = h.cont.scrollHeight;
          }
        });
      }
      if (typeof bridge.onTerminalExit === 'function') {
        bridge.onTerminalExit((ev) => {
          const h = termHandles.get(ev.id);
          if (h && h.term) h.term.write(`\r\n\x1b[33m[orchdesk: 进程已退出，退出码 ${ev.code}]\x1b[0m\r\n`);
          else if (h && h.pre) {
            h.lines = h.lines || [];
            h.lines.push(`\n[orchdesk: 进程已退出，退出码 ${ev.code}]`);
            h.pre.textContent = h.lines.join('');
          }
          refreshTerminal();
        });
      }
    } catch (err) { console.warn('[init] 终端订阅失败:', err); }

    // 订阅工具执行步骤（此前主进程发 orchdesk:tool-step 但无人订阅 → 步骤条永远为空）
    try {
      if (typeof bridge.onToolStep === 'function') {
        // 渲染节流：文本兜底模式可一次解析多个工具连发 running/done，若每事件都全量
        // render()，毫秒窗口内会触发 2N 次整页重建。合并到 ≤150ms 一次——工具步骤通常
        // 秒级间隔不受影响，连发窗口期 typing 实时行仍平滑刷新。
        let toolRenderTimer = null;
        const scheduleRender = () => {
          if (toolRenderTimer) return;
          toolRenderTimer = setTimeout(() => { toolRenderTimer = null; render(); }, 150);
        };
        bridge.onToolStep((step) => {
          const s = state.sessions[step.sessionId];
          if (!s || !step) return;
          state.toolSteps[step.sessionId] = state.toolSteps[step.sessionId] || [];
          const list = state.toolSteps[step.sessionId];
          if (step.ph === 'running') {
            list.push({ n: step.name, ph: 'running' });
          } else {
            const rec = [...list].reverse().find((x) => x.n === step.name && x.ph === 'running');
            if (rec) { rec.ph = step.ph; rec.result = step.result || ''; }
            else list.push({ n: step.name, ph: step.ph, result: step.result || '' });
          }
          if (state.sel === step.sessionId) scheduleRender();
        });
      }
    } catch (err) { console.warn('[init] 工具步骤订阅失败:', err); }

    // 第二步：并行加载所有元数据（互不依赖，同时发起）
    const results = await Promise.allSettled([
      // 授权
      bridge.getAuthMode().then(r => { if (r?.mode) state.authMode = r.mode; }).catch(() => {}),
      bridge.getAuthLevels().then(r => { if (Array.isArray(r) && r.length) state.authLevels = r; }).catch(() => {}),
      // ④M-1：授权模式卡 + 白名单工具下拉数据化（canonical = authz 插件；加载后覆盖兜底文案）
      (typeof bridge.getAuthModes === 'function'
        ? bridge.getAuthModes().then((r) => {
            if (r && Array.isArray(r.modes) && r.modes.length) state.authModes = r.modes;
            if (r && Array.isArray(r.grantTools) && r.grantTools.length) state.grantTools = r.grantTools;
          })
        : Promise.resolve()).catch(() => {}),
      bridge.getAuthAudit().then(r => { if (r) state.authAudit = r; }).catch(() => {}),
      // 授权白名单（PRD FR-9）：真实规则列表（此前只有「单次」粒度，UI 无白名单可看）
      (typeof bridge.listGrants === 'function'
        ? bridge.listGrants().then(r => { if (Array.isArray(r)) state.grants = r; })
        : Promise.resolve()).catch(() => {}),
      // 提示词库
      bridge.listPrompts().then(r => { if (Array.isArray(r)) state.promptDocs = r; }).catch(() => {}),
      bridge.mergePrompts('main').then(r => { if (r?.conflicts) state.promptConflicts = r.conflicts; }).catch(() => {}),
      // 记忆 + 补偿 + 自进化
      bridge.getMemoryStats().then(r => {
        if (!r) return;
        state.memoryStats = r;
        // 四域真实计数（seg-tab 上显示的数字）。此前插件统计只被拉来存着，
        // 从没进过 UI —— 用户看不到 worker 域到底有没有东西。
        if (r.domainCounts && typeof r.domainCounts === 'object') state.memory.stats = r.domainCounts;
      }).catch(() => {}),
      bridge.getCompensationAudit().then(r => { if (Array.isArray(r)) state.compAudit = r; }).catch(() => {}),
      bridge.getSandbox().then(r => { if (r && typeof r === 'object') state.sandbox = { mode: r.mode || 'workspace-write', networkAllow: Array.isArray(r.networkAllow) ? r.networkAllow : ['*'] }; }).catch(() => {}),
      // 数据目录内容清单（PRD FR-4.2）：真实体积与文件数（此前 UI 写死「~ 24 MB」）
      (typeof bridge.getDataDirInventory === 'function'
        ? bridge.getDataDirInventory().then(r => { if (r && typeof r === 'object') state.dataDirInventory = r; })
        : Promise.resolve()).catch(() => {}),
      // 沙箱日志（PRD FR-8 可检索）：每次刷新设置页都会重拉，见 refreshSandboxLog
      (typeof bridge.getSandboxLog === 'function'
        ? bridge.getSandboxLog(sandboxLogQuery()).then(r => { applySandboxLog(r); })
        : Promise.resolve()).catch(() => {}),
      // 桌面集成（PRD FR-4.2）：6 个开关的真实状态（此前 UI 硬编码 on/off，与系统无关）
      (typeof bridge.getDesktop === 'function'
        ? bridge.getDesktop().then(r => { if (r && r.config) state.desktop = r; })
        : Promise.resolve()).catch(() => {}),
      bridge.listTempPlugins().then(r => { if (Array.isArray(r)) state.tempPlugins = r; }).catch(() => {}),
      // 浏览器（ADR-0011）：启动即同步一次状态，标题栏入口才能如实显示开/关
      (typeof bridge.getBrowserStatus === 'function'
        ? bridge.getBrowserStatus().then(r => { applyBrowserState(r); })
        : Promise.resolve()).catch(() => {}),
      // 插件运行时真实状态（插件页开关据此显示，而非硬编码的 p.on）
      (typeof bridge.getPluginRuntime === 'function'
        ? bridge.getPluginRuntime().then(r => { if (r) state.pluginRuntime = r; })
        : Promise.resolve()).catch(() => {}),
      // 编排目录（8 专家 + 3 团的真实数据，替代渲染层硬编码常量）
      (typeof bridge.getOrchestrationCatalog === 'function'
        ? bridge.getOrchestrationCatalog().then(r => {
            if (r && Array.isArray(r.experts) && r.experts.length) state.orchestrationCatalog = r;
          })
        : Promise.resolve()).catch(() => {}),
      // 模型管理
      bridge.getModelConfig().then(async (mc) => {
        if (mc && mc.providers && mc.providers.length) {
          state.modelProviders = mc.providers;
          dynamicModels = mc.providers.flatMap(p => p.models.map(n => ({ n, p: p.name + ' \u00b7 ' + p.type, k: '(本地)', state: '\u5df2\u914d' })));
          if (mc.defaultProvider) state.defaultProvider = mc.defaultProvider;
          state.defaultModel = mc.defaultModel;
          state.maxToolIterations = mc.maxToolIterations || 200;
          autoSelectModels(mc.providers, mc.defaultProvider, mc.defaultModel);
        } else {
          // BUG-015：桥接可用但无提供商时不要清空选择（可能是瞬时失败），
          // 交给 autoSelectModels 决定，避免「发送被拦死且无出路」。
          dynamicModels = [];
          autoSelectModels(state.modelProviders, state.defaultProvider, state.defaultModel);
        }
      }).catch(() => { dynamicModels = []; autoSelectModels(state.modelProviders, state.defaultProvider, state.defaultModel); }),
      // 观雅集
      bridge.guanjiTokenStatus().then(r => { state.guanjiTokenSet = !!(r && r.configured); }).catch(() => {}),
      bridge.guanjiList().then(r => { if (Array.isArray(r) && r.length) state.guanjiSkills = r; }).catch(() => {}),
      // 本地已安装技能（磁盘真实扫描；此前只存内存，重启即显示 0 个）
      refreshInstalledSkills(),
      // MCP（真接入）：真实 server 配置 + 连接状态 + 工具清单
      refreshMcp(),
      // Hub
      bridge.hubStatus().then(r => { if (r) state.hubStatus = r; }).catch(() => {}),
    ]);

    // 订阅审批弹窗
    if (bridge.onAuthRequest) {
      bridge.onAuthRequest((req) => { showApprovalModal(req); });
    }

    // 需求3：状态栏右下角图标区（浏览器 / 终端）在所有元数据到位后建一次，
    // 此时 loaded / open 已是真实值，图标才不会先闪一下「未接入」再点亮。
    renderStatusBarActions();
    renderBrowserSide();

    console.log('[init] parallel results:', results.map((r, i) => r.status === 'rejected' ? `${i}:FAIL` : `${i}:ok`).join(', '));

    // Final render
    if (!Object.keys(state.sessions).length) {
      console.log('[init] showing wizard (no sessions)');
      $('#wizard').classList.remove('hidden');
      renderWizard();
    } else {
      console.log('[init] rendering...');
      render();
    }
    // 动态状态栏：显示 OrchDesk Core + 当前 commit
    try {
      const el = $('#statusText');
      if (el) {
        const resp = await fetch('https://api.github.com/repos/ra1nzzz/orchdesk/commits/main', { signal: AbortSignal.timeout?.(3000) });
        if (resp.ok) { const d = await resp.json(); el.textContent = 'OrchDesk Core · ' + d.sha.slice(0, 7); }
        else el.textContent = 'OrchDesk Core · local';
      }
    } catch { const el = $('#statusText'); if (el) el.textContent = 'OrchDesk Core · local'; }
    console.log('[init] done');
  }
  setInterval(() => { const c = $('#clock'); if (c) c.textContent = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }); }, 1000);
  init();
})();
