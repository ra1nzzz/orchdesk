/**
 * 凭据加密 + 沙箱验证（P1-3，对齐 PRD §5 FR-5 与 NFR）
 * ----------------------------------------------------------------------------
 * 1. AES-256-GCM 加解密往返、抗篡改、格式识别
 * 2. 密钥派生自机器指纹（确定性、跨调用一致）
 * 3. 空串 / 非法密文 → 空串（不回落明文、不抛错）
 * 4. 主进程 encryptKey/decryptKey 走新格式（stub electron 后驱动真实 handler）
 * 5. shell_command 在子进程异步执行，不阻塞主进程且超时可杀
 *
 * 运行：node credentials-verify.cjs   （需先 npx tsc -p tsconfig.json）
 */

const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');

let passed = 0;
let failed = 0;
const log = [];
async function check(name, fn) {
  try { await fn(); passed++; log.push(`  PASS  ${name}`); }
  catch (err) { failed++; log.push(`  FAIL  ${name}\n        ${(err && err.message) || err}`); }
}

const cred = require('./dist/credentials.js');

(async () => {
  console.log('\n== A. AES-256-GCM 加解密 ==');

  await check('加密输出为 v1 格式', () => {
    const enc = cred.encryptSecret('sk-test-123');
    assert.ok(cred.isV1Cipher(enc), '应为 v1 格式，实际 ' + enc.slice(0, 20));
    assert.strictEqual(enc.split(':').length, 4, '应为 4 段：v1:iv:tag:ct');
  });

  await check('加解密往返一致（含中文与特殊字符）', () => {
    for (const raw of ['sk-abc123', '中文密钥·测试', 'a"b\'c\\d\ne', 'x'.repeat(4096)]) {
      assert.strictEqual(cred.decryptSecret(cred.encryptSecret(raw)), raw, '往返失败: ' + raw.slice(0, 20));
    }
  });

  await check('每次加密密文不同（随机 IV）', () => {
    const a = cred.encryptSecret('same');
    const b = cred.encryptSecret('same');
    assert.notStrictEqual(a, b, '相同明文应产生不同密文（IV 随机）');
    assert.strictEqual(cred.decryptSecret(a), cred.decryptSecret(b), '但解密结果应一致');
  });

  await check('空串加密返回空串', () => {
    assert.strictEqual(cred.encryptSecret(''), '');
  });

  await check('空 / 非法输入解密返回空串（不抛错）', () => {
    assert.strictEqual(cred.decryptSecret(''), '');
    assert.strictEqual(cred.decryptSecret(undefined), '');
    assert.strictEqual(cred.decryptSecret('garbage'), '');
    assert.strictEqual(cred.decryptSecret('v1:xx'), '');
    assert.strictEqual(cred.decryptSecret('v2:a:b:c'), '');
  });

  await check('密文被篡改 → 解密失败返回空串（GCM 认证）', () => {
    const enc = cred.encryptSecret('sk-secret');
    const parts = enc.split(':');
    // 篡改密文最后一个字符
    const ct = Buffer.from(parts[3], 'base64');
    ct[ct.length - 1] = ct[ct.length - 1] ^ 0xff;
    const tampered = [parts[0], parts[1], parts[2], ct.toString('base64')].join(':');
    assert.strictEqual(cred.decryptSecret(tampered), '', '篡改后必须解密失败（GCM tag 校验）');
  });

  await check('密钥派生确定（同一机器多次调用结果一致）', () => {
    const a = cred.encryptSecret('determinism');
    cred.resetKeyCache();
    assert.strictEqual(cred.decryptSecret(a), 'determinism', '清缓存后仍应能解密（派生确定性）');
  });

  console.log('== A2. 显式密钥版（TRACE TOKEN 加密内置）==');
  const KEY_A = crypto.randomBytes(32).toString('hex');
  const KEY_B = crypto.randomBytes(32).toString('hex');
  await check('encryptWithKey/decryptWithKey 往返一致（含中文）', () => {
    const enc = cred.encryptWithKey('ghp_trace_令牌123', KEY_A);
    assert.ok(cred.isV1Cipher(enc), '应为 v1 格式');
    assert.strictEqual(cred.decryptWithKey(enc, KEY_A), 'ghp_trace_令牌123', '同密钥应可解密');
  });
  await check('换密钥 / 篡改 → 解密返回空串（不抛错不回落明文）', () => {
    const enc = cred.encryptWithKey('secret', KEY_A);
    assert.strictEqual(cred.decryptWithKey(enc, KEY_B), '', '不同密钥应解密失败');
    assert.strictEqual(cred.decryptWithKey(enc.slice(0, -4) + 'AAAA', KEY_A), '', '密文篡改应解密失败（GCM 认证）');
    assert.strictEqual(cred.decryptWithKey(undefined, KEY_A), '', 'undefined 应返回空串');
  });

  console.log('== B. 主进程凭据读写（stub electron 驱动真实 handler）==');

  // 用独立子进程跑，避免 stub 污染本进程
  const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'orchdesk-cred-'));
  const script = `
    const Module = require('module');
    const path = require('path'), fs = require('fs'), os = require('os');
    const HOME = ${JSON.stringify(HOME)};
    process.env.ORCHDESK_HOME = HOME;
    const { makeElectronStub } = require(${JSON.stringify(path.join(__dirname, '..', '..', 'scripts', 'verify-kit.cjs'))});
    const stub = makeElectronStub({
      home: HOME,
      getPath: (n) => n === 'appData' ? path.join(HOME, 'ad') : path.join(HOME, 'st', n),
    });
    const ipc = stub.ipcHandlers;
    const orig = Module._load;
    Module._load = function (req) { if (req === 'electron') return stub; return orig.apply(this, arguments); };
    require('${path.join(__dirname, 'dist', 'main.js').replace(/\\/g, '\\\\')}');
    (async () => {
      const cid = require('${path.join(__dirname, 'dist', 'credentials.js').replace(/\\/g, '\\\\')}');
      await ipc.get('orchdesk:models-save')(null, {
        providers: [{ id: 'p1', name: '测试', type: 'openai-compatible', baseUrl: 'http://x/v1', apiKey: 'sk-real-secret', models: ['m'] }],
        defaultProvider: 'p1', defaultModel: 'm', maxToolIterations: 10,
      });
      const raw = JSON.parse(fs.readFileSync(path.join(HOME, 'models.json'), 'utf-8'));
      const p = raw.providers[0];
      const out = {
        hasPlainKey: 'apiKey' in p,
        encIsV1: cid.isV1Cipher(p.apiKeyEnc),
        encPreview: String(p.apiKeyEnc || '').slice(0, 24),
        matchesCiphertext: cid.decryptSecret(p.apiKeyEnc) === 'sk-real-secret',
      };
      // 再读一次配置，确认读取路径不会把密文写坏
      const read = await ipc.get('orchdesk:models-get')(null);
      out.readOk = Array.isArray(read.providers) && read.providers.length === 1;
      console.log('RESULT_JSON:' + JSON.stringify(out));
      process.exit(0);
    })().catch((e) => { console.log('ERR:' + e.message); process.exit(1); });
  `;
  const tmpScript = path.join(os.tmpdir(), `cred-probe-${Date.now()}.cjs`);
  fs.writeFileSync(tmpScript, script, 'utf-8');

  let probeOut = '';
  try {
    probeOut = require('node:child_process').execSync(`node "${tmpScript}"`, { encoding: 'utf-8', timeout: 60_000 });
  } catch (err) {
    probeOut = (err.stdout || '') + (err.stderr || '');
  } finally {
    try { fs.unlinkSync(tmpScript); } catch {}
  }
  const m = probeOut.match(/RESULT_JSON:(\{.*\})/);
  const probe = m ? JSON.parse(m[1]) : null;

  await check('保存后明文 apiKey 不落盘', () => {
    assert.ok(probe, '探针未产出结果: ' + probeOut.slice(0, 300));
    assert.strictEqual(probe.hasPlainKey, false, 'models.json 中不应保留明文 apiKey');
  });

  await check('API Key 以 AES-256-GCM v1 格式存储（PRD 要求）', () => {
    assert.ok(probe, '探针未产出结果');
    assert.strictEqual(probe.encIsV1, true, '应为 v1 格式，实际 ' + probe.encPreview);
    assert.strictEqual(probe.matchesCiphertext, true, '应能解出原文');
  });

  await check('读取配置不破坏密文', () => {
    assert.ok(probe, '探针未产出结果');
    assert.strictEqual(probe.readOk, true, 'models-get 应能正常返回');
  });

  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch {}

  console.log('== C. 沙箱：命令在子进程异步执行 ==');

  await check('shell_command 经审批放行后正确执行（授权门→弹窗→应答→子进程全链路）', async () => {
    const out = await runToolProbe('shell_command', { command: 'echo hello-sandbox' }, { approve: true });
    assert.ok(out && typeof out.result === 'string', '应返回 result');
    assert.ok(out.result.includes('hello-sandbox'), '应包含命令输出，实际: ' + JSON.stringify(out).slice(0, 200));
    assert.ok(!out.error, '不应有错误，实际: ' + out.error);
  });

  await check('渲染层未就绪时 shell 被授权门零等待拒绝（fail-closed）', async () => {
    const out = await runToolProbe('shell_command', { command: 'echo blocked' });
    assert.ok(out.error && out.error.includes('未获批准'), '应被审批拒绝，实际: ' + JSON.stringify(out).slice(0, 200));
  });

  await check('file_write 未获批时被授权门拦截（白名单内路径仍不 silently 放行）', async () => {
    const out = await runToolProbe('file_write', { path: '__DATA__/should-not-exist.txt', content: 'x' });
    assert.ok(out.error && out.error.includes('未获批准'), '写文件应被审批拦截，实际: ' + JSON.stringify(out).slice(0, 200));
  });

  await check('file_write 审批放行后写入成功（授权门正向链路）', async () => {
    const out = await runToolProbe('file_write', { path: '__DATA__/probe-written.txt', content: 'hello-gate' }, { approve: true });
    assert.ok(!out.error, '不应有错误，实际: ' + JSON.stringify(out).slice(0, 200));
    assert.ok(String(out.result).includes('已写入'), '应返回写入成功，实际: ' + out.result);
  });

  await check('白名单外的命令被拒绝', async () => {
    const out = await runToolProbe('shell_command', { command: 'format C:' });
    assert.ok(out.error, '应被白名单拒绝');
    assert.ok(out.error.includes('白名单'), '错误信息应说明白名单，实际: ' + out.error);
  });

  await check('空命令被拒绝（不执行）', async () => {
    const out = await runToolProbe('shell_command', { command: '' });
    assert.ok(out.error, '空命令应被拒绝，实际: ' + JSON.stringify(out));
  });

  await check('目录白名单外的路径被拒绝', async () => {
    const out = await runToolProbe('file_read', { path: 'C:\\Windows\\System32\\config\\SAM' });
    assert.ok(out.error, '应被路径白名单拒绝，实际: ' + JSON.stringify(out));
  });

  // -------------------------------------------------------------------------
  console.log('\n' + log.join('\n'));
  console.log(`\n结果: ${passed} 通过, ${failed} 失败, 共 ${passed + failed} 项\n`);
  if (failed > 0) process.exit(1);
  console.log('凭据与沙箱全部验证通过');
  process.exit(0);

  // ---- helper：在子进程里用 stub electron 驱动 orchdesk:tool-execute ----
  // opts.approve=true 走完整审批链路：load-sessions（渲染层就绪标记）→ 触发工具 →
  // 拦截 webContents.send 的审批请求 → 经 authz-submit-decision 应答 allowed-once。
  async function runToolProbe(toolName, args, opts = {}) {
    const probe = `
      const Module = require('module');
      const path = require('path'), fs = require('fs'), os = require('os');
      const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'orchdesk-tool-'));
      process.env.ORCHDESK_HOME = HOME;
      const { makeElectronStub } = require(${JSON.stringify(path.join(__dirname, '..', '..', 'scripts', 'verify-kit.cjs'))});
      const stub = makeElectronStub({
        home: HOME,
        getPath: (n) => n === 'appData' ? path.join(HOME,'ad') : path.join(HOME,'st',n),
      });
      const ipc = stub.ipcHandlers;
      const orig = Module._load;
      Module._load = function (req) { if (req === 'electron') return stub; return orig.apply(this, arguments); };
      require('${path.join(__dirname, 'dist', 'main.js').replace(/\\/g, '\\\\')}');
      const args0 = ${JSON.stringify({ name: toolName, arguments: args })};
      // __DATA__ 占位 → 子进程数据目录（ORCHDESK_HOME，必在路径白名单内）
      if (args0.arguments && args0.arguments.path) {
        args0.arguments.path = String(args0.arguments.path).replace(/__DATA__/g, HOME);
      }
      (async () => {
        // 等 bootRuntime 完成（plugin-runtime handler 注册早于运行时就绪，直接 kick 会竞态）
        for (let i = 0; i < 100; i++) {
          const h = ipc.get('orchdesk:plugin-runtime');
          if (h) {
            const st = await h(null);
            if (st && st.ready && st.plugins && st.plugins.length >= 9) break;
          }
          await new Promise((r) => setTimeout(r, 50));
        }
        ${opts.approve ? "await ipc.get('orchdesk:load-sessions')(null);" : ''}
        const kick = ipc.get('orchdesk:tool-execute')(null, args0);
        ${opts.approve ? `
        let approvalReq = null;
        for (let i = 0; i < 100 && !approvalReq; i++) {
          approvalReq = stub.webSent.find((w) => w.ch === 'orchdesk:authz-approval-request');
          if (!approvalReq) await new Promise((r) => setTimeout(r, 20));
        }
        if (!approvalReq) { console.log('ERR: 审批请求未发出'); process.exit(1); }
        stub.ipcListeners.get('orchdesk:authz-submit-decision')(null, approvalReq.payload.id, 'allowed-once');
        ` : ''}
        const r = await kick;
        console.log('TOOL_JSON:' + JSON.stringify(r));
        process.exit(0);
      })().catch(e => { console.log('ERR:' + e.message); process.exit(1); });
    `;
    const f = path.join(os.tmpdir(), `tool-probe-${Date.now()}-${crypto.randomBytes(3).toString('hex')}.cjs`);
    fs.writeFileSync(f, probe, 'utf-8');
    let out = '';
    try {
      out = require('node:child_process').execSync(`node "${f}"`, { encoding: 'utf-8', timeout: 60_000 });
    } catch (err) {
      out = (err.stdout || '') + (err.stderr || '');
    } finally {
      try { fs.unlinkSync(f); } catch {}
    }
    const mm = out.match(/TOOL_JSON:(\{.*\})/);
    if (!mm) throw new Error('探针无输出: ' + out.slice(0, 200));
    return JSON.parse(mm[1]);
  }
})().catch((e) => { console.error('ERR', e); process.exit(1); });
