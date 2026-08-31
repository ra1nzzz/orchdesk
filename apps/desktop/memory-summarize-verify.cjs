/**
 * FR-10 记忆摘要 seam（宿主侧）验证
 * ----------------------------------------------------------------------------
 * 第十五个死挂点：memory 插件的 setSummarize 实现完整，但**全项目零调用方** ——
 * 上下文达 80% 触发的自动转储一直走「首尾各 3 条截断 200 字」的抽取式兜底，
 * PRD FR-10 要求的「LLM 摘要 → 语义分块 → 向量编码 → 注入」只完成后两步。
 *
 * 本套件分两段：
 *   A. 纯逻辑（memory-summarize.ts）：提示词 / 文本抽取 / 截断 / 超时
 *   B. 真链路（stub electron + 本地 HTTP mock 网关 + dist/main.js）：
 *      seam 是否真被注入、是否真去调模型、模型挂了是否真回落兜底。
 *      B 段是这一段的关键 —— 只测插件侧的 setSummarize 契约（已在
 *      scripts/verify-plugins.mjs 覆盖）证明不了「宿主来接线了没有」。
 *
 * 运行：node memory-summarize-verify.cjs   （需先 npx tsc -p tsconfig.json）
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

const ms = require('./dist/memory-summarize.js');

(async () => {
  console.log('\n== A. 摘要纯逻辑 ==');

  await check('extractSummarizeText：字符串 / ContentBlock[] / 垃圾值都能吃', () => {
    assert.strictEqual(ms.extractSummarizeText({ content: '纯文本' }), '纯文本');
    assert.strictEqual(
      ms.extractSummarizeText({ content: [{ type: 'text', text: '块一' }, { type: 'text', text: '块二' }] }),
      '块一\n块二',
    );
    // 非文本块（图片引用等）不该混进来 —— 混进来就是给模型喂 URL 噪声。
    assert.strictEqual(
      ms.extractSummarizeText({ content: [{ type: 'image', url: 'x' }, { type: 'text', text: '正文' }] }),
      '正文',
    );
    assert.strictEqual(ms.extractSummarizeText(null), '');
    assert.strictEqual(ms.extractSummarizeText(undefined), '');
    assert.strictEqual(ms.extractSummarizeText({}), '');
    assert.strictEqual(ms.extractSummarizeText({ content: 123 }), '');
  });

  await check('joinSummarizeInput：拼接 & 超长截断保留**尾部**（最近的最关键）', () => {
    const joined = ms.joinSummarizeInput(['一', '二', '三']);
    assert.strictEqual(joined, '一\n二\n三');
    const long = ms.joinSummarizeInput(['A'.repeat(100), 'B'.repeat(100)], 60);
    assert.ok(long.length <= 60 + 20, '应被截断，实际长度 ' + long.length);
    assert.ok(long.includes('B'), '尾部（最新）应保留');
    assert.ok(!long.includes('A'.repeat(20)), '头部应被截断掉');
    assert.ok(/前文已省略/.test(long), '截断要有标记，避免误以为是完整原文');
  });

  await check('joinSummarizeInput：空 / 非法输入不炸，非法 budget 回落默认', () => {
    assert.strictEqual(ms.joinSummarizeInput([]), '');
    assert.strictEqual(ms.joinSummarizeInput(['', '  ', null]), '');
    assert.strictEqual(ms.joinSummarizeInput(['A'.repeat(100)], 0).length, 100, 'budget=0 应回落默认（不截断）');
    assert.strictEqual(ms.joinSummarizeInput(['A'.repeat(100)], NaN).length, 100);
  });

  await check('buildSummarizeMessages：system + user 两条，原文进 user', () => {
    const out = ms.buildSummarizeMessages(['PostgreSQL 连接池要扩容', '下周三发版']);
    assert.strictEqual(out.length, 2);
    assert.strictEqual(out[0].role, 'system');
    assert.strictEqual(out[1].role, 'user');
    assert.ok(out[1].content.includes('PostgreSQL 连接池要扩容'), '原文应进 user 消息');
    assert.ok(out[1].content.includes('下周三发版'));
  });

  await check('提示词硬性要求「只压缩不改写、保留原词」（召回是词面匹配）', () => {
    // 召回端是本地 TF-IDF，纯词面匹配：模型把「PostgreSQL 连接池」润色成
    // 「数据库连接管理」，用户下次问 postgresql 就再也命中不了。提示词必须
    // 把这条约束写死，否则 LLM 摘要反而**降低**召回率。
    const s = ms.SUMMARIZE_SYSTEM;
    assert.ok(/保留/.test(s) && /专有名词|关键名词/.test(s), '应要求保留关键名词/专有名词');
    assert.ok(/不要|不输出/.test(s), '应约束输出形态');
    assert.ok(ms.SUMMARIZE_MAX_OUTPUT <= 500, '摘要上限不应过长（稀释 TF-IDF）');
  });

  await check('clampSummary：去空白 + 限长；空结果返回空串（供调用方回落）', () => {
    assert.strictEqual(ms.clampSummary('  摘要  '), '摘要');
    assert.strictEqual(ms.clampSummary(''), '');
    assert.strictEqual(ms.clampSummary('   '), '');
    assert.strictEqual(ms.clampSummary(null), '');
    assert.strictEqual(ms.clampSummary('x'.repeat(1000), 50).length, 50);
    assert.strictEqual(ms.clampSummary('短', 0).length, 1, 'budget=0 回落默认（短文本不受影响）');
  });

  await check('withTimeout：正常值原样返回', async () => {
    const v = await ms.withTimeout(Promise.resolve('ok'), 500);
    assert.strictEqual(v, 'ok');
  });

  await check('withTimeout：超时 reject，且吞掉原 Promise 的迟到 rejection', async () => {
    let unhandled = false;
    const onUnhandled = () => { unhandled = true; };
    process.on('unhandledRejection', onUnhandled);
    // 原 Promise 在超时**之后**才 reject —— 这时它已经没人 await 了，
    // 不管住就会变成 unhandledRejection 把主进程拖死。
    const slow = new Promise((_, rej) => setTimeout(() => rej(new Error('迟到错误')), 40));
    let msg = '';
    await ms.withTimeout(slow, 15).then(() => { msg = 'resolved'; }, (e) => { msg = e.message; });
    await new Promise((r) => setTimeout(r, 80));
    process.off('unhandledRejection', onUnhandled);
    assert.strictEqual(msg, 'summarize-timeout:15ms', '实际 ' + msg);
    assert.strictEqual(unhandled, false, '原 Promise 的迟到 rejection 必须被吞掉');
  });

  await check('withTimeout：非法 ms 回落默认（0 / 负数 / NaN 不会立刻超时）', async () => {
    for (const bad of [0, -1, NaN]) {
      const v = await ms.withTimeout(Promise.resolve('x'), bad);
      assert.strictEqual(v, 'x', 'ms=' + bad + ' 应回落默认');
    }
  });

  console.log('\n== B. 真链路（stub electron + 本地 mock 网关 + dist/main.js）==');

  const probe = runProbe();

  await check('seam 已由宿主注入（第十五个死挂点：此前零调用方）', () => {
    assert.strictEqual(probe.statusNoModel.seam, true,
      'bootRuntime 应把摘要实现注入 memory 服务，实际 ' + JSON.stringify(probe.statusNoModel));
  });

  await check('未配置模型 → 状态如实报 extractive（不冒充 llm）', () => {
    assert.strictEqual(probe.statusNoModel.mode, 'extractive',
      '没模型就不能说在用 LLM 摘要，实际 ' + JSON.stringify(probe.statusNoModel));
    assert.strictEqual(probe.statusNoModel.model, '');
  });

  await check('配置模型后 → 状态转 llm，并带出提供商/模型名', () => {
    assert.strictEqual(probe.statusWithModel.mode, 'llm', '实际 ' + JSON.stringify(probe.statusWithModel));
    assert.ok(probe.statusWithModel.provider, '应带出提供商名');
    assert.ok(probe.statusWithModel.model, '应带出模型名');
  });

  await check('真调模型：dump 走 LLM 摘要（mode=llm，块内容来自模型）', () => {
    assert.strictEqual(probe.dumpMode, 'llm', '实际 mode=' + probe.dumpMode);
    assert.strictEqual(probe.chunkCount, 3, `12 条长消息应切 3 块，实际 ${probe.chunkCount}`);
    assert.ok(/^模型摘要：/.test(String(probe.firstChunk)),
      '块内容应来自模型回复，实际 ' + JSON.stringify(probe.firstChunk));
  });

  await check('送进模型的请求：带 system 约束 + 原文片段（不是空请求）', () => {
    assert.ok(probe.reqSystem, '请求应带 system 提示词');
    assert.ok(/记忆压缩器/.test(String(probe.reqSystem)), 'system 应是摘要提示词，实际 ' + probe.reqSystem);
    assert.ok(probe.reqUserHasOriginal, 'user 消息应含原文片段（否则模型无从摘要）');
  });

  await check('模型报错（HTTP 500）→ 真回落抽取式兜底，块数不减（fail-open）', () => {
    assert.strictEqual(probe.failMode, 'extractive', '模型挂了应回落，实际 mode=' + probe.failMode);
    assert.strictEqual(probe.failChunkCount, 3, `块数不应减少，实际 ${probe.failChunkCount}`);
    assert.ok(/^摘要（抽取式）/.test(String(probe.failFirstChunk)),
      '应回落抽取式，实际 ' + JSON.stringify(probe.failFirstChunk));
  });

  await check('兜底后记忆仍写入且可召回（转储没有化为乌有）', () => {
    assert.ok(probe.recallAfterFail > 0, '回落后的条目也应可被召回，实际命中 ' + probe.recallAfterFail);
  });

  // -------------------------------------------------------------------------
  console.log('\n' + log.join('\n'));
  console.log(`\n结果：通过 ${passed} / 失败 ${failed}\n`);
  process.exit(failed ? 1 : 0);
})();

/**
 * 子进程跑真实主进程：stub electron + 本地 mock 网关。
 * 与 memory-promotion-verify.cjs 的 runProbe 同套路，区别是这里额外起一个
 * node:http 服务充当模型网关 —— 只有真发出 HTTP 请求，才能证明 seam 接的是
 * 模型而不是又一层占位。
 */
function runProbe() {
  const APP_DIR = __dirname;
  const script = `
    const Module = require('module');
    const path = require('path'), fs = require('fs'), os = require('os'), http = require('http');
    // probe 脚本落在系统临时目录，__dirname 指向那里 —— 所有路径必须以 APP_DIR 为基准。
    const APP_DIR = ${JSON.stringify(APP_DIR)};
    const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'orchdesk-msum-'));
    process.env.ORCHDESK_HOME = HOME;

    // --- 本地 mock 网关：'ok' 返回固定摘要，'fail' 返回 500 ---
    let mode = 'ok';
    let lastBody = null;
    let firstBody = null;
    const REPLY = '模型摘要：已确认数据库分片方案，下周三发版';
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        try { lastBody = JSON.parse(Buffer.concat(chunks).toString('utf-8')); } catch (e) { lastBody = null; }
        // 一次 dump 会按块发多次请求，断言「原文送进去了」要看**第一块**（含分片-0）。
        if (!firstBody) firstBody = lastBody;
        if (mode === 'fail') {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end('upstream boom');
          return;
        }
        const payload = JSON.stringify({ choices: [{ message: { content: REPLY } }] });
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
        res.end(payload);
      });
    });

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
      await new Promise((r) => server.listen(0, '127.0.0.1', r));
      const port = server.address().port;

      require(path.join(APP_DIR, 'dist', 'main.js'));

      // 等 bootRuntime 完成（plugin-runtime handler 注册早于运行时就绪，直接取会竞态）
      for (let i = 0; i < 200; i++) {
        const h = ipc.get('orchdesk:plugin-runtime');
        if (h) {
          const st = await h(null);
          if (st && st.ready && st.plugins && st.plugins.length >= 9) break;
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      const { getService } = require(path.join(APP_DIR, 'dist', 'dsh-runtime.js'));
      const mem = getService('memory');
      if (!mem) { console.log('ERR: memory service unavailable'); process.exit(1); }

      const status = () => ipc.get('orchdesk:memory-summarize-status')(null);
      const seed = (tag) => {
        const msgs = [];
        for (let i = 0; i < 12; i++) {
          msgs.push({ content: [{ type: 'text', text: tag + '-' + i + '：' + '正文'.repeat(200) }] });
        }
        return msgs;
      };

      // --- 1. 未配置模型：seam 已注入但模式是兜底 ---
      out.statusNoModel = await status();

      // --- 2. 配一个指向本地 mock 网关的提供商 ---
      // 走真实加密链路产出 apiKeyEnc（与 main.ts 的 decryptKey 同源）：
      // 没 Key 时 callOpenAICompatible 直接抛错，测不到「模型真的被调了」这条路径。
      const { encryptSecret } = require(path.join(APP_DIR, 'dist', 'credentials.js'));
      fs.writeFileSync(path.join(HOME, 'models.json'), JSON.stringify({
        providers: [{ id: 'p-mock', name: '本地 mock 网关', type: 'openai-compatible',
          baseUrl: 'http://127.0.0.1:' + port + '/v1', models: ['mock-model'],
          apiKeyEnc: encryptSecret('test-key-do-not-use') }],
        defaultProvider: 'p-mock', defaultModel: 'mock-model',
      }), 'utf-8');
      out.statusWithModel = await status();

      // --- 3. 真 dump：应去调模型 ---
      const rec = await mem.dump('s-llm', seed('分片'), { domain: 'project' });
      out.dumpMode = rec.mode;
      out.chunkCount = rec.chunks.length;
      out.firstChunk = rec.chunks[0];
      out.reqSystem = firstBody && firstBody.messages ? String(firstBody.messages[0].content) : '';
      const userMsg = firstBody && firstBody.messages ? String(firstBody.messages[1].content) : '';
      out.reqUserHasOriginal = userMsg.includes('分片-0');
      out.reqUserLen = userMsg.length;

      // --- 4. 模型报错：应回落抽取式且块数不减 ---
      mode = 'fail';
      const rec2 = await mem.dump('s-fail', seed('缓存'), { domain: 'project' });
      out.failMode = rec2.mode;
      out.failChunkCount = rec2.chunks.length;
      out.failFirstChunk = rec2.chunks[0];
      out.recallAfterFail = (mem.recall('缓存', { domain: 'project', k: 5 }) || [])
        .filter((h) => (h.score || 0) > 0).length;

      console.log('RESULT_JSON:' + JSON.stringify(out));
      server.close();
      process.exit(0);
    })().catch((e) => { console.log('ERR:' + ((e && e.stack) || e)); process.exit(1); });
  `;
  const tmp = path.join(os.tmpdir(), `msum-probe-${Date.now()}.cjs`);
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
