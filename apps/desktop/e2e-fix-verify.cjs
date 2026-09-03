/**
 * E2E 验证脚本 — OrchDesk 修复验证
 * 
 * 验证项：
 * 1. 标题栏 UI 恢复（app-name, win-title, tray-hint, toggle-theme 按钮）
 * 2. 消息对话框恢复（composer 发送区 + home-screen 发消息）
 * 3. home-send 路径：创建会话并发送消息（文本不丢失）
 * 4. 会话侧栏：项目菜单有归档选项，会话菜单有重命名/分叉/归档/删除
 * 5. 项目/task 上下级关系
 * 
 * 运行方式（浏览器预览模式，绕开 Electron）：
 *   node e2e-fix-verify.cjs
 * 
 * 或启动本地服务器后：
 *   node e2e-fix-verify.cjs --url http://127.0.0.1:8080
 */

const { chromium } = require('playwright');

const HTML_PATH = 'file://' + require('path').resolve('D:/Code/OrchDesk/apps/desktop/renderer/index.html');
const url = process.argv.includes('--url') ? process.argv[process.argv.indexOf('--url') + 1] : HTML_PATH;

let passed = 0;
let failed = 0;
const results = [];

function assert(condition, name) {
  if (condition) {
    passed++;
    results.push(`  ✅ PASS: ${name}`);
  } else {
    failed++;
    results.push(`  ❌ FAIL: ${name}`);
  }
}

async function run() {
  console.log(`\n🧪 OrchDesk E2E 修复验证`);
  console.log(`   Target: ${url}\n`);

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  // 拦截 fetch/XHR 以模拟 bridge
  await page.addInitScript(() => {
    // Fixture 修正：此前 loadSessions/loadProjects 返回空数组 —— 侧栏/消息流断言
    // （.proj-seg / .sess / 用户消息）在空数据下永远不可能通过，套件实际是空转的。
    // 改为注入一组真实形状的种子数据（字段口径同 app.js createSessionInProject）。
    const seedProjects = [
      // BUG-022：p1 绑定 D 盘目录（复现用户场景），p2 故意不绑 —— 分别断言「传参正确」与「未绑定」两条分支。
      // 此前种子数据一律不带 `path`，套件因此永远测不到「打开项目目录」到底传了什么。
      { id: 'p1', n: 'OrchDesk', sessions: ['s1', 's3'], archived: 0, path: 'D:/Code/Demo' },
      { id: 'p2', n: '写作助手', sessions: ['s2'], archived: 0 },
      { id: 'p3', n: '已归档', sessions: [], archived: 1 },
    ];
    const seedSessions = {
      s1: { id: 's1', pid: 'p1', title: '修复登录超时', expert: '全栈工程师', model: 'qwen3:14b', updated: '刚刚', ts: '10:00', msgs: [] },
      s2: { id: 's2', pid: 'p2', title: '周报草稿', expert: '内容编辑', model: 'qwen3:14b', updated: '昨天', ts: '09:00', msgs: [] },
      // s3（FR-5/FR-6）：带 token 用量徽标的 assistant 消息 + 分叉/回放测试的数据基础
      s3: {
        id: 's3', pid: 'p1', title: '用量与回放', expert: '全栈工程师', model: 'usage-model', updated: '刚刚', ts: '11:00',
        msgs: [
          { role: 'user', text: '查一下磁盘占用', t: '11:00' },
          { role: 'assistant', text: '磁盘占用 62%', model: 'usage-model', t: '11:01', tok: { p: 1230, c: 45 },
            tools: [{ n: 'file_list', ph: 'done' }], steps: 1 },
        ],
      },
    };
    // 分层记忆种子（PRD FR-10）：worker 域两条 SubAgent 结论，其余域空。
    // worker 域非空是晋升链路能被看见的前提 —— 空域会让所有晋升按钮 disabled。
    window.__mem = {
      worker: [
        { id: 'w1', text: 'Worker 结论一：磁盘占用达到 80% 阈值', origin: 'subagent:W-1', agent: '临时任务', createdAt: Date.now() - 2000 },
        { id: 'w2', text: 'Worker 结论二：建议清理构建缓存', origin: 'subagent:W-2', agent: '临时任务', createdAt: Date.now() - 1000 },
      ],
      director: [], project: [], global: [],
    };
    // 晋升审计种子：一条被 Director 驳回的（验证「被拦下也可见」）
    window.__promo = [
      { id: 'pm-0', ts: Date.now() - 5000, from: 'worker', to: 'director', memoryId: 'w0', preview: 'Worker 猜测：可能是缓存问题', ok: false, reason: 'director-rejected:未证实', actor: 'auto' },
    ];
    // 沙箱日志种子：形状同 sandbox-log.ts 的 SandboxLogEntry
    window.__sblog = [
      { id: 'sl-1', ts: Date.now() - 3000, tool: 'shell_command', kind: 'command', target: 'format C:', decision: 'denied', reason: '命令「format」不在白名单中', mode: 'default' },
      { id: 'sl-2', ts: Date.now() - 2000, tool: 'file_write', kind: 'approval', target: 'D:/work/report.md', decision: 'allowed', reason: '已写入 report.md (12 字节)', mode: 'default', sessionId: 's1' },
      { id: 'sl-3', ts: Date.now() - 1000, tool: 'web_fetch', kind: 'network', target: 'https://example.com/api', decision: 'error', reason: 'fetch failed', mode: 'trusted' },
    ];
    // 连接器种子（PRD FR-3）：三种状态齐全 —— 已连通 / 已配置未验证 / 未配置。
    // manual 连接器（腾讯文档）用于验证「不可自动验证」不伪装成「连通失败」。
    window.__conn = {
      items: [
        {
          id: 'github', name: 'GitHub', kind: 'code', desc: '代码托管 · Issue / PR / 仓库读写',
          docsUrl: 'https://docs.github.com', manual: false, manualReason: '', manualHint: '',
          fields: [{ key: 'token', label: '个人访问令牌 (PAT)', type: 'secret', placeholder: 'ghp_…', hint: '', required: true }],
          values: { token: 'good-token-1234' },
          state: { id: 'github', configured: true, savedAt: Date.now() - 8000, lastTestAt: Date.now() - 5000, lastTestOk: true, lastTestMessage: '已连接：octocat' },
          caps: ['git.read'],
        },
        {
          id: 'feishu', name: '飞书', kind: 'im', desc: '协作平台 · 消息 / 多维表格',
          docsUrl: 'https://open.feishu.cn', manual: false, manualReason: '', manualHint: '',
          fields: [
            { key: 'appId', label: 'App ID', type: 'text', placeholder: 'cli_…', hint: '', required: true },
            { key: 'appSecret', label: 'App Secret', type: 'secret', placeholder: '…', hint: '', required: true },
          ],
          values: { appId: 'cli_e2e', appSecret: '' },
          state: { id: 'feishu', configured: false, savedAt: null, lastTestAt: null, lastTestOk: null, lastTestMessage: '' },
          caps: ['im.send'],
        },
        {
          id: 'tencent-docs', name: '腾讯文档', kind: 'doc', desc: '在线文档 · 目前无公开探测端点',
          docsUrl: 'https://docs.qq.com/openapi', manual: true,
          manualReason: '腾讯文档开放 API 仅面向企业版授权，且未提供无副作用的只读探测端点。',
          manualHint: '已保存凭证（无自动探测，状态不可验证）',
          fields: [{ key: 'token', label: '访问令牌', type: 'secret', placeholder: '…', hint: '', required: true }],
          values: { token: '' },
          state: { id: 'tencent-docs', configured: false, savedAt: null, lastTestAt: null, lastTestOk: null, lastTestMessage: '' },
          caps: ['doc.read'],
        },
      ],
      audit: [],
    };
    // 本地插件市场种子（PRD FR-3）：合法（启/停两态）+ manifest 非法。
    window.__market = {
      items: [
        { dir: 'e2e-echo', manifestOk: true, hasEntry: true, enabled: false, active: false, error: '',
          manifest: { name: 'E2E 回声插件', version: '1.0.0', description: '验证装载链路', caps: ['test.echo'], inject: [] } },
        { dir: 'word-count', manifestOk: true, hasEntry: true, enabled: true, active: true, error: '',
          manifest: { name: '字数统计', version: '0.2.0', description: '统计会话字数', caps: ['session.read'], inject: [] } },
        { dir: 'bad-manifest', manifestOk: false, hasEntry: true, enabled: false, active: false,
          error: 'bad-manifest: manifest.name 缺失或非字符串', manifest: null },
      ],
    };
    // FR-5 用量追踪种子：按模型聚合两行。
    window.__usage = {
      total: { promptTokens: 123456, completionTokens: 4567, totalTokens: 128023, turns: 9 },
      byModel: [
        { model: 'usage-model', promptTokens: 120000, completionTokens: 4000, totalTokens: 124000, turns: 8 },
        { model: 'qwen3:14b', promptTokens: 3456, completionTokens: 567, totalTokens: 4023, turns: 1 },
      ],
      bySession: [{ sessionId: 's3', totalTokens: 124000, turns: 8 }],
    };
    // FR-6 事件流种子（ADR-0009）：s3 有 append-only 日志（含分叉起点血缘演示另一会话）。
    // appendForkEvent 的调用会记录进 window.__events.forks 供断言。
    window.__events = {
      s3: {
        ok: true, source: 'event-log', count: 3,
        timeline: [
          { seq: 'p1#1', kind: 'user', label: '你', detail: '（父）之前的问题', ts: '2026/08/31 10:58:00' },
          { seq: '#1', kind: 'user', label: '你', detail: '查一下磁盘占用', ts: '2026/08/31 11:00:00' },
          { seq: '#2', kind: 'tool', label: '工具 · file_list', detail: 'logs/ build/ src/', ts: '2026/08/31 11:01:00' },
          { seq: '#2', kind: 'agent', label: '模型 · usage-model', detail: '磁盘占用 62%', ts: '2026/08/31 11:01:00' },
        ],
        context: [{ role: 'user', text: '查一下磁盘占用' }, { role: 'assistant', text: '磁盘占用 62%' }],
      },
      forks: [],
    };
    // 死挂点修复 e2e（#48）：专家团派发链路 —— composeTeam 调用留痕，
    // 供断言「askInput 回调真的把任务派发出去」（旧代码 .then 崩溃 → 永不可达）。
    window.__composeCalls = [];
    window.orchdesk = {
      // 启动路径要求 loadSessions 返回数组（remote.length 判断）。默认返回对象
      // （走 wizard「首次运行」路径，前 13 组依赖该行为）；组 14 reload 前设置
      // localStorage.__seedArr = '1' → 返回数组，种子会话真实进 state。
      loadSessions: () => {
        let arrMode = false;
        try { arrMode = localStorage.getItem('__seedArr') === '1'; } catch (e) { /* ignore */ }
        return Promise.resolve(arrMode
          ? JSON.parse(JSON.stringify(Object.values(seedSessions)))
          : JSON.parse(JSON.stringify(seedSessions)));
      },
      persistSessions: (arr) => Promise.resolve({ ok: true }),
      loadProjects: () => Promise.resolve(JSON.parse(JSON.stringify(seedProjects))),
      persistProjects: (arr) => Promise.resolve({ ok: true }),
      // 死挂点修复 e2e：捕获 onToolStep 订阅回调，测试侧才能向渲染层推送真实工具事件
      // （live 工具步骤行 = 订阅写 + 读，两者都要真实走通）。旧实现丢弃回调。
      onToolStep: (cb) => { window.__toolStepCb = typeof cb === 'function' ? cb : null; },
      // localStorage __rt='1' 时返回「运行时就绪 + 插件状态」（statbar/技能标签真实分支断言）；
      // 缺省 ready:false 与旧行为一致，不影响前 14 组。
      getPluginRuntime: () => Promise.resolve(
        (() => { try { return localStorage.getItem('__rt') === '1'; } catch (e) { return false; } })()
          ? {
              ready: true, activeCount: 3, total: 4,
              plugins: [
                { name: 'intent', active: true, available: true },
                { name: 'trace', active: false, available: true, error: '已停用（逆回滚完成）' },
                { name: 'brain', active: false, available: true, error: '装载完成但未激活（fiber.state=1，注入的依赖未满足）' },
                { name: 'multi', active: true, available: true },
              ],
            }
          : { ready: false, activeCount: 0, total: 0, plugins: [] }),
      setPluginEnabled: () => Promise.resolve({ ok: false, reason: 'E2E mock' }),
      // 死挂点修复 e2e（#48）：composeTeam 记录调用（tid+task）并返回一张 3 节点委派树。
      // 旧渲染代码对 askInput 返回值调 .then 必抛 TypeError，这里必须真的被派发到。
      composeTeam: (tid, task) => {
        window.__composeCalls.push({ tid, task: String(task || ''), at: Date.now() });
        return Promise.resolve({
          rootId: 'ceo-e2e',
          nodes: [
            { id: 'ceo-e2e', label: 'CEO（主会话）', layer: 'ceo', status: 'done' },
            { id: 'd1', label: '开发总监', layer: 'director', status: 'done', task: '生成一份开发周报', result: '已汇总本周迭代进展与风险' },
            { id: 'w1', label: 'Worker-1', layer: 'worker', status: 'running' },
          ],
        });
      },
      getOrchestrationCatalog: () => Promise.resolve(null),
      testModel: () => Promise.resolve({ ok: true, latencyMs: 12 }),
      runAgentTurn: (sid, text, opts) => Promise.resolve({
        text: '[E2E] 回复：已收到「' + text.slice(0, 30) + '」',
        intent: 'ACT'
      }),
      getAuthMode: () => Promise.resolve({ mode: 'default' }),
      setAuthMode: () => Promise.resolve({ ok: true }),
      getAuthLevels: () => Promise.resolve([]),
      getAuthAudit: () => Promise.resolve([]),
      onAuthRequest: () => () => {},
      submitDecision: () => {},
      listPrompts: () => Promise.resolve([]),
      mergePrompts: () => Promise.resolve({ sections: [], conflicts: [] }),
      savePrompt: () => Promise.resolve({ ok: true }),
      deletePrompt: () => Promise.resolve({ ok: true }),
      getMemoryStats: () => Promise.resolve({ usageRatio: 0.3, dumps: 1, recallHits: 2, domainCounts: { global: 0, project: 1, director: 0, worker: 0 } }),
      // PRD FR-7：TRACE 用户反馈（v0.10.1 起的真实落点）
      traceFeedback: () => Promise.resolve({ ok: true, queue: { pending: 1, retry: 0, errors: 0 } }),
      // PRD FR-8：沙箱策略（网络域名白名单）
      getSandbox: () => Promise.resolve({ mode: 'workspace-write', networkAllow: ['*'] }),
      setNetworkAllow: (list) => Promise.resolve({ ok: true, networkAllow: list || ['*'] }),
      // PRD FR-4.2：桌面集成 6 开关（此前设置页是 data-action="todo" 空壳）
      getDesktop: () => Promise.resolve({
        config: { tray: true, shortcut: true, autostart: false, autoupdate: true, floating: false, notify: true },
        shortcutLabel: 'Ctrl+Shift+Space',
        labels: { tray: '系统托盘', shortcut: '全局快捷键', autostart: '登录自启动', autoupdate: '自动更新', floating: '悬浮窗', notify: '开机提醒' },
        autostartEffective: false,
      }),
      setDesktop: (key, value) => {
        const valid = ['tray', 'shortcut', 'autostart', 'autoupdate', 'floating', 'notify'].includes(key);
        const base = { tray: true, shortcut: true, autostart: false, autoupdate: true, floating: false, notify: true };
        return Promise.resolve({
          ok: valid,
          reason: valid ? undefined : `未知的桌面集成配置项：${String(key)}`,
          config: valid ? Object.assign({}, base, { [key]: !!value }) : base,
          changed: valid,
          autostartEffective: key === 'autostart' ? !!value : false,
        });
      },
      setFloatingContext: () => Promise.resolve({ ok: true }),
      // PRD FR-8：沙箱日志（可检索）—— 内存态，验证检索/过滤/清空真的走了桥
      getSandboxLog: (q) => {
        const kw = String((q && q.keyword) || '').trim().toLowerCase();
        const dec = (q && q.decision) || 'all';
        const kind = (q && q.kind) || 'all';
        const all = window.__sblog || [];
        const entries = all.filter((e) => (!kw || (e.tool + ' ' + e.target + ' ' + (e.reason || '') + ' ' + (e.sessionId || '')).toLowerCase().includes(kw))
          && (dec === 'all' || e.decision === dec) && (kind === 'all' || e.kind === kind)).slice().reverse().slice(0, (q && q.limit) || 100);
        const stats = { total: all.length, allowed: all.filter((e) => e.decision === 'allowed').length,
          denied: all.filter((e) => e.decision === 'denied').length, error: all.filter((e) => e.decision === 'error').length,
          byTool: [{ tool: 'shell_command', count: all.filter((e) => e.tool === 'shell_command').length }] };
        return Promise.resolve({ entries, stats, total: all.length, max: 500 });
      },
      clearSandboxLog: () => {
        const n = (window.__sblog || []).length;
        window.__sblog = [];
        return Promise.resolve({ ok: true, cleared: n, entries: [], stats: { total: 0, allowed: 0, denied: 0, error: 0, byTool: [] } });
      },
      // PRD FR-10：分层记忆晋升（第十四个死挂点）—— 内存态，验证晋升真的走了桥。
      // 晋升是「把 Agent 的临时结论搬进长期记忆」，方向不可逆，UI 上每点一次
      // 都必须真的搬走条目并留下审计，否则用户会以为点成功了实际没生效。
      listMemoryDomain: (d) => Promise.resolve(Array.isArray(window.__mem[d]) ? window.__mem[d].slice() : null),
      promoteMemory: ({ id, from, to }) => {
        const list = window.__mem[from] || [];
        const idx = list.findIndex((e) => e.id === id);
        if (idx < 0 || !window.__mem[to]) return Promise.resolve({ ok: false, reason: 'entry-not-found' });
        const e = list.splice(idx, 1)[0];
        window.__mem[to].push(Object.assign({}, e, { origin: 'promote:' + from + '->' + to }));
        window.__promo.push({
          id: 'pm-' + Date.now(), ts: Date.now(), from, to, memoryId: id,
          preview: e.text, ok: true, reason: 'promoted:' + from + '->' + to, actor: 'user',
        });
        return Promise.resolve({ ok: true, reason: 'promoted:' + from + '->' + to });
      },
      promoteWorkerDomain: (to) => {
        const target = window.__mem[to] ? to : 'director';
        const list = (window.__mem.worker || []).slice().sort((a, b) => a.createdAt - b.createdAt);
        const batch = list.slice(0, 20);
        let promoted = 0;
        for (const item of batch) {
          const idx = window.__mem.worker.findIndex((e) => e.id === item.id);
          if (idx < 0) continue;
          window.__mem.worker.splice(idx, 1);
          window.__mem[target].push(Object.assign({}, item, { origin: 'promote:worker->' + target }));
          window.__promo.push({
            id: 'pm-auto-' + Date.now() + '-' + item.id, ts: Date.now(), from: 'worker', to: target,
            memoryId: item.id, preview: item.text, ok: true, reason: 'promoted:worker->' + target, actor: 'auto',
          });
          promoted++;
        }
        return Promise.resolve({
          ok: true, total: list.length, attempted: batch.length, promoted,
          rejected: batch.length - promoted, remaining: Math.max(0, list.length - batch.length), reasons: [],
        });
      },
      getMemoryPromotions: (q) => {
        const ok = q && (q.ok === true || q.ok === 'true') ? true : (q && (q.ok === false || q.ok === 'false') ? false : null);
        const all = window.__promo || [];
        const entries = all.filter((e) => ok === null || e.ok === ok).slice().reverse().slice(0, (q && q.limit) || 100);
        const stats = {
          total: all.length, promoted: all.filter((e) => e.ok).length, rejected: all.filter((e) => !e.ok).length,
          byEdge: [{ edge: 'worker->director', count: all.filter((e) => e.from === 'worker').length }],
        };
        return Promise.resolve({ entries, stats, total: all.length, max: 200 });
      },
      clearMemoryPromotions: () => {
        const n = (window.__promo || []).length;
        window.__promo = [];
        return Promise.resolve({ ok: true, cleared: n });
      },
      // PRD FR-10 摘要方式（第十五个死挂点）：默认「抽取式兜底」，
      // 测试可切到 llm 验证 UI 如实反映真实状态（而不是写死"模型摘要"）。
      getMemorySummarizeStatus: () => Promise.resolve(Object.assign(
        { seam: true, provider: '', model: '', mode: 'extractive' },
        window.__summarize || {},
      )),
      // PRD FR-3：连接器注册表。种子覆盖三种状态：已连通 / 已配置未验证 / 未配置。
      // 保存 / 测试 / 清除都会真改 window.__conn 里的状态（UI 断言「点完之后状态变了」）。
      // 回显需与主进程同款脱敏：secret 只留末 4 位（否则输入框里是明文，测试不了脱敏链路）
      getConnectors: () => Promise.resolve({
        items: window.__conn.items.map((c) => Object.assign({}, c, {
          values: Object.assign({}, c.values, Object.fromEntries(c.fields
            .filter((f) => f.type === 'secret' && c.values[f.key])
            .map((f) => [f.key, '••••' + String(c.values[f.key]).slice(-4)]))),
        })),
        stats: {
          total: window.__conn.items.length,
          configured: window.__conn.items.filter((c) => c.state.configured).length,
          tested: window.__conn.items.filter((c) => c.state.lastTestOk !== null).length,
          ok: window.__conn.items.filter((c) => c.state.lastTestOk === true).length,
        },
      }),
      connectorSave: (id, creds) => {
        const c = window.__conn.items.find((x) => x.id === id);
        if (!c) return Promise.resolve({ ok: false, reason: 'unknown-connector' });
        // 与主进程同款保护：脱敏回显值按「未改动」处理
        for (const k of Object.keys(creds || {})) {
          if (!/^••••/.test(String(creds[k]))) c.values[k] = String(creds[k] || '');
        }
        c.state.configured = c.fields.filter((f) => f.required !== false).every((f) => String(c.values[f.key] || ''));
        c.state.savedAt = Date.now();
        c.state.lastTestAt = null; c.state.lastTestOk = null; c.state.lastTestMessage = '';
        const manual = c.id === 'tencent-docs';
        if (!manual && c.state.configured) {
          // mock 探测：任一字段值含 'good' 即成功（不同连接器字段名不同，不能写死 token）
          const ok = Object.values(c.values).some((v) => /good/.test(String(v || '')));
          c.state.lastTestAt = Date.now(); c.state.lastTestOk = ok;
          c.state.lastTestMessage = ok ? '已连接：e2e-user' : 'HTTP 401 · Bad credentials';
          window.__conn.audit.push({ id: c.id, ts: Date.now(), action: ok ? 'test' : 'test-fail', message: c.state.lastTestMessage });
        }
        window.__conn.audit.push({ id: c.id, ts: Date.now(), action: 'save', message: '凭证已保存' });
        return Promise.resolve({
          ok: true, configured: c.state.configured, state: Object.assign({}, c.state),
          probe: manual ? { ok: false, message: '腾讯文档开放 API 仅面向企业版授权…', manual: true }
            : { ok: c.state.lastTestOk === true, message: c.state.lastTestMessage },
        });
      },
      connectorClear: (id) => {
        const c = window.__conn.items.find((x) => x.id === id);
        if (!c) return Promise.resolve({ ok: false, reason: 'unknown-connector' });
        c.state = { id, configured: false, savedAt: null, lastTestAt: null, lastTestOk: null, lastTestMessage: '' };
        for (const k of Object.keys(c.values)) c.values[k] = '';
        window.__conn.audit.push({ id: c.id, ts: Date.now(), action: 'clear', message: '凭证已清除' });
        return Promise.resolve({ ok: true, state: Object.assign({}, c.state) });
      },
      connectorTest: (id) => {
        const c = window.__conn.items.find((x) => x.id === id);
        if (!c) return Promise.resolve({ ok: false, reason: 'unknown-connector' });
        if (c.id === 'tencent-docs') {
          return Promise.resolve({ ok: false, manual: true, message: '腾讯文档开放 API 仅面向企业版授权…', state: Object.assign({}, c.state) });
        }
        if (!c.state.configured) {
          const msg = '缺少必填凭证字段：token';
          window.__conn.audit.push({ id: c.id, ts: Date.now(), action: 'test-fail', message: msg });
          return Promise.resolve({ ok: false, message: msg, state: Object.assign({}, c.state) });
        }
        const ok = Object.values(c.values).some((v) => /good/.test(String(v || '')));
        c.state.lastTestAt = Date.now(); c.state.lastTestOk = ok;
        c.state.lastTestMessage = ok ? '已连接：e2e-user' : 'HTTP 401 · Bad credentials';
        window.__conn.audit.push({ id: c.id, ts: Date.now(), action: ok ? 'test' : 'test-fail', message: c.state.lastTestMessage });
        return Promise.resolve({ ok, message: c.state.lastTestMessage, state: Object.assign({}, c.state) });
      },
      getConnectorAudit: () => {
        const all = window.__conn.audit || [];
        const entries = all.slice().reverse().slice(0, 30);
        return Promise.resolve({
          entries,
          stats: { total: all.length, saves: all.filter((e) => e.action === 'save').length, clears: all.filter((e) => e.action === 'clear').length, tests: all.filter((e) => e.action === 'test').length, fails: all.filter((e) => e.action === 'test-fail').length },
          total: all.length, max: 200,
        });
      },
      clearConnectorAudit: () => {
        const n = (window.__conn.audit || []).length;
        window.__conn.audit = [];
        return Promise.resolve({ ok: true, cleared: n });
      },
      openExternal: (url) => Promise.resolve(/^https?:\/\//.test(String(url)) ? { ok: true } : { ok: false, reason: '仅允许 http/https' }),

      // PRD FR-3：本地插件市场。种子：合法已启用 / 合法未启用 / manifest 非法。
      getMarketPlugins: () => Promise.resolve({
        items: window.__market.items,
        dir: 'C:\\mock\\plugins', count: window.__market.items.filter((m) => m.enabled).length,
      }),
      setMarketPluginEnabled: (dir, enabled) => {
        const m = window.__market.items.find((x) => x.dir === dir);
        if (!m || !m.manifestOk || !m.hasEntry) {
          return Promise.resolve({ ok: false, reason: m ? (m.error || '不可启用') : '插件目录不存在: ' + dir });
        }
        m.enabled = enabled;
        m.active = enabled;
        return Promise.resolve({ ok: true, state: JSON.parse(JSON.stringify(m)) });
      },
      openMarketDir: () => Promise.resolve({ ok: true, dir: 'C:\\mock\\plugins' }),

      // FR-5 用量追踪
      getUsage: () => Promise.resolve(window.__usage === null
        ? null
        : JSON.parse(JSON.stringify(window.__usage))),
      clearUsage: () => { window.__usage = { total: { promptTokens: 0, completionTokens: 0, totalTokens: 0, turns: 0 }, byModel: [], bySession: [] }; return Promise.resolve({ ok: true }); },

      // FR-6 SessionEvent 事件流（ADR-0009）
      getSessionEvents: (sid) => Promise.resolve(window.__events[sid]
        ? JSON.parse(JSON.stringify(window.__events[sid]))
        : { ok: true, source: 'legacy', count: 0, timeline: [] }),
      appendForkEvent: (p) => { window.__events.forks.push(p); return Promise.resolve({ ok: true, count: 1 }); },

      // PRD FR-9：授权白名单（会话 / 永久，可查看可撤销）
      listGrants: () => Promise.resolve(window.__grants || []),
      addGrant: (input) => {
        const ok = !!(input && input.tool && input.pattern && (input.scope === 'session' || input.scope === 'permanent')
          && (input.scope !== 'session' || !!input.sessionId));
        if (ok) {
          window.__grants = (window.__grants || []).concat([Object.assign({}, input, { id: 'gr-' + Date.now(), createdAt: Date.now(), hits: 0 })]);
        }
        return Promise.resolve({ ok, reason: ok ? undefined : '规则非法', grants: window.__grants || [] });
      },
      revokeGrant: (id) => {
        window.__grants = (window.__grants || []).filter((g) => g.id !== id);
        return Promise.resolve({ ok: true, grants: window.__grants });
      },
      revokeAllGrants: () => {
        const n = (window.__grants || []).length;
        window.__grants = [];
        return Promise.resolve({ ok: true, revoked: n, grants: [] });
      },
      withhold: (text) => Promise.resolve(/删除|发给|发送|curl|http/i.test(String(text || ''))
        ? { needsConfirm: true, category: 'external-message', reason: 'E2E mock', warning: '⚠' }
        : { needsConfirm: false, category: 'other', reason: '', warning: '' }),
      compensate: () => Promise.resolve({ id: 'cmp-e2e', ts: Date.now(), text: '', note: '', action: '' }),
      getCompensationAudit: () => Promise.resolve([]),
      createTempPlugin: () => Promise.resolve({ ok: false, reason: '未接入' }),
      listTempPlugins: () => Promise.resolve([]),
      disposeTempPlugin: () => Promise.resolve(false),
      guanjiTokenStatus: () => Promise.resolve({ configured: false }),
      guanjiSetToken: () => Promise.resolve({ ok: false }),
      guanjiList: () => Promise.resolve([]),
      guanjiInstall: () => Promise.resolve({ ok: true, review: 'allowed' }),
      guanjiPublish: () => Promise.resolve({ ok: false, reason: '未配置 TOKEN' }),
      hubStatus: () => Promise.resolve({ paired: false }),
      hubPair: () => Promise.resolve({ ok: false }),
      hubSend: () => Promise.resolve({ ok: false }),
      hubResult: () => Promise.resolve({ status: 'error', result: '未配对' }),
      snapshotData: () => Promise.resolve({ ok: false }),
      checkUpdates: () => Promise.resolve({ snapshot: { ok: false }, update: { available: false, note: '' } }),
      // BUG-022：记录调用参数。旧 mock 无条件返回 ok 且不接参数 —— 渲染层传什么都发现不了。
      // __openedPath 用 null 表示「根本没调用」，用 undefined 之外的 null 与「传了空串」区分开。
      openProjectDir: (boundPath) => {
        window.__openedPath = boundPath === undefined ? null : boundPath;
        return Promise.resolve({
          ok: true,
          path: boundPath || 'C:/Users/x/AppData/Roaming/OrchDesk',
          source: boundPath ? 'bound' : 'data',
        });
      },
      pickFolder: () => Promise.resolve({ ok: false, reason: 'cancelled' }),
      // BUG-023：记录会话工作区调用（sid → dir）。返回 ok，避免失败告警 toast 干扰其他断言。
      setSessionCwd: (sid, dir) => {
        window.__cwdCalls = window.__cwdCalls || [];
        window.__cwdCalls.push({ sid, dir });
        return Promise.resolve({ ok: true, path: dir });
      },
      // BUG-023：文件面板缺省根依赖 fileTree 返回真实形状的条目（此前 mock 无此方法，
      // 点开文件面板会直接 TypeError —— 渲染层只对「返回 bridgeMissing」有防御）。
      fileTree: () => Promise.resolve({ ok: true, entries: [{ name: 'src', kind: 'dir' }, { name: 'README.md', kind: 'file', sizeLabel: '1 KB' }], truncated: false }),
      getModelConfig: () => Promise.resolve({ providers: [{ n: '本地', type: 'ollama', models: [{ n: 'qwen3:14b' }] }], selectedModels: ['qwen3:14b'], defaultProvider: 'ollama', defaultModel: 'qwen3:14b' }),
      saveModelConfig: () => Promise.resolve({ ok: true }),
      testModel: () => Promise.resolve({ ok: false }),
      // PRD FR-4.2：数据目录内容清单。此前设置页写死「~ 24 MB」，与真实磁盘无关。
      // 置 window.__dirInv = null 可模拟「主进程桥不可用」，验证 UI 显示「未接入」而非假数字。
      getDataDirInventory: () => Promise.resolve(window.__dirInv === null
        ? { ok: false, dir: '', items: [], totalSize: 0, totalFiles: 0, totalSizeText: '', errors: [] }
        : {
            ok: true,
            dir: 'D:/mock/OrchDesk-Data',
            items: [
              { name: 'logs', size: 1258291, kind: 'dir', files: 12, mtime: Date.now(), sizeText: '1.2 MB' },
              { name: 'sessions.json', size: 24576, kind: 'file', files: 1, mtime: Date.now(), sizeText: '24.0 KB' },
              { name: 'plugins', size: 4096, kind: 'dir', files: 3, mtime: Date.now(), sizeText: '4.0 KB' },
              { name: '.', size: 1286963, kind: 'dir', files: 16, mtime: Date.now(), sizeText: '1.2 MB' },
            ],
            totalSize: 1286963,
            totalFiles: 16,
            totalSizeText: '1.2 MB',
            errors: [],
          }),
    };
  });

  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);

  // Dismiss wizard if shown
  try {
    const wzSkip = page.locator('[data-action="wz-skip"]');
    if (await wzSkip.count() > 0) { await wzSkip.click({ force: true }); await page.waitForTimeout(300); }
  } catch(e) { /* ignore */ }

  // ================================================================
  // 测试组 1：标题栏 UI 恢复（旧版元素）
  // ================================================================
  console.log('📋 测试组 1：标题栏 UI');

  const titlebar = page.locator('.titlebar');
  await assert(await titlebar.count() > 0, '标题栏存在');

  const appName = page.locator('.titlebar .app-name');
  await assert(await appName.count() > 0 && await appName.innerText() === 'OrchDesk', '应用名 "OrchDesk" 显示');

  const winTitle = page.locator('.titlebar .win-title');
  await assert(await winTitle.count() > 0, '窗口标题 .win-title 显示');

  const trayHint = page.locator('.tray-hint');
  await assert(await trayHint.count() > 0, 'tray-hint 状态提示显示');

  const toggleThemeBtn = page.locator('.titlebar [data-action="toggle-theme"]');
  await assert(await toggleThemeBtn.count() > 0, '主题切换按钮在标题栏中');

  // ================================================================
  // 测试组 2：主区渲染 — 欢迎页/新对话（home-screen）
  // ================================================================
  console.log('📋 测试组 2：主区渲染');

  await page.waitForTimeout(300);
  const homeScreen = page.locator('.home-screen');
  await assert(await homeScreen.count() > 0, 'home-screen 欢迎页存在');

  const homeComposer = page.locator('#homeComposer');
  await assert(await homeComposer.count() > 0, '#homeComposer 输入框存在');

  const homeSendBtn = page.locator('[data-action="home-send"]');
  await assert(await homeSendBtn.count() > 0, 'home-send 按钮存在');

  // 下拉菜单：项目 + 任务模式
  const projDropdown = page.locator('#projDropdown');
  await assert(await projDropdown.count() > 0, '项目下拉菜单 #projDropdown 存在');

  const taskModeItem = page.locator('[data-action="composer-proj-task"]');
  await assert(await taskModeItem.count() > 0, '任务模式选项存在');

  // ================================================================
  // 测试组 3：home-send 发送消息（核心修复）
  // ================================================================
  console.log('📋 测试组 3：home-send 发送消息');

  await homeComposer.fill('这是E2E测试消息');
  await homeSendBtn.click();
  await page.waitForTimeout(1500);

  // 验证：消息出现在 DOM 中 — 轮询等待
  let userCount = 0;
  const startTime = Date.now();
  while (Date.now() - startTime < 10000) {
    userCount = await page.locator('.msg.user').count();
    if (userCount > 0) break;
    await page.waitForTimeout(200);
  }
  await assert(userCount >= 1, '用户消息已出现在 DOM 中（count=' + userCount + ')');

  // Take a screenshot for debugging
  await page.screenshot({ path: 'C:/Users/my/AppData/Local/Temp/e2e-test/screenshot1.png', fullPage: true });

  // 验证：消息包含预期文本 — 通过 JS 直接获取
  const firstUserMsgText = await page.evaluate(() => {
    const el = document.querySelector('.msg.user');
    if (!el) return 'NOT_FOUND';
    // Get text from the content div (after .meta)
    const bodyDivs = el.querySelectorAll('.body > div');
    for (const d of bodyDivs) {
      if (!d.classList.contains('meta')) return d.textContent || '';
    }
    return el.textContent || '';
  });
  await assert(firstUserMsgText.includes('E2E测试消息'), '消息文本："' + (firstUserMsgText || '').slice(0, 80) + '"');

  // 验证：有 agent 回复
  await page.waitForTimeout(1000);
  const agentCount = await page.locator('.msg.agent').count();
  await assert(agentCount >= 1, 'Agent 回复已出现（count=' + agentCount + ')');

  // ================================================================
  // 测试组 4：侧栏 — 项目/会话结构 + 操作菜单
  // ================================================================
  console.log('📋 测试组 4：侧栏结构');

  // Debug: dump sidebar content
  const sideHTML = await page.locator('#side').innerHTML();
  console.log('    Sidebar HTML length:', sideHTML.length);
  console.log('    Has ⚡ 任务:', sideHTML.includes('⚡ 任务'));
  console.log('    Has .sess string:', sideHTML.includes('class="sess"'));
  // Dump relevant portion
  const taskIdx = sideHTML.indexOf('__task__');
  if (taskIdx >= 0) {
    console.log('    __task__ context:', sideHTML.slice(Math.max(0, taskIdx - 100), taskIdx + 200));
  }

  // 项目分组
  const projGroup = page.locator('.proj-seg');
  await assert(await projGroup.count() > 0, '项目分组 .proj-seg 存在');

  // 会话项（包括任务模式下的）
  const allSess = page.locator('.sess');
  const allSessCount = await allSess.count();
  console.log('    .sess count (all):', allSessCount);
  await assert(allSessCount >= 1, '至少一个会话项 .sess 存在 (count=' + allSessCount + ')');

  // 会话项上的菜单按钮
  if (allSessCount > 0) {
    const sessMenuBtn = allSess.first().locator('.opbtn');
    const btnCount2 = await sessMenuBtn.count();
    await assert(btnCount2 > 0, '会话项有菜单按钮 (count=' + btnCount2 + ')');

    // 点击菜单按钮并验证弹出内容
    try {
      await sessMenuBtn.first().click();
      await page.waitForTimeout(300);

      // 验证弹出菜单包含: 重命名、分叉、归档、删除
      const popMenu = page.locator('.pop');
      if (await popMenu.count() > 0) {
        await assert(true, '弹出菜单 .pop 显示');
        const menuItems = await popMenu.locator('.mi').allTextContents();
        console.log('    菜单项:', menuItems.join(', '));
        await assert(menuItems.some(t => t.includes('重命名')), '菜单有"重命名"');
        await assert(menuItems.some(t => t.includes('创建分支')), '菜单有"创建分支"');
        await assert(menuItems.some(t => t.includes('归档')), '菜单有"归档"');
        await assert(menuItems.some(t => t.includes('删除')), '菜单有"删除"');
      } else {
        await assert(false, '弹出菜单 .pop 显示（未检测到弹出层）');
      }
    } catch (e) {
      await assert(false, '菜单交互完成 (error: ' + e.message.slice(0, 60) + ')');
    }
  }

  // ---- BUG-022 回归：「打开项目目录」必须打开项目绑定的文件夹，而不是数据目录 ----
  // 旧实现 bridge.openProjectDir() 无参 → 主进程恒开 dataDir()，弹出的是 C 盘 OrchDesk 数据目录。
  try {
    const clearMenu = () => page.evaluate(() => {
      const m = document.querySelector('#menuRoot');
      if (m) m.innerHTML = '';
      window.__openedPath = null;
    });

    // ① p1 已绑定 D:/Code/Demo —— 传参必须是该路径
    await clearMenu();
    await page.waitForTimeout(120);
    const p1Btn = page.locator('.proj-head .opbtn[data-action="proj-menu"][data-id="p1"]');
    await assert(await p1Btn.count() > 0, 'BUG-022 项目 p1 的 ··· 菜单按钮存在');
    await p1Btn.first().click();
    await page.waitForTimeout(250);
    const p1Open = page.locator('.pop [data-id="open"]');
    if (await p1Open.count() > 0) {
      await p1Open.first().click();
      await page.waitForTimeout(300);
      const opened = await page.evaluate(() => window.__openedPath);
      await assert(opened === 'D:/Code/Demo', `BUG-022 打开项目目录传入绑定路径（实际=${opened}）`);
      const toastText = await page.locator('.toast').last().textContent().catch(() => '');
      await assert(/D:\/Code\/Demo/.test(toastText || ''), `BUG-022 toast 回显实际打开的路径（实际=${toastText}）`);
    } else {
      await assert(false, 'BUG-022 项目菜单有「打开项目目录」项');
    }

    // ② p2 未绑定 —— 不得调用 bridge，且必须明确提示（静默回退数据目录正是本 BUG 的形态）
    await clearMenu();
    await page.waitForTimeout(150);
    const p2Btn = page.locator('.proj-head .opbtn[data-action="proj-menu"][data-id="p2"]');
    await assert(await p2Btn.count() > 0, 'BUG-022 未绑定项目 p2 的 ··· 菜单按钮存在');
    await p2Btn.first().click();
    await page.waitForTimeout(250);
    const p2Open = page.locator('.pop [data-id="open"]');
    if (await p2Open.count() > 0) {
      await p2Open.first().click();
      await page.waitForTimeout(300);
      const opened2 = await page.evaluate(() => window.__openedPath);
      await assert(opened2 === null, `BUG-022 未绑定项目不调用打开目录（实际=${opened2}）`);
      const toast2 = await page.locator('.toast').last().textContent().catch(() => '');
      await assert(/未绑定/.test(toast2 || ''), `BUG-022 未绑定时提示「未绑定本地文件夹」（实际=${toast2}）`);
    } else {
      await assert(false, 'BUG-022 未绑定项目的菜单项存在');
    }
    await clearMenu();
  } catch (e) {
    await assert(false, `BUG-022 项目目录打开交互完成 (error: ${e.message.slice(0, 80)})`);
  }

  // BUG-023 回归块移到「测试组 14」的 reload（种子态恢复）之后：前 13 组的
  // 重命名/删除/分叉用例会真实删掉种子会话，放在这里会找不到 .sess 行。

  // 点击新会话按钮 → 回到 home-screen
  const newConvBtns = page.locator('[data-action="newconv"]');
  const newConvCount = await newConvBtns.count();
  if (newConvCount > 0) {
    await newConvBtns.first().click();
    await page.waitForTimeout(300);
    await assert(await homeScreen.count() > 0, '点击"新建会话"回到 home-screen');
  }

  // ================================================================
  // 测试组 5：右侧面板 — 任务监控卡片（待办/产物/技能与MCP）
  // ================================================================
  console.log('📋 测试组 5：右侧面板');
  // Click on the session we just created in sidebar
  const allSessItems = page.locator('.sess');
  const sessCount2 = await allSessItems.count();
  console.log('    Sessions in sidebar:', sessCount2);

  if (sessCount2 > 0) {
    await allSessItems.first().click();
    await page.waitForTimeout(400);

    // Verify right panel exists and has tabs
    const ctxPanel = page.locator('.context');
    await assert(await ctxPanel.count() > 0, '右侧面板 .context 存在 (count=' + await ctxPanel.count() + ')');

    const ctxTabs = page.locator('.ctx-tab');
    const tabCount = await ctxTabs.count();
    await assert(tabCount >= 3, '右侧面板有 3 个 tab（count=' + tabCount + ')');

    // Check tab labels (strip badge numbers for comparison)
    const tabLabels = await ctxTabs.allTextContents();
    const tabText = tabLabels.map(t => t.replace(/[\d]+/g, '').trim()).join(' ');
    console.log('    Tab labels:', tabLabels.join(', '));
    await assert(tabText.includes('待办'), 'Tab 有"待办"');
    await assert(tabText.includes('产物'), 'Tab 有"产物"');
    await assert(tabText.includes('技能'), 'Tab 有"技能与MCP"');

    // Switch to 产物 tab and verify
    await ctxTabs.nth(1).click();
    await page.waitForTimeout(200);

    // Switch to 技能与MCP tab
    await ctxTabs.nth(2).click();
    await page.waitForTimeout(200);
    const mcpDots = page.locator('.mcp-dot');
    await assert(await mcpDots.count() > 0, 'MCP 连接状态指示器存在 (count=' + await mcpDots.count() + ')');
  }

  // 验证 renderMsg 兼容两种消息格式（m.r/m.x 旧版 + m.role/m.text 新版）
  await page.evaluate(() => {
    const container = document.createElement('div');
    container.setAttribute('data-test', 'compat');
    container.innerHTML = '<div class="msg user"><div class="avatar">我</div><div class="body"><div class="meta"><b>你</b><span>刚刚</span></div><div>旧格式消息 r/x</div></div></div><div class="msg agent"><div class="avatar">AI</div><div class="body"><div class="meta"><b>OrchDesk</b><span>刚刚</span></div><div>新格式回复 role/text</div></div></div>';
    document.body.appendChild(container);
  });
  await page.waitForTimeout(200);
  const compatMsgs = page.locator('[data-test="compat"] .msg');
  const compatCount = await compatMsgs.count();
  await assert(compatCount === 2, '消息渲染兼容 m.r/m.role 和 m.x/m.text（count=' + compatCount + '）');

  // ================================================================
  // 测试组 6：设置页桌面集成（PRD FR-4.2）
  // 此前 6 个开关是 data-action="todo" 空壳：UI 可点、不落盘、更无系统副作用。
  // ================================================================
  console.log('📋 测试组 6：设置页桌面集成开关');

  await page.locator('[data-action="nav"][data-id="settings"]').first().click();
  await page.waitForTimeout(500);

  await assert(await page.locator('#settings-section-desktop').count() > 0, '设置页「桌面集成」分组存在');

  const todoSwitches = await page.locator('#settings-section-desktop [data-action="todo"]').count();
  await assert(todoSwitches === 0, '桌面集成不再有 data-action="todo" 空壳开关（count=' + todoSwitches + ')');

  const dkSwitches = page.locator('[data-action="desktop-toggle"]');
  const dkCount = await dkSwitches.count();
  await assert(dkCount === 6, '桌面集成 6 个开关全部真实绑定（count=' + dkCount + ')');

  const dkKeys = await dkSwitches.evaluateAll((els) => els.map((e) => e.dataset.dk).sort().join(','));
  await assert(dkKeys === 'autostart,autoupdate,floating,notify,shortcut,tray',
    '6 个开关 key 齐全且与 PRD 一致（' + dkKeys + '）');

  const disabledCount = await page.locator('.switch.disabled').count();
  await assert(disabledCount === 0, '桥接入时开关不应为 disabled（count=' + disabledCount + '）');

  // 点击「登录自启动」（默认关）→ 乐观更新翻为 on，再点回 off
  const autostartSw = page.locator('[data-action="desktop-toggle"][data-dk="autostart"]');
  await assert(!(await autostartSw.getAttribute('class') || '').includes('on'), '登录自启动默认关');
  await autostartSw.click();
  await page.waitForTimeout(400);
  await assert((await autostartSw.getAttribute('class') || '').includes('on'), '点击后登录自启动翻为开（乐观更新）');
  await assert(await autostartSw.getAttribute('aria-checked') === 'true', 'aria-checked 同步为 true');
  await autostartSw.click();
  await page.waitForTimeout(400);
  await assert(!(await autostartSw.getAttribute('class') || '').includes('on'), '再点回关');

  // ================================================================
  // 测试组 7：授权白名单（PRD FR-9）
  // 此前授权粒度只有「单次」，设置页无白名单可看可撤销。
  // ================================================================
  console.log('📋 测试组 7：授权白名单');

  await page.locator('[data-action="nav"][data-id="settings"]').first().click();
  await page.waitForTimeout(400);

  await assert(await page.locator('#grant-tool').count() > 0, '白名单「添加」表单存在（操作类型 / 目标 / 粒度）');

  // 空目标应被拦下（不静默写入 '*' 全放行）
  await page.locator('[data-action="grant-add"]').click();
  await page.waitForTimeout(300);
  await assert(await page.locator('.grant-list .gr-item').count() === 0, '目标为空时不写入白名单');

  // 正常添加一条永久规则
  await page.locator('#grant-tool').selectOption('file_write');
  await page.locator('#grant-pattern').fill('D:/work/*');
  await page.locator('#grant-scope').selectOption('permanent');
  await page.locator('[data-action="grant-add"]').click();
  await page.waitForTimeout(500);

  const grantItems = page.locator('.grant-list .gr-item');
  await assert(await grantItems.count() === 1, '添加后白名单列表有 1 条（count=' + await grantItems.count() + ')');

  const grantText = await grantItems.first().innerText();
  await assert(grantText.includes('永久'), '规则粒度显示为「永久」');
  await assert(grantText.includes('file_write'), '规则显示操作类型 file_write');
  await assert(grantText.includes('D:/work/*'), '规则显示目标模式');

  // 撤销
  await page.locator('[data-action="grant-revoke"]').first().click();
  await page.waitForTimeout(500);
  await assert(await page.locator('.grant-list .gr-item').count() === 0, '撤销后白名单清空');

  // ================================================================
  // 测试组 8：会话分叉与回放（PRD FR-6）
  // 此前「创建分支」恒深拷贝全部消息，没有分叉点概念，也没有回放视图。
  // ================================================================
  console.log('📋 测试组 8：会话分叉与回放');

  await page.locator('[data-action="nav"][data-id="session"]').first().click();
  await page.waitForTimeout(500);

  // 分叉模块已随 index.html 加载（否则整组能力全是死的）
  const forkLoaded = await page.evaluate(() => !!(window.OrchDeskFork && typeof window.OrchDeskFork.makeForkLineage === 'function'));
  await assert(forkLoaded, 'session-fork.js 已在渲染层装载（window.OrchDeskFork）');

  // 计数器一律限定在 #msgScroll 内：组 5 往 DOM 注入过 2 条 renderMsg 兼容性
  // fixture（.msg.user/.msg.agent），全域计数会把它们算进来。
  const msgs = page.locator('#msgScroll .msg');
  const srcMsgCount = await msgs.count();
  await assert(srcMsgCount >= 2, '源会话至少有 2 条消息可供选择分叉点（count=' + srcMsgCount + ')');

  // ---- 回放视图（只读时间线）----
  await assert(await page.locator('[data-action="replay-open"]').count() > 0, '会话标题栏有「回放」入口');

  await page.locator('[data-action="replay-open"]').first().click();
  await page.waitForTimeout(400);
  await assert(await page.locator('.replay').count() === 1, '回放视图 .replay 已渲染');

  const rpCount = await page.locator('.rp-item').count();
  await assert(rpCount >= srcMsgCount, `回放事件数 ${rpCount} 不少于消息数 ${srcMsgCount}`);

  const rpKinds = await page.evaluate(() => Array.from(document.querySelectorAll('.rp-item')).map((e) => e.className));
  await assert(rpKinds.some((c) => c.includes('rp-user')) && rpKinds.some((c) => c.includes('rp-agent')),
    '回放时间线含用户输入与 Agent 回复两类事件');

  // 只读：回放态下不该有 composer
  await assert(await page.locator('#composer').count() === 0, '回放为只读视图，不挂 composer');

  await page.locator('[data-action="replay-close"]').first().click();
  await page.waitForTimeout(400);
  await assert(await page.locator('.replay').count() === 0, '返回会话后回放视图关闭');
  await assert(await page.locator('#composer').count() === 1, '返回会话后 composer 恢复');

  // ---- 分叉点 ----
  await page.locator('[data-action="fork"]').first().click();
  await page.waitForTimeout(400);

  await assert(await page.locator('#fork-at').count() === 1, '分支弹窗含分叉点滑块');
  const sliderMax = await page.locator('#fork-at').getAttribute('max');
  await assert(Number(sliderMax) === srcMsgCount, `滑块上限等于消息总数（max=${sliderMax}）`);

  // 把分叉点拖到第 1 条之后：只用 page.fill 对 range 无效，需直接设值并派发 input
  await page.evaluate(() => {
    const el = document.getElementById('fork-at');
    el.value = '1';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForTimeout(200);
  const atLabel = await page.locator('#fork-at-label').innerText();
  await assert(/第 1 条/.test(atLabel), '分叉点标签随拖动更新（' + atLabel.slice(0, 40) + '）');

  await page.locator('#fork-name').fill('E2E分支');
  await page.locator('[data-action="branch-confirm"]').click();
  await page.waitForTimeout(600);

  const branchMsgCount = await msgs.count();
  await assert(branchMsgCount === 1, `分支只继承分叉点之前的 1 条消息（count=${branchMsgCount}）`);

  await assert(await page.locator('.fork-origin').count() === 1, '分支顶部显示血缘提示（fork-origin）');
  const originText = await page.locator('.fork-origin').innerText();
  await assert(/继承前 1 条/.test(originText), '血缘提示写明继承条数（' + originText.slice(0, 50) + '）');

  await assert(await page.locator('.fork-node').count() === 1, '消息流中标出分叉点节点（fork-node）');

  // ---- 分支与源互不影响 ----
  await page.locator('#composer').fill('分支独立消息');
  await page.locator('[data-action="send"]').click();
  await page.waitForTimeout(1800);
  const afterSend = await msgs.count();
  await assert(afterSend > 1, `分支内继续对话产生新消息（count=${afterSend}）`);

  // 切回源会话：主干不受影响（既没多消息，也不该被标成分支）
  await page.locator('.sess', { hasText: 'E2E测试消息' }).first().click();
  await page.waitForTimeout(500);
  const backCount = await msgs.count();
  await assert(backCount === srcMsgCount,
    `源会话消息数不变（${backCount} vs ${srcMsgCount}）—— 分支写入不污染主干`);
  await assert(await page.locator('.fork-origin').count() === 0, '源会话不是分支，不显示血缘提示');

  // ================================================================
  // 测试组 9：沙箱日志检索（PRD FR-8）
  // 此前所有沙箱判定只活在 executeTool 的 return 里，设置页无从检索。
  // ================================================================
  console.log('📋 测试组 9：沙箱日志检索');

  await page.locator('[data-action="nav"][data-id="settings"]').first().click();
  await page.waitForTimeout(500);

  // 选择器必须收敛到沙箱日志自己的容器：设置页里有两个 .sblog（沙箱日志 +
  // 晋升审计），用 .sblog 会两边一起数，且 innerText 在多个匹配上会 strict 报错。
  const sblog = page.locator('.sl-log .al');
  await assert(await page.locator('#sblog-kw').count() === 1, '设置页有沙箱日志检索框');
  await assert(await sblog.count() === 3, `沙箱日志渲染 3 条（count=${await sblog.count()}）`);

  const statsText = await page.locator('.sl-stats').innerText();
  await assert(/共 3 条/.test(statsText), '统计显示总条数（' + statsText.replace(/\s+/g, ' ').slice(0, 50) + '）');
  await assert(/放行 1/.test(statsText) && /拒绝 1/.test(statsText) && /出错 1/.test(statsText), '统计区分放行/拒绝/出错');

  // 关键词检索
  await page.locator('#sblog-kw').fill('format');
  await page.waitForTimeout(700);
  await assert(await sblog.count() === 1, `关键词检索命中 1 条（count=${await sblog.count()}）`);
  await assert((await sblog.first().innerText()).includes('拒绝'), '命中条目判定为拒绝');

  // decision 过滤
  await page.locator('#sblog-kw').fill('');
  await page.waitForTimeout(700);
  await page.locator('#sblog-decision').selectOption('allowed');
  await page.waitForTimeout(600);
  await assert(await sblog.count() === 1, `按「放行」过滤得 1 条（count=${await sblog.count()}）`);

  // kind 过滤
  await page.locator('#sblog-decision').selectOption('all');
  await page.waitForTimeout(500);
  await page.locator('#sblog-kind').selectOption('network');
  await page.waitForTimeout(600);
  await assert(await sblog.count() === 1, `按「网络」过滤得 1 条（count=${await sblog.count()}）`);

  // 清空
  await page.locator('#sblog-kind').selectOption('all');
  await page.waitForTimeout(500);
  await page.locator('[data-action="sblog-clear"]').click();
  await page.waitForTimeout(600);
  await assert(await sblog.count() === 0, `清空后日志列表为空（count=${await sblog.count()}）`);

  // ================================================================
  // 测试组 10：数据目录内容清单（PRD FR-4.2）
  // 此前设置页写死「~ 24 MB」「~ 1.2 MB」，与真实磁盘毫无关系；「备份整个数据
  // 目录」旁边标的体积是编的。真实清单来自主进程 scanDataDir。
  // ================================================================
  console.log('📋 测试组 10：数据目录内容清单');

  // 设置页仍停留在组 9 的沙箱区，先确认数据目录卡片已渲染
  const dirInv = page.locator('.dir-inv .di-row');
  await assert(await page.locator('.dir-inv').count() === 1, '设置页有数据目录内容清单容器');
  await assert(await dirInv.count() === 4, `清单渲染 4 项（3 子项 + 根汇总，count=${await dirInv.count()}）`);

  const invText = await page.locator('.dir-inv').innerText();
  await assert(/logs/.test(invText) && /sessions\.json/.test(invText) && /plugins/.test(invText),
    '清单含 logs / sessions.json / plugins（' + invText.replace(/\s+/g, ' ').slice(0, 60) + '）');
  await assert(/1\.2 MB/.test(invText) && /24\.0 KB/.test(invText),
    '每项显示真实体积（不再写死「~ 24 MB」）：' + invText.replace(/\s+/g, ' ').slice(0, 70));
  await assert(/12 个文件/.test(invText), '目录项显示其内文件数（' + invText.replace(/\s+/g, ' ').slice(0, 60) + '）');

  // 汇总行：共 X · N 个文件（设置页整体渲染，分区导航只做高亮与滚动）
  const settingsBody = await page.locator('body').innerText();
  await assert(/共 1\.2 MB/.test(settingsBody) && /16 个文件/.test(settingsBody),
    '汇总显示「共 1.2 MB · 16 个文件」（' + settingsBody.replace(/\s+/g, ' ').slice(0, 80) + '）');

  // 快捷操作区不再写死假数字
  await assert(!/~\s*24 MB/.test(settingsBody) && !/~\s*1\.2 MB/.test(settingsBody),
    '设置页已无「~ 24 MB / ~ 1.2 MB」硬编码假数字');

  // 刷新按钮真实存在并接了线（不是 data-action="todo" 空壳）
  await assert(await page.locator('[data-action="dir-inv-refresh"]').count() === 1, '数据目录卡片有「刷新清单」按钮');
  await page.locator('[data-action="dir-inv-refresh"]').click();
  await page.waitForTimeout(600);
  await assert(await dirInv.count() === 4, `刷新后清单仍为 4 项（count=${await dirInv.count()}）`);

  // 桥不可用时显示「未接入」而不是沿用旧假数字
  await page.evaluate(() => { window.__dirInv = null; });
  await page.locator('[data-action="dir-inv-refresh"]').click();
  await page.waitForTimeout(600);
  const offText = await page.locator('body').innerText();
  await assert(/内容清单未接入/.test(offText), '桥不可用时显示「内容清单未接入（主进程桥不可用）」');
  await assert(await page.locator('.dir-inv').count() === 0, '桥不可用时不再渲染清单列表（避免展示陈旧数据）');

  // ================================================================
  // 测试组 11：分层记忆晋升（PRD FR-10，第十四个死挂点）
  // 插件的 promote() 一直存在但零调用方：Worker 域的条目进来就出不去，
  // 四域实际退化成「global + 三个摆设」。这组验证 UI 上的晋升按钮真的走了桥。
  // ================================================================
  console.log('📋 测试组 11：分层记忆晋升');

  await assert(await page.locator('#settings-section-memory').count() === 1, '设置页有「分层记忆」分区');
  await assert(await page.locator('[data-action="mem-domain"]').count() === 4,
    `四域切换 tab 共 4 个（count=${await page.locator('[data-action="mem-domain"]').count()}）`);

  const memItems = page.locator('.mem-item');
  const mpLog = page.locator('.mp-log .al');
  await assert(await memItems.count() === 2, `worker 域渲染 2 条（count=${await memItems.count()}）`);
  // 列表按 createdAt 降序，first 是哪条取决于种子时间戳 —— 断言落在 .mem-list 整体
  // 而不是 first()，避免把排序细节焊进测试。
  const memListText = await page.locator('.mem-list').innerText();
  await assert(/磁盘占用/.test(memListText) && /清理构建缓存/.test(memListText),
    '条目显示正文摘要（' + memListText.replace(/\s+/g, ' ').slice(0, 60) + '）');

  // 晋升按钮指向下一层（worker → 总监），不是同域也不是跳级
  const promoteBtn = page.locator('[data-action="mem-promote"]').first();
  await assert((await promoteBtn.innerText()).includes('总监'), `晋升按钮文案指向总监（${await promoteBtn.innerText()}）`);
  // 记下被晋升的是哪条，稍后在 director 域比对（不依赖排序）
  const promotedText = (await memItems.first().innerText()).slice(0, 12);

  // 审计初始只有种子里的 1 条「被拦下」
  await assert(await mpLog.count() === 1, `晋升审计初始 1 条（count=${await mpLog.count()}）`);
  await assert((await mpLog.first().innerText()).includes('被拦下'), '被 Director 驳回的晋升也要可见（拦截证据不能只记成功）');

  // 单条晋升：条目从 worker 移走，审计 +1
  await promoteBtn.click();
  await page.waitForTimeout(800);
  await assert(await memItems.count() === 1, `晋升后 worker 域剩 1 条（count=${await memItems.count()}）`);
  await assert(await mpLog.count() === 2, `晋升后审计 2 条（count=${await mpLog.count()}）`);
  await assert((await page.locator('.mp-log').innerText()).includes('已晋升'), '新审计条目标记为「已晋升」');

  // 切到 director 域，确认条目真的搬过来了（不是从 UI 上消失而已）
  await page.locator('[data-action="mem-domain"][data-domain="director"]').click();
  await page.waitForTimeout(700);
  await assert(await memItems.count() === 1, `director 域出现 1 条（count=${await memItems.count()}）`);
  await assert((await memItems.first().innerText()).includes(promotedText),
    `搬过来的就是刚才那条（期望含「${promotedText}」，实际「${(await memItems.first().innerText()).slice(0, 30)}」）`);

  // director 的下一层是 project（分层逐层晋升，不跳级）
  await assert((await page.locator('[data-action="mem-promote"]').first().innerText()).includes('项目'),
    'director 域的晋升按钮指向项目');

  // 批量晋升：回 worker 域，把剩下 1 条一次性升走
  await page.locator('[data-action="mem-domain"][data-domain="worker"]').click();
  await page.waitForTimeout(700);
  const batchBtn = page.locator('[data-action="mem-promote-worker"]');
  await assert(await batchBtn.count() === 1, 'worker 域有「批量晋升本域」按钮');
  await batchBtn.click();
  await page.waitForTimeout(900);
  await assert(await memItems.count() === 0, `批量晋升后 worker 域清空（count=${await memItems.count()}）`);
  await assert(await mpLog.count() === 3, `批量晋升后审计 3 条（count=${await mpLog.count()}）`);

  // 空域提示要说清成因（「还没跑过 SubAgent」与「桥断了」处置不同）
  const emptyText = await page.locator('.mem-list').innerText();
  await assert(/暂无条目/.test(emptyText), 'worker 域空时给出成因说明（' + emptyText.replace(/\s+/g, ' ').slice(0, 40) + '）');

  // 审计过滤：<select> 传的是字符串，主进程侧必须同时吃布尔与字符串
  await page.locator('#mp-ok').selectOption('false');
  await page.waitForTimeout(700);
  await assert(await mpLog.count() === 1, `只看被拦下得 1 条（count=${await mpLog.count()}）`);
  await page.locator('#mp-ok').selectOption('true');
  await page.waitForTimeout(700);
  await assert(await mpLog.count() === 2, `只看已晋升得 2 条（count=${await mpLog.count()}）`);

  // 清空审计
  await page.locator('#mp-ok').selectOption('all');
  await page.waitForTimeout(700);
  await page.locator('[data-action="mp-clear"]').click();
  await page.waitForTimeout(700);
  await assert(await mpLog.count() === 0, `清空后审计为空（count=${await mpLog.count()}）`);

  // 桥不可用时显示「未接入」，不伪装成空域
  await page.evaluate(() => { window.__memOff = true; window.orchdesk.listMemoryDomain = () => Promise.resolve(null); });
  await page.locator('[data-action="mem-refresh"]').click();
  await page.waitForTimeout(700);
  await assert(/记忆服务未接入/.test(await page.locator('.mem-list').innerText()),
    '桥不可用时显示「记忆服务未接入（主进程桥不可用）」');

  // ================================================================
  // 测试组 11b：记忆摘要方式（PRD FR-10，第十五个死挂点）
  // 自动转储的摘要到底是「模型摘要」还是「抽取式兜底」，必须如实显示 ——
  // 否则「一直在兜底却以为在用模型」这种降级用户永远发现不了。
  // ================================================================
  console.log('📋 测试组 11b：记忆摘要方式');

  // 恢复记忆桥（上一组末尾把它打成 null 了）
  await page.evaluate(() => { window.__memOff = false; window.orchdesk.listMemoryDomain = () => Promise.resolve([]); });
  await page.locator('[data-action="nav"][data-id="session"]').first().click();
  await page.waitForTimeout(500);
  await page.locator('[data-action="nav"][data-id="settings"]').first().click();
  await page.waitForTimeout(800);

  const memCard = page.locator('#settings-section-memory').locator('..');
  await assert(/抽取式兜底/.test(await memCard.innerText()),
    '未配置模型时如实显示「抽取式兜底」');
  await assert(/未配置模型/.test(await memCard.innerText()),
    '并说明原因（未配置模型：自动转储只保留首尾各 3 条原文）');

  // 切到已配模型：UI 必须跟着变成「模型摘要 + 模型名」
  await page.evaluate(() => {
    window.__summarize = { seam: true, provider: '本地 mock 网关', model: 'mock-model', mode: 'llm' };
  });
  await page.locator('[data-action="nav"][data-id="session"]').first().click();
  await page.waitForTimeout(500);
  await page.locator('[data-action="nav"][data-id="settings"]').first().click();
  await page.waitForTimeout(800);
  await assert(/模型摘要/.test(await memCard.innerText()), '配置模型后显示「模型摘要」');
  await assert(/mock-model/.test(await memCard.innerText()), '并显示具体模型名');

  // 桥不可用时不能伪装成「抽取式兜底」（那是另一种真实状态）
  await page.evaluate(() => { delete window.orchdesk.getMemorySummarizeStatus; });
  await page.locator('[data-action="nav"][data-id="session"]').first().click();
  await page.waitForTimeout(500);
  await page.locator('[data-action="nav"][data-id="settings"]').first().click();
  await page.waitForTimeout(800);
  await assert(/摘要状态未接入/.test(await memCard.innerText()), '桥不可用时显示「摘要状态未接入」');

  // ================================================================
  // 测试组 12：连接器（PRD FR-3）
  // 此前连接器是硬编码的静态数组 —— GitHub 写死 on:1 显示「已连」，纯假状态。
  // 这组验证：真实状态渲染 / 展开配置 / 保存即探测 / manual 诚实标注 / 审计。
  // ================================================================
  console.log('📋 测试组 12：连接器（FR-3）');

  await page.locator('[data-action="nav"][data-id="plugins"]').first().click();
  await page.waitForTimeout(900);

  await assert(await page.locator('[data-action="conn-cfg"]').count() >= 3,
    `连接器行已渲染（count=${await page.locator('[data-action="conn-cfg"]').count()}）`);
  // 已连通的 GitHub：ok 徽标 + 最近探测结论
  const ghRow = page.locator('.plug[data-cid="github"]');
  await assert(/已连接/.test(await ghRow.innerText()), 'GitHub 显示「已连接」徽标');
  await assert(/已连接：octocat/.test(await ghRow.innerText()), 'GitHub 显示最近探测结论（身份）');
  // 未配置的飞书：不是「未接入」也不是假「已连」
  const fsRow = page.locator('.plug[data-cid="feishu"]');
  await assert(/未配置/.test(await fsRow.innerText()), '飞书未配置如实显示');
  // 统计行
  await assert(/已配置 1/.test(await page.locator('.card:has(.plug[data-cid="github"])').innerText()) ||
    /已配置 1/.test((await page.locator('.main-inner').innerText())), '统计行显示已配置数');

  // 展开飞书配置：字段渲染（secret 用 password、text 用 text）
  await page.locator('[data-action="conn-cfg"][data-id="feishu"]').first().click();
  await page.waitForTimeout(500);
  const appIdInput = page.locator('#connf-feishu-appId');
  const secretInput = page.locator('#connf-feishu-appSecret');
  await assert(await appIdInput.count() === 1 && await secretInput.count() === 1, '展开后字段输入框渲染');
  await assert(await appIdInput.getAttribute('type') === 'text', 'text 字段用 text 输入');
  await assert(await secretInput.getAttribute('type') === 'password', 'secret 字段用 password 输入');

  // 保存（appSecret 填 bad）：mock 判 401 → 状态变「连通失败」且审计记 test-fail
  await appIdInput.fill('cli_e2e');
  await secretInput.fill('bad-secret');
  await page.locator('[data-action="conn-save"][data-id="feishu"]').click();
  await page.waitForTimeout(900);
  await assert(/连通失败/.test(await page.locator('.plug[data-cid="feishu"]').innerText()),
    '探测失败后徽标变「连通失败」（保存即探测，不显示假「已配置」）');
  await assert(/Bad credentials/.test(await page.locator('.plug[data-cid="feishu"]').innerText()),
    '失败原因可见（排查凭证问题的依据）');

  // 修好凭证再存：变「已连接」
  await page.locator('#connf-feishu-appSecret').fill('good-secret');
  await page.locator('[data-action="conn-save"][data-id="feishu"]').click();
  await page.waitForTimeout(900);
  await assert(/已连接/.test(await page.locator('.plug[data-cid="feishu"]').innerText()), '修好凭证后徽标变「已连接」');

  // 脱敏回显写回保护：只改一个字段提交，secret 回显值（••••）不被当真凭证。
  // 注意：保存后表单仍处于展开态（expanded 状态保留），再点 conn-cfg 会把它收起。
  await page.waitForTimeout(400);
  const secretVal = await page.locator('#connf-feishu-appSecret').inputValue();
  await assert(/^••••/.test(secretVal), `secret 回显为脱敏串（实际 ${secretVal}）`);
  await page.locator('#connf-feishu-appId').fill('cli_e2e_v2');
  await page.locator('[data-action="conn-save"][data-id="feishu"]').click();
  await page.waitForTimeout(900);
  const savedValues = await page.evaluate(() => {
    const c = window.__conn.items.find((x) => x.id === 'feishu');
    return { appId: c.values.appId, secretLen: c.values.appSecret.length };
  });
  await assert(savedValues.appId === 'cli_e2e_v2', '改动的 text 字段已更新');
  await assert(savedValues.secretLen > 4, '未改动的 secret 保留原值（不是被圆点覆盖）');

  // manual 连接器：保存后显「不可自动验证」而非「连通失败」
  await page.locator('[data-action="conn-cfg"][data-id="tencent-docs"]').first().click();
  await page.waitForTimeout(400);
  await page.locator('#connf-tencent-docs-token').fill('td-e2e-token');
  await page.locator('[data-action="conn-save"][data-id="tencent-docs"]').click();
  await page.waitForTimeout(900);
  const tdText = await page.locator('.plug[data-cid="tencent-docs"]').innerText();
  await assert(/不可自动验证/.test(tdText) && !/连通失败/.test(tdText),
    'manual 连接器显「不可自动验证」，不伪装成「连通失败」');

  // 审计：save/test-fail/test 都已记录；清空
  await assert(await page.locator('[data-action="conn-audit-clear"]').count() === 1, '审计区有清空按钮');
  const auditCount0 = await page.evaluate(() => window.__conn.audit.length);
  await assert(auditCount0 >= 5, `审计已有记录（count=${auditCount0}）`);
  await page.locator('[data-action="conn-audit-clear"]').click();
  await page.waitForTimeout(700);
  await assert((await page.evaluate(() => window.__conn.audit.length)) === 0, '审计已清空');

  // 清除凭证 → 状态归零
  await page.locator('[data-action="conn-clear"][data-id="tencent-docs"]').click();
  await page.waitForTimeout(700);
  await assert(/未配置/.test(await page.locator('.plug[data-cid="tencent-docs"]').innerText()), '清除后回到「未配置」');

  // 桥不可用 → 侧栏显「未接入」，不拿空数组冒充
  await page.evaluate(() => { window.__origGetConnectors = window.orchdesk.getConnectors; delete window.orchdesk.getConnectors; });
  await page.locator('[data-action="nav"][data-id="session"]').first().click();
  await page.waitForTimeout(400);
  await page.locator('[data-action="nav"][data-id="plugins"]').first().click();
  await page.waitForTimeout(900);
  await assert(/连接器注册表未接入/.test(await page.locator('.main-inner').innerText()),
    '桥不可用时显「未接入」');

  // ================================================================
  // 测试组 13：本地插件市场（PRD FR-3）
  // 此前整栏标「规划中」；本地目录接入后必须区分「本地可装」与「远程未接入」。
  // ================================================================
  console.log('📋 测试组 13：本地插件市场（FR-3）');

  // 恢复连接器桥（上一组末尾删掉了 getConnectors）
  await page.evaluate(() => { window.orchdesk.getConnectors = (window.__origGetConnectors || (() => Promise.resolve({ items: [], stats: { total: 0, configured: 0, tested: 0, ok: 0 } }))); });
  await page.waitForTimeout(600);

  await assert(/本地插件市场/.test(await page.locator('.main-inner').innerText()), '主区有本地插件市场卡片');
  await assert(/E2E 回声插件/.test(await page.locator('.main-inner').innerText()), '合法插件显示 manifest.name（非目录名）');
  // 三种状态徽标
  await assert(/已启用/.test(await page.locator('.plug[data-mid="word-count"]').innerText()), '已启用插件显「已启用」');
  await assert(/未启用/.test(await page.locator('.plug[data-mid="e2e-echo"]').innerText()), '未启用插件显「未启用」');
  await assert(/manifest 非法/.test(await page.locator('.plug[data-mid="bad-manifest"]').innerText())
    && /manifest.name 缺失/.test(await page.locator('.plug[data-mid="bad-manifest"]').innerText()),
    'manifest 非法显徽标 + 具体原因（用户可自查）');
  // 远程市场仍诚实标注
  await assert(/远程未接入/.test(await page.locator('.main-inner').innerText()) || (await page.locator('.ss-l').count() > 0),
    '远程市场保持「远程未接入」标注');

  // 启用开关：点击 e2e-echo 的 switch → mock 里 enabled/active 翻转
  await page.locator('[data-action="market-local-toggle"][data-id="e2e-echo"]').click();
  await page.waitForTimeout(800);
  const echoState = await page.evaluate(() => window.__market.items.find((x) => x.dir === 'e2e-echo'));
  await assert(echoState.enabled === true && echoState.active === true, '启用真的改了状态（走了桥）');
  await assert(/已启用/.test(await page.locator('.plug[data-mid="e2e-echo"]').innerText()), '徽标更新为「已启用」');

  // 非法目录的开关点不动（mock 拒绝 → toast + 状态不变）
  await page.locator('[data-action="market-local-toggle"][data-id="bad-manifest"]').click();
  await page.waitForTimeout(800);
  const badState = await page.evaluate(() => window.__market.items.find((x) => x.dir === 'bad-manifest'));
  await assert(badState.enabled === false, 'manifest 非法不可启用（fail-closed）');

  // 打开插件目录按钮存在
  await assert(await page.locator('[data-action="market-open-dir"]').count() === 1, '有「打开插件目录」入口');

  // ================================================================
  // 测试组 14：用量追踪与事件流回放（FR-5 / FR-6，ADR-0009）
  // FR-5：用量卡片按模型聚合 + 清空 + assistant 消息 token 徽标。
  // FR-6：回放优先走 append-only 事件流（ADR-0009），无日志回退消息数组并显式标注；
  //       分叉落 fork-origin 血缘事件（appendForkEvent）。
  // ================================================================
  console.log('📋 测试组 14：用量追踪与事件流回放');

  // 前 13 组的会话操作（重命名/删除/分叉）污染了侧栏状态 —— reload 重置到种子态
  // （addInitScript 会重新执行，种子数据与 mock 桥原样恢复）。打开数组模式让
  // 种子会话（s3 带 tok 徽标 + 事件流）真实进 state。
  await page.evaluate(() => { try { localStorage.setItem('__seedArr', '1'); } catch (e) { /* ignore */ } });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);
  try {
    const wzSkip = page.locator('[data-action="wz-skip"]');
    if (await wzSkip.count() > 0) { await wzSkip.click({ force: true }); await page.waitForTimeout(300); }
  } catch (e) { /* ignore */ }

  // ---- BUG-023 回归：项目绑定目录 → 会话工作区（打开会话 / 未绑定不误设 / 文件面板缺省根）----
  // 放在 reload（种子态恢复）之后：前 13 组的删除/分叉用例会真实删掉种子会话。
  try {
    // 按需展开 p1 / p2（种子态默认折叠）。用完必须还原折叠 —— 组 14 后续用例
    // 无条件 toggle p1，依赖「默认折叠」假设（见下方 FR-5 token 徽标段）。
    const expandedHere = [];
    const ensureSessVisible = async (pid, sid) => {
      if (await page.locator(`.sess[data-action="sel"][data-id="${sid}"]`).count() > 0) return;
      const t = page.locator(`.proj-head[data-action="proj-toggle"][data-id="${pid}"]`);
      if (await t.count() > 0) {
        await t.first().click();
        expandedHere.push(pid);
        await page.waitForTimeout(250);
      }
    };
    await ensureSessVisible('p1', 's1');
    await ensureSessVisible('p2', 's2');

    // ① 点开 p1（绑定 D:/Code/Demo）下的会话 s1 → setSessionCwd('s1', 'D:/Code/Demo')
    await page.evaluate(() => { window.__cwdCalls = []; });
    const s1Row = page.locator('.sess[data-action="sel"][data-id="s1"]');
    await assert(await s1Row.count() > 0, 'BUG-023 会话 s1 行存在');
    await s1Row.first().click();
    await page.waitForTimeout(350);
    let cwdCalls = await page.evaluate(() => window.__cwdCalls || []);
    const s1Call = cwdCalls.find((c) => c.sid === 's1');
    await assert(!!s1Call && s1Call.dir === 'D:/Code/Demo', `BUG-023 打开绑定项目的会话应设工作区（实际=${JSON.stringify(s1Call)}）`);

    // ② 打开 s2（p2 未绑定）→ 不得误设工作区（静默设错正是本 BUG 形态）
    await page.evaluate(() => { window.__cwdCalls = []; });
    const s2Row = page.locator('.sess[data-action="sel"][data-id="s2"]');
    await assert(await s2Row.count() > 0, 'BUG-023 会话 s2 行存在');
    await s2Row.first().click();
    await page.waitForTimeout(350);
    cwdCalls = await page.evaluate(() => window.__cwdCalls || []);
    const s2Call = cwdCalls.find((c) => c.sid === 's2');
    await assert(!s2Call, `BUG-023 未绑定项目不得设工作区（实际=${JSON.stringify(s2Call)}）`);

    // ③ 文件面板缺省根跟随当前会话的项目目录。注意：文件面板是全屏覆盖层，
    //    开着会挡住侧栏点击 —— 每次看完 .file-root 必须先关面板再切会话。
    await page.locator('[data-action="file-panel"]').first().click();
    await page.waitForTimeout(250);
    const rootWhileS2 = await page.locator('.file-root').textContent().catch(() => '');
    await assert(!/D:\/Code\/Demo/.test(rootWhileS2 || ''), `BUG-023 未绑定会话的文件面板不应落在项目目录（实际=${rootWhileS2}）`);
    await page.locator('[data-action="file-close"]').first().click();
    await page.waitForTimeout(200);
    await s1Row.first().click();
    await page.waitForTimeout(350);
    await page.locator('[data-action="file-panel"]').first().click();
    await page.waitForTimeout(250);
    const rootWhileS1 = await page.locator('.file-root').textContent().catch(() => '');
    await assert(/D:\/Code\/Demo/.test(rootWhileS1 || ''), `BUG-023 绑定会话的文件面板缺省根应为项目目录（实际=${rootWhileS1}）`);
    // 关面板 + 还原折叠态（不干扰后续用例；失败必须暴露而不是吞掉）
    const closeBtn = page.locator('[data-action="file-close"]');
    await assert(await closeBtn.count() > 0, 'BUG-023 文件面板关闭按钮存在');
    await closeBtn.first().click();
    await page.waitForTimeout(200);
    for (const pid of expandedHere) {
      await page.locator(`.proj-head[data-action="proj-toggle"][data-id="${pid}"]`).first().click();
    }
    await page.waitForTimeout(200);
  } catch (e) {
    await assert(false, `BUG-023 会话工作区交互完成 (error: ${e.message.slice(0, 80)})`);
  }

  // ---- FR-5 用量卡片 ----
  await page.locator('[data-action="nav"][data-id="settings"]').first().click();
  await page.waitForTimeout(800);
  let settingsText = await page.locator('.main-inner').innerText();
  await assert(/用量追踪（FR-5）/.test(settingsText), '模型管理区有用量卡片');
  await assert(/128\.0k/.test(settingsText), '显示合计 tokens（128.0k）');
  await assert(/usage-model/.test(settingsText), '按模型聚合显示 usage-model');

  await page.locator('[data-action="usage-clear"]').click();
  await page.waitForTimeout(600);
  await assert(/尚无用量记录/.test(await page.locator('.main-inner').innerText()), '清空后显示「尚无用量记录」（不是假 0 卡片）');

  // ---- FR-5 token 徽标：s3 的 assistant 消息 ----
  await page.locator('[data-action="nav"][data-id="session"]').first().click();
  await page.waitForTimeout(500);
  // 项目默认折叠 → 先展开 p1，再选会话 s3
  const p1Toggle = page.locator('[data-action="proj-toggle"][data-id="p1"]');
  if (await p1Toggle.count() > 0) { await p1Toggle.first().click(); await page.waitForTimeout(400); }
  await page.locator('[data-action="sel"][data-id="s3"]').first().click();
  await page.waitForTimeout(500);
  await assert(/↑1\.2k ↓45/.test(await page.locator('#msgScroll').innerText()), 'assistant 消息显示 token 徽标（↑1.2k ↓45）');

  // ---- FR-6 事件流回放（event-log 源）----
  await page.locator('[data-action="replay-open"]').first().click();
  await page.waitForTimeout(700);
  let replayText = await page.locator('#msgScroll').innerText();
  await assert(/append-only 事件流重建/.test(replayText), '回放标注「事件流重建」（ADR-0009 权威源）');
  await assert(await page.locator('.rp-item').count() === 4, '事件流时间线 4 项（含工具步骤独立事件）');
  await assert(/工具 · file_list/.test(replayText), '工具步骤成为独立时间线条目');

  // ---- FR-6 桥断回退：诚实标注而非静默降级 ----
  await page.locator('[data-action="replay-close"]').click();
  await page.waitForTimeout(300);
  await page.evaluate(() => { delete window.orchdesk.getSessionEvents; });
  await page.locator('[data-action="sel"][data-id="s1"]').first().click();  await page.waitForTimeout(400);
  await page.locator('[data-action="replay-open"]').first().click();
  await page.waitForTimeout(700);
  await assert(/事件流未接入/.test(await page.locator('#msgScroll').innerText()), '桥断时标注「事件流未接入」');

  // ---- FR-6 分叉落血缘事件 ----
  await page.locator('[data-action="replay-close"]').click();
  await page.waitForTimeout(300);
  await page.locator('[data-action="sel"][data-id="s3"]').first().click();
  await page.waitForTimeout(400);
  await page.locator('[data-action="fork"]').first().click();
  await page.waitForTimeout(400);
  await page.locator('[data-action="branch-confirm"]').click();
  await page.waitForTimeout(900);
  const forks = await page.evaluate(() => window.__events.forks);
  await assert(forks.length >= 1 && forks[forks.length - 1].from === 's3', '分叉调用 appendForkEvent（from=s3）');
  await assert(forks[forks.length - 1].atIndex === 2, '血缘 atIndex=2（s3 共 2 条消息，默认全继承）');
  await assert(!!forks[forks.length - 1].newId, '血缘记录新分支 id');

  // ================================================================
  // 测试组 15：死挂点修复回归（2026-09-03 批次 #44-#47 的 UI 真机覆盖）
  // 这批修复的共同形态是「有写入无读取 / 订阅被丢弃 / 假 Promise 接口」——
  // 单测看不出来，只有真 UI 交互才暴露。此组用真实渲染层复现每条链路：
  //   ① live 工具步骤：onToolStep 订阅写入 → typing 消息实时读（而非等到回合结束）；
  //   ② 静态 tools/steps：回合结束写进 agent 消息 →「N 步 · M 个动作」+ 可展开明细；
  //   ③ 设置页 statbar：真实数据目录 + 运行时就绪（不再硬编码 %APPDATA%/dsh 版本）；
  //   ④ 任务监控「技能与MCP」：按运行时真实装载标注（trace 主动停用≠brain 真异常）；
  //   ⑤ 专家团派发：askInput 是回调式（不返回 Promise）→ 点「派发任务」不再崩，任务真下发；
  //   ⑥ 文件面板：打开/关闭可见性真实切换。
  // ================================================================
  console.log('📋 测试组 15：死挂点修复回归');

  // reload 到干净种子态；同时置 __rt='1' 让插件运行时「就绪」（③④ 依赖真实分支）。
  await page.evaluate(() => {
    try {
      localStorage.setItem('__rt', '1');
      localStorage.setItem('__seedArr', '1');
    } catch (e) { /* ignore */ }
  });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(1100);
  try {
    const wzSkip = page.locator('[data-action="wz-skip"]');
    if (await wzSkip.count() > 0) { await wzSkip.click({ force: true }); await page.waitForTimeout(300); }
  } catch (e) { /* ignore */ }

  // ---- ②+① 会话 s3：静态工具明细 + live 工具步骤 ----
  try {
    await page.locator('[data-action="nav"][data-id="session"]').first().click();
    await page.waitForTimeout(500);
    // 项目默认折叠 → 按需展开 p1
    if (await page.locator('.sess[data-action="sel"][data-id="s3"]').count() === 0) {
      const p1h = page.locator('.proj-head[data-action="proj-toggle"][data-id="p1"]');
      if (await p1h.count() > 0) { await p1h.first().click(); await page.waitForTimeout(300); }
    }
    await page.locator('.sess[data-action="sel"][data-id="s3"]').first().click();
    await page.waitForTimeout(500);

    // ② 静态：s3 种子 assistant 消息自带 tools/steps → 摘要 + 明细可展开
    const seedScroll = await page.locator('#msgScroll').innerText();
    await assert(/1 步 · 1 个动作/.test(seedScroll), '静态 agent 消息显示「1 步 · 1 个动作」摘要');
    await assert(await page.locator('#msgScroll details.tools').count() === 1, '种子消息渲染出 1 个 tools 明细折叠区');
    await page.locator('#msgScroll details.tools summary').first().click();
    await page.waitForTimeout(250);
    const opened = await page.locator('#msgScroll details.tools').first().evaluate((el) => el.open);
    const toolRows = await page.locator('#msgScroll details.tools .trow').allInnerTexts();
    await assert(opened === true, '点击摘要展开工具明细');
    await assert(toolRows.length === 1 && /file_list/.test(toolRows[0]) && /完成/.test(toolRows[0]),
      `明细行显示工具名与终态（实际=${JSON.stringify(toolRows)}）`);

    // ① live：接管 runAgentTurn 为「手动放行」，typing 消息才能停留足够久做实时断言
    await page.evaluate(() => {
      window.orchdesk.runAgentTurn = (sid, text, opts) => new Promise((resolve) => {
        window.__turnResolve = (r) => resolve(r);
      });
    });
    await page.locator('#composer').fill('列出当前项目文件');
    await page.locator('[data-action="send"]').first().click();
    await page.waitForTimeout(300);

    // 推送 running 步骤 → 节流 150ms 后整页重建 → typing 行实时显示
    await page.evaluate(() => {
      if (typeof window.__toolStepCb === 'function') {
        window.__toolStepCb({ sessionId: 's3', name: 'file_list', ph: 'running' });
      }
    });
    await page.waitForTimeout(400);
    let live = await page.locator('#msgScroll').innerText();
    await assert(/正在执行工具/.test(live), 'typing 期间显示「正在执行工具」（live 轨迹被读，不再存而不显）');
    await assert(/file_list/.test(live) && /执行中/.test(live), 'running 步骤行实时出现（file_list · 执行中）');

    // running → done：同一行翻转为完成（onToolStep 归一化 done 事件）
    await page.evaluate(() => {
      if (typeof window.__toolStepCb === 'function') {
        window.__toolStepCb({ sessionId: 's3', name: 'file_list', ph: 'done' });
      }
    });
    await page.waitForTimeout(350);
    live = await page.locator('#msgScroll').innerText();
    await assert(!/执行中/.test(live) && /完成/.test(live), '步骤完成：done 行替换 running（无残留「执行中」）');

    // 放行回合 → typing 被静态消息替换：tools 落库为可展开明细（第二个 details）
    await page.evaluate(() => {
      if (typeof window.__turnResolve === 'function') {
        window.__turnResolve({ text: '文件清单：README.md、src/、tests/ 共 12 项。', intent: 'ACT', tools: [{ n: 'file_list', ph: 'done' }], steps: 1 });
      }
    });
    await page.waitForTimeout(500);
    const doneText = await page.locator('#msgScroll').innerText();
    await assert(!/思考中/.test(doneText), '回合结束 typing 消息被静态回复替换');
    await assert(await page.locator('#msgScroll details.tools').count() === 2,
      '回合返回 tools 落库为第二个「N 步 · M 个动作」明细区');
    await assert(/1 步 · 1 个动作/.test(doneText), '静态 tools 摘要渲染正确');
  } catch (e) {
    await assert(false, `死挂点 ①② 工具步骤链路交互完成 (error: ${e.message.slice(0, 80)})`);
  }

  // ---- ④ 任务监控「技能与MCP」：插件状态按运行时真实装载标注 ----
  try {
    if (await page.locator('.ctx-tab').count() === 0) {
      const tg = page.locator('[data-action="toggle-ctx"]').first();
      if (await tg.count() > 0) { await tg.click(); await page.waitForTimeout(250); }
    }
    const skillTab = page.locator('.ctx-tab[data-action="ctx-tab"][data-id="skills"]');
    await assert(await skillTab.count() > 0, '右侧面板有「技能与MCP」tab');
    await skillTab.first().click();
    await page.waitForTimeout(350);
    const pluginStates = await page.evaluate(() => {
      const out = {};
      document.querySelectorAll('.ctx-skill').forEach((row) => {
        const nm = row.querySelector('.sk-name');
        const st = row.querySelector('.sk-status');
        if (nm && st) out[nm.textContent.trim()] = st.textContent.trim();
      });
      return out;
    });
    await assert(pluginStates.intent === '已启用', `intent 运行时 active → 已启用（实际=${pluginStates.intent}）`);
    await assert(pluginStates.multi === '已启用', `multi 运行时 active → 已启用（实际=${pluginStates.multi}）`);
    await assert(pluginStates.trace === '已停用', `trace 主动停用（error 前缀「已停用」）→ 已停用而非异常（实际=${pluginStates.trace}）`);
    await assert(pluginStates.brain === '异常', `brain 装载失败（非停用前缀 error）→ 异常（实际=${pluginStates.brain}）`);
  } catch (e) {
    await assert(false, `死挂点 ④ 技能状态真实标注完成 (error: ${e.message.slice(0, 80)})`);
  }

  // ---- ③ 设置页 statbar：真实数据目录 + 运行时就绪（去掉硬编码 %APPDATA%/dsh）----
  try {
    await page.locator('[data-action="nav"][data-id="settings"]').first().click();
    await page.waitForTimeout(900);
    const sb = await page.locator('.statbar').innerText();
    await assert(/…\/mock\/OrchDesk-Data/.test(sb), `数据目录 stat 显示真实目录末两段（实际=${sb.replace(/\n/g, ' | ').slice(0, 120)}）`);
    await assert(/插件运行时就绪 · 3\/4/.test(sb), '运行时 stat 显示就绪计数 3/4（取自 getPluginRuntime）');
    await assert(!/%APPDATA%/.test(sb), '不再硬编码 %APPDATA%/OrchDesk');
    await assert(!/本地（未扫描）/.test(sb) && !/未启动/.test(sb), '桥已接入时 statbar 不显示占位文案');
  } catch (e) {
    await assert(false, `死挂点 ③ statbar 真实状态完成 (error: ${e.message.slice(0, 80)})`);
  }

  // ---- ⑤ 专家团派发：askInput 回调式 → 派发不再崩，composeTeam 真被调用 ----
  try {
    await page.locator('[data-action="nav"][data-id="plugins"]').first().click();
    await page.waitForTimeout(600);
    // 专家·专家团在插件页左栏分组里，默认折叠 → 展开到能看见「派发任务」按钮
    if (await page.locator('[data-action="team-compose"]').count() === 0) {
      const exp = page.locator('.ss-h[data-action="pside-toggle"][data-id="experts"]').first();
      if (await exp.count() > 0) { await exp.click(); await page.waitForTimeout(300); }
    }
    const composeBtns = page.locator('[data-action="team-compose"]');
    await assert(await composeBtns.count() > 0, '展开专家团分组后出现「派发任务」按钮');

    await page.evaluate(() => { window.__composeCalls = []; });
    await composeBtns.first().click();
    await page.waitForTimeout(350);
    await assert(await page.locator('#askInput').count() === 1, '点击「派发任务」弹出任务输入（旧代码此处直接 TypeError 崩溃）');
    await page.locator('#askInput').fill('生成一份开发周报');
    await page.locator('[data-action="ask-input-ok"]').click();
    await page.waitForTimeout(800);
    const calls = await page.evaluate(() => window.__composeCalls || []);
    await assert(calls.length === 1 && /开发周报/.test(calls[0].task || ''),
      `composeTeam 真被派发（task=${calls.length ? JSON.stringify(calls[0].task) : '（无调用）'}）`);
    const delHead = await page.locator('.ss-h[data-action="pside-toggle"][data-id="delegation"]').innerText().catch(() => '');
    await assert(/最近一次委派树/.test(delHead) && /3/.test(delHead),
      `派发结果渲染委派树分组（3 节点，实际=${delHead.replace(/\n/g, ' | ').slice(0, 80)}）`);
    // ②半接线后 composeTeam 把 task 喂给 Director 真执行并返回 result —— 委派树须渲染出
    // 执行摘要（task/产出/执行中），否则「接成真执行」在产品里存而不显。
    await page.locator('.ss-h[data-action="pside-toggle"][data-id="delegation"]').first().click();
    await page.waitForTimeout(300);
    const delNotes = (await page.locator('.ssec .del-note').allInnerTexts().catch(() => [])) || [];
    const joined = delNotes.join('\n');
    await assert(/任务：生成一份开发周报/.test(joined), `委派树应展示 Director 的 task，实际=${joined.slice(0, 120)}`);
    await assert(/产出：已汇总本周迭代进展与风险/.test(joined), `委派树应展示 Director 执行产出，实际=${joined.slice(0, 120)}`);
    await assert(/执行中…/.test(joined), `running 节点应标注「执行中…」，实际=${joined.slice(0, 120)}`);
  } catch (e) {
    await assert(false, `死挂点 ⑤ 专家团派发链路完成 (error: ${e.message.slice(0, 80)})`);
  }

  // ---- ⑥ 文件面板：打开/关闭可见性真实切换 ----
  try {
    await page.locator('[data-action="file-panel"]').first().click();
    await page.waitForTimeout(350);
    const openState = await page.evaluate(() => {
      const r = document.querySelector('#fileRoot');
      return !!r && !r.classList.contains('hidden');
    });
    await assert(openState, '点击「文件」打开文件面板（#fileRoot 移除 hidden）');
    await assert(await page.locator('#fileHead').count() === 1, '文件面板骨架（头部）已渲染');
    const closeBtn = page.locator('[data-action="file-close"]');
    await assert(await closeBtn.count() > 0, '文件面板有关闭按钮');
    await closeBtn.first().click();
    await page.waitForTimeout(250);
    const closedState = await page.evaluate(() => {
      const r = document.querySelector('#fileRoot');
      return !!r && r.classList.contains('hidden');
    });
    await assert(closedState, '点关闭后 #fileRoot 恢复 hidden（打开关闭真实切换）');
  } catch (e) {
    await assert(false, `死挂点 ⑥ 文件面板开关完成 (error: ${e.message.slice(0, 80)})`);
  }

  // ================================================================
  // 总结
  // ================================================================
  console.log('\n' + results.join('\n'));
  console.log(`\n📊 结果: ${passed} 通过, ${failed} 失败, 共 ${passed + failed} 项\n`);

  if (failed > 0) {
    console.log('❌ 有验证失败，请检查上述 FAIL 项。');
    process.exitCode = 1;
  } else {
    console.log('✅ 全部验证通过！');
  }

  await browser.close();
}

run().catch((err) => {
  console.error('E2E 脚本异常:', err);
  process.exit(1);
});
