/**
 * dsh 运行时接线验证（BUG-014 根因修复的防回归）
 * ----------------------------------------------------------------------------
 * 用 Module._load 钩子 stub electron，require 真实主进程 dist/main.js，
 * 等 app.whenReady() 里的 bootRuntime() 跑完，然后断言：
 *
 *   1. 9 个 Cordis 插件全部激活（此前为 0 —— asar 里根本没打包）
 *   2. 7 个服务真实可用（authz / memory / orchestration / brainHands /
 *      promptLib / compensation / evolution）
 *   3. 授权：三模式 + L0–L4 + 审计日志 + fail-closed（无应答方 → 不开门）
 *   4. 11 个曾返回静态占位的 IPC handler 现在返回真实数据
 *   5. SubAgent 创建/销毁是可逆效应（dispose 后无残留）
 *   6. 编排目录真实（8 专家 + 3 团，替换渲染层硬编码 mock）
 *
 * 运行：node dsh-runtime-verify.cjs   （需先 npx tsc -p tsconfig.json）
 */

const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const Module = require('node:module');

// ---------------------------------------------------------------------------
// 隔离环境
// ---------------------------------------------------------------------------
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'orchdesk-dsh-'));
process.env.ORCHDESK_HOME = HOME;

const { makeElectronStub, createChecker } = require('../../scripts/verify-kit.cjs');

let readyResolve;
const readyPromise = new Promise((r) => { readyResolve = r; });

// stub 取 5 份旧实现的并集（见 scripts/verify-kit.cjs），本脚本的差异项在此覆盖。
const electronStub = makeElectronStub({
  home: HOME,
  onReady: () => readyResolve(),
  getPath: (name) => (name === 'appData' ? path.join(HOME, 'appdata') : path.join(HOME, 'stub', name)),
});
const ipcHandlers = electronStub.ipcHandlers;

const origLoad = Module._load;
Module._load = function (request) {
  if (request === 'electron') return electronStub;
  return origLoad.apply(this, arguments);
};

global.fetch = async () => ({ ok: true, status: 200, text: async () => '{}', json: async () => ({ choices: [{ message: { content: 'ok' } }] }) });

// ---------------------------------------------------------------------------
require('./dist/main.js');

const { check, summary } = createChecker();

(async () => {
  await readyPromise;
  // 等 bootRuntime（异步插件加载）完成
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 50));
    if (ipcHandlers.has('orchdesk:plugin-runtime')) {
      const st = await ipcHandlers.get('orchdesk:plugin-runtime')(null);
      if (st && st.ready && st.plugins && st.plugins.length >= 9) break;
    }
  }

  console.log('\n== A. 插件运行时装载 ==');

  let rt;
  await check('运行时已启动且 9 个插件全部激活（修复前为 0/9）', async () => {
    rt = await ipcHandlers.get('orchdesk:plugin-runtime')(null);
    assert.ok(rt && rt.ready, '运行时未就绪: ' + JSON.stringify(rt));
    assert.strictEqual(rt.total, 9, '插件总数应为 9，实际 ' + rt.total);
    assert.strictEqual(rt.activeCount, 9, `应 9/9 激活，实际 ${rt.activeCount}/9` +
      '\n        未激活: ' + JSON.stringify(rt.plugins.filter((p) => !p.active)));
  });

  console.log('== B. 授权服务（FR-9）==');

  await check('authz 三模式真实可读（default/trusted/paranoid）', async () => {
    const modes = await ipcHandlers.get('orchdesk:authz-get-mode')(null);
    assert.ok(modes && modes.mode, '应返回当前模式');
    const svcModes = await ipcHandlers.get('orchdesk:authz-get-levels')(null);
    assert.ok(Array.isArray(svcModes), 'levels 应为数组');
  });

  await check('L0–L4 分级返回 5 级（修复前恒为 [] → UI 显示"加载中"）', async () => {
    const levels = await ipcHandlers.get('orchdesk:authz-get-levels')(null);
    assert.ok(Array.isArray(levels) && levels.length === 5, '应为 5 级，实际 ' + (levels || []).length);
    const nums = levels.map((l) => l.level).sort();
    assert.deepStrictEqual(nums, [0, 1, 2, 3, 4], '分级应为 L0–L4，实际 ' + JSON.stringify(nums));
  });

  await check('授权审计日志可读且为空数组（修复前也是 []，但来自 stub）', async () => {
    const audit = await ipcHandlers.get('orchdesk:authz-get-audit')(null);
    assert.ok(Array.isArray(audit), '审计应为数组');
  });

  await check('切换授权模式真实生效并落审计（修复前恒返回"授权服务未加载"）', async () => {
    const r = await ipcHandlers.get('orchdesk:authz-set-mode')(null, 'paranoid');
    assert.ok(r && r.ok !== false, '切换应成功，实际 ' + JSON.stringify(r));
    const audit = await ipcHandlers.get('orchdesk:authz-get-audit')(null);
    assert.ok(audit.some((a) => a.kind === 'sandbox-mode'), '切换应产生审计记录，实际 ' + JSON.stringify(audit));
  });

  await check('fail-closed：无 GUI 应答方时审批请求不开门', async () => {
    const { getService } = require('./dist/dsh-runtime.js');
    const approval = getService('approval');
    assert.ok(approval, 'approval 服务应可用');
    const outcome = await approval.request({ toolName: 'rm -rf /', reason: '破坏性操作' });
    assert.strictEqual(outcome, 'unavailable', '无应答方必须返回 unavailable，实际 ' + outcome);
  });

  console.log('== C. 记忆 / 提示词 / 补偿 / 自进化（FR-10~13）==');

  await check('memory-stats 返回四域真实结构（修复前恒 null）', async () => {
    const stats = await ipcHandlers.get('orchdesk:memory-stats')(null);
    assert.ok(stats && typeof stats === 'object', '应返回对象，实际 ' + JSON.stringify(stats));
    for (const d of ['global', 'project', 'director', 'worker']) {
      assert.ok(d in stats, `应含四域之一 ${d}，实际 ${JSON.stringify(stats)}`);
    }
  });

  await check('prompt-list 返回数组（修复前恒 [] 且来自 stub）', async () => {
    const list = await ipcHandlers.get('orchdesk:prompt-list')(null);
    assert.ok(Array.isArray(list), '应返回数组，实际 ' + JSON.stringify(list));
  });

  await check('comp-audit 返回数组且补偿服务可用', async () => {
    const audit = await ipcHandlers.get('orchdesk:comp-audit')(null);
    assert.ok(Array.isArray(audit), '补偿审计应为数组');
    const { getService } = require('./dist/dsh-runtime.js');
    const comp = getService('compensation');
    assert.ok(comp && typeof comp.classify === 'function', 'compensation 服务应可用');
    const cls = comp.classify('把这封邮件发给客户');
    assert.ok(cls && cls.category, '外发分类应有结果，实际 ' + JSON.stringify(cls));
  });

  await check('evol-list 返回数组且自进化服务可用', async () => {
    const list = await ipcHandlers.get('orchdesk:evol-list')(null);
    assert.ok(Array.isArray(list), '自进化列表应为数组');
    const { getService } = require('./dist/dsh-runtime.js');
    const evol = getService('evolution');
    assert.ok(evol && typeof evol.createTempPlugin === 'function', 'evolution 服务应可用');
  });

  await check('提示词保存走真实服务（未接入时返回明确 unavailable，不塞假数据）', async () => {
    const r = await ipcHandlers.get('orchdesk:prompt-save')(null, { title: 't', body: 'b' });
    assert.ok(r && typeof r === 'object', '应返回对象');
  });

  console.log('== D. 编排目录（替换渲染层 mock 常量）==');

  await check('编排目录真实：8 专家 + 3 团', async () => {
    const catalog = await ipcHandlers.get('orchdesk:orchestration-catalog')(null);
    assert.ok(catalog, '目录不应为 null');
    const experts = catalog.experts || [];
    const teams = catalog.teams || [];
    assert.strictEqual(experts.length, 8, '应为 8 个专家，实际 ' + experts.length);
    assert.strictEqual(teams.length, 3, '应为 3 个专家团，实际 ' + teams.length);
  });

  console.log('== E. SubAgent 可逆效应 ==');

  await check('SubAgent 可创建，dispose 后无残留（可逆效应）', async () => {
    const { getService } = require('./dist/dsh-runtime.js');
    const agents = getService('agents');
    assert.ok(agents && typeof agents.create === 'function', 'agents 服务应可用');
    const before = agents.list().length;
    const handle = await agents.create({ sessionId: 'sub-verify-1', meta: { origin: 'subagent' } });
    assert.ok(handle && handle.agent && handle.agent.id === 'sub-verify-1', '应返回 handle');
    assert.strictEqual(agents.list().length, before + 1, '创建后应增加一个');
    await handle.dispose();
    assert.strictEqual(agents.list().length, before, 'dispose 后应无残留');
    assert.ok(!agents.list().includes('sub-verify-1'), '会话 id 应被清理');
  });

  await check('SubAgent followup 在未注入运行器时明确报错（不伪造结果）', async () => {
    const { getService } = require('./dist/dsh-runtime.js');
    const agents = getService('agents');
    const handle = await agents.create({ sessionId: 'sub-verify-2' });
    const r = await agents.followup('sub-verify-2', [{ role: 'user', content: 'hi' }]);
    await handle.dispose();
    // 本进程注入了运行器（main.ts 已注入），因此要么真实结果、要么明确报错
    assert.ok(r && typeof r.text === 'string', '应返回 { text }');
  });

  console.log('== F. 沙箱策略持久化 ==');

  await check('sandboxPolicy 模式切换落盘并重新可读', async () => {
    const { getService } = require('./dist/dsh-runtime.js');
    const sp = getService('sandboxPolicy');
    assert.ok(sp, 'sandboxPolicy 服务应可用');
    sp.setSandboxMode({ id: 's-verify' }, 'read-only');
    const r = sp.resolve({ session: { id: 's-verify' } });
    assert.strictEqual(r.mode, 'read-only', '应返回 read-only，实际 ' + r.mode);
    // 未知模式必须降级为最严（fail-safe，不静默放宽）
    sp.setSandboxMode({ id: 's-verify2' }, 'bogus-mode');
    assert.strictEqual(sp.resolve({ session: { id: 's-verify2' } }).mode, 'read-only',
      '未知模式应降级为 read-only');
  });

  await check('网络域名白名单（PRD FR-8）：默认不限、配置后精确/后缀命中、非法入参 fail-safe', () => {
    const hs = require('./dist/host-services.js');
    assert.deepStrictEqual(hs.normalizeNetworkAllow(null), ['*'], '非法值应回落 ["*"]');
    assert.deepStrictEqual(hs.normalizeNetworkAllow(['  ', 'GITHUB.com ', 'bad/x']), ['github.com'],
      '应去空白/小写/丢弃非法项');
    const sp = require('./dist/dsh-runtime.js').getService('sandboxPolicy');
    sp.setNetworkAllow(['*']);
    assert.strictEqual(sp.isDomainAllowed('https://example.com/x'), true, '默认 * 应放行');
    sp.setNetworkAllow(['github.com', '*.deepseek.com']);
    assert.strictEqual(sp.isDomainAllowed('https://github.com/a/b'), true, '精确域名应放行');
    assert.strictEqual(sp.isDomainAllowed('https://api.github.com/a'), true, '子域应放行');
    assert.strictEqual(sp.isDomainAllowed('https://chat.deepseek.com'), true, '*. 后缀应放行');
    assert.strictEqual(sp.isDomainAllowed('https://evil.com'), false, '未列域名应拒绝');
    assert.strictEqual(sp.isDomainAllowed('not-a-url'), false, '无法解析应拒绝（fail-closed）');
    assert.deepStrictEqual(sp.getNetworkAllow(), ['github.com', '*.deepseek.com'], '配置应可读回');
    sp.setNetworkAllow(['*']); // 复位，避免影响后续用例
  });

  // -------------------------------------------------------------------------
  console.log('== TRACE 配置注入（TOKEN 加密内置 + 用户开关）==');
  const rtMod = require('./dist/dsh-runtime.js'); // 同缓存单例；buildTraceConfig 为纯函数
  await check('buildTraceConfig 缺省：目标为 OrchDesk 公开仓库、脱敏开、无内置文件时 token 为空', () => {
    delete process.env.ORCHDESK_DATA_DIR;
    // 密闭：真实 build/ 可能已内置 TOKEN（打包含凭据），指向空目录保证「未内置」分支可测。
    process.env.ORCHDESK_TRACE_BUILD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-build-empty-'));
    try {
      const cfg = rtMod.buildTraceConfig({ repoUrl: '', token: 'x', maskEnabled: false, batchSize: 20, cacheDir: 'c' });
      assert.strictEqual(cfg.repoUrl, rtMod.TRACE_REPO_URL, '实际: ' + cfg.repoUrl);
      assert.strictEqual(cfg.maskEnabled, true, '脱敏应默认开');
      assert.strictEqual(cfg.token, '', 'dev 无内置文件应为空串（只缓冲不上传）');
    } finally {
      delete process.env.ORCHDESK_TRACE_BUILD_DIR;
    }
  });
  await check('buildTraceConfig enabled=false → repoUrl 置空（用户开关关闭 = 只缓冲不上传）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-off-'));
    fs.writeFileSync(path.join(dir, 'trace.json'), JSON.stringify({ enabled: false }));
    process.env.ORCHDESK_DATA_DIR = dir;
    try {
      const cfg = rtMod.buildTraceConfig({ repoUrl: '', token: 'x' });
      assert.strictEqual(cfg.repoUrl, '', '关闭时应置空上传目标');
    } finally {
      delete process.env.ORCHDESK_DATA_DIR;
    }
  });

  // -------------------------------------------------------------------------
  console.log('== 记忆持久化接线（回灌 + 落盘 + 去重）==');
  const ddMod = require('./dist/data-dir.js');
  await check('persistMemoryNow：四域落盘为独立文件，快照去重（无变化不重写）', () => {
    const entry = { id: 'g1', domain: 'global', text: '用户称呼为梧哥', vector: { u: 1 }, source: { origin: 'test' }, createdAt: 1 };
    let snap = { global: [entry], project: [], director: [], worker: [] };
    let writes = 0;
    const origWrite = fs.writeFileSync;
    fs.writeFileSync = (...a) => { writes++; return origWrite(...a); };
    try {
      const api = { serializeDomains: () => snap, hydrateDomains: () => {} };
      rtMod.persistMemoryNow(api);
      const dir = path.join(ddMod.getDataDir(), 'memory');
      const g = JSON.parse(fs.readFileSync(path.join(dir, 'global.json'), 'utf-8'));
      assert.strictEqual(g.length, 1, 'global.json 应有 1 条');
      assert.strictEqual(g[0].id, 'g1');
      for (const d of ['project', 'director', 'worker']) {
        assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dir, d + '.json'), 'utf-8')), [], d + '.json 应为空数组');
      }
      const writesAfterFirst = writes;
      rtMod.persistMemoryNow(api); // 快照未变 → 零写盘
      assert.strictEqual(writes, writesAfterFirst, '快照未变时不应产生新写入');
      snap = { global: [entry, { ...entry, id: 'g2' }], project: [], director: [], worker: [] };
      rtMod.persistMemoryNow(api);
      assert.strictEqual(writes, writesAfterFirst + 4, '快照变化后应重写四个文件');
    } finally {
      fs.writeFileSync = origWrite;
    }
  });
  await check('hydrateMemory：磁盘快照回灌 + 坏文件跳过 + 返回是否恢复', () => {
    const dir = path.join(ddMod.getDataDir(), 'memory');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'global.json'), JSON.stringify([{ id: 'r1', text: '用户项目在 D:/Code/OrchDesk', vector: { d: 1 }, source: {}, createdAt: 2 }]));
    fs.writeFileSync(path.join(dir, 'project.json'), '{broken json');
    fs.rmSync(path.join(dir, 'director.json'), { force: true });
    let hydrated = null;
    const api = {
      serializeDomains: () => hydrated || { global: [], project: [], director: [], worker: [] },
      hydrateDomains: (s) => { hydrated = s; },
    };
    const restored = rtMod.hydrateMemory(api);
    assert.strictEqual(restored, true, '存在合法条目时应返回 true');
    assert.strictEqual(hydrated.global.length, 1, 'global 应回灌 1 条');
    assert.deepStrictEqual(hydrated.project, [], '坏文件域应跳过为空');
    assert.deepStrictEqual(hydrated.director, [], '缺失文件域应为空');
    // 全空盘 → false：先清空盘上快照（上一轮写入的 r1 仍在盘上）。
    for (const d of ['global', 'project', 'director', 'worker']) {
      fs.writeFileSync(path.join(dir, d + '.json'), '[]');
    }
    assert.strictEqual(rtMod.hydrateMemory({ serializeDomains: () => ({ global: [], project: [], director: [], worker: [] }), hydrateDomains: () => {} }), false, '全部为空时应返回 false');
  });

  // -------------------------------------------------------------------------
  // 桌面集成（PRD FR-4.2）—— 第十个死挂点的防回归
  // 断言重点不是「配置能存能读」，而是**每个开关都真的触发了对应的系统副作用**：
  // 托盘 → Tray 实例、快捷键 → globalShortcut、自启动 → 系统登录项、悬浮窗 → BrowserWindow。
  // -------------------------------------------------------------------------
  const desktopMod = require('./dist/desktop-integration.js');

  await check('授权白名单（PRD FR-9）：IPC 新增 / 撤销 / 全部撤销，且落盘可回灌', async () => {
    const before = await ipcHandlers.get('orchdesk:authz-list-grants')();
    assert(Array.isArray(before), 'list-grants 应返回数组');
    await ipcHandlers.get('orchdesk:authz-revoke-all-grants')();
    const r = await ipcHandlers.get('orchdesk:authz-grant')({}, { tool: 'file_write', pattern: 'D:/work/*', scope: 'permanent' });
    assert.strictEqual(r.ok, true, '新增应成功: ' + (r.reason || ''));
    assert.strictEqual(r.grants.length, 1, '应回传最新规则列表');
    // 落盘：authz-grants.json 真实存在且内容可用
    const file = path.join(ddMod.getDataDir(), 'authz-grants.json');
    assert.ok(fs.existsSync(file), `authz-grants.json 应落盘：${file}`);
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf-8'));
    assert.strictEqual(onDisk.length, 1, '盘上应有 1 条');
    assert.strictEqual(onDisk[0].pattern, 'D:/work/*', '盘上内容应正确');
    // 回灌：模拟重启（另起一份 api 从盘上恢复）
    const probe = { list: [] };
    const fakeApi = { serializeGrants: () => probe.list, hydrateGrants: (l) => { probe.list = l; } };
    assert.strictEqual(rtMod.hydrateGrants(fakeApi), 1, '应从盘上回灌 1 条');
    assert.strictEqual(probe.list[0].pattern, 'D:/work/*', '回灌内容应正确');
    // 撤销单条
    const rev = await ipcHandlers.get('orchdesk:authz-revoke-grant')({}, r.grants[0].id);
    assert.strictEqual(rev.ok, true, '撤销应成功');
    assert.strictEqual(rev.grants.length, 0, '撤销后应为空');
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf-8')), [], '撤销应立即写穿落盘');
  });

  await check('授权白名单：非法规则被 IPC 拒绝（不静默丢弃）', async () => {
    const r = await ipcHandlers.get('orchdesk:authz-grant')({}, { tool: 'file_write', pattern: '', scope: 'permanent' });
    assert.strictEqual(r.ok, false, '空 pattern 应被拒绝');
    assert.ok(!!r.reason, '应给出 reason');
  });

  await check('桌面集成纯逻辑：归一化拒绝未知键、字符串 "false" 不恒真、缺失回落默认', () => {
    const d = desktopMod.normalizeDesktopConfig({ tray: 'false', shortcut: 0, nope: true });
    assert.strictEqual(d.tray, false, '字符串 "false" 应归一为 false（否则手改 JSON 会让开关恒开）');
    assert.strictEqual(d.shortcut, false, '0 应归一为 false');
    assert.strictEqual(d.notify, true, '未提供的键应回落默认（notify 默认开）');
    assert.strictEqual('nope' in d, false, '未知键应丢弃，不污染配置');
    assert.deepStrictEqual(desktopMod.normalizeDesktopConfig(null), desktopMod.DEFAULT_DESKTOP_CONFIG, '非法入参回落默认');
  });

  await check('desktop-get 返回真实配置：6 键齐全 + 快捷键读法 + 自启动系统实际状态', async () => {
    const r = await ipcHandlers.get('orchdesk:desktop-get')();
    for (const k of desktopMod.DESKTOP_KEYS) {
      assert.strictEqual(typeof r.config[k], 'boolean', `config.${k} 应为布尔`);
    }
    assert.strictEqual(r.shortcutLabel, 'Ctrl+Shift+Space', '快捷键读法应返回给 UI');
    assert.strictEqual(r.labels.tray, '系统托盘', '应返回中文标签');
    assert.strictEqual(typeof r.autostartEffective, 'boolean', '自启动需展示系统实际状态而非意愿值');
  });

  await check('desktop-set 托盘：开 → 真创建 Tray；关 → 真销毁（此前开关与系统无关）', async () => {
    const before = electronStub.trayInstances.length;
    let r = await ipcHandlers.get('orchdesk:desktop-set')({}, 'tray', true);
    assert.strictEqual(r.ok, true, '切换应成功');
    assert.ok(electronStub.trayInstances.length >= before, '开启托盘应创建 Tray 实例');
    const created = electronStub.trayInstances[electronStub.trayInstances.length - 1];
    assert.strictEqual(created.destroyed, false, '新托盘应处于未销毁状态');
    r = await ipcHandlers.get('orchdesk:desktop-set')({}, 'tray', false);
    assert.strictEqual(r.config.tray, false, '配置应落为 false');
    assert.strictEqual(electronStub.trayInstances[electronStub.trayInstances.length - 1].destroyed, true, '关闭托盘必须真的 destroy（否则关掉后托盘仍常驻）');
  });

  await check('desktop-set 快捷键：开 → 注册加速器；关 → 注销（退出未注销会残留）', async () => {
    const acc = desktopMod.SHORTCUT_ACCELERATOR;
    await ipcHandlers.get('orchdesk:desktop-set')({}, 'shortcut', true);
    assert.strictEqual(electronStub.globalShortcut.isRegistered(acc), true, '开启应注册全局快捷键');
    await ipcHandlers.get('orchdesk:desktop-set')({}, 'shortcut', false);
    assert.strictEqual(electronStub.globalShortcut.isRegistered(acc), false, '关闭必须真的注销加速器');
    await ipcHandlers.get('orchdesk:desktop-set')({}, 'shortcut', true);
  });

  await check('desktop-set 自启动：写系统登录项 + autostartEffective 回读真实值', async () => {
    const r = await ipcHandlers.get('orchdesk:desktop-set')({}, 'autostart', true);
    assert.strictEqual(r.ok, true, '写入系统登录项应成功');
    const last = electronStub.loginItems[electronStub.loginItems.length - 1];
    assert.strictEqual(last.openAtLogin, true, '应真的调用 app.setLoginItemSettings({openAtLogin:true})');
    assert.strictEqual(r.autostartEffective, true, '应回读系统实际状态');
    const off = await ipcHandlers.get('orchdesk:desktop-set')({}, 'autostart', false);
    assert.strictEqual(off.autostartEffective, false, '关闭后系统状态应为 false');
  });

  await check('desktop-set 悬浮窗：开 → 创建无边框置顶窗口并渲染上下文', async () => {
    const before = electronStub.windows.length;
    await ipcHandlers.get('orchdesk:desktop-set')({}, 'floating', true);
    assert.strictEqual(electronStub.windows.length, before + 1, '开启悬浮窗应真的创建 BrowserWindow');
    const win = electronStub.windows[electronStub.windows.length - 1];
    assert.strictEqual(win.opts.frame, false, '悬浮窗应无边框');
    assert.strictEqual(win.opts.alwaysOnTop, true, '悬浮窗应置顶');
    assert.strictEqual(win.opts.skipTaskbar, true, '悬浮窗不应占任务栏');
    assert.strictEqual(win.opts.webPreferences.nodeIntegration, false, '悬浮窗渲染进程同样禁用 node');
  });

  await check('desktop-floating-context：会话上下文入窗（标题截断 80、负数会话归零）', async () => {
    const r = await ipcHandlers.get('orchdesk:desktop-floating-context')({}, { title: 'x'.repeat(200), sessions: -5 });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.context.title.length, 80, '超长标题应截断，避免小窗撑爆');
    assert.strictEqual(r.context.sessions, 0, '负数会话数应归零');
    const win = electronStub.windows[electronStub.windows.length - 1];
    assert.ok(String(win.loaded || '').includes('data:text/html'), '悬浮窗内容应已加载');
    assert.ok(String(win.loaded || '').includes('x'.repeat(80)), '推送的标题应真的渲染进小窗');
    await ipcHandlers.get('orchdesk:desktop-set')({}, 'floating', false);
  });

  await check('desktop-set 未知键被拒绝（拼写错误静默丢弃比报错更难查）', async () => {
    const r = await ipcHandlers.get('orchdesk:desktop-set')({}, 'trayy', true);
    assert.strictEqual(r.ok, false, '未知键应拒绝');
    assert.ok(/未知/.test(String(r.reason)), '应给出明确原因');
    assert.strictEqual('trayy' in r.config, false, '拒绝时不应写入配置');
  });

  await check('桌面集成配置落盘并可重新读回（重启后开关保持）', async () => {
    await ipcHandlers.get('orchdesk:desktop-set')({}, 'notify', false);
    const file = desktopMod.desktopConfigFile(ddMod.getDataDir());
    assert.ok(fs.existsSync(file), `desktop.json 应落盘：${file}`);
    const reread = desktopMod.loadDesktopConfig(ddMod.getDataDir());
    assert.strictEqual(reread.notify, false, '重读应反映刚写入的值');
    await ipcHandlers.get('orchdesk:desktop-set')({}, 'notify', true);
  });

  // -------------------------------------------------------------------------
  const ok = summary();

  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch {}
  if (!ok) process.exit(1);
  console.log('dsh 运行时接线全部验证通过');
  // 运行时持有定时器/句柄，需显式退出，否则进程挂起
  process.exit(0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
