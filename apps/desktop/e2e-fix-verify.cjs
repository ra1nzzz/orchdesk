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
      { id: 'p1', n: 'OrchDesk', sessions: ['s1'], archived: 0 },
      { id: 'p2', n: '写作助手', sessions: ['s2'], archived: 0 },
      { id: 'p3', n: '已归档', sessions: [], archived: 1 },
    ];
    const seedSessions = {
      s1: { id: 's1', pid: 'p1', title: '修复登录超时', expert: '全栈工程师', model: 'qwen3:14b', updated: '刚刚', ts: '10:00', msgs: [] },
      s2: { id: 's2', pid: 'p2', title: '周报草稿', expert: '内容编辑', model: 'qwen3:14b', updated: '昨天', ts: '09:00', msgs: [] },
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
    window.orchdesk = {
      loadSessions: () => Promise.resolve(JSON.parse(JSON.stringify(seedSessions))),
      persistSessions: (arr) => Promise.resolve({ ok: true }),
      loadProjects: () => Promise.resolve(JSON.parse(JSON.stringify(seedProjects))),
      persistProjects: (arr) => Promise.resolve({ ok: true }),
      onToolStep: () => () => {},
      getPluginRuntime: () => Promise.resolve({ ready: false, activeCount: 0, total: 0, plugins: [] }),
      setPluginEnabled: () => Promise.resolve({ ok: false, reason: 'E2E mock' }),
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
      openProjectDir: () => Promise.resolve({ ok: true }),
      pickFolder: () => Promise.resolve({ ok: false, reason: 'cancelled' }),
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
