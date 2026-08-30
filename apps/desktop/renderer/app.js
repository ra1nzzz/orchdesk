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
  };
  const ic = (n, s = 20) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${I[n]}</svg>`;
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
  const AUTH_MODES = [
    { id: 'default', label: '默认安全', blurb: '工作区可写；L3/L4 操作弹窗确认。' },
    { id: 'trusted', label: '信任模式', blurb: '同默认沙箱，放宽命令/网络白名单；高危操作仍弹窗。' },
    { id: 'paranoid', label: '偏执模式', blurb: '只读沙箱 + 任何 ask 自动拒绝。' },
  ];
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
  const CONNECTORS = [
    { n: 'GitHub', d: '代码托管', on: 1 }, { n: '飞书', d: '协作平台', on: 0 },
    { n: '企业微信', d: '企业通讯', on: 0 }, { n: '腾讯文档', d: '在线文档', on: 0 },
    { n: 'Notion', d: '知识管理', on: 0 }, { n: 'Linear', d: '项目管理', on: 0 }, { n: '钉钉', d: '企业通讯', on: 0 }
  ];

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
      onAuthRequest: () => () => {},
      submitDecision: () => {},
      // 提示词库
      listPrompts: () => Promise.resolve([]),
      mergePrompts: () => Promise.resolve({ sections: [], conflicts: [] }),
      savePrompt: () => Promise.resolve({ ok: false }),
      deletePrompt: () => Promise.resolve({ ok: false }),
      // 记忆
      getMemoryStats: () => Promise.resolve(null),
      // 补偿层
      withhold: (text) => Promise.resolve({ needsConfirm: false, category: 'other', reason: '', warning: '' }),
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
      hubStatus: () => Promise.resolve({ paired: false }),
      hubPair: () => Promise.resolve({ ok: false, reason: '未配对' }),
      hubSend: () => Promise.resolve({ ok: false, reason: '未配对' }),
      hubResult: () => Promise.resolve({ status: 'error', result: '未配对' }),
      snapshotData: () => Promise.resolve({ ok: false, reason: '未接入' }),
      checkUpdates: () => Promise.resolve({ snapshot: { ok: false }, update: { available: false, note: '未接入' } }),
      exportData: () => Promise.resolve({ ok: false, reason: '未接入' }),
      importData: () => Promise.resolve({ ok: false, reason: '未接入' }),
      openLogDir: () => Promise.resolve({ ok: false, reason: '未接入' }),
    };
  })();

  /* ---------- 状态 ---------- */
  const state = {
    page: 'session', theme: 'dark', sel: null, ctxOpen: 1, ctxTab: 'todo', wz: 0, wzExpert: 0,
    selProjForComposer: null, projDropdownOpen: false, composerMoreOpen: false,
    newConvMode: true,
    feedback: new Set(), authMode: 'default',
    authLevels: [], authAudit: [],
    promptDocs: [], promptConflicts: [],
    compAudit: [], tempPlugins: [],
    guanjiSkills: [], guanjiTokenSet: false, installedSkills: [], askInputCb: null,
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
    // 最近一次专家团派发结果（composeTeam 返回的 { rootId, nodes }）
    delegationLast: null,
    // TRACE 上报开关（默认开；bridge.traceStatus 拉取后覆盖）
    traceEnabled: true,
    traceBuiltin: false
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
  function esc(v) {
    return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }
  function renderMsg(m, sid) {
    const isU = (m.r || m.role) === 'user';
    const intentBadge = m.intent && m.intent !== 'ACT'
      ? (m.intent === 'CONFIRM' ? `<span class="badge warn">意图 · 待确认</span>` : `<span class="badge danger">意图 · 已拦截</span>`)
      : '';
    const tools = (m.tools && m.tools.length) ? `<details class="tools"><summary>${ic('chev', 14)} ${m.steps} 步 · ${m.tools.length} 个动作</summary>${m.tools.map((t) => `<div class="trow"><span class="tdot" style="background:${t.ph === 'running' ? 'var(--warn)' : 'var(--ok)'};${t.ph === 'running' ? 'animation:pulse 1.6s infinite' : ''}"></span><span class="mono">${esc(t.n)}</span><span class="faint" style="margin-left:auto">${t.ph === 'running' ? '执行中' : '完成'}</span></div>`).join('')}</details>` : '';
    const sub = m.sub ? `<div class="subagent"><span class="badge ${m.sub.state === 'running' ? 'warn' : 'info'}">SubAgent</span><span class="mono">${esc(m.sub.name)}</span><span class="phases faint">${m.sub.state === 'running' ? '执行中 · 即用即走' : '已回收并销毁'}</span></div>` : '';
    const fb = (m.feedback && state.feedback.has(sid + '|' + m.t)) ? `<div class="feedback" style="color:var(--ok)">已记录反馈 · 已脱敏遥测</div>`
      : (m.feedback ? `<div class="feedback"><span>这条回答对你有帮助吗？</span><button data-action="trace" data-t="${m.t}">有帮助</button><button data-action="trace" data-t="${m.t}">需改进</button><span class="faint">反馈将用于改善回复质量</span></div>` : '');
    const raw = m.x || m.text || '';
    let txt;
    if (m.typing) {
      txt = '<span class="faint">思考中…</span>';
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
      <div class="body"><div class="meta"><b>${isU ? '你' : 'OrchDesk'}</b><span>${m.t}</span>${intentBadge}</div>
      <div class="md-body">${txt}</div>${sub}${tools}${fb}</div></div>`;
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
        <button class="seg-tab active" data-action="todo">项目</button>
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
      '数据分析': 'bar-chart', 'PPT 制作': 'presentation', '闲时任务': 'clock',
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
    const AUTH_MODE_LABEL = { default: '默认安全', trusted: '信任模式', paranoid: '偏执模式' };
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
              <span class="cm-val">${AUTH_MODE_LABEL[state.authMode] || '默认安全'}</span>
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
      return `<div style="flex:1;overflow-y:auto" id="msgScroll">
        <div style="max-width:760px;margin:0 auto;padding:18px 16px 10px">
          <div class="row" style="justify-content:space-between;margin-bottom:4px">
            <div class="row"><b style="font-size:16px">${esc(s.title)}</b>
              <span class="badge info">${esc(s.expert)}</span></div>
            <button class="iconbtn" data-action="toggle-ctx" title="切换右侧面板" style="transform:rotate(${state.ctxOpen ? 0 : 180}deg);transition:.15s">${ic('chev', 14)}</button></div>
          <div id="confirmZone"></div>
          ${(s.msgs || []).map((m) => renderMsg(m, s.id)).join('')}
        </div></div>
      ${renderComposer(s)}`;
    },
    ctx() {
      const s = state.sel && state.sessions[state.sel] ? state.sessions[state.sel] : null;
      const tabId = state.ctxTab || 'todo';
      const tabs = [
        { id: 'todo', label: '待办', badge: '' },
        { id: 'products', label: '产物', badge: '' },
        { id: 'skills', label: '技能与MCP', badge: '' },
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
      // ---- 提取步骤 ----
      const steps = [];
      msgs.forEach((m, i) => {
        if (m.tools && m.tools.length) {
          m.tools.forEach((t) => {
            steps.push({ text: t.n, status: t.ph === 'done' ? 'done' : t.ph === 'running' ? 'running' : 'pending', time: m.t || '' });
          });
        }
        if (m.sub) {
          steps.push({ text: 'SubAgent: ' + (m.sub.name || ''), status: m.sub.state === 'disposed' ? 'done' : 'running', time: m.t || '' });
        }
      });
      const doneSteps = steps.filter(st => st.status === 'done').length;
      const runningSteps = steps.filter(st => st.status === 'running').length;

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

      // ---- 技能 ----
      const usedSkills = [];
      const seen = new Set();
      msgs.forEach(m => {
        if ((m.r === 'agent' || m.role === 'assistant') && (m.x || m.text)) {
          const content = m.x || m.text || '';
          const re = /\{skill:(\w+)\}/g;
          let sm;
          while ((sm = re.exec(content)) !== null) {
            if (!seen.has(sm[1])) { seen.add(sm[1]); usedSkills.push(sm[1]); }
          }
        }
      });
      const builtinSkills = ['intent', 'trace', 'brain', 'multi'];
      builtinSkills.forEach(sk => { if (!seen.has(sk)) usedSkills.unshift(sk); });

      // MCP 连接状态：此前是硬编码常量（含假的 connected:true）。
      // 现在以插件运行时真实装载状态为准——内置插件即本地能力来源；
      // 运行时不可用时全部标为「未接入」，不伪造已连接。
      const rt = state.pluginRuntime;
      const rtOf = (n) => (rt && Array.isArray(rt.plugins) ? rt.plugins.find((x) => x.name === n) : null);
      const mcps = [
        { name: 'filesystem', desc: '文件系统', plugin: 'brain' },
        { name: 'intent', desc: '意图识别网关', plugin: 'intent' },
        { name: 'memory', desc: '记忆服务', plugin: 'memory' },
        { name: 'orchestration', desc: '多 Agent 编排', plugin: 'multi' },
      ].map((m) => {
        const live = rtOf(m.plugin);
        return {
          name: m.name,
          desc: m.desc,
          connected: rt && rt.ready ? (live ? live.active === true : false) : false,
          unavailable: !(rt && rt.ready),
        };
      });

      // ---- Tab 内容 ----
      let bodyHTML = '';
      if (tabId === 'todo') {
        if (steps.length === 0) {
          bodyHTML = '<div class="ctx-empty"><div class="empty-icon">' + ic('check', 28) + '</div>暂无执行步骤<br><span style="font-size:10px">发送消息后将跟踪 Agent 操作</span></div>';
        } else {
          bodyHTML = '<div class="ctx-section"><div class="ctx-section-title">执行步骤</div>' + steps.map(st => {
            const dot = st.status === 'done' ? ic('check', 12) : st.status === 'running' ? ic('refresh', 12) : ic('circle', 12);
            return '<div class="ctx-step"><span class="step-dot ' + st.status + '">' + dot + '</span><span class="step-text">' + esc(st.text) + '</span><span class="step-time">' + esc(st.time) + '</span></div>';
          }).join('') + '</div>';
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
      } else if (tabId === 'skills') {
        bodyHTML = '<div class="ctx-section"><div class="ctx-section-title">插件（默认启用）</div>' + usedSkills.map(sk => {
          const isOn = builtinSkills.includes(sk);
          return '<div class="ctx-skill"><span class="sk-icon builtin">' + sk[0].toUpperCase() + '</span><span class="sk-name">' + esc(sk) + '</span><span class="sk-status ' + (isOn ? 'on' : 'idle') + '">' + (isOn ? '已启用' : '可用') + '</span></div>';
        }).join('') + '</div>';
        bodyHTML += '<div class="ctx-section"><div class="ctx-section-title">MCP 连接</div>'
          + (mcps.length && mcps[0].unavailable ? '<div class="faint" style="font-size:10px;padding:2px 0 6px">运行时未接入 · 以下为待接入能力，非实时连接状态</div>' : '')
          + mcps.map(m => '<div class="ctx-mcp"><span class="mcp-dot ' + (m.connected ? 'connected' : 'disconnected') + '"></span><span style="flex:1">' + esc(m.name) + '</span><span style="font-size:10px;color:var(--fg-faint)">' + esc(m.desc) + ' · ' + (m.unavailable ? '未接入' : (m.connected ? '已连接' : '待连接')) + '</span></div>').join('') + '</div>';
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
      // 插件市场 / 连接器：目前无后端注册表，属「规划中」清单。
      // 明确标注，避免把规划项当成可安装的真实能力（此前显示为「可装」是误导）。
      const market = PLUGIN_MARKET.map((p) => `<div class="ss-i"><span class="id"></span><span class="in">${esc(p.n)}</span><span class="ib badge">规划中</span></div>`).join('');
      const skills = SKILLS_MARKET.map((s) => `<div class="ss-i"><span class="id"></span><span class="in mono" style="font-size:11.5px">${esc(s.n)}</span>${s.auth ? '<span class="ib badge warn">授权</span>' : '<span class="ib badge ok">可装</span>'}</div>`).join('');
      const experts = [...expertList().map((e) => `<div class="ss-i"><span class="id"></span><span class="in">${e}</span><span class="ib badge info">专家</span></div>`),
        ...teamList().map((t) => `<div class="ss-i"><span class="id"></span><span class="in">${esc(t.n)}</span><button class="btn sm ghost" data-action="team-compose" data-tid="${esc(t.id || '')}" data-tn="${esc(t.n)}">派发任务</button><span class="ib badge ceo">团</span></div>`)].join('');
      // 委派树结果（composeTeam 返回后渲染；CEO→Director→Worker 三层）
      const deleg = (state.delegationLast?.nodes || []).map((n) => `<div class="ss-i"><span class="id"></span><span class="in">${esc(String(n.label || n.id))}</span><span class="ib badge ${String(n.layer) === 'ceo' ? 'ceo' : 'info'}">${esc(String(n.layer || ''))}</span><span class="ib badge ${String(n.status) === 'done' ? 'ok' : 'warn'}">${esc(String(n.status || ''))}</span></div>`).join('');
      const expertsHtml = experts + (deleg ? sec('delegation', '最近一次委派树', (state.delegationLast?.nodes || []).length, deleg) : '');
      // 连接器：尚无后端，全部标「未接入」（此前 GitHub 硬编码 on:1 显示为「已连」，是假状态）
      const connectors = CONNECTORS.map((c) => `<div class="ss-i"><span class="id"></span><span class="in">${esc(c.n)}</span><span class="ib badge">未接入</span></div>`).join('');
      return sec('builtin', '内置插件', PLUGINS.length, builtIn) +
        sec('market', '插件市场', PLUGIN_MARKET.length, market) +
        sec('skills', '技能市场', SKILLS_MARKET.length, skills) +
        sec('experts', '专家·专家团', expertList().length + teamList().length, expertsHtml) +
        sec('connectors', '连接器', CONNECTORS.length, connectors);
    },
    main() {
      return `<div class="main-inner"><h1 class="pg">插件</h1><div class="pg-sub">一切皆插件——能力以插件形式挂载；启用 = 注册 effect，停用 = 注册回滚（无残留）。</div>
        ${PLUGINS.map((p) => `<div class="plug" data-pid="${p.id}">
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
          <table style="width:100%">
            <tr><th style="width:32%">技能</th><th>能力</th><th style="width:80px;text-align:right">操作</th></tr>
            ${(state.guanjiSkills.length ? state.guanjiSkills : SKILLS_MARKET.map((s) => ({ slug: s.n, name: s.n, description: s.d, caps: s.caps, auth: s.auth }))).map((s) => `<tr>
              <td><div class="mono" style="font-size:11.5px">${esc(s.slug)}</div><div class="faint" style="font-size:11px;margin-top:2px">${esc(s.description || '')}</div></td>
              <td>${s.caps.map((c) => `<span class="badge cap" style="margin:2px 4px 2px 0">${esc(c)}</span>`).join('')}${s.auth ? '<span class="badge warn">需授权</span>' : ''}</td>
              <td style="text-align:right"><button class="btn sm primary" data-action="guanji-install" data-slug="${esc(s.slug)}">安装</button></td>
            </tr>`).join('')}
          </table>
          <div class="row" style="margin-top:10px"><button class="btn sm" data-action="guanji-publish">发布技能到观雅集</button></div>
          ${state.installedSkills.length ? `<div class="sec-title" style="margin-top:12px;font-size:12px">已安装（启用 / 停用 / 卸载）</div>` + state.installedSkills.map((s) => `<div class="row" style="padding:5px 0;border-top:1px solid var(--border)"><div style="flex:1"><span class="mono" style="font-size:11.5px">${esc(s.slug)}</span>${s.enabled ? '' : '<span class="badge">已停用</span>'}</div><button class="btn sm" data-action="skill-toggle" data-n="${esc(s.slug)}">${s.enabled ? '停用' : '启用'}</button><button class="btn sm ghost" data-action="skill-uninstall" data-n="${esc(s.slug)}">卸载</button></div>`).join('') : ''}
        </div></div>`;
    },
    ctx() {
      return `<div class="sec-title">能力审查</div>
        <div class="faint" style="margin-bottom:8px">插件加载前经 inject 静态声明审查；<b>红色能力</b>需用户主动授权。</div>
        <div class="card" style="padding:10px">
          <div style="font-size:11.5px;font-weight:600;margin-bottom:6px">L0-L4 分级</div>
          <div class="faint" style="font-size:11.5px;line-height:1.7">
            L0 读取（无副作用）<br>L1 状态写入（应用域内）<br>L2 文件系统（受限目录）<br>L3 网络（白名单）<br>L4 Shell / 进程（仅 FULL ACCESS）
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
        ${[{ id: 'model', n: '模型', icon: 'bot' }, { id: 'cred', n: '凭据', icon: 'shield' }, { id: 'sandbox', n: '沙箱与授权', icon: 'shield' }, { id: 'prompt', n: '系统提示词', icon: 'at' }, { id: 'desktop', n: '桌面集成', icon: 'settings' }, { id: 'data', n: '数据目录', icon: 'folder' }, { id: 'about', n: '关于', icon: 'at' }]
          .map((s) => `<div class="node" data-action="settings-nav" data-id="${s.id}" style="padding:6px 8px;border-radius:7px;cursor:pointer;display:flex;align-items:center;gap:8px"><span style="color:var(--fg-dim)">${ic(s.icon, 14)}</span><span style="font-size:12.5px">${s.n}</span></div>`).join('')}`;
    },
    main() {
      return `<div class="main-inner"><h1 class="pg">设置</h1><div class="pg-sub">模型、沙箱、授权、桌面集成等能力均以插件形式挂载，在此统一管理。</div>
        <div class="statbar">
          <div class="stat"><div class="sk">授权模式</div><div class="sv"><span class="dot" style="background:var(--ok)"></span>${({ default: '默认安全', trusted: '信任模式', paranoid: '偏执模式' })[state.authMode] || '默认安全'}</div></div>
          <div class="stat"><div class="sk">沙箱</div><div class="sv"><span class="badge ok" style="font-weight:600">Windows ACL</span></div></div>
          <div class="stat"><div class="sk">数据目录</div><div class="sv" style="font-size:12px;font-weight:500">%APPDATA%/OrchDesk</div></div>
          <div class="stat"><div class="sk">运行时</div><div class="sv" style="font-size:12px;font-weight:500">dsh 99f6f02</div></div>
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
            ${AUTH_MODES.map((m) => `<div class="am ${state.authMode === m.id ? 'sel' : ''}" data-action="auth-mode-pick" data-id="${m.id}">
              <div class="am-h"><b>${m.label}</b>${state.authMode === m.id ? '<span class="badge ok">当前</span>' : ''}</div>
              <div class="faint" style="font-size:11.5px;margin-top:4px">${m.blurb}</div>
            </div>`).join('')}
          </div>
          <div class="sec-title" style="margin:16px 0 8px">L0-L4 分级</div>
          <div class="levels">
            ${state.authLevels.length ? state.authLevels.map((l) => `<div class="lv"><span class="lv-n">L${l.level}</span><span class="lv-l">${l.label}</span><span class="faint">${l.scope}</span>${l.requiresApproval ? '<span class="badge warn">需授权</span>' : ''}</div>`).join('') : '<div class="faint">分级定义加载中…</div>'}
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
          <div class="desktop-item"><div><div class="di-name">系统托盘</div><div class="di-desc">关闭窗口后继续运行</div></div><div class="switch on" data-action="todo"></div></div>
          <div class="desktop-item"><div><div class="di-name">全局快捷键</div><div class="di-desc mono">Ctrl+Shift+Space</div></div><div class="switch on" data-action="todo"></div></div>
          <div class="desktop-item"><div><div class="di-name">登录自启动</div><div class="di-desc">开机时启动 OrchDesk</div></div><div class="switch" data-action="todo"></div></div>
          <div class="desktop-item"><div><div class="di-name">自动更新</div><div class="di-desc">新版本静默下载</div></div><div class="switch on" data-action="todo"></div></div>
          <div class="desktop-item"><div><div class="di-name">TRACE 遥测</div><div class="di-desc" id="trace-desc">脱敏遥测上报至 OrchDesk 公开仓库（仅白名单字段，不含任何消息内容）</div></div><div class="switch ${state.traceEnabled ? 'on' : ''}" id="trace-switch" data-action="trace-toggle"></div></div>
          <div class="desktop-item"><div><div class="di-name">悬浮窗</div><div class="di-desc">桌面浮动小窗</div></div><div class="switch" data-action="todo"></div></div>
          <div class="desktop-item"><div><div class="di-name">开机提醒</div><div class="di-desc">关键事件系统通知</div></div><div class="switch on" data-action="todo"></div></div>
        </div>
        <div class="sec-title" id="settings-section-data"><span class="ico">${ic('folder', 14)}</span>数据目录</div>
        <div class="card">
          <div class="row"><span class="mono">%APPDATA%/OrchDesk</span><span class="faint">· 本地优先，数据不出本机</span></div>
          <div class="faint" style="margin-top:6px;font-size:11.5px">包含 sessions.db · memory · plugins · logs · 缓存</div>
          <div class="row" style="margin-top:8px"><button class="btn sm" data-action="open-project-dir">打开目录</button><button class="btn sm" data-action="open-log-dir">打开日志</button><button class="btn sm" data-action="snapshot-data">导出快照</button><button class="btn sm primary" data-action="check-updates">检查更新（先快照）</button></div>
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
          <div class="row" style="padding:4px 0"><span>备份整个数据目录</span><span class="faint mono" style="margin-left:auto">~ 24 MB</span></div>
          <div class="row" style="padding:4px 0"><span>清理 TRACE 遥测缓存</span><span class="faint mono" style="margin-left:auto">~ 1.2 MB</span></div>
          <div class="row" style="padding:4px 0"><span>导出安装报告</span><span style="margin-left:auto"><button class="btn sm" data-action="todo">执行</button></span></div>
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
      if (state.page === 'settings') renderModelProviders();
      if (state.page === 'settings' && state.settingsSection) {
        const target = $('#settings-section-' + state.settingsSection);
        if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        document.querySelectorAll('[data-action="settings-nav"]').forEach(el => {
          el.style.background = el.dataset.id === state.settingsSection ? 'var(--bg-hover)' : '';
        });
      }
      const sc = $('#msgScroll'); if (sc) sc.scrollTop = sc.scrollHeight;
    } catch (err) {
      console.error('[render] ERROR:', err);
      $('#main').innerHTML = '<div style="color:#EF4444;padding:40px;font-family:monospace"><b>渲染错误</b><pre>' + (err && err.stack || err) + '</pre></div>';
    }
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
    render();
    try {
      const res = await bridge.runAgentTurn(s.id, text, { models: state.selectedModels, thinkLevel: state.thinkLevel });
      s.msgs[typingIdx] = { r: 'agent', t: nowTime(), x: res.text, intent: res.intent || 'ACT', feedback: 1 };
      touch(s); persist(); render();
      toast(`已入会话日志 · ${state.selectedModels.length} 模型 · 思维 ${thinkLabel(state.thinkLevel)}`, 'ok');
    } catch (err) {
      s.msgs[typingIdx] = { r: 'agent', t: nowTime(), x: '（模型回合失败：' + (err && err.message ? err.message : err) + '）' };
      render();
      toast('模型回合失败', 'danger');
    }
  }

  async function doRename(sid, title) {
    const s = state.sessions[sid]; if (!s) return;
    s.title = title || s.title; touch(s); persist(); render();
    toast(`已重命名为「${s.title}」`, 'ok');
  }

  async function doFork(sid, name) {
    const src = state.sessions[sid]; if (!src) return;
    const id = 's' + Date.now().toString(36);
    // clone() 此前未定义 → 点击「创建分支」必抛异常。改用 deepClone，
    // 并继承源会话所属项目（此前硬编码 'p1'，会把分支塞进错误的项目组）。
    const s = deepClone(src);
    const pid = src.pid && src.pid !== '__task__' ? src.pid : (state.projects.find((p) => !p.archived) || {}).id || '__task__';
    s.id = id;
    s.title = name || ('分支-' + (src.title || sid));
    s.pid = pid;
    s.updated = '刚刚';
    s.forkedFrom = sid;
    s.forkedAt = new Date().toISOString();
    // 消息深拷贝后仍为独立数组，后续写入互不影响
    s.msgs = Array.isArray(s.msgs) ? s.msgs : [];
    state.sessions[id] = s;
    const proj = state.projects.find((p) => p.id === pid);
    if (proj && !proj.sessions.includes(id)) proj.sessions.unshift(id);
    state.sel = id; persist(); render();
    toast('已创建分支（继承前缀事件，独立写入）', 'ok');
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
    const targetSpec = AUTH_MODES.find((m) => m.id === target);
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
        ${AUTH_MODES.map((m) => `<div class="row" style="padding:9px 10px;border:1px solid ${state.authMode === m.id ? 'var(--accent)' : 'var(--border)'};border-radius:8px;margin-bottom:7px;cursor:pointer" data-action="auth-mode-pick" data-id="${m.id}">
          <div style="flex:1"><b>${m.label}</b>${state.authMode === m.id ? ' <span class="badge ok">当前</span>' : ''}<div class="faint" style="font-size:11px;margin-top:3px">${m.blurb}</div></div>
          ${state.authMode === m.id ? '' : '<button class="btn sm">选择</button>'}
        </div>`).join('')}
      </div>
      <div class="mf"><button class="btn ghost" data-action="modal-cancel">关闭</button></div>`);
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
        if (!state.installedSkills.find((x) => x.slug === skill.slug)) state.installedSkills.push({ slug: skill.slug, enabled: true });
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
      else toast(`已切换为「${({ default: '默认安全', trusted: '信任模式', paranoid: '偏执模式' })[target]}」`, target === 'paranoid' ? 'ok' : 'warn');
    } catch {
      toast('授权模式切换失败（运行时未接入）', 'warn');
    }
  }

  /* ---------- 审批弹窗（T-P3-2 fail-closed） ---------- */
  // 主进程经 authz 插件转发 dsh approval/request → 渲染层弹窗 → 用户决定 → submitDecision。
  function showApprovalModal(req) {
    openModal(`<div class="mh danger">${ic('warn', 18)}<b>授权确认（L3/L4 操作）</b></div>
      <div class="mb">
        <div>Agent 请求执行 <b>${req.toolName || '受限操作'}</b>${req.reason ? `：<span class="faint">${req.reason}</span>` : ''}。</div>
        <div class="warn-list" style="margin-top:10px">
          <div>· 该操作属于 L3/L4 级别，需你显式授权</div>
          <div>· 超时或关闭将视为 <b>拒绝（fail-closed）</b>，操作不会执行</div>
        </div>
      </div>
      <div class="mf">
        <button class="btn ghost" data-action="approval-deny" data-id="${req.id}">拒绝</button>
        <button class="btn danger" data-action="approval-allow" data-id="${req.id}">允许本次</button>
      </div>`);
  }

  function confirmNewBranch(sid) {
    openModal(`<div class="mh">${ic('fork', 18)}<b>从此会话创建分支</b></div>
      <div class="mb">
        <div>分支将继承当前 <span class="mono">#${sid}</span> 的全部事件前缀，但写入新事件 ID，<b>互不污染</b>。</div>
        <div class="warn-list"><div>· 可在分叉点独立探索</div><div>· 主干不受影响</div><div>· 可随时合并或丢弃分支</div></div>
        <div style="margin-top:10px">分支名：<input type="text" value="分支-${sid}-1" style="margin-top:4px"></div>
      </div>
      <div class="mf">
        <button class="btn ghost" data-action="modal-cancel">取消</button>
        <button class="btn primary" data-action="branch-confirm">创建分支</button>
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
  document.body.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && (e.target.id === 'homeComposer' || e.target.id === 'composer')) {
      e.preventDefault();
      const sendBtn = e.target.closest('.home-textarea-wrap')?.querySelector('[data-action="home-send"]')
        || document.querySelector('[data-action="home-send"], [data-action="send"]');
      if (sendBtn) sendBtn.click();
    }
  });
  document.body.addEventListener('click', async (e) => {
    const el = e.target.closest('[data-action]'); if (!el) return;
    const a = el.dataset.action, id = el.dataset.id;
    switch (a) {
      case 'nav': state.page = id; render(); break;
      case 'settings-nav': state.settingsSection = id; render(); break;
      case 'toggle-theme': { state.theme = state.theme === 'light' ? 'dark' : 'light'; document.documentElement.dataset.theme = state.theme; break; }
      case 'toggle-ctx': state.ctxOpen = !state.ctxOpen; render(); break;
      case 'ctx-tab': state.ctxTab = el.dataset.id; render(); break;
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
      case 'sel': state.sel = id; render(); break;
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
          const r = await bridge.openProjectDir();
          toast(r && r.ok ? '已打开项目目录' : `打开失败：${(r && r.reason) || '未知错误'}`, r && r.ok ? 'ok' : 'danger');
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
      case 'fork': confirmNewBranch(state.sel); break;
      case 'branch-confirm': { const inp = $('#modalRoot input[type=text]'); const nm = inp ? inp.value : ''; closeModal(); doFork(state.sel, nm); break; }
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
      case 'approval-deny': { const id = el.dataset.id; closeModal(); bridge.submitDecision(id, 'rejected'); toast('已拒绝该操作', 'danger'); break; }
      case 'confirm-yes': case 'confirm-no': { const z = $('#confirmZone'); z.innerHTML = ''; toast(a === 'confirm-yes' ? '已确认 · 入审计日志' : '已拒绝 · 入审计日志', a === 'confirm-yes' ? 'ok' : 'danger'); break; }

      /* 补偿层（T-P5-1） */
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
      case 'sim-subagent': { const sc = $('#msgScroll'); const div = document.createElement('div'); div.className = 'msg agent'; div.innerHTML = `<div class="avatar" style="background:var(--ceo)">AI</div><div class="body"><div class="meta"><b>OrchDesk</b><span>刚刚</span></div><div>已派发 SubAgent 处理该任务。</div><div class="subagent"><span class="badge warn">SubAgent</span><span class="mono">W-108 临时任务</span><span class="faint">执行中…</span></div></div>`; sc.appendChild(div); sc.scrollTop = sc.scrollHeight;
        setTimeout(() => { div.querySelector('.subagent').innerHTML = `<span class="badge info">SubAgent</span><span class="mono">W-108 临时任务</span><span class="faint">已回收并销毁（即用即走）</span>`; toast('脑手解耦：SubAgent 成果已回收，上下文已销毁', 'ok'); }, 2200); break; }
      case 'trace': {
        // key 必须与 renderMsg 的读取口径一致（sid|m.t）；此前硬编码 's1' 导致反馈永远显示不出来。
        const sid = state.sel || '';
        const key = sid + '|' + (el.dataset.t || '');
        if (state.feedback.has(key)) state.feedback.delete(key);
        else state.feedback.add(key);
        // 反馈落盘，重启后仍在（此前仅存于内存 Set）
        const s = state.sessions[sid];
        if (s) { s.feedback = [...state.feedback].filter((k) => k.startsWith(sid + '|')); persist(); }
        render();
        toast('TRACE：反馈已记录（脱敏后遥测）', 'ok');
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
      case 'skill-uninstall': { state.installedSkills = state.installedSkills.filter((x) => x.slug !== el.dataset.n); toast(`已卸载「${el.dataset.n}」`, 'warn'); render(); break; }

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
      case 'todo': toast('该操作在真实版本中打开对应面板'); break;

      /* T-P6-3 数据快照 + 更新检查 */
      case 'open-project-dir': {
        const r = await bridge.openProjectDir();
        toast(r && r.ok ? '已打开项目目录' : `打开失败：${(r && r.reason) || '未知错误'}`, r && r.ok ? 'ok' : 'danger');
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
      case 'modal-bg': if (e.target === el) { state.askInputCb = null; closeModal(); } break;
      case 'modal-cancel': state.askInputCb = null; closeModal(); break;
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
      case 'team-compose': {
        const tid = el.dataset.tid;
        const tn = el.dataset.tn || '专家团';
        askInput({
          title: `派发任务 · ${tn}`,
          label: 'CEO（主会话）将拆解任务并派给 Director→Worker，经真实模型执行，耗时可能较长。',
          placeholder: '描述要派发的任务…',
        }).then((task) => {
          task = String(task || '').trim();
          if (!task) return;
          toast('编排中：CEO 拆解 → Director → Worker…', 'info');
          bridge.composeTeam(tid, task).then((r) => {
            if (r && r.error) { toast(r.error, 'err'); return; }
            state.delegationLast = r;
            render();
            toast(`编排完成 · ${r.rootId || ''}`, 'ok');
          }).catch((e) => toast('编排失败: ' + ((e && e.message) || e), 'err'));
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

    // 订阅工具执行步骤（此前主进程发 orchdesk:tool-step 但无人订阅 → 步骤条永远为空）
    try {
      if (typeof bridge.onToolStep === 'function') {
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
          if (state.sel === step.sessionId) render();
        });
      }
    } catch (err) { console.warn('[init] 工具步骤订阅失败:', err); }

    // 第二步：并行加载所有元数据（互不依赖，同时发起）
    const results = await Promise.allSettled([
      // 授权
      bridge.getAuthMode().then(r => { if (r?.mode) state.authMode = r.mode; }).catch(() => {}),
      bridge.getAuthLevels().then(r => { if (Array.isArray(r) && r.length) state.authLevels = r; }).catch(() => {}),
      bridge.getAuthAudit().then(r => { if (r) state.authAudit = r; }).catch(() => {}),
      // 提示词库
      bridge.listPrompts().then(r => { if (Array.isArray(r)) state.promptDocs = r; }).catch(() => {}),
      bridge.mergePrompts('main').then(r => { if (r?.conflicts) state.promptConflicts = r.conflicts; }).catch(() => {}),
      // 记忆 + 补偿 + 自进化
      bridge.getMemoryStats().then(r => { if (r) state.memoryStats = r; }).catch(() => {}),
      bridge.getCompensationAudit().then(r => { if (Array.isArray(r)) state.compAudit = r; }).catch(() => {}),
      bridge.listTempPlugins().then(r => { if (Array.isArray(r)) state.tempPlugins = r; }).catch(() => {}),
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
      // Hub
      bridge.hubStatus().then(r => { if (r) state.hubStatus = r; }).catch(() => {}),
    ]);

    // 订阅审批弹窗
    if (bridge.onAuthRequest) {
      bridge.onAuthRequest((req) => { showApprovalModal(req); });
    }

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
