/**
 * 本地插件市场验证（PRD FR-3）。
 *
 * A 组：纯逻辑（require dist/plugin-market.js）—— manifest 校验 / 启用状态归一化 / 目录名。
 * B 组：stub electron 驱动真实 IPC + 真实 cordis 运行时 —— 种子插件目录（合法 / manifest
 *       非法 / 缺 index.js），验证：扫描不执行代码、启用 = 真装载（服务真的注册进 ctx）、
 *       停用 = 真卸载（服务消失，逆回滚无残留）、非法输入 fail-closed、启用意愿写穿落盘。
 *
 * 运行：node plugin-market-verify.cjs
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');

const APP_DIR = __dirname;
const PM = require(path.join(APP_DIR, 'dist', 'plugin-market.js'));

let passed = 0; let failed = 0; const log = [];
async function check(name, fn) {
  try { await fn(); passed += 1; log.push(`  PASS  ${name}`); }
  catch (e) { failed += 1; log.push(`  FAIL  ${name}\n        ${e && e.message || e}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

(async () => {
  /* ============================== A 组：纯逻辑 ============================== */
  console.log('== 本地插件市场：manifest 与状态（FR-3）==');

  await check('manifest 全字段合法 → 归一化通过', () => {
    const r = PM.validateMarketManifest({ name: '我的插件', version: '1.2.3', description: 'd', caps: ['fs.read'], inject: ['memory'] }, 'dir1');
    assert(r.ok, '应通过: ' + JSON.stringify(r));
    assert(r.manifest.version === '1.2.3' && r.manifest.caps.length === 1 && r.manifest.inject[0] === 'memory', '字段应保留');
  });

  await check('manifest 缺省字段 → version/desc/caps/inject 给默认值（不炸）', () => {
    const r = PM.validateMarketManifest({ name: 'x' }, 'dir2');
    assert(r.ok && r.manifest.version === '0.0.0' && r.manifest.description === '' && r.manifest.caps.length === 0 && r.manifest.inject.length === 0, '默认值错误: ' + JSON.stringify(r));
  });

  await check('manifest.name 缺失 / 非字符串 → 失败且报目录名', () => {
    const a = PM.validateMarketManifest({}, 'dirA');
    const b = PM.validateMarketManifest({ name: 42 }, 'dirB');
    assert(!a.ok && /dirA/.test(a.error), '应报目录名: ' + JSON.stringify(a));
    assert(!b.ok && /dirB/.test(b.error), '应报目录名: ' + JSON.stringify(b));
  });

  await check('manifest caps / inject 非数组 → 丢弃为空（脏数据不炸）；超长截断', () => {
    const r = PM.validateMarketManifest({ name: 'x', caps: 'fs.read', inject: [1, null, 'ok'], description: '长'.repeat(500) }, 'dirC');
    assert(r.ok && r.manifest.caps.length === 0, '非数组 caps 应丢弃');
    assert(r.manifest.inject.length === 1 && r.manifest.inject[0] === 'ok', 'inject 应滤掉非字符串，实际 ' + JSON.stringify(r.manifest.inject));
    assert(r.manifest.description.length === PM.MANIFEST_FIELD_MAX, 'description 应截断');
  });

  await check('启用状态归一化：非布尔 → false（fail-closed）；路径穿越 key 丢弃', () => {
    const m = PM.normalizeEnabledMap({ a: true, b: 'yes', c: 1, d: false, '../evil': true, 'sub/dir': true });
    assert(m.a === true && m.d === false, '布尔应保留');
    assert(m.b === false && m.c === false, '非布尔必须按 false（默认不装载第三方代码）');
    assert(!('../evil' in m) && !('sub/dir' in m), '路径穿越 key 应丢弃');
    assert(Object.keys(PM.normalizeEnabledMap(null)).length === 0, '非对象 → 空表');
  });

  await check('目录名校验：穿越 / 隐藏目录 / 空串 → 拒绝', () => {
    assert(PM.isMarketDirName('my-plugin') === true, '合法名应通过');
    assert(!PM.isMarketDirName('../evil') && !PM.isMarketDirName('a/b') && !PM.isMarketDirName('.hidden') && !PM.isMarketDirName('') && !PM.isMarketDirName('..') && !PM.isMarketDirName(42), '非法名应拒绝');
  });

  /* ===================== B 组：真 IPC + 真 cordis 运行时 ===================== */
  console.log('== 本地插件市场：真装载链路（stub electron）==');

  const probe = runProbe();
  await check('扫描：3 个目录标志正确（合法 / manifest 非法 / 缺 index.js）', () => {
    const by = (d) => probe.items.find((x) => x.dir === d);
    assert(probe.items.length === 3, `应扫到 3 个，实际 ${probe.items.length}`);
    const good = by('e2e-echo');
    assert(good.manifestOk && good.hasEntry && good.manifest.name === 'E2E 回声插件', '合法目录标志错误: ' + JSON.stringify(good));
    const bad = by('bad-manifest');
    assert(!bad.manifestOk && /manifest.name/.test(bad.error), '非法 manifest 应带具体原因: ' + bad.error);
    const missing = by('no-entry');
    assert(missing.manifestOk && !missing.hasEntry && /index\.js/.test(missing.error), '缺产物应报 index.js: ' + missing.error);
    assert(probe.items.every((x) => !x.enabled && !x.active), '初始应全部未启用（fail-closed）');
  });

  await check('启用合法插件 → 真装载：active 且服务注册进 ctx', () => {
    assert(probe.toggleOn.ok === true && probe.toggleOn.state.active === true, '应激活: ' + JSON.stringify(probe.toggleOn));
    assert(probe.serviceAfterOn && probe.serviceAfterOn.pong === 'e2e', `服务应可取（${JSON.stringify(probe.serviceAfterOn)}）`);
  });

  await check('停用 → 服务从 ctx 消失（逆回滚无残留，不是 UI 上消失而已）', () => {
    assert(probe.toggleOff.ok === true && probe.toggleOff.state.active === false, '应停用: ' + JSON.stringify(probe.toggleOff));
    assert(probe.serviceAfterOff === null, '停用后服务应不可取，实际 ' + JSON.stringify(probe.serviceAfterOff));
  });

  await check('已激活时重复启用幂等：不注册第二份 effect', () => {
    assert(probe.toggleAgain.ok === true && probe.toggleAgain.state.active === true, '重新启用应仍激活');
    assert(probe.pongCountAfterTwice === 2, `off→on 一次装载一轮，应为 2，实际 ${probe.pongCountAfterTwice}`);
    assert(probe.pongCountAfterIdempotent === 2, `已激活时再启用必须幂等（仍为 2），实际 ${probe.pongCountAfterIdempotent}`);
  });

  await check('manifest 非法 → 启用被拒（fail-closed）且报原因', () => {
    assert(probe.toggleBad.ok === false && /manifest/.test(probe.toggleBad.reason), '应拒绝: ' + JSON.stringify(probe.toggleBad));
  });

  await check('缺 index.js → 启用被拒', () => {
    assert(probe.toggleMissing.ok === false && /index\.js/.test(probe.toggleMissing.reason), '应拒绝: ' + JSON.stringify(probe.toggleMissing));
  });

  await check('目录名路径穿越 → 启用被拒', () => {
    assert(probe.toggleTraversal.ok === false, '路径穿越必须拒绝: ' + JSON.stringify(probe.toggleTraversal));
  });

  await check('启用意愿写穿落盘：plugin-market.json 可解码且与内存一致', () => {
    assert(probe.persisted && probe.persisted['e2e-echo'] === true, '落盘应记 e2e-echo=true，实际 ' + JSON.stringify(probe.persisted));
    assert(probe.persisted.bad !== true, '未启用目录不得记 true');
  });

  await check('startupMarketPlugins 回灌：按持久化意愿重新装载', () => {
    assert(probe.startupResults.length === 1 && probe.startupResults[0].dir === 'e2e-echo' && probe.startupResults[0].ok === true,
      '回灌应只装载已启用的插件并成功: ' + JSON.stringify(probe.startupResults));
    assert(probe.serviceAfterStartup && probe.serviceAfterStartup.pong === 'e2e', '回灌后服务应可用');
  });

  console.log('\n' + log.join('\n'));
  console.log(`\n结果：通过 ${passed} / 失败 ${failed}\n`);
  process.exit(failed ? 1 : 0);
})();

/** 子进程跑真实主进程：stub electron；种子 3 个市场插件目录。 */
function runProbe() {
  const script = `
    const Module = require('module');
    const path = require('path'), fs = require('fs'), os = require('os');
    // probe 脚本落在系统临时目录，__dirname 指向那里 —— 所有路径必须以 APP_DIR 为基准。
    const APP_DIR = ${JSON.stringify(APP_DIR)};
    const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'orchdesk-mkt-'));
    process.env.ORCHDESK_HOME = HOME;

    // --- 种子市场目录 ---
    const mroot = path.join(HOME, 'plugins');
    fs.mkdirSync(path.join(mroot, 'e2e-echo'), { recursive: true });
    fs.writeFileSync(path.join(mroot, 'e2e-echo', 'manifest.json'), JSON.stringify({
      name: 'E2E 回声插件', version: '1.0.0', description: '验证装载链路',
      caps: ['test.echo'], inject: [],
    }), 'utf-8');
    // CJS 插件：装载即 provide 服务；effect 只挂一次计数器（验证幂等）。
    fs.writeFileSync(path.join(mroot, 'e2e-echo', 'index.js'), \`
      let pongCount = 0;
      module.exports = {
        name: 'e2e-echo',
        inject: [],
        apply(ctx) {
          pongCount += 1;
          ctx.provide('e2eEcho', { pong: 'e2e', pongCount: () => pongCount });
        },
      };
    \`, 'utf-8');
    fs.mkdirSync(path.join(mroot, 'bad-manifest'), { recursive: true });
    fs.writeFileSync(path.join(mroot, 'bad-manifest', 'manifest.json'), JSON.stringify({ version: '1.0.0' }), 'utf-8');
    fs.writeFileSync(path.join(mroot, 'bad-manifest', 'index.js'), 'module.exports = { name: "bad", apply() {} };', 'utf-8');
    fs.mkdirSync(path.join(mroot, 'no-entry'), { recursive: true });
    fs.writeFileSync(path.join(mroot, 'no-entry', 'manifest.json'), JSON.stringify({ name: 'no entry' }), 'utf-8');

    const { makeElectronStub } = require(${JSON.stringify(path.join(APP_DIR, '..', '..', 'scripts', 'verify-kit.cjs'))});
    const stub = makeElectronStub({
      home: HOME,
      getPath: (n) => n === 'appData' ? path.join(HOME, 'ad') : path.join(HOME, 'st', n),
    });
    const ipc = stub.ipcHandlers;
    const orig = Module._load;
    Module._load = function (req) { if (req === 'electron') return stub; return orig.apply(this, arguments); };

    const out = {};
    (async () => {
      require(path.join(APP_DIR, 'dist', 'main.js'));
      // handler 注册早于运行时就绪 —— 必须等 bootRuntime 完成（market-toggle 依赖 runtime）。
      for (let i = 0; i < 200; i++) {
        const h = ipc.get('orchdesk:plugin-runtime');
        if (h) {
          const st = await h(null);
          if (st && st.ready && st.plugins && st.plugins.length >= 9) break;
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      const list = () => ipc.get('orchdesk:market-plugins')(null);
      const toggle = (dir, on) => ipc.get('orchdesk:market-toggle')(null, dir, on);
      const { getService } = require(path.join(APP_DIR, 'dist', 'dsh-runtime.js'));
      const svc = () => getService('e2eEcho');

      const l0 = await list();
      out.items = l0.items;

      // 幂等测试前先取 effect 计数器的初值（应为 1：启用一次）
      const on1 = await toggle('e2e-echo', true);
      out.toggleOn = on1;
      out.serviceAfterOn = svc() ? { pong: svc().pong } : null;

      out.toggleOff = await toggle('e2e-echo', false);
      out.serviceAfterOff = svc();

      out.toggleAgain = await toggle('e2e-echo', true);
      out.pongCountAfterTwice = svc() && typeof svc().pongCount === 'function' ? svc().pongCount() : -1;
      // 已激活时再次启用：必须幂等（不重复 ctx.plugin）
      await toggle('e2e-echo', true);
      out.pongCountAfterIdempotent = svc() && typeof svc().pongCount === 'function' ? svc().pongCount() : -1;

      out.toggleBad = await toggle('bad-manifest', true);
      out.toggleMissing = await toggle('no-entry', true);
      out.toggleTraversal = await toggle('../evil', true);

      // 落盘
      const fsMod = fs;
      const pfile = path.join(HOME, 'plugin-market.json');
      out.persisted = fsMod.existsSync(pfile)
        ? (JSON.parse(fsMod.readFileSync(pfile, 'utf-8')).enabled || {})
        : null;

      // 回灌（先停用，模拟「重启后按意愿重新装载」）
      await toggle('e2e-echo', false);
      const rt = require(path.join(APP_DIR, 'dist', 'dsh-runtime.js'));
      out.startupResults = await rt.startupMarketPlugins({ 'e2e-echo': true, 'bad-manifest': false });
      out.serviceAfterStartup = svc() ? { pong: svc().pong } : null;

      console.log('RESULT_JSON:' + JSON.stringify(out));
      process.exit(0);
    })().catch((e) => { console.log('ERR:' + ((e && e.stack) || e)); process.exit(1); });
  `;
  const tmp = path.join(os.tmpdir(), `mkt-probe-${Date.now()}.cjs`);
  fs.writeFileSync(tmp, script, 'utf-8');
  let stdout = '';
  try {
    stdout = execFileSync(process.execPath, [tmp], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180000 });
  } catch (err) {
    const so = String((err && err.stdout) || '');
    const se = String((err && err.stderr) || '');
    throw new Error(`probe 失败：${err.message}\n${so}\n${se}`);
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* 清理失败不影响结果 */ }
  }
  const m = stdout.match(/RESULT_JSON:(.*)/);
  if (!m) throw new Error('probe 未输出结果：\n' + stdout);
  return JSON.parse(m[1]);
}
