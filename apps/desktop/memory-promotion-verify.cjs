/**
 * 分层记忆晋升（PRD FR-10）验证
 * ----------------------------------------------------------------------------
 * 1. 晋升审计纯逻辑：归一化 / 环形缓冲 / 检索 / 统计（memory-promotion.ts）
 * 2. 真实 IPC 驱动：stub electron 后 require dist/main.js，用真实 handler 走完
 *    「写 worker 域 → 晋升 → 审计落盘 → 回读」全链路
 *
 * 分工：插件侧的晋升**语义**（fail-closed、来源标注、域隔离）由
 * scripts/verify-plugins.mjs 的「memory/晋升」组覆盖；本套件覆盖调用链与持久化。
 *
 * 运行：node memory-promotion-verify.cjs   （需先 npx tsc -p tsconfig.json）
 */

const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

let passed = 0;
let failed = 0;
const log = [];
async function check(name, fn) {
  try { await fn(); passed++; log.push(`  PASS  ${name}`); }
  catch (err) { failed++; log.push(`  FAIL  ${name}\n        ${(err && err.message) || err}`); }
}

const promo = require('./dist/memory-promotion.js');

(async () => {
  console.log('\n== A. 晋升审计纯逻辑 ==');

  await check('normalize：缺 from/to/memoryId → null（不存不可检索的脏数据）', () => {
    assert.strictEqual(promo.normalizePromotionEntry(null), null);
    assert.strictEqual(promo.normalizePromotionEntry({ from: 'worker', to: 'director' }), null, '缺 memoryId');
    assert.strictEqual(promo.normalizePromotionEntry({ from: 'worker', to: 'nope', memoryId: 'm1' }), null, '域名非法');
    assert.strictEqual(promo.normalizePromotionEntry({ from: 'nope', to: 'director', memoryId: 'm1' }), null, '源域非法');
  });

  await check('normalize：补全 id/ts，preview 截断', () => {
    const e = promo.normalizePromotionEntry({
      from: 'worker', to: 'director', memoryId: 'm1',
      preview: 'x'.repeat(500), ok: false, reason: 'director-rejected:too weak',
    });
    assert.ok(e && e.id, '应补全 id');
    assert.ok(e.ts > 0, '应补全 ts');
    assert.ok(e.preview.length <= promo.PROMOTION_PREVIEW_MAX + 1, 'preview 应被截断，实际 ' + e.preview.length);
    assert.ok(/…$/.test(e.preview), '截断应以省略号结尾');
  });

  await check('actor 只认 user / auto（其它值回落 user）', () => {
    assert.strictEqual(promo.normalizePromotionEntry({ from: 'worker', to: 'director', memoryId: 'm', actor: 'auto' }).actor, 'auto');
    assert.strictEqual(promo.normalizePromotionEntry({ from: 'worker', to: 'director', memoryId: 'm', actor: 'hacker' }).actor, 'user');
    assert.strictEqual(promo.normalizePromotionEntry({ from: 'worker', to: 'director', memoryId: 'm' }).actor, 'user');
  });

  await check('append 不改原数组 + 环形淘汰最旧', () => {
    const list = [];
    const out = promo.appendPromotionLog(list, { from: 'worker', to: 'director', memoryId: 'm1', ts: 1 });
    assert.strictEqual(list.length, 0, '原数组不应被修改');
    assert.strictEqual(out.length, 1);
    let acc = out;
    for (let i = 2; i <= promo.PROMOTION_LOG_MAX + 20; i++) {
      acc = promo.appendPromotionLog(acc, { from: 'worker', to: 'director', memoryId: 'm' + i, ts: i });
    }
    assert.strictEqual(acc.length, promo.PROMOTION_LOG_MAX, '应截断到上限，实际 ' + acc.length);
    assert.strictEqual(acc[acc.length - 1].memoryId, 'm' + (promo.PROMOTION_LOG_MAX + 20), '应保留最新的');
    assert.strictEqual(acc[0].memoryId, 'm21', '应淘汰最旧的，实际首条 ' + acc[0].memoryId);
  });

  await check('入场即归一：坏条目 append 后长度不变', () => {
    const out = promo.appendPromotionLog([], { from: 'worker' });
    assert.strictEqual(out.length, 0, '缺字段的条目不应入场');
  });

  const SEED = [
    { ts: 1, from: 'worker', to: 'director', memoryId: 'a1', preview: 'Worker 说磁盘满了', ok: true, reason: 'promoted:worker->director', actor: 'auto' },
    { ts: 2, from: 'worker', to: 'director', memoryId: 'a2', preview: 'Worker 猜测是缓存', ok: false, reason: 'director-rejected:未证实', actor: 'auto' },
    { ts: 3, from: 'director', to: 'project', memoryId: 'a3', preview: '磁盘阈值 80%', ok: true, reason: 'promoted:director->project', actor: 'user' },
    { ts: 4, from: 'project', to: 'global', memoryId: 'a4', preview: '用户偏好中文回复', ok: true, reason: 'promoted:project->global', actor: 'user' },
  ].map((e) => promo.normalizePromotionEntry(e));

  await check('检索：默认从新到老', () => {
    const out = promo.searchPromotionLog(SEED);
    assert.strictEqual(out.length, 4);
    assert.strictEqual(out[0].memoryId, 'a4', '第一条应是最新的 a4');
  });

  await check('检索：ok 同时吃布尔与字符串（<select> 传的是字符串）', () => {
    assert.strictEqual(promo.searchPromotionLog(SEED, { ok: false }).length, 1, '布尔 false');
    assert.strictEqual(promo.searchPromotionLog(SEED, { ok: 'false' }).length, 1, '字符串 false');
    assert.strictEqual(promo.searchPromotionLog(SEED, { ok: true }).length, 3, '布尔 true');
    assert.strictEqual(promo.searchPromotionLog(SEED, { ok: 'true' }).length, 3, '字符串 true');
    assert.strictEqual(promo.searchPromotionLog(SEED, { ok: 'all' }).length, 4, "'all' 不过滤");
    assert.strictEqual(promo.searchPromotionLog(SEED, {}).length, 4, '不传不过滤');
  });

  await check('检索：按 to / from 过滤', () => {
    assert.strictEqual(promo.searchPromotionLog(SEED, { to: 'director' }).length, 2);
    assert.strictEqual(promo.searchPromotionLog(SEED, { from: 'worker' }).length, 2);
    assert.strictEqual(promo.searchPromotionLog(SEED, { from: 'worker', to: 'project' }).length, 0, '组合过滤应求交');
  });

  await check('检索：关键词命中 preview / memoryId / reason', () => {
    assert.strictEqual(promo.searchPromotionLog(SEED, { keyword: '磁盘' }).length, 2, 'preview 命中');
    assert.strictEqual(promo.searchPromotionLog(SEED, { keyword: 'a3' }).length, 1, 'memoryId 命中');
    assert.strictEqual(promo.searchPromotionLog(SEED, { keyword: '未证实' }).length, 1, 'reason 命中');
    assert.strictEqual(promo.searchPromotionLog(SEED, { keyword: 'DISK' }).length, 0, '大小写不敏感只对 ASCII 有效，此处本就无匹配');
    assert.strictEqual(promo.searchPromotionLog(SEED, { keyword: '   ' }).length, 4, '纯空白 = 不过滤');
  });

  await check('检索：limit 生效', () => {
    assert.strictEqual(promo.searchPromotionLog(SEED, { limit: 2 }).length, 2);
    assert.strictEqual(promo.searchPromotionLog(SEED, { limit: 0 }).length, 4, 'limit=0 视为未设置，回落默认 100');
    assert.strictEqual(promo.searchPromotionLog(SEED, { limit: -5 }).length, 4, '负 limit 回落默认');
  });

  await check('统计：成功/失败分计 + 按边聚合降序', () => {
    const s = promo.promotionStats(SEED);
    assert.strictEqual(s.total, 4);
    assert.strictEqual(s.promoted, 3);
    assert.strictEqual(s.rejected, 1);
    assert.strictEqual(s.byEdge[0].edge, 'worker->director');
    assert.strictEqual(s.byEdge[0].count, 2);
  });

  await check('normalizePromotionLog：从任意输入重建（坏条目跳过 + 截断）', () => {
    const out = promo.normalizePromotionLog([
      { from: 'worker', to: 'director', memoryId: 'ok1' },
      null, 'x', { from: 'worker' },
      { from: 'project', to: 'global', memoryId: 'ok2' },
    ]);
    assert.strictEqual(out.length, 2, '只应保留 2 条合法条目，实际 ' + out.length);
    assert.strictEqual(promo.normalizePromotionLog('not-array').length, 0);
    assert.strictEqual(promo.normalizePromotionLog(undefined).length, 0);
  });

  console.log('\n== B. 真实 IPC 驱动（stub electron + dist/main.js）==');

  const probe = runProbe();

  await check('记忆服务装载：worker 域写入 2 条可被列出', () => {
    assert.strictEqual(probe.listLen, 2, `worker 域应有 2 条，实际 ${probe.listLen}`);
    assert.ok(probe.listIds.every((id) => typeof id === 'string' && id), '条目 id 应为非空字符串');
  });

  await check('fail-closed：无 Director 过滤器时晋升被拒（ok=false）', () => {
    assert.strictEqual(probe.rejectedOk, false, '应被拒绝，实际 ' + JSON.stringify(probe.rejectedReason));
    assert.ok(/director-rejected|filter/.test(String(probe.rejectedReason)), '原因应指向 Director 过滤，实际 ' + probe.rejectedReason);
  });

  await check('被拦下的晋升也入审计（拦截证据不能只记成功）', () => {
    assert.ok(probe.auditAfterReject >= 1, `被拒后审计应有记录，实际 ${probe.auditAfterReject}`);
    assert.strictEqual(probe.rejectedStats.rejected, 1, '统计应记 1 条被拦，实际 ' + JSON.stringify(probe.rejectedStats));
  });

  await check('Director 放行后晋升成功，条目从 worker 移到 director', () => {
    assert.strictEqual(probe.approveOk, true, '放行后应成功，实际 ' + probe.approveReason);
    assert.strictEqual(probe.workerAfter, 1, `worker 域应剩 1 条，实际 ${probe.workerAfter}`);
    assert.strictEqual(probe.directorAfter, 1, `director 域应有 1 条，实际 ${probe.directorAfter}`);
  });

  await check('审计落盘可回读（写穿，重启后仍可追溯）', () => {
    assert.ok(probe.persisted >= 2, `落盘文件应含 >=2 条，实际 ${probe.persisted}`);
    assert.ok(probe.persistFileOk, 'memory-promotions.json 应可解析为数组');
  });

  await check('批量晋升：逐条过 Director 过滤', () => {
    // 批量前 worker 域有 4 条（结论二 + 三/四/五；结论一已被单条晋升走），
    // director 域已有 1 条 → 批量后 director 应为 5 条。
    assert.strictEqual(probe.batchPromoted, 4, `应晋升 4 条，实际 ${JSON.stringify(probe.batch)}`);
    assert.strictEqual(probe.batchRemaining, 0, '4 条未超上限，不应有剩余');
    assert.strictEqual(probe.directorAfterBatch, 5, `director 域应共 5 条，实际 ${probe.directorAfterBatch}`);
  });

  await check('批量晋升上限：超出部分报 remaining 且不处理', () => {
    assert.strictEqual(probe.batchCapAttempted, 20, `一次最多处理 20 条，实际 ${probe.batchCapAttempted}`);
    assert.strictEqual(probe.batchCapRemaining, 5, `应剩 5 条，实际 ${probe.batchCapRemaining}`);
  });

  await check('非法参数被拒且**不**入审计（参数错误不值得留痕）', () => {
    assert.strictEqual(probe.badDomain.reason, 'bad-domain');
    assert.strictEqual(probe.badId.reason, 'bad-id');
    assert.strictEqual(probe.auditAfterBad, probe.auditBeforeBad, '非法参数不应写入审计');
  });

  await check('域名非法时 memory-list 返回 null（不回传空数组冒充「空域」）', () => {
    assert.strictEqual(probe.listBadDomain, null, '实际 ' + JSON.stringify(probe.listBadDomain));
  });

  await check('清空审计归零', () => {
    assert.strictEqual(probe.clearOk, true);
    assert.strictEqual(probe.afterClearTotal, 0, '清空后应为 0，实际 ' + probe.afterClearTotal);
  });

  // -------------------------------------------------------------------------
  console.log('\n' + log.join('\n'));
  console.log(`\n结果：通过 ${passed} / 失败 ${failed}\n`);
  process.exit(failed ? 1 : 0);
})();

/**
 * 子进程跑真实主进程（stub electron）。
 * 与 credentials-verify.cjs 的 runToolProbe 同套路：真实 handler + 真实落盘，
 * 只把 electron 换成 stub，避免 mock 掩盖「IPC 名写错 / 落盘路径写错」这类问题。
 */
function runProbe() {
  const script = `
    const Module = require('module');
    const path = require('path'), fs = require('fs'), os = require('os');
    // probe 脚本落在系统临时目录，__dirname 指向那里 —— 所有路径必须以 APP_DIR 为基准，
    // 直接写 __dirname 会解析到 temp（这是第一次跑就踩到的坑）。
    const APP_DIR = ${JSON.stringify(__dirname)};
    const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'orchdesk-promo-'));
    process.env.ORCHDESK_HOME = HOME;
    const { makeElectronStub } = require(${JSON.stringify(path.join(__dirname, '..', '..', 'scripts', 'verify-kit.cjs'))});
    const stub = makeElectronStub({
      home: HOME,
      getPath: (n) => n === 'appData' ? path.join(HOME, 'ad') : path.join(HOME, 'st', n),
    });
    const ipc = stub.ipcHandlers;
    const orig = Module._load;
    Module._load = function (req) { if (req === 'electron') return stub; return orig.apply(this, arguments); };
    require(${JSON.stringify(path.join(__dirname, 'dist', 'main.js'))});

    const D = path.join(APP_DIR, 'dist');
    const out = {};
    (async () => {
      // 等 bootRuntime 完成（plugin-runtime handler 注册早于运行时就绪，直接 kick 会竞态）
      for (let i = 0; i < 200; i++) {
        const h = ipc.get('orchdesk:plugin-runtime');
        if (h) {
          const st = await h(null);
          if (st && st.ready && st.plugins && st.plugins.length >= 9) break;
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      const { getService } = require(path.join(D, 'dsh-runtime.js'));
      const mem = getService('memory');
      if (!mem) { console.log('ERR: memory service unavailable'); process.exit(1); }

      const list = (d) => ipc.get('orchdesk:memory-list')(null, d);
      const stats = async () => (await ipc.get('orchdesk:memory-promotions')(null, {}));
      const promote = (id, from, to) => ipc.get('orchdesk:memory-promote')(null, { id, from, to });

      // --- 1. 种子：往 worker 域写 2 条（模拟 SubAgent 结果落域）---
      mem.record('worker', 'Worker 结论一：磁盘占用达到阈值', { origin: 'subagent:W-1' });
      mem.record('worker', 'Worker 结论二：建议清理缓存', { origin: 'subagent:W-2' });
      const l0 = await list('worker');
      out.listLen = (l0 || []).length;
      out.listIds = (l0 || []).map((e) => e.id);
      out.listBadDomain = await list('nope');

      // --- 2. fail-closed：未注入 Director 过滤器 → 拒绝 ---
      const r1 = await promote(out.listIds[0], 'worker', 'director');
      out.rejectedOk = r1.ok;
      out.rejectedReason = r1.reason;
      const s1 = await stats();
      out.auditAfterReject = s1.total;
      out.rejectedStats = s1.stats;

      // --- 3. 注入放行过滤器 → 晋升成功 ---
      const brainEntry = path.join(APP_DIR, 'vendor', 'plugins', 'brain', 'index.js');
      const brainMod = await import('file://' + brainEntry.replace(/\\\\/g, '/'));
      brainMod.setDirectorFilter(() => true);
      const r2 = await promote(out.listIds[0], 'worker', 'director');
      out.approveOk = r2.ok;
      out.approveReason = r2.reason;
      out.workerAfter = ((await list('worker')) || []).length;
      out.directorAfter = ((await list('director')) || []).length;

      // --- 4. 审计落盘可回读 ---
      const pf = path.join(HOME, 'memory-promotions.json');
      try {
        const raw = JSON.parse(fs.readFileSync(pf, 'utf-8'));
        out.persistFileOk = Array.isArray(raw);
        out.persisted = (raw || []).length;
      } catch (e) { out.persistFileOk = false; out.persisted = 0; }

      // --- 5. 批量晋升（3 条）---
      mem.record('worker', 'Worker 结论三', { origin: 'subagent:W-3' });
      mem.record('worker', 'Worker 结论四', { origin: 'subagent:W-4' });
      mem.record('worker', 'Worker 结论五', { origin: 'subagent:W-5' });
      const b1 = await ipc.get('orchdesk:memory-promote-worker')(null, { to: 'director' });
      out.batch = b1;
      out.batchPromoted = b1.promoted;
      out.batchRemaining = b1.remaining;
      out.directorAfterBatch = ((await list('director')) || []).length;

      // --- 6. 批量上限：塞 25 条，应只处理 20 条 ---
      for (let i = 0; i < 25; i++) mem.record('worker', '批量上限测试 ' + i, { origin: 'subagent:cap-' + i });
      const b2 = await ipc.get('orchdesk:memory-promote-worker')(null, { to: 'director' });
      out.batchCapAttempted = b2.attempted;
      out.batchCapRemaining = b2.remaining;

      // --- 7. 非法参数不入审计 ---
      const before = await stats();
      out.auditBeforeBad = before.total;
      out.badDomain = await promote('x', 'worker', 'nope');
      out.badId = await promote('', 'worker', 'director');
      out.auditAfterBad = (await stats()).total;

      // --- 8. 清空 ---
      const cl = await ipc.get('orchdesk:memory-promotions-clear')(null);
      out.clearOk = cl.ok;
      out.afterClearTotal = (await stats()).total;

      console.log('RESULT_JSON:' + JSON.stringify(out));
      process.exit(0);
    })().catch((e) => { console.log('ERR:' + (e && e.stack || e)); process.exit(1); });
  `;
  const tmp = path.join(os.tmpdir(), `promo-probe-${Date.now()}.cjs`);
  fs.writeFileSync(tmp, script, 'utf-8');
  let stdout = '';
  try {
    stdout = execFileSync(process.execPath, [tmp], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 });
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
