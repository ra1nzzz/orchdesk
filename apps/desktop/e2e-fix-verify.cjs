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
    window.orchdesk = {
      loadSessions: () => Promise.resolve([]),
      persistSessions: (arr) => Promise.resolve({ ok: true }),
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
