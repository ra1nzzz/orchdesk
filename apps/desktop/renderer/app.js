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
    archive: '<rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8M10 12h4"/>',
    at: '<circle cx="12" cy="12" r="4"/><path d="M16 12v1.5a2.5 2.5 0 0 0 5 0V12a9 9 0 1 0-3.5 7.1"/>',
    shield: '<path d="M12 2 4 5v6c0 5 3.5 9.5 8 11 4.5-1.5 8-6 8-11V5z"/>',
    shieldOff: '<path d="M5 5l14 14M12 2 4 5v6c0 5 3.5 9.5 8 11 4.5-1.5 8-6 8-11V5z"/>',
    bot: '<rect x="4" y="7" width="16" height="12" rx="3"/><circle cx="9" cy="13" r="1.2"/><circle cx="15" cy="13" r="1.2"/><path d="M12 7V3M9 3h6"/>',
    trash: '<path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1.2 13a2 2 0 0 1-2 1.8H8.2a2 2 0 0 1-2-1.8L5 6"/>',
    warn: '<path d="M10.3 3.86 1.82 18a2 2 0 0 0 1.7 3h16.9a2 2 0 0 0 1.7-3L13.7 3.86a2 2 0 0 0-3.4 0zM12 9v4M12 17h.01"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>'
  };
  const ic = (n, s = 20) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${I[n]}</svg>`;

  /* ---------- 种子数据（首次运行 / 浏览器预览用） ---------- */
  const SEED_PROJECTS = [
    { id: 'p1', n: 'OrchDesk', d: '本地 Agent 工作台', open: 1, archived: 0, sessions: ['s1', 's2'] },
    { id: 'p2', n: '写作助手', d: 'AI 资讯日报 / 知识库', open: 1, archived: 0, sessions: ['s3'] },
    { id: 'p3', n: '已归档', d: '', open: 0, archived: 1, sessions: ['s4'] }
  ];
  const EXPERTS = ['Orchestrator（主会话）', '开发总监', '设计总监', '测试总监', '项目管理总监', '文档总监', '艺术总监', '风险控制总监'];
  const TEAMS = [{ n: '预置 · 全栈开发团', m: '开发总监 + 测试总监 + 文档总监' }, { n: '预置 · 写作团', m: '文档总监 + 艺术总监' }, { n: '自定义 · 我的专家团', m: '自编排（拖拽专家）' }];
  // 三模式（与 @orchdesk/dsh-authz 插件对齐；映射到 dsh sandbox/mode + approval/policy）。
  const AUTH_MODES = [
    { id: 'default', label: '默认安全', blurb: '工作区可写；L3/L4 操作弹窗确认。平衡日常使用与安全。' },
    { id: 'trusted', label: '信任模式', blurb: '同默认沙箱，放宽命令/网络白名单；高危操作仍弹窗。' },
    { id: 'paranoid', label: '偏执模式', blurb: '只读沙箱 + 任何 ask 自动拒绝。最严；不可逆操作一律不开门。' },
  ];
  // 提示词分类标签（与 @orchdesk/dsh-prompt 插件 CATEGORY_LABELS 对齐）。
  const PROMPT_CAT_LABELS = { role: '角色行为', safety: '安全边界', format: '输出格式', 'skill-link': '技能联动' };
  const PROMPT_CATS = Object.keys(PROMPT_CAT_LABELS);
  const SEED_SESSIONS = {
    s1: { id: 's1', pid: 'p1', title: '主会话', expert: 'Orchestrator（主会话）', model: 'Claude Opus 4.7', updated: '刚刚', ts: '22:01', msgs: [
      { r: 'user', t: '22:01', x: '帮我优化这段登录逻辑，并跑一遍测试。' },
      { r: 'agent', t: '22:01', intent: 'ACT', x: '好的。我让「代码审查」SubAgent 先分析现有实现，同时本地模型做了意图初筛，判定为普通开发请求，直接放行。',
        tools: [{ n: '脑-手：派发 SubAgent · 代码审查', ph: 'running' }, { n: 'git.status', ph: 'done' }], steps: 2, sub: { name: 'W-107 代码审查', state: 'running' }, feedback: 1 },
      { r: 'user', t: '22:03', x: '顺便把结论整理成一份说明。' },
      { r: 'agent', t: '22:04', intent: 'ACT', x: 'SubAgent 已返回，结论已回收并沉淀到项目记忆。说明整理好了，见下方。',
        tools: [{ n: '脑-手：回收 + 沉淀', ph: 'done' }, { n: 'orchclaw-tasks.finish', ph: 'done' }], steps: 2, sub: { name: 'W-107 代码审查', state: 'disposed' }, feedback: 1 }] },
    s2: { id: 's2', pid: 'p1', title: '代码审查', expert: '开发总监', model: 'Claude Sonnet 4.6', updated: '昨天', ts: '昨天', msgs: [{ r: 'user', t: '昨天', x: '审查这次重构的边界条件。' }, { r: 'agent', t: '昨天', intent: 'ACT', x: '已审查完成，发现 2 处边界遗漏，均已标注。', steps: 4, feedback: 1 }] },
    s3: { id: 's3', pid: 'p2', title: '写作助手', expert: '文档总监', model: 'GPT-5', updated: '周一', ts: '周一', msgs: [{ r: 'agent', t: '周一', x: '日报模板已就绪，随时可以开始。', steps: 1, feedback: 1 }] },
    s4: { id: 's4', pid: 'p3', title: '（旧）API 探索', expert: '开发总监', model: 'DeepSeek-V4', updated: '上周', ts: '上周', archived: 1, msgs: [{ r: 'user', t: '上周', x: '尝试用 deepseek-harness 跑个 demo。' }] }
  };
  const PLUGINS = [
    { id: 'intent', n: '意图识别', on: 1, model: 'qwen3:14b（本地）', d: 'prompt 到达模型前必经 agent/pre-step；本地模型做 F1-F4 初筛，高风险才转人工确认。', repo: '', caps: ['prompt.read', 'intent.classify', 'flow.gate'], cfg: ['风险阈值：0.70', '默认回退：BLOCK', '初筛模型：qwen3:14b（本地）'] },
    { id: 'trace', n: 'TRACE', on: 1, d: 'Agent Loop 前 / Loop 结束，记录用户对语用意图的反馈；脱敏后遥测上传至公开 GitHub 仓库。', repo: 'github.com/ra1nzzz/orchdesk-telemetry（脱敏）', caps: ['event.read', 'pii.mask', 'github.write'], cfg: ['脱敏：开', '反馈时机：Loop 结束后', '遥测仓库：公开 GitHub'] },
    { id: 'brain', n: '脑手解耦', on: 1, d: '主会话负责理解、回收、沉淀；SubAgent 执行、反馈、即用即走。', repo: '', caps: ['agent.spawn', 'agent.dispose', 'memory.commit'], cfg: ['每任务 SubAgent 并发：1-3', 'SubAgent 上下文隔离：开'] },
    { id: 'multi', n: '多Agent编排', on: 1, d: '类 WorkBuddy 的专家与专家团；可用预置，也可自编排。', repo: '', caps: ['expert.load', 'team.compose', 'role.bind'], cfg: ['预置专家团：2 个', '自编排：开'] },
    { id: 'hub', n: 'OrchClaw Hub', on: 0, deferred: 0, d: '配对远程 Agent 后，主会话可向其下发任务并回收结果（联调就绪，待配对）。', repo: '', caps: ['pair.token', 'agent.remote', 'ws.channel'], cfg: ['配对：安全存储加密', '远程 Agent 通道：主会话'] }
  ];
  const SKILLS_MARKET = [
    { n: 'guanji', d: '观雅集官方客户端', caps: ['skill.fetch', 'skill.install'], auth: 0 },
    { n: 'consolidate-project-knowledge-base', d: '项目知识库治理', caps: ['fs.read', 'fs.write', 'doc.review'], auth: 1 },
    { n: 'aihot', d: 'AI 资讯日报', caps: ['web.fetch', 'cron.schedule'], auth: 0 },
    { n: 'kimi-webbridge', d: '本地浏览器接管（截图/抓取）', caps: ['browser.navigate', 'browser.screenshot'], auth: 1 }
  ];
  const PLUGIN_MARKET = [
    { n: 'Git 集成', d: '仓库操作 / PR / Issue', caps: ['git.read', 'git.write'], auth: 1 },
    { n: 'PDF 工具箱', d: '读取/合并/拆分/OCR', caps: ['pdf.read', 'pdf.write'], auth: 0 },
    { n: '浏览器自动化', d: 'Playwright 驱动', caps: ['browser.navigate', 'browser.screenshot'], auth: 1 },
    { n: '邮件助手', d: 'SMTP/IMAP 收发', caps: ['mail.send', 'mail.read'], auth: 1 },
    { n: '数据可视化', d: 'Chart.js 图表生成', caps: ['chart.render'], auth: 0 }
  ];
  const CONNECTORS = [
    { n: 'GitHub', d: '代码托管', on: 1 }, { n: '飞书', d: '协作平台', on: 0 }, { n: '企业微信', d: '企业通讯', on: 0 },
    { n: '腾讯文档', d: '在线文档', on: 0 }, { n: 'Notion', d: '知识管理', on: 0 }, { n: 'Linear', d: '项目管理', on: 0 },
    { n: 'TAPD', d: '研发管理', on: 0 }, { n: '钉钉', d: '企业通讯', on: 0 }
  ];
  const MODELS = [
    { n: 'Claude Opus 4.7', p: 'Anthropic · 200K', k: 'sk-••••••••', state: '已测' },
    { n: 'Claude Sonnet 4.6', p: 'Anthropic · 200K', k: 'sk-••••••••', state: '已测' },
    { n: 'GPT-5', p: 'OpenAI · 256K', k: 'sk-••••••••', state: '已测' },
    { n: 'DeepSeek-V4', p: 'DeepSeek · 128K', k: 'sk-••••••••', state: '未配' },
    { n: 'qwen3:14b', p: 'Ollama 本地 · 意图初筛', k: '(本地)', state: '已就绪' }
  ];

  /* ---------- 桥接（主进程 contextBridge；缺省回落页内内存） ---------- */
  const bridge = (function () {
    const real = (typeof window !== 'undefined' && window.orchdesk) ? window.orchdesk : null;
    if (real) return real;
    // 浏览器预览回落：页内内存，不跨重启持久化
    let mem = [];
    const compAudit = [];
    const tempPlugins = new Map();
    const clone = (x) => JSON.parse(JSON.stringify(x));
    // T-P5 本地启发式（与插件 classify / staticGate 同义；仅占位演示，真实逻辑在补偿层/自进化插件）。
    const WITHHOLD_RE = /(删除|删掉|删去|清空|格式化|rm\s|rmdir|del\s|trash|wipe|drop\s+table|删库|shred|发送|发邮件|群发|对外发送|发消息|广播|notify|send\s+email|message-send|broadcast|请求接口|调用接口|调用API|网络请求|POST|GET|PUT|http|curl|fetch|api\s+call|webhook|API|写入共享|上传到共享|保存到共享盘|写共享目录|写共享文件|shared\s+drive|upload\s+to\s+shared|发布|部署|提交|支付|转账|购买|下单|publish|deploy|commit|payment|transfer|purchase)/i;
    function classifyOutboundLocal(text) {
      const needs = WITHHOLD_RE.test(text || '');
      return { needsConfirm: needs, category: needs ? 'outbound' : 'other', reason: needs ? '检测到跨边界/不可逆外发操作' : '未检测到跨边界外发操作', warning: needs ? '⚠ 此操作不可撤销：发送前需二次确认' : '' };
    }
    function suggestCompLocal(text) {
      const t = (text || '');
      if (/(删除|删掉|删库|rm\s|del\s|wipe)/i.test(t)) return '从回收站/备份恢复；记录被删路径以便追溯';
      if (/(发送|发邮件|对外发送|广播)/i.test(t)) return '撤回消息（若通道支持）；否则记录已发内容与收件方';
      if (/(请求接口|调用|网络|http|curl|fetch|API|webhook)/i.test(t)) return '记录外发请求；必要时联系服务端作废 token/会话';
      if (/(共享|shared\s+drive|upload\s+to\s+shared)/i.test(t)) return '从共享盘版本历史恢复上一版';
      if (/(发布|部署|提交|支付|转账|购买|下单)/i.test(t)) return '记录不可逆操作；尝试业务侧回滚（如适用）';
      return '记录操作以便审计追溯';
    }
    const HARD_DENY_RE = /(child_process|exec\(|eval\(|new\s+Function|process\.exit|process\.kill|require\('child_process'\)|remote\s+import|import\s*\(\s*['"]https?:|vm\.|__proto__|constructor\s*\.\s*constructor)/i;
    function staticGateLocal(code) {
      if (!code || !code.trim()) return { allowed: false, reason: '空代码，拒绝' };
      if (HARD_DENY_RE.test(code)) return { allowed: false, reason: '命中静态拒绝规则（危险 API）' };
      return { allowed: true, requiresSandbox: true };
    }
    return {
      loadSessions: () => Promise.resolve(clone(mem)),
      persistSessions: (arr) => { mem = clone(arr); return Promise.resolve(); },
      runAgentTurn: (sessionId, text, opts) => Promise.resolve({
        text: '（浏览器预览模式）未连接主进程运行时，这是本地占位回复。在 Electron 中此回合会调用真实模型（或本地 Ollama）。',
        intent: 'ACT'
      }),
      // T-P3-2 授权桥（占位环境回落：返回默认，UI 不崩；Electron 中由 preload 接主进程）。
      getAuthMode: () => Promise.resolve({ mode: 'default' }),
      setAuthMode: () => Promise.resolve({ ok: false }),
      getAuthLevels: () => Promise.resolve([
        { level: 0, label: '读取', scope: '无副作用', requiresApproval: false },
        { level: 1, label: '状态写入', scope: '应用域内', requiresApproval: false },
        { level: 2, label: '文件系统', scope: '受限目录', requiresApproval: false },
        { level: 3, label: '网络', scope: '白名单', requiresApproval: true },
        { level: 4, label: 'Shell / 进程', scope: '仅 FULL ACCESS', requiresApproval: true },
      ]),
      getAuthAudit: () => Promise.resolve([]),
      onAuthRequest: () => () => {},
      submitDecision: () => {},
      // T-P4-3 提示词库桥（占位环境回落：返回空列表，UI 不崩；Electron 中由 preload 接主进程）。
      listPrompts: () => Promise.resolve([]),
      mergePrompts: () => Promise.resolve({ sections: [], conflicts: [] }),
      savePrompt: () => Promise.resolve({ ok: false }),
      deletePrompt: () => Promise.resolve({ ok: false }),
      // T-P4-1/2 记忆桥（占位环境回落：返回静态占用与示例召回；Electron 中由 preload 接主进程 memory 服务）。
      getMemoryStats: () => Promise.resolve({ usageRatio: 0.41, dumps: 2, recallHits: 1, domainCounts: { global: 0, project: 1, director: 0, worker: 0 } }),
      // T-P5-1 补偿层桥（占位环境回落：本地启发式 + 本地审计；Electron 中由 preload 接主进程 compensation 服务）。
      withhold: (text) => Promise.resolve(classifyOutboundLocal(text)),
      compensate: (text, note) => {
        const rec = { id: 'cmp-' + Date.now().toString(36), ts: Date.now(), text: (text || '').slice(0, 80), note: note || '', action: suggestCompLocal(text) };
        compAudit.push(rec);
        return Promise.resolve(rec);
      },
      getCompensationAudit: () => Promise.resolve(compAudit.slice()),
      // T-P5-2 自进化桥（占位环境回落：仅驻内存 Map；Electron 中由 preload 接主进程 evolution 服务，真实沙箱执行）。
      createTempPlugin: (spec) => {
        const gate = staticGateLocal(spec && spec.code ? spec.code : '');
        if (!gate.allowed) return Promise.resolve({ ok: false, reason: gate.reason });
        const id = 'tp-' + Date.now().toString(36);
        const rec = { id, name: (spec && spec.name) || 'untitled', status: 'active', trustLevel: 'shell', requiresSandbox: true, inMemory: true };
        tempPlugins.set(id, rec);
        return Promise.resolve({ ok: true, plugin: rec });
      },
      listTempPlugins: () => Promise.resolve([...tempPlugins.values()]),
      disposeTempPlugin: (id) => Promise.resolve(tempPlugins.delete(id)),
      // T-P6-1 观雅集桥（浏览器预览回落：静态样本 + 本地能力审查；Electron 中接主进程 guanji 客户端）。
      guanjiTokenStatus: () => Promise.resolve({ configured: false }),
      guanjiSetToken: () => Promise.resolve({ ok: false }),
      guanjiList: () => Promise.resolve(SKILLS_MARKET.map((s) => ({ slug: s.n, name: s.n, description: s.d, caps: s.caps, auth: s.auth }))),
      guanjiInstall: (skill) => skill && skill.auth ? Promise.resolve({ ok: false, review: 'needs-auth', reason: '演示环境需配置观雅集 TOKEN' }) : Promise.resolve({ ok: true, review: 'allowed' }),
      guanjiPublish: () => Promise.resolve({ ok: false, reason: '演示环境需配置观雅集 TOKEN' }),
      // T-P6-2 OrchClaw Hub 桥（浏览器预览回落：未接主进程；Electron 中接主进程 hub 客户端，真实配对远程）。
      hubStatus: () => Promise.resolve({ paired: false }),
      hubPair: () => Promise.resolve({ ok: false, reason: '演示环境未接主进程' }),
      hubSend: () => Promise.resolve({ ok: false, reason: '未配对' }),
      hubResult: () => Promise.resolve({ status: 'error', result: '未配对' }),
      // T-P6-3 数据快照 + 更新检查（浏览器预览回落：未接主进程）。
      snapshotData: () => Promise.resolve({ ok: false, reason: '演示环境未接主进程' }),
      checkUpdates: () => Promise.resolve({ snapshot: { ok: false }, update: { available: false, note: '演示环境未接主进程' } }),
    };
  })();

  /* ---------- 状态 ---------- */
  const clone = (x) => JSON.parse(JSON.stringify(x));
  const state = {
    page: 'session', theme: 'light', sel: 's1', ctxOpen: 1, wz: 0, wzExpert: 0,
    feedback: new Set(), authMode: 'default',
    authLevels: [], authAudit: [],
    promptDocs: [], promptConflicts: [],
    compAudit: [], tempPlugins: [],
    guanjiSkills: [], guanjiTokenSet: false, installedSkills: [], askInputCb: null,
    hubStatus: { paired: false }, hubUrl: '', hubTaskText: '', hubResultText: '',
    memoryStats: { usageRatio: 0.41, dumps: 2, recallHits: 1, domainCounts: { global: 0, project: 1, director: 0, worker: 0 } },
    pExpanded: new Set(['p1', 'p2']),
    plugSideExpanded: new Set(['builtin', 'market', 'skills', 'experts', 'connectors']),
    selectedModels: ['Claude Opus 4.7'], thinkLevel: 'standard',
    projects: clone(SEED_PROJECTS),
    sessions: clone(SEED_SESSIONS)
  };

  const $ = (s) => document.querySelector(s);
  const PAGES = [
    { id: 'session', n: '会话', icon: 'conv' },
    { id: 'plugins', n: '插件', icon: 'skills' },
    { id: 'settings', n: '设置', icon: 'settings' }
  ];
  const nowTime = () => new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });

  function persist() { bridge.persistSessions(Object.values(state.sessions)).catch(() => {}); }

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
    const isU = m.r === 'user';
    const intentBadge = m.intent
      ? (m.intent === 'ACT' ? `<span class="badge ok"><span class="dot" style="background:var(--ok)"></span>意图 ACT</span>`
        : m.intent === 'CONFIRM' ? `<span class="badge warn">意图 · 待确认</span>` : `<span class="badge danger">意图 · 已拦截</span>`)
      : '';
    const tools = (m.tools && m.tools.length) ? `<details class="tools"><summary>${ic('chev', 14)} ${m.steps} 步 · ${m.tools.length} 个动作</summary>${m.tools.map((t) => `<div class="trow"><span class="dot" style="background:${t.ph === 'running' ? 'var(--warn)' : 'var(--ok)'};${t.ph === 'running' ? 'animation:pulse 1.6s infinite' : ''}"></span><span class="mono">${esc(t.n)}</span><span class="faint" style="margin-left:auto">${t.ph === 'running' ? '执行中' : '完成'}</span></div>`).join('')}</details>` : '';
    const sub = m.sub ? `<div class="subagent"><span class="badge ${m.sub.state === 'running' ? 'warn' : 'info'}">SubAgent</span><span class="mono">${esc(m.sub.name)}</span><span class="phases faint">${m.sub.state === 'running' ? '执行中 · 即用即走' : '已回收并销毁'}</span></div>` : '';
    const fb = (m.feedback && state.feedback.has(sid + '|' + m.t)) ? `<div class="feedback" style="color:var(--ok)">已记录反馈 · 已脱敏遥测</div>`
      : (m.feedback ? `<div class="feedback"><span>这条回答对你有帮助吗？</span><button data-action="trace" data-t="${m.t}">有帮助</button><button data-action="trace" data-t="${m.t}">需改进</button><span class="faint">TRACE 脱敏遥测 → 公开 GitHub 仓库</span></div>` : '');
    const txt = m.typing ? `<span class="faint">思考中…</span>` : esc(m.x);
    return `<div class="msg ${isU ? 'user' : 'agent'}${m.typing ? ' typing' : ''}">
      <div class="avatar">${isU ? '我' : 'AI'}</div>
      <div class="body"><div class="meta"><b>${isU ? '你' : 'OrchDesk'}</b><span>${m.t}</span>${intentBadge}</div>
      <div>${txt}</div>${sub}${tools}${fb}</div></div>`;
  }

  /* ---------- 渲染：侧栏（项目分组 + 会话 + 悬浮 +） ---------- */
  function renderSideSession() {
    const blocks = state.projects.map((p) => {
      const expanded = state.pExpanded.has(p.id);
      const sess = p.sessions.map((sid) => {
        const s = state.sessions[sid]; if (!s) return '';
        return `<div class="sess ${state.sel === sid ? 'active' : ''}" data-action="sel" data-id="${sid}">
          <span class="si"></span>
          <span class="sn" title="${esc(s.title)}">${esc(s.title)}</span>
          <span class="st">${esc(s.updated)}</span>
          <button class="sm" data-action="sess-menu" data-id="${sid}" title="更多">${ic('more', 14)}</button>
        </div>`;
      }).join('');
      return `<div class="proj">
        <div class="proj-head" data-action="proj-toggle" data-id="${p.id}">
          <span class="pf ${expanded ? 'open' : ''}">${ic('chev', 12)}</span>
          <span class="pn">${esc(p.n)}</span>
          <span class="pc">${p.sessions.length}</span>
          <button class="pm" data-action="proj-menu" data-id="${p.id}" title="项目操作">${ic('more', 14)}</button>
        </div>
        ${expanded ? `<div class="proj-list">${sess}</div>` : ''}
      </div>`;
    }).join('');
    return blocks + `<div class="fab-wrap"><button class="fab" data-action="newconv" title="新建会话">${ic('plus', 22)}</button></div>`;
  }

  function thinkLabel(l) { return ({ off: '关闭', standard: '标准', deep: '深度', max: '最大' })[l] || '标准'; }
  function renderComposer(s) {
    const AUTH_MODE_LABEL = { default: '默认安全', trusted: '信任模式', paranoid: '偏执模式' };
    const authChip = `<button class="auth ${state.authMode === 'paranoid' ? 'full' : ''}" data-action="auth-open"><span class="dot"></span>${AUTH_MODE_LABEL[state.authMode] || '默认安全'}</button>`;
    const mpLabel = state.selectedModels.length > 1 ? state.selectedModels.length + ' 个模型' : (state.selectedModels[0] || '选择模型');
    const thinkIdx = ({ off: 0, standard: 1, deep: 2, max: 3 })[state.thinkLevel] || 1;
    return `<div class="composer"><div class="box" style="margin:0 auto">
      <textarea id="composer" placeholder="向 ${s.expert} 发消息…（先经意图识别插件初筛）"></textarea>
      <div id="outboundWarn" class="outbound-warn" hidden></div>
      <div class="bar">
        <div class="tools-left">
          <button class="t-btn" data-action="skill-add" data-tip="加载技能">${ic('plus')}</button>
          <button class="t-btn" data-action="expert-add" data-tip="引用专家或专家团">${ic('at')}</button>
          ${authChip}
        </div>
        <div class="right">
          <span class="intent-hint" id="intentHint"><span class="dot" style="background:var(--ok)"></span>意图识别：本地模型 ACT</span>
          <button class="c-mp ${state.selectedModels.length > 1 ? 'multi' : ''}" data-action="model-pick"><span class="md"></span><span class="mn">${mpLabel}</span>${ic('chev', 12)}</button>
          <div class="think-slider">
            <span>思维</span>
            <input type="range" min="0" max="3" step="1" value="${thinkIdx}" data-action="think-slider">
            <span class="tl">${thinkLabel(state.thinkLevel)}</span>
          </div>
          <button class="btn sm primary" data-action="send">发送</button>
        </div>
      </div>
    </div></div>`;
  }

  const VIEWS = {};
  VIEWS.session = {
    side() { return renderSideSession(); },
    main() {
      const s = state.sessions[state.sel] || state.sessions.s1;
      return `<div style="flex:1;overflow-y:auto" id="msgScroll">
        <div style="max-width:760px;margin:0 auto;padding:18px 16px 10px">
          <div class="row" style="justify-content:space-between;margin-bottom:4px">
            <div class="row"><b style="font-size:16px">${s.title}</b>
              <span class="badge info">${s.expert}</span></div>
            <button class="iconbtn" data-action="toggle-ctx" title="切换右侧面板" style="transform:rotate(${state.ctxOpen ? 0 : 180}deg);transition:.15s">${ic('chev', 14)}</button></div>
          <div id="confirmZone"></div>
          ${(s.msgs || []).map((m) => renderMsg(m, s.id)).join('')}
        </div></div>
      ${renderComposer(s)}`;
    },
    ctx() {
      const s = state.sessions[state.sel] || state.sessions.s1;
      const ms = state.memoryStats || { usageRatio: 0.41, dumps: 2, recallHits: 1, domainCounts: { global: 0, project: 1, director: 0, worker: 0 } };
      const pct = Math.round((ms.usageRatio ?? 0.41) * 100);
      return `<div class="sec-title">会话上下文</div>
        <div class="card" style="padding:12px"><div class="row" style="justify-content:space-between"><span class="mut" style="font-size:12px">上下文占用</span><b>${pct}%</b></div>
          <div class="gauge" style="margin-top:6px"><i style="width:${Math.min(100, pct)}%"></i><span class="th" style="left:80%"></span></div>
          <div class="faint" style="margin-top:5px">80% 阈值触发自动转储（LLM 摘要 + 本地 TF-IDF 编码 + 伪记忆注入，原消息不丢）</div></div>
        <div class="sec-title">记忆召回</div><div class="faint">已转储 ${ms.dumps ?? 0} 次 · 近期召回命中 ${ms.recallHits ?? 0} 条（project 域优先）</div>
        <div class="sec-title">四域记忆分布</div><div class="faint">global ${ms.domainCounts?.global ?? 0} · project ${ms.domainCounts?.project ?? 0} · director ${ms.domainCounts?.director ?? 0} · worker ${ms.domainCounts?.worker ?? 0}</div>
        <div class="sec-title">本次会话的 SubAgent</div>
        <div class="faint">W-107 代码审查：已回收并销毁（即用即走）</div>
        <div class="sec-title">分叉</div><button class="btn sm" data-action="fork">从此会话分叉</button>
        <div class="faint" style="margin-top:6px" id="forkLog">暂无分叉</div>`;
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
      const market = PLUGIN_MARKET.map((p) => `<div class="ss-i"><span class="id"></span><span class="in">${p.n}</span>${p.auth ? '<span class="ib badge warn">授权</span>' : '<span class="ib badge ok">可装</span>'}</div>`).join('');
      const skills = SKILLS_MARKET.map((s) => `<div class="ss-i"><span class="id"></span><span class="in mono" style="font-size:11.5px">${s.n}</span>${s.auth ? '<span class="ib badge warn">授权</span>' : '<span class="ib badge ok">可装</span>'}</div>`).join('');
      const experts = [...EXPERTS.map((e) => `<div class="ss-i"><span class="id"></span><span class="in">${e}</span><span class="ib badge info">专家</span></div>`),
        ...TEAMS.map((t) => `<div class="ss-i"><span class="id"></span><span class="in">${t.n}</span><span class="ib badge ceo">团</span></div>`)].join('');
      const connectors = CONNECTORS.map((c) => `<div class="ss-i ${c.on ? 'on' : ''}"><span class="id"></span><span class="in">${c.n}</span>${c.on ? '<span class="ib badge ok">已连</span>' : '<span class="ib badge">未连</span>'}</div>`).join('');
      return sec('builtin', '内置插件', PLUGINS.length, builtIn) +
        sec('market', '插件市场', PLUGIN_MARKET.length, market) +
        sec('skills', '技能市场', SKILLS_MARKET.length, skills) +
        sec('experts', '专家·专家团', EXPERTS.length + TEAMS.length, experts) +
        sec('connectors', '连接器', CONNECTORS.length, connectors);
    },
    main() {
      return `<div class="main-inner"><h1 class="pg">插件</h1><div class="pg-sub">一切皆插件——能力以插件形式挂载；启用 = 注册 effect，停用 = 注册回滚（无残留）。</div>
        ${PLUGINS.map((p) => `<div class="plug" data-pid="${p.id}">
          <div class="ph">
            <div style="min-width:0;flex:1">
              <div class="ptitle">${p.n}
                ${p.on ? '<span class="badge ok">已启用</span>' : p.deferred ? '<span class="badge">延后 · 需联调</span>' : '<span class="badge">已关闭</span>'}
                ${p.model ? `<span class="badge info">${p.model}</span>` : ''}</div>
              <div class="pdesc">${p.d}</div>
              <div class="pmeta">${p.repo ? `<span class="mono">${p.repo}</span>·` : ''}<span class="faint">能力声明</span></div>
              <div class="pcaps">${p.caps.map((c, i) => `<span class="badge cap ${i === 0 ? '' : (c.includes('write') || c.includes('dispose') || c.includes('commit') ? 'warn' : '')}">${c}</span>`).join('')}</div>
            </div>
            <div class="pactions">
              <div class="switch ${p.on ? 'on' : ''}" data-action="plug-toggle" data-id="${p.id}"></div>
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
          .map((s) => `<div class="node" style="padding:6px 8px;border-radius:7px;cursor:pointer;display:flex;align-items:center;gap:8px"><span style="color:var(--fg-dim)">${ic(s.icon, 14)}</span><span style="font-size:12.5px">${s.n}</span></div>`).join('')}`;
    },
    main() {
      return `<div class="main-inner"><h1 class="pg">设置</h1><div class="pg-sub">模型、沙箱、授权、桌面集成等能力均以插件形式挂载，在此统一管理。</div>
        <div class="statbar">
          <div class="stat"><div class="sk">授权模式</div><div class="sv"><span class="dot" style="background:var(--ok)"></span>${({ default: '默认安全', trusted: '信任模式', paranoid: '偏执模式' })[state.authMode] || '默认安全'}</div></div>
          <div class="stat"><div class="sk">沙箱</div><div class="sv"><span class="badge ok" style="font-weight:600">Windows ACL</span></div></div>
          <div class="stat"><div class="sk">数据目录</div><div class="sv" style="font-size:12px;font-weight:500">%APPDATA%/OrchDesk</div></div>
          <div class="stat"><div class="sk">运行时</div><div class="sv" style="font-size:12px;font-weight:500">dsh 99f6f02</div></div>
        </div>
        <div class="sec-title"><span class="ico">${ic('bot', 14)}</span>模型</div>
        <div class="models-search"><input type="search" placeholder="按名称 / 提供方搜索…"></div>
        <div class="card models-card">
          <table>
            <tr><th>模型</th><th>提供方</th><th>密钥</th><th>状态</th><th style="text-align:right">操作</th></tr>
            ${MODELS.map((m) => `<tr>
              <td><b>${m.n}</b></td><td class="mut">${m.p}</td><td class="mono faint">${m.k}</td>
              <td>${m.state === '已测' ? '<span class="badge ok">已测</span>' : m.state === '已就绪' ? '<span class="badge ok">已就绪</span>' : '<span class="badge">未配</span>'}</td>
              <td style="text-align:right"><button class="btn sm" data-action="model-test" data-n="${m.n}">测试</button></td>
            </tr>`).join('')}
          </table>
        </div>
        <div class="sec-title"><span class="ico">${ic('shield', 14)}</span>沙箱与授权</div>
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
        <div class="sec-title"><span class="ico">${ic('at', 14)}</span>系统提示词库</div>
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
        <div class="sec-title"><span class="ico">${ic('settings', 14)}</span>桌面集成</div>
        <div class="desktop-grid">
          <div class="desktop-item"><div><div class="di-name">系统托盘</div><div class="di-desc">关闭窗口后继续运行</div></div><div class="switch on" data-action="todo"></div></div>
          <div class="desktop-item"><div><div class="di-name">全局快捷键</div><div class="di-desc mono">Ctrl+Shift+Space</div></div><div class="switch on" data-action="todo"></div></div>
          <div class="desktop-item"><div><div class="di-name">登录自启动</div><div class="di-desc">开机时启动 OrchDesk</div></div><div class="switch" data-action="todo"></div></div>
          <div class="desktop-item"><div><div class="di-name">自动更新</div><div class="di-desc">新版本静默下载</div></div><div class="switch on" data-action="todo"></div></div>
          <div class="desktop-item"><div><div class="di-name">悬浮窗</div><div class="di-desc">桌面浮动小窗</div></div><div class="switch" data-action="todo"></div></div>
          <div class="desktop-item"><div><div class="di-name">开机提醒</div><div class="di-desc">关键事件系统通知</div></div><div class="switch on" data-action="todo"></div></div>
        </div>
        <div class="sec-title"><span class="ico">${ic('folder', 14)}</span>数据目录</div>
        <div class="card">
          <div class="row"><span class="mono">%APPDATA%/OrchDesk</span><span class="faint">· 本地优先，数据不出本机</span></div>
          <div class="faint" style="margin-top:6px;font-size:11.5px">包含 sessions.db · memory · plugins · logs · 缓存</div>
          <div class="row" style="margin-top:8px"><button class="btn sm" data-action="todo">打开目录</button><button class="btn sm" data-action="snapshot-data">导出快照</button><button class="btn sm primary" data-action="check-updates">检查更新（先快照）</button></div>
        </div>
        <div class="sec-title"><span class="ico">${ic('at', 14)}</span>关于</div>
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
      ${EXPERTS.map((e, i) => `<div class="expert-opt ${state.wzExpert === i ? 'sel' : ''}" data-action="wz-expert" data-i="${i}"><div class="avatar" style="background:${i === 0 ? 'var(--ceo)' : 'var(--director)'}">${e[0]}</div><div><b>${e}</b><div class="faint">${i === 0 ? '主会话：理解/拆解/回收/沉淀' : '领域专家'}</div></div></div>`).join('')}` }
  ];
  function renderWizard() {
    $('#wzBody').innerHTML = WZ[state.wz].h;
    $('#wzNext').textContent = state.wz === 0 ? '下一步' : '进入会话';
  }

  /* ---------- 引擎 ---------- */
  function render() {
    renderRail();
    const v = VIEWS[state.page];
    $('#side').innerHTML = v.side();
    $('#main').innerHTML = v.main();
    $('#context').innerHTML = v.ctx();
    $('#appGrid').classList.toggle('has-ctx', state.ctxOpen);
    $('#winTitle').textContent = PAGES.find((x) => x.id === state.page).n + ' — 本地 Agent 工作台';
    const sc = $('#msgScroll'); if (sc) sc.scrollTop = sc.scrollHeight;
  }

  function toast(msg, type = '') {
    const t = document.createElement('div'); t.className = 'toast ' + type; t.textContent = msg;
    $('#toastRoot').appendChild(t); setTimeout(() => t.remove(), 3200);
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

  /* ---------- 会话操作（真实落盘，经桥） ---------- */
  function findProjectOf(sid) { return state.projects.find((p) => p.sessions.includes(sid)); }
  function touch(s) { s.updated = '刚刚'; }

  async function doNewConv() {
    const id = 's' + Date.now().toString(36);
    const s = { id, pid: 'p1', title: '新会话', expert: EXPERTS[state.wzExpert] || EXPERTS[0], model: state.selectedModels[0] || '—', updated: '刚刚', ts: nowTime(), msgs: [] };
    state.sessions[id] = s;
    const p1 = state.projects.find((p) => p.id === 'p1');
    if (p1 && !p1.sessions.includes(id)) p1.sessions.unshift(id);
    state.pExpanded.add('p1');
    state.sel = id;
    persist(); render();
    toast('已新建会话（已落盘）', 'ok');
  }

  async function doSend() {
    const c = $('#composer'); if (!c) return;
    const text = c.value.trim();
    if (!text) { toast('输入为空', 'warn'); return; }
    if (state.selectedModels.length === 0) { toast('请先选择至少一个模型', 'warn'); return; }
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
    const s = clone(src);
    s.id = id; s.title = name || ('分支-' + sid); s.pid = 'p1'; s.updated = '刚刚';
    state.sessions[id] = s;
    const p1 = state.projects.find((p) => p.id === 'p1');
    if (p1) p1.sessions.unshift(id);
    state.sel = id; persist(); render();
    toast('已创建分支（继承前缀事件，独立写入）', 'ok');
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
    p.archived = 1; p.open = 0; state.pExpanded.delete(pid);
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
        ${EXPERTS.map((e) => `<div class="row" style="padding:6px 8px;border:1px solid var(--border);border-radius:7px;margin-bottom:5px"><div style="flex:1"><b>${e}</b></div><button class="btn sm" data-action="expert-attach" data-n="${e}">@ 引用</button></div>`).join('')}
        <div class="sec-title" style="margin:10px 0 6px">专家团</div>
        ${TEAMS.map((t) => `<div class="row" style="padding:6px 8px;border:1px solid var(--border);border-radius:7px;margin-bottom:5px"><div style="flex:1"><b>${t.n}</b><div class="faint" style="font-size:11px">${t.m}</div></div><button class="btn sm primary" data-action="expert-attach" data-n="${t.n}">引用团</button></div>`).join('')}
      </div>
      <div class="mf"><button class="btn ghost" data-action="modal-cancel">关闭</button></div>`);
  }

  function openModelPicker() {
    const groups = {};
    MODELS.forEach((m) => { const p = m.p.split(' · ')[0]; if (!groups[p]) groups[p] = []; groups[p].push(m); });
    const html = Object.entries(groups).map(([provider, models]) => {
      const allSel = models.every((m) => state.selectedModels.includes(m.n));
      return `<div class="mg-grp">
        <div class="mg-h">${provider}<span class="mg-all" data-action="mg-toggle-all" data-p="${provider}">${allSel ? '取消全选' : '全选'}</span></div>
        ${models.map((m) => { const sel = state.selectedModels.includes(m.n);
          return `<div class="m-opt ${sel ? 'sel' : ''}" data-action="model-toggle" data-n="${m.n}">
            <div class="mo-cb"></div>
            <div class="mo-info"><div class="mo-name">${m.n}</div><div class="mo-meta">${m.p}</div></div>
            <div class="mo-state">${m.state === '已测' || m.state === '已就绪' ? '<span class="badge ok">' + m.state + '</span>' : '<span class="badge">' + m.state + '</span>'}</div>
          </div>`; }).join('')}
      </div>`;
    }).join('');
    openModal(`<div class="mh">${ic('bot', 18)}<b>选择模型</b></div>
      <div class="mb">
        <div class="faint" style="margin-bottom:10px">可选择一个或多个提供商的单个或多个模型；多选时按顺序调用（主模型 + 备用）。思维等级对所有选中模型生效。</div>
        ${html}
      </div>
      <div class="mf">
        <button class="btn ghost" data-action="model-clear">清空</button>
        <button class="btn primary" data-action="model-confirm">确认（${state.selectedModels.length} 个）</button>
      </div>`);
  }

  /* ---------- 交互 ---------- */
  document.body.addEventListener('click', async (e) => {
    const el = e.target.closest('[data-action]'); if (!el) return;
    const a = el.dataset.action, id = el.dataset.id;
    switch (a) {
      case 'nav': state.page = id; render(); break;
      case 'toggle-theme': { state.theme = state.theme === 'light' ? 'dark' : 'light'; document.documentElement.dataset.theme = state.theme; break; }
      case 'toggle-ctx': state.ctxOpen = !state.ctxOpen; render(); break;

      /* 会话 */
      case 'sel': state.sel = id; render(); break;
      case 'newconv': doNewConv(); break;
      case 'proj-toggle': { if (state.pExpanded.has(id)) state.pExpanded.delete(id); else state.pExpanded.add(id); render(); break; }
      case 'proj-menu': e.stopPropagation(); openMenu(el, [
        { id: 'open', label: '打开项目目录', svg: ic('folder', 14) },
        { sep: 1, label: '归档项目', svg: ic('archive', 14), danger: 1, id: 'archive' }]);
        document.querySelector('.pop [data-id="open"]').onclick = () => { toast('已打开项目目录（演示）', 'ok'); $('#menuRoot').innerHTML = ''; };
        document.querySelector('.pop [data-id="archive"]').onclick = () => { $('#menuRoot').innerHTML = ''; confirmArchiveProject(id); };
        break;
      case 'sess-menu': e.stopPropagation(); openMenu(el, [
        { id: 'copy', label: '复制会话 ID', svg: ic('copy', 14) },
        { id: 'rename', label: '重命名', svg: ic('edit', 14) },
        { sep: 1, id: 'fork', label: '创建分支', svg: ic('fork', 14) },
        { sep: 1, id: 'archive', label: '归档', svg: ic('archive', 14), danger: 1 }]);
        const pop = document.querySelector('.pop');
        pop.querySelector('[data-id="copy"]').onclick = () => { navigator.clipboard && navigator.clipboard.writeText(id).catch(() => {}); toast(`已复制 #${id}`, 'ok'); $('#menuRoot').innerHTML = ''; };
        pop.querySelector('[data-id="rename"]').onclick = () => { $('#menuRoot').innerHTML = ''; confirmRename(id); };
        pop.querySelector('[data-id="fork"]').onclick = () => { $('#menuRoot').innerHTML = ''; confirmNewBranch(id); };
        pop.querySelector('[data-id="archive"]').onclick = () => { $('#menuRoot').innerHTML = ''; doArchiveSession(id); };
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
      case 'trace': { state.feedback.add('s1|' + el.dataset.t); render(); toast('TRACE：反馈已脱敏并遥测至公开 GitHub 仓库', 'ok'); break; }

      /* 模型选择 + 思维等级 */
      case 'model-pick': openModelPicker(); break;
      case 'model-toggle': {
        const n = el.dataset.n; const idx = state.selectedModels.indexOf(n);
        if (idx >= 0) { state.selectedModels.splice(idx, 1); el.classList.remove('sel'); }
        else { state.selectedModels.push(n); el.classList.add('sel'); }
        const btn = document.querySelector('[data-action="model-confirm"]'); if (btn) btn.textContent = `确认（${state.selectedModels.length} 个）`;
        document.querySelectorAll('.mg-all').forEach((sp) => { const p = sp.dataset.p; const grp = MODELS.filter((m) => m.p.split(' · ')[0] === p); const allSel = grp.every((m) => state.selectedModels.includes(m.n)); sp.textContent = allSel ? '取消全选' : '全选'; });
        break;
      }
      case 'mg-toggle-all': {
        const p = el.dataset.p; const grp = MODELS.filter((m) => m.p.split(' · ')[0] === p);
        const allSel = grp.every((m) => state.selectedModels.includes(m.n));
        if (allSel) grp.forEach((m) => { const i = state.selectedModels.indexOf(m.n); if (i >= 0) state.selectedModels.splice(i, 1); });
        else grp.forEach((m) => { if (!state.selectedModels.includes(m.n)) state.selectedModels.push(m.n); });
        openModelPicker(); break;
      }
      case 'model-confirm': closeModal(); render(); break;
      case 'model-clear': state.selectedModels = []; openModelPicker(); break;

      /* 插件 */
      case 'pside-toggle': { if (state.plugSideExpanded.has(id)) state.plugSideExpanded.delete(id); else state.plugSideExpanded.add(id); render(); break; }
      case 'plug-toggle': { el.classList.toggle('on'); toast(el.classList.contains('on') ? `已启用 ${id}（注册为 effect）` : `已停用 ${id}（注册已回滚，无残留）`, el.classList.contains('on') ? 'ok' : 'warn'); break; }
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
      case 'model-test': { el.disabled = true; el.textContent = '测试中…'; setTimeout(() => { el.disabled = false; el.textContent = '测试'; toast(`${el.dataset.n} 连通正常`, 'ok'); }, 800); break; }
      case 'todo': toast('该操作在真实版本中打开对应面板'); break;

      /* T-P6-3 数据快照 + 更新检查 */
      case 'snapshot-data': { const r = await bridge.snapshotData(); toast(r && r.ok ? `数据快照已生成：${r.dir}` : `快照失败：${(r && r.reason) || ''}`, r && r.ok ? 'ok' : 'danger'); break; }
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
      case 'wz-next': if (state.wz === 0) { state.wz = 1; renderWizard(); } else { $('#wizard').classList.add('hidden'); state.page = 'session'; render(); toast(`已进入会话 · 默认专家：${EXPERTS[state.wzExpert]}`, 'ok'); } break;
      case 'wz-skip': $('#wizard').classList.add('hidden'); state.page = 'session'; render(); break;
      case 'wz-open': state.wz = 0; renderWizard(); $('#wizard').classList.remove('hidden'); break;
      case 'wz-expert': state.wzExpert = +el.dataset.i; renderWizard(); break;
    }
  });

  async function updateOutboundWarn(text) {
    const el = $('#outboundWarn'); if (!el) return;
    try {
      const w = await Promise.resolve(bridge.withhold(text || ''));
      if (w && w.needsConfirm) { el.hidden = false; el.textContent = w.warning || '⚠ 此操作不可撤销：发送前需二次确认'; }
      else { el.hidden = true; el.textContent = ''; }
    } catch { el.hidden = true; }
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

  /* ---------- 启动 ---------- */
  async function init() {
    try {
      const remote = await bridge.loadSessions();
      if (remote && remote.length) {
        state.sessions = {};
        remote.forEach((s) => { state.sessions[s.id] = s; });
        // 重建 projects.sessions 引用
        state.projects.forEach((p) => { p.sessions = remote.filter((s) => s.pid === p.id).map((s) => s.id); });
        if (!state.sessions[state.sel]) state.sel = remote[0].id;
      }
    } catch (err) { /* 回落种子数据 */ }
    // 授权初始化（T-P3-2）：拉取真实模式/分级/审计，并订阅审批弹窗请求。
    try {
      const mode = await bridge.getAuthMode();
      if (mode && mode.mode) state.authMode = mode.mode;
    } catch { /* 回落默认 default */ }
    try {
      const levels = await bridge.getAuthLevels();
      if (levels && levels.length) state.authLevels = levels;
    } catch { /* 分级留空，UI 显示加载中 */ }
    try {
      const audit = await bridge.getAuthAudit();
      if (audit) state.authAudit = audit;
    } catch { /* 审计留空 */ }
    // 订阅主进程转发的 dsh approval/request（L3/L4 操作弹窗，fail-closed）。
    if (bridge.onAuthRequest) {
      bridge.onAuthRequest((req) => { showApprovalModal(req); });
    }
    // 提示词库初始化（T-P4-3）：拉取真实提示词列表 + 合并冲突。
    try {
      const list = await bridge.listPrompts();
      if (Array.isArray(list)) state.promptDocs = list;
    } catch { /* 占位环境保留空列表 */ }
    try {
      const merged = await bridge.mergePrompts('main');
      if (merged && Array.isArray(merged.conflicts)) state.promptConflicts = merged.conflicts;
    } catch { /* 冲突留空 */ }
    // 记忆统计初始化（T-P4-1/2）：上下文占用 / 转储数 / 召回命中（占位环境回落静态值）。
    try {
      const ms = await bridge.getMemoryStats();
      if (ms) state.memoryStats = ms;
    } catch { /* 保留静态占位 */ }
    // 补偿层审计初始化（T-P5-1）：拉取补偿审计（占位环境回落空）。
    try {
      const ca = await bridge.getCompensationAudit();
      if (Array.isArray(ca)) state.compAudit = ca;
    } catch { /* 审计留空 */ }
    // 自进化临时插件初始化（T-P5-2）：拉取当前驻内存临时插件（重启即失）。
    try {
      const tp = await bridge.listTempPlugins();
      if (Array.isArray(tp)) state.tempPlugins = tp;
    } catch { /* 留空 */ }
    // T-P6-1 观雅集：拉取 TOKEN 状态 + 真实技能列表（无 token 回落静态样本）。
    try {
      const ts = await bridge.guanjiTokenStatus();
      state.guanjiTokenSet = !!(ts && ts.configured);
      const gl = await bridge.guanjiList();
      if (Array.isArray(gl) && gl.length) state.guanjiSkills = gl;
    } catch { /* 保留静态样本 */ }
    // T-P6-2 OrchClaw Hub：拉取配对状态。
    try {
      const hs = await bridge.hubStatus();
      if (hs) state.hubStatus = hs;
    } catch { /* 未配对 */ }
    render(); renderWizard();
  }
  setInterval(() => { const c = $('#clock'); if (c) c.textContent = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }); }, 1000);
  init();
})();
